import { execFileSync } from "node:child_process";
import type { WorkflowContext } from "scrat";

type OpenIssue = Awaited<ReturnType<WorkflowContext["github"]["listOpenItems"]>>["issues"][number];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelOverride = { provider?: string; model?: string; thinkingLevel?: ThinkingLevel };

type LedgerKind = "bugfix" | "feature" | "refactor" | "chore";
type LedgerEntry = {
  number: number;
  title: string;
  mergedAt: string;
  kind: LedgerKind;
  areas: string[];
  files: string[];
  summary: string;
};

type LedgerBatchResult = {
  status: "complete" | "incomplete" | "needs_decision";
  entries: Array<{
    number: number;
    kind: LedgerKind;
    areas: string[];
    summary: string;
  }>;
};

type ProposalResult = {
  status: "complete" | "incomplete" | "needs_decision";
  found: boolean;
  slug?: string;
  title?: string;
  linkedNumbers?: number[];
  summary?: string;
  evidence?: Array<{ path: string; symbol?: string; detail: string }>;
  proposal?: string;
};

type CritiqueResult = {
  status: "complete" | "incomplete" | "needs_decision";
  approved: boolean;
  reason: string;
  revisedTitle?: string;
  revisedBody?: string;
};

const ledgerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "kind", "areas", "summary"],
        properties: {
          number: { type: "integer" },
          kind: { type: "string", enum: ["bugfix", "feature", "refactor", "chore"] },
          areas: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 5 },
          summary: { type: "string", minLength: 10 },
        },
      },
    },
  },
};

const proposeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["found"],
  if: {
    properties: { found: { const: true } },
    required: ["found"],
  },
  then: {
    required: ["slug", "title", "linkedNumbers", "proposal"],
  },
  properties: {
    found: { type: "boolean", description: "True only if one high-leverage primitive or refactor eliminates a verified shared root cause." },
    slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,60}$", description: "Short kebab-case slug for deduplication when found is true." },
    title: { type: "string", minLength: 5, description: "Concise GitHub RFC issue title when found is true." },
    linkedNumbers: { type: "array", items: { type: "integer" }, description: "Issue/PR numbers whose shared root cause this addresses." },
    summary: { type: "string", description: "2-3 sentence summary of the shared root cause and proposed primitive." },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "detail"],
        properties: {
          path: { type: "string" },
          symbol: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    proposal: { type: "string", minLength: 10, description: "Full Markdown RFC issue body when found is true." },
  },
};

const critiqueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "reason"],
  properties: {
    approved: { type: "boolean" },
    reason: { type: "string" },
    revisedTitle: { type: "string" },
    revisedBody: { type: "string" },
  },
};

type ProposedRfc = { slug: string; title: string; issueNumber?: number; proposedAt: string };

const str = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const strList = (value: unknown, fallback: string[]) => Array.isArray(value) && value.every((v) => typeof v === "string") ? value : fallback;
const labelOf = (label: string | { name?: string | null }) => typeof label === "string" ? label : (label.name ?? "");
const trimText = (text: string | null | undefined, max: number) => {
  const clean = (text ?? "").trim();
  if (clean.length <= max) return clean;
  return max ? `${clean.slice(0, max - 1)}…` : "";
};

function readModelOverride(raw: unknown): ModelOverride {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: ModelOverride = {};
  if (typeof record.provider === "string" && record.provider.trim()) out.provider = record.provider.trim();
  if (typeof record.model === "string" && record.model.trim()) out.model = record.model.trim();
  if (typeof record.thinkingLevel === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(record.thinkingLevel)) {
    out.thinkingLevel = record.thinkingLevel as ThinkingLevel;
  }
  return out;
}

function mapPrTouchedFiles(cwd: string, commitLimit: number, maxFilesPerPr: number): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (commitLimit <= 0 || maxFilesPerPr <= 0) return result;
  let stdout = "";
  try {
    stdout = execFileSync("git", ["log", "--first-parent", `-n`, String(commitLimit), "--format=@@@%s", "--name-only"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return result;
  }
  let currentPr: number | undefined;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("@@@")) {
      const subject = line.slice(3);
      const match = subject.match(/\(#(\d+)\)\s*$/) ?? subject.match(/^Merge pull request #(\d+)\b/);
      currentPr = match ? Number(match[1]) : undefined;
      continue;
    }
    if (currentPr === undefined) continue;
    const files = result.get(currentPr) ?? [];
    if (files.length < maxFilesPerPr && !files.includes(line)) {
      files.push(line);
      result.set(currentPr, files);
    }
  }
  return result;
}

export default async function maintainerSweep(ctx: WorkflowContext) {
  const cfg = ctx.workflow.config;
  const count = (key: string, fallback?: number) => {
    const value = cfg[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`maintainer-sweep config.${key} must be a non-negative integer`);
    }
    return value;
  };
  const maxOpenIssues = count("maxOpenIssues");
  const maxOpenPrs = count("maxOpenPrs");
  const recentMergedDays = count("recentMergedDays");
  const maxMergedPrs = count("maxMergedPrs");
  const minLinkedIssues = count("minLinkedIssues");
  const maxIssueBodyChars = count("maxIssueBodyChars");
  const maxPrBodyChars = count("maxPrBodyChars");
  const maxProposedHistory = count("maxProposedHistory");
  const ledgerBackfillDays = count("ledgerBackfillDays", 60);
  const ledgerMaxEntries = count("ledgerMaxEntries", 120);
  const ledgerBatchSize = Math.max(1, count("ledgerBatchSize", 20));
  const ledgerSummaryMaxChars = count("ledgerSummaryMaxChars", 360);
  const ledgerMaxFilesPerPr = count("ledgerMaxFilesPerPr", 12);
  const ledgerGitLogLimit = count("ledgerGitLogLimit", 300);
  const channel = str(cfg.channel).trim();
  const issueLabels = strList(cfg.issueLabels, ["maintainer-rfc"]);
  const critiqueModel = readModelOverride(cfg.critique);
  const ledgerModel = readModelOverride(cfg.ledger);
  const rfcLabels = new Set(issueLabels.map((label) => label.toLowerCase()));
  const rfcMarker = `<!-- scrat-fingerprint:workflow:${ctx.workflow.name}:`;
  const isRfc = (issue: OpenIssue) => issue.labels.some((label) => rfcLabels.has(labelOf(label).toLowerCase())) || (issue.body ?? "").includes(rfcMarker);

  const gathered = await ctx.step("gather", {
    maxOpenIssues, maxOpenPrs, recentMergedDays, ledgerBackfillDays, maxMergedPrs, maxIssueBodyChars, maxPrBodyChars, issueLabels,
  }, async () => {
    const previouslyProposed = ctx.state.get<ProposedRfc[]>("proposed") ?? [];
    const existingLedger = ctx.state.get<LedgerEntry[]>("mergedLedger") ?? [];
    const lookbackDays = existingLedger.length > 0 ? recentMergedDays : Math.max(recentMergedDays, ledgerBackfillDays);
    const { open, merged } = await ctx.parallel({
      open: () => ctx.github.listOpenItems(),
      merged: () => ctx.github.listRecentMergedPrs(lookbackDays, maxMergedPrs),
    });
    return {
      previouslyProposed,
      existingLedger,
      backlog: {
        openIssues: open.issues.filter((i) => !isRfc(i)).slice(0, maxOpenIssues).map((i) => ({
          number: i.number,
          title: i.title,
          labels: i.labels.map(labelOf).filter(Boolean),
          updatedAt: i.updated_at,
          body: trimText(i.body, maxIssueBodyChars),
        })),
        openPrs: open.pullRequests.slice(0, maxOpenPrs).map((p) => ({
          number: p.number,
          title: p.title,
          labels: p.labels.map(labelOf).filter(Boolean),
          updatedAt: p.updated_at,
          body: trimText(p.body, maxPrBodyChars),
        })),
        recentMergedPrs: merged.map((m) => ({
          number: m.number,
          title: m.title,
          labels: m.labels,
          mergedAt: m.mergedAt,
          body: trimText(m.body, maxPrBodyChars),
        })),
      },
    };
  });
  const { backlog, previouslyProposed, existingLedger } = gathered;

  return ctx.workspace.withCheckout(ctx.workspace.baseBranch, async (ws) => {
    const ledgerResult = await ctx.step("update_ledger", {
      baseSha: ws.baseSha,
      existingCount: existingLedger.length,
      newestKnown: existingLedger[0]?.number ?? null,
      recentMergedNumbers: backlog.recentMergedPrs.map((pr) => pr.number),
      ledgerMaxEntries,
      ledgerBatchSize,
      ledgerSummaryMaxChars,
    }, async () => {
      const byNumber = new Map<number, LedgerEntry>();
      for (const entry of existingLedger) byNumber.set(entry.number, entry);
      const unseen = backlog.recentMergedPrs.filter((pr) => !byNumber.has(pr.number));
      if (!unseen.length) {
        return { added: 0, total: existingLedger.length, entries: existingLedger };
      }
      const filesByPr = mapPrTouchedFiles(ws.path, ledgerGitLogLimit, ledgerMaxFilesPerPr);
      const addedEntries: LedgerEntry[] = [];
      for (let i = 0; i < unseen.length; i += ledgerBatchSize) {
        const chunk = unseen.slice(i, i + ledgerBatchSize).map((pr) => ({
          number: pr.number,
          title: pr.title,
          mergedAt: pr.mergedAt,
          labels: pr.labels,
          files: filesByPr.get(pr.number) ?? [],
          body: pr.body,
        }));
        const res = await ctx.agent.run<LedgerBatchResult>({
          cwd: ws.path,
          skill: "LEDGER.md",
          ...ledgerModel,
          codemode: false,
          tools: ["read", "ls"],
          input: { maxSummaryChars: ledgerSummaryMaxChars, prs: chunk },
          submitResult: {
            schema: ledgerSchema,
            description: "Submit one compact root-cause ledger entry for each PR in prs.",
          },
        });
        if (res.outcome !== "complete") throw new Error(`Ledger summarizer did not complete (outcome: ${res.outcome})`);
        const returned = new Map((res.data?.entries ?? []).map((entry) => [entry.number, entry]));
        for (const pr of chunk) {
          const item = returned.get(pr.number);
          const entry: LedgerEntry = {
            number: pr.number,
            title: pr.title,
            mergedAt: pr.mergedAt,
            kind: item?.kind ?? "feature",
            areas: (item?.areas ?? []).map((a) => a.trim()).filter(Boolean).slice(0, 5),
            files: pr.files,
            summary: trimText(item?.summary || pr.title, ledgerSummaryMaxChars),
          };
          byNumber.set(pr.number, entry);
          addedEntries.push(entry);
        }
      }
      const mergedEntries = [...byNumber.values()]
        .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number)
        .slice(0, ledgerMaxEntries);
      ctx.state.set("mergedLedger", mergedEntries);
      return { added: addedEntries.length, total: mergedEntries.length, entries: mergedEntries };
    });

    const signalLedger = ledgerResult.entries.filter((entry) => entry.kind !== "chore");
    const backlogNumbers = new Set([
      ...backlog.openIssues.map(({ number }) => number),
      ...backlog.openPrs.map(({ number }) => number),
      ...signalLedger.map(({ number }) => number),
    ]);
    if (backlogNumbers.size < minLinkedIssues) {
      return { status: "skipped", reason: "Not enough backlog items to cluster.", ledgerAdded: ledgerResult.added, ledgerTotal: ledgerResult.total };
    }

    const proposeInput = {
      openIssues: backlog.openIssues,
      openPrs: backlog.openPrs,
      mergedLedger: signalLedger,
      minLinkedIssues,
      previouslyProposed,
    };
    const proposalRun = await ctx.step("propose", { baseSha: ws.baseSha, ...proposeInput }, async () => {
      const res = await ctx.agent.run<ProposalResult>({
        cwd: ws.path,
        input: proposeInput,
        submitResult: {
          schema: proposeSchema,
          description: "Submit the maintainer sweep RFC decision (or found: false if no high-leverage shared root cause exists).",
        },
      });
      if (res.outcome !== "complete") throw new Error(`Propose agent did not complete (outcome: ${res.outcome})`);
      return res;
    });

    const proposal = proposalRun.data;
    if (!proposal?.found || !proposal.slug || !proposal.title || !proposal.proposal) {
      return { status: "no_rfc", ledgerAdded: ledgerResult.added, ledgerTotal: ledgerResult.total, summary: proposal?.summary ?? proposalRun.text };
    }
    const { slug } = proposal;
    const linked = [...new Set(proposal.linkedNumbers)].filter((number) => Number.isInteger(number) && backlogNumbers.has(number));
    if (linked.length < minLinkedIssues) {
      return { status: "rejected_threshold", slug, linkedNumbers: linked, minLinkedIssues, ledgerAdded: ledgerResult.added, ledgerTotal: ledgerResult.total };
    }
    if (previouslyProposed.some((entry) => entry.slug === slug)) {
      return { status: "already_proposed", slug, ledgerAdded: ledgerResult.added, ledgerTotal: ledgerResult.total };
    }

    const linkedSet = new Set(linked);
    const critiqueInput = {
      proposal: { ...proposal, linkedNumbers: linked },
      minLinkedIssues,
      previouslyProposed,
      linkedIssues: backlog.openIssues.filter(({ number }) => linkedSet.has(number)),
      linkedMergedPrs: signalLedger.filter(({ number }) => linkedSet.has(number)),
      mergedLedger: signalLedger,
      openPrs: backlog.openPrs,
    };
    const critiqueRun = await ctx.step("critique", { baseSha: ws.baseSha, ...critiqueInput }, async () => {
      const res = await ctx.agent.run<CritiqueResult>({
        cwd: ws.path,
        skill: "CRITIQUE.md",
        ...critiqueModel,
        input: critiqueInput,
        submitResult: {
          schema: critiqueSchema,
          description: "Submit the skeptical maintainer verification verdict.",
        },
      });
      if (res.outcome !== "complete") throw new Error(`Critique agent did not complete (outcome: ${res.outcome})`);
      return res;
    });

    const critique = critiqueRun.data;
    if (!critique?.approved) {
      return { status: "critique_rejected", slug, reason: critique?.reason ?? critiqueRun.text, ledgerAdded: ledgerResult.added, ledgerTotal: ledgerResult.total };
    }

    const title = critique.revisedTitle?.trim() || proposal.title;
    const body = critique.revisedBody?.trim() || proposal.proposal;
    const key = `rfc-${slug}`;
    const issue = await ctx.github.issue({ key, title, body, labels: issueLabels });

    ctx.state.update<ProposedRfc[]>("proposed", (prev = []) => maxProposedHistory ? [
      ...prev.filter((entry) => entry.slug !== slug),
      { slug, title, issueNumber: issue.number || undefined, proposedAt: new Date().toISOString() },
    ].slice(-maxProposedHistory) : []);

    let slackResult: { ts: string; dryRun?: boolean; previewPath?: string } | undefined;
    if (channel) {
      const refLine = issue.dryRun ? `[dry-run] Would open RFC: ${title}` : issue.created ? `Opened RFC #${issue.number}: ${title}` : `RFC #${issue.number}: ${title}`;
      const text = `${refLine}\nLinked: ${linked.map((n) => `#${n}`).join(", ")}\n${proposal.summary ?? ""}`.trim();
      slackResult = await ctx.slack.post({ key, channel, text });
    }

    return {
      status: issue.dryRun ? "dry_run" : issue.created ? "opened" : "existing",
      slug,
      title,
      linkedNumbers: linked,
      ledgerAdded: ledgerResult.added,
      ledgerTotal: ledgerResult.total,
      issue,
      slack: slackResult,
    };
  });
}
