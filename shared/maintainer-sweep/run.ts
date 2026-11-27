import { execFileSync } from "node:child_process";
import type { WorkflowContext } from "scrat";

type OpenIssue = Awaited<ReturnType<WorkflowContext["github"]["listOpenItems"]>>["issues"][number];
type D1 = WorkflowContext["d1"];
type Extraction = Extract<Awaited<ReturnType<D1["extract"]>>, { ok: true }>["answers"][string];
type IssueFacts = Partial<{ linkedIssues: string[]; errors: string[]; symbols: string[] }>;
type SweepIssue = { number: number; title: string; labels: string[]; body: string; extracted?: IssueFacts };
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelOverride = { provider?: string; model?: string; thinkingLevel?: ThinkingLevel };

type LedgerKind = "bugfix" | "feature" | "refactor" | "chore";
type Hunk = { path: string; snippet: string };
type PrGitContext = { sha: string; files: string[] };
type LedgerEntry = {
  number: number;
  title: string;
  mergedAt: string;
  kind: LedgerKind;
  areas: string[];
  files: string[];
  hunks?: Hunk[];
  linkedIssues?: string[];
  summary: string;
};
type CandidateCluster = {
  group: string;
  itemNumbers: number[];
  d1Score?: number;
  meetsD1Threshold?: boolean;
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

const ledgerSchema = (maxAreas: number, minSummaryChars: number) => ({
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
          areas: { type: "array", items: { type: "string", minLength: 1 }, maxItems: maxAreas },
          summary: { type: "string", minLength: minSummaryChars },
        },
      },
    },
  },
});

const proposeSchema = (minSlugChars: number, maxSlugChars: number, minTitleChars: number, minBodyChars: number) => ({
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
    slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", minLength: minSlugChars, maxLength: maxSlugChars, description: "Short kebab-case slug for deduplication when found is true." },
    title: { type: "string", minLength: minTitleChars, description: "Concise GitHub RFC issue title when found is true." },
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
    proposal: { type: "string", minLength: minBodyChars, description: "Full Markdown RFC issue body when found is true." },
  },
});

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
const excludedDiffPaths = [
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "Cargo.lock", "composer.lock", "Gemfile.lock", "poetry.lock", "uv.lock", "*.min.*", "*.generated.*",
  "dist/**", "generated/**", "__generated__/**",
].map((pattern) => `:(exclude,glob,icase)**/${pattern}`);
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

async function inWaves<T, R>(ctx: WorkflowContext, items: readonly T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let i = 0; i < items.length; i += width) {
    const wave = Object.fromEntries(items.slice(i, i + width).map((item, index) => [index, () => run(item)]));
    result.push(...Object.values(await ctx.parallel(wave)));
  }
  return result;
}

function confidentStrings(answer: Extraction | undefined, minimum: number): string[] {
  if (!Array.isArray(answer?.value) || (answer.confidence !== undefined && !(answer.confidence >= minimum))) return [];
  const values: unknown[] = answer.value;
  return [...new Set(values.flatMap((value, i) => {
    const confidence = answer.confidences?.[i];
    if (typeof value !== "string" || (confidence !== undefined && !(confidence >= minimum))) return [];
    const clean = value.trim();
    return clean ? [clean] : [];
  }))];
}

function tryGit(cwd: string, maxBuffer: number, args: string[]) {
  if (!maxBuffer) return "";
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function mapPrGitContext(cwd: string, baseSha: string, commitLimit: number, maxFilesPerPr: number, maxBuffer: number): Map<number, PrGitContext> {
  const result = new Map<number, PrGitContext>();
  if (!commitLimit) return result;
  const stdout = tryGit(cwd, maxBuffer, ["log", "--first-parent", "-n", String(commitLimit), "--format=@@@%H%x09%s", "--name-only", baseSha, "--"]);
  let current: PrGitContext | undefined;
  for (const rawLine of stdout.split("\n")) {
    if (!rawLine) continue;
    const header = rawLine.match(/^@@@([a-f0-9]+)\t(.*)$/);
    if (header) {
      const [, sha, subject] = header;
      const match = subject.match(/\(#(\d+)\)\s*$/) ?? subject.match(/^Merge pull request #(\d+)\b/);
      const number = match ? Number(match[1]) : undefined;
      current = undefined;
      if (number !== undefined && !result.has(number)) {
        current = { sha, files: [] };
        result.set(number, current);
      }
      continue;
    }
    if (current && current.files.length < maxFilesPerPr && !current.files.includes(rawLine)) {
      current.files.push(rawLine);
    }
  }
  return result;
}

function readPrHunks(cwd: string, sha: string, limit: number, maxChars: number, maxBuffer: number): Hunk[] {
  if (!limit || !maxChars) return [];
  const stdout = tryGit(cwd, maxBuffer, [
    "show", "--first-parent", "--unified=1", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--src-prefix=a/", "--dst-prefix=b/", "--format=", sha, "--", ...excludedDiffPaths,
  ]);
  const hunks: Hunk[] = [];
  let path = "";
  let lines: string[] = [];
  const flush = () => {
    if (path && lines.some((line) => /^[+-]\s*\S/.test(line))) {
      hunks.push({ path, snippet: trimText(lines.join("\n"), maxChars) });
    }
    lines = [];
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("@@ ")) {
      flush();
      if (hunks.length >= limit) break;
      if (line.startsWith("diff --git ")) path = "";
      else if (path) lines.push(line);
    } else if (lines.length) {
      if (/^[ +\\-]/.test(line)) lines.push(line);
    } else if (/^(?:--- |\+\+\+ )"?[ab]\//.test(line)) {
      path = line.slice(4).split("\t", 1)[0].replace(/^"?[ab]\//, "").replace(/"$/, "");
    }
  }
  if (hunks.length < limit) flush();
  return hunks;
}

async function selectPrHunks(
  d1: D1 | undefined, cwd: string, sha: string, pr: { title: string; body: string },
  cfg: { maxHunks: number; candidateHunks: number; maxChars: number; minScore: number }, maxBuffer: number,
): Promise<Hunk[]> {
  if (!cfg.maxHunks) return [];
  const canScore = d1 && cfg.candidateHunks > 0;
  const limit = canScore ? Math.max(cfg.maxHunks + 1, cfg.candidateHunks) : cfg.maxHunks;
  const hunks = readPrHunks(cwd, sha, limit, cfg.maxChars, maxBuffer);
  if (canScore && hunks.length > cfg.maxHunks) {
    const candidates = hunks.slice(0, cfg.candidateHunks).map((hunk, index) => ({ id: `hunk_${index}`, ...hunk }));
    const result = await d1.score({
      state: JSON.stringify({ title: pr.title, body: pr.body, hunks: candidates }),
      questions: Object.fromEntries(candidates.map(({ id }) => [
        id, `Does ${id} show the core behavioral change, bug fix, or invariant boundary?`,
      ])),
    });
    if (result.ok) {
      const ranked = candidates.flatMap(({ id }, index) => {
        const score = result.scores[id];
        return Number.isFinite(score) && score >= cfg.minScore ? [{ index, score }] : [];
      }).sort((a, b) => b.score - a.score || a.index - b.index);
      const indices = new Set([...ranked.map(({ index }) => index), ...hunks.keys()]);
      return [...indices].slice(0, cfg.maxHunks).map((index) => hunks[index]);
    }
  }
  return hunks.slice(0, cfg.maxHunks);
}

function explicitReferences(text: string): string[] {
  return [...text.matchAll(/#(\d+)\b/g)].map(([, number]) => `#${number}`);
}

function seedClusters(issues: SweepIssue[], ledger: LedgerEntry[], maxClusters: number, maxItems: number, detailChars: number) {
  const groups = new Map<string, Set<number>>();
  const items = new Map<number, { kind: LedgerKind | "issue"; title: string; detail: string }>();
  const index = (number: number, areas: string[], paths: string[], refs: string[]) => {
    const add = (key: string) => {
      const group = groups.get(key) ?? new Set<number>();
      group.add(number);
      groups.set(key, group);
    };
    for (const area of areas) {
      const key = area.toLowerCase().trim().replace(/^(?:area|scope|component)[:/\s]+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (key && !/^(?:bug|bugfix|enhancement|feature|question|chore|refactor|documentation|duplicate|invalid|help-wanted|good-first-issue|wontfix)$/.test(key)) add(`area:${key}`);
    }
    for (const path of paths) {
      const parts = path.replace(/^\.?\//, "").split("/").filter(Boolean);
      for (let length = 1; length <= parts.length; length++) add(`path:${parts.slice(0, length).join("/")}`);
    }
    for (const ref of [`#${number}`, ...refs]) add(`ref:${ref}`);
  };
  if (!maxClusters || maxItems < 2) return { clusters: [], items };
  for (const issue of issues) {
    const { number, title, body, labels, extracted } = issue;
    const issueText = `${title}\n${body}`;
    const pathText = [issueText, ...(extracted?.symbols ?? [])].join("\n").replace(/https?:\/\/[^\s<>"`]+/gi, "");
    const paths = [
      ...(pathText.match(/(?:[\w.@+-]+\/)+[\w.@+-]+/g) ?? []),
      ...(extracted?.symbols ?? []).filter((symbol) => /^[\w@+-]+\.[a-z]\w*$/i.test(symbol)),
    ];
    const refs = (extracted?.linkedIssues ?? []).flatMap((ref) => /^\d+$/.test(ref) ? [`#${ref}`] : explicitReferences(ref));
    items.set(number, {
      kind: "issue",
      title,
      detail: trimText([...(extracted?.errors ?? []), ...(extracted?.symbols ?? []), ...refs, body].join("\n"), detailChars),
    });
    index(number, labels, paths, [...refs, ...explicitReferences(issueText)]);
  }
  for (const { number, title, kind, areas, files, summary, linkedIssues } of ledger) {
    items.set(number, { kind, title, detail: trimText(summary, detailChars) });
    index(number, areas, files, [...(linkedIssues ?? []), ...explicitReferences(`${title}\n${summary}`)]);
  }
  const isBugfix = (number: number) => Number(items.get(number)?.kind === "bugfix");
  const seen = new Set<string>();
  const clusters: CandidateCluster[] = [];
  const seeds = [...groups].flatMap(([group, members]) => {
    if (members.size < 2) return [];
    const numbers = [...members];
    const bugfixes = numbers.reduce((sum, number) => sum + isBugfix(number), 0);
    return [{ group, numbers, bugfixes }];
  }).sort((a, b) => b.numbers.length - a.numbers.length || b.bugfixes - a.bugfixes || a.group.localeCompare(b.group));
  for (const { group, numbers } of seeds) {
    const itemNumbers = numbers.sort((a, b) => isBugfix(b) - isBugfix(a) || b - a).slice(0, maxItems).sort((a, b) => a - b);
    const key = itemNumbers.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    clusters.push({ group, itemNumbers });
    if (clusters.length >= maxClusters) break;
  }
  return { clusters, items };
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
  const num = (key: string, fallback: number) => {
    const value = cfg[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`maintainer-sweep config.${key} must be a number between 0 and 1`);
    }
    return value;
  };
  const d1 = ctx.d1?.enabled ? ctx.d1 : undefined;
  const maxOpenIssues = count("maxOpenIssues");
  const maxOpenPrs = count("maxOpenPrs");
  const recentMergedDays = count("recentMergedDays");
  const maxMergedPrs = count("maxMergedPrs");
  const minLinkedIssues = count("minLinkedIssues");
  const maxIssueBodyChars = count("maxIssueBodyChars");
  const maxPrBodyChars = count("maxPrBodyChars");
  const maxProposedHistory = count("maxProposedHistory");
  const extractConfig = {
    maxItems: count("d1ExtractMaxItems", 24),
    concurrency: count("d1ExtractConcurrency", 4),
    minConfidence: num("d1ExtractMinConfidence", 0.55),
    maxStateChars: count("d1ExtractMaxStateChars", 8000),
  };
  const ledgerBackfillDays = count("ledgerBackfillDays", 60);
  const ledgerMaxEntries = count("ledgerMaxEntries", 120);
  const ledgerBatchSize = Math.max(1, count("ledgerBatchSize", 20));
  const ledgerSummaryMaxChars = count("ledgerSummaryMaxChars", 360);
  const ledgerSummaryMinChars = count("ledgerSummaryMinChars", 10);
  const ledgerMaxAreas = count("ledgerMaxAreas", 5);
  const ledgerMaxFilesPerPr = count("ledgerMaxFilesPerPr", 12);
  const ledgerGitLogLimit = count("ledgerGitLogLimit", 300);
  const ledgerGitMaxBufferBytes = count("ledgerGitMaxBufferBytes", 8 * 1024 * 1024);
  const ledgerParallelBatches = Math.max(1, count("ledgerParallelBatches", 3));
  const hunkConfig = {
    maxHunks: count("ledgerMaxHunksPerPr", 2),
    candidateHunks: count("ledgerCandidateHunksPerPr", 8),
    maxChars: count("ledgerMaxHunkChars", 700),
    concurrency: Math.max(1, count("ledgerHunkConcurrency", 3)),
    minScore: num("ledgerD1MinScore", 0.35),
  };
  const clusterConfig = {
    maxClusters: count("d1MaxClusters", 16),
    maxItems: count("d1MaxClusterItems", 8),
    minScore: num("d1ClusterMinScore", 0.45),
    detailChars: count("d1ClusterItemMaxChars", 360),
  };
  const maxDuplicateChecks = count("maxDuplicateChecks", 2);
  const proposalSchema = proposeSchema(
    count("rfcMinSlugChars", 2), count("rfcMaxSlugChars", 61), count("rfcMinTitleChars", 5), count("rfcMinBodyChars", 10),
  );
  const channel = str(cfg.channel).trim();
  const issueLabels = strList(cfg.issueLabels, ["maintainer-rfc"]);
  const critiqueModel = readModelOverride(cfg.critique);
  const ledgerModel = readModelOverride(cfg.ledger);
  const rfcLabels = new Set(issueLabels.map((label) => label.toLowerCase()));
  const rfcMarker = `<!-- scrat-fingerprint:workflow:${ctx.workflow.name}:`;
  const isRfc = (issue: OpenIssue) => issue.labels.some((label) => rfcLabels.has(labelOf(label).toLowerCase())) || (issue.body ?? "").includes(rfcMarker);

  const gathered = await ctx.step("gather", {
    maxOpenIssues, maxOpenPrs, recentMergedDays, ledgerBackfillDays, maxMergedPrs, maxIssueBodyChars, maxPrBodyChars, issueLabels,
    extractConfig, d1Enabled: !!d1,
  }, async () => {
    const previouslyProposed = ctx.state.get<ProposedRfc[]>("proposed") ?? [];
    const existingLedger = ctx.state.get<LedgerEntry[]>("mergedLedger") ?? [];
    const lookbackDays = existingLedger.length > 0 ? recentMergedDays : Math.max(recentMergedDays, ledgerBackfillDays);
    const { open, merged } = await ctx.parallel({
      open: () => ctx.github.listOpenItems(),
      merged: () => ctx.github.listRecentMergedPrs(lookbackDays, maxMergedPrs),
    });
    const issues = open.issues.filter((issue) => !isRfc(issue)).slice(0, maxOpenIssues);
    const factsByNumber = new Map<number, IssueFacts>();
    if (d1 && extractConfig.concurrency && extractConfig.maxStateChars) {
      const eligible = issues.filter((issue) => (issue.body?.length ?? 0) > maxIssueBodyChars)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.number - a.number)
        .slice(0, extractConfig.maxItems);
      await inWaves(ctx, eligible, extractConfig.concurrency, async (issue) => {
        const result = await d1.extract({
          state: (issue.body ?? "").slice(0, extractConfig.maxStateChars),
          fields: {
            linked_issues: { type: "list", items: "text", instructions: "Explicit issue or PR numbers referenced (e.g. #123)." },
            error_messages: { type: "list", items: "text", instructions: "Exact error names, codes, or failure messages mentioned." },
            symbols_or_paths: { type: "list", items: "text", instructions: "Specific file paths, endpoints, functions, or symbols named." },
          },
        });
        if (!result.ok) return;
        const facts: IssueFacts = {};
        for (const [key, field] of [["linkedIssues", "linked_issues"], ["errors", "error_messages"], ["symbols", "symbols_or_paths"]] as const) {
          const values = confidentStrings(result.answers[field], extractConfig.minConfidence);
          if (values.length) facts[key] = values;
        }
        if (Object.keys(facts).length) factsByNumber.set(issue.number, facts);
      });
    }
    return {
      previouslyProposed,
      existingLedger,
      backlog: {
        openIssues: issues.map((issue) => ({
          number: issue.number,
          title: issue.title,
          labels: issue.labels.map(labelOf).filter(Boolean),
          updatedAt: issue.updated_at,
          body: trimText(issue.body, maxIssueBodyChars),
          extracted: factsByNumber.get(issue.number),
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
      ledgerSummaryMinChars,
      ledgerParallelBatches,
      ledgerMaxAreas,
      ledgerMaxFilesPerPr,
      ledgerGitLogLimit,
      ledgerGitMaxBufferBytes,
      hunkConfig,
      d1Enabled: !!d1,
    }, async () => {
      const byNumber = new Map<number, LedgerEntry>();
      for (const entry of existingLedger) byNumber.set(entry.number, entry);
      const unseen = backlog.recentMergedPrs.filter((pr) => !byNumber.has(pr.number));
      if (!unseen.length) {
        return { added: 0, total: existingLedger.length, entries: existingLedger };
      }
      const gitByPr = mapPrGitContext(ws.path, ws.baseSha, ledgerGitLogLimit, ledgerMaxFilesPerPr, ledgerGitMaxBufferBytes);
      const chunks: typeof unseen[] = [];
      for (let i = 0; i < unseen.length; i += ledgerBatchSize) {
        chunks.push(unseen.slice(i, i + ledgerBatchSize));
      }
      const batches = await inWaves(ctx, chunks, ledgerParallelBatches, async (batch) => {
        const chunk = await inWaves(ctx, batch, hunkConfig.concurrency, async (pr) => {
          const git = gitByPr.get(pr.number);
          const hunks = git ? await selectPrHunks(d1, ws.path, git.sha, pr, hunkConfig, ledgerGitMaxBufferBytes) : [];
          return { ...pr, files: git?.files ?? [], hunks };
        });
        const res = await ctx.agent.run<LedgerBatchResult>({
          cwd: ws.path,
          skill: "LEDGER.md",
          ...ledgerModel,
          codemode: false,
          tools: ["read", "ls"],
          input: { maxSummaryChars: ledgerSummaryMaxChars, maxAreas: ledgerMaxAreas, prs: chunk },
          submitResult: {
            schema: ledgerSchema(ledgerMaxAreas, ledgerSummaryMinChars),
            description: "Submit one compact root-cause ledger entry for each PR in prs.",
          },
        });
        if (res.outcome !== "complete") throw new Error(`Ledger summarizer did not complete (outcome: ${res.outcome})`);
        const returned = new Map((res.data?.entries ?? []).map((entry) => [entry.number, entry]));
        return chunk.map((pr): LedgerEntry => {
          const item = returned.get(pr.number);
          const linkedIssues = [...new Set(explicitReferences(`${pr.title}\n${pr.body}`))];
          return {
            number: pr.number,
            title: pr.title,
            mergedAt: pr.mergedAt,
            kind: item?.kind ?? "feature",
            areas: (item?.areas ?? []).map((a) => a.trim()).filter(Boolean).slice(0, ledgerMaxAreas),
            files: pr.files,
            hunks: pr.hunks,
            ...(linkedIssues.length ? { linkedIssues } : {}),
            summary: trimText(item?.summary || pr.title, ledgerSummaryMaxChars),
          };
        });
      });
      const addedEntries = batches.flat();
      for (const entry of addedEntries) byNumber.set(entry.number, entry);
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

    const { clusters } = await ctx.step("rank_candidates", {
      baseSha: ws.baseSha, d1Enabled: !!d1, clusterConfig, openIssues: backlog.openIssues, mergedLedger: signalLedger,
    }, async () => {
      const { clusters, items } = seedClusters(
        backlog.openIssues, signalLedger, clusterConfig.maxClusters, clusterConfig.maxItems, clusterConfig.detailChars,
      );
      if (!d1 || !clusters.length) return { clusters, d1Used: false };
      const keyed = clusters.map((cluster, index) => ({ id: `cluster_${index}`, ...cluster }));
      const numbers = new Set(keyed.flatMap(({ itemNumbers }) => itemNumbers));
      const result = await d1.score({
        state: JSON.stringify({
          clusters: keyed,
          items: Object.fromEntries([...numbers].map((number) => [number, items.get(number)])),
        }),
        questions: Object.fromEntries(keyed.map(({ id }) => [
          id, `Do the items in ${id} stem from one shared failing invariant or missing primitive in the codebase (not merely touching the same broad folder), and does the root cause still appear unresolved?`,
        ])),
      });
      if (!result.ok) return { clusters, d1Used: false };
      const scored = clusters.map((cluster, index): CandidateCluster => {
        const d1Score = result.scores[keyed[index].id];
        return Number.isFinite(d1Score) ? { ...cluster, d1Score, meetsD1Threshold: d1Score >= clusterConfig.minScore } : cluster;
      });
      scored.sort((a, b) => Number(!!b.meetsD1Threshold) - Number(!!a.meetsD1Threshold) || (b.d1Score ?? -Infinity) - (a.d1Score ?? -Infinity));
      return { clusters: scored, d1Used: scored.some((cluster) => cluster.d1Score !== undefined) };
    });

    const proposeInput = {
      baseSha: ws.baseSha,
      candidateClusters: clusters,
      openIssues: backlog.openIssues,
      openPrs: backlog.openPrs,
      mergedLedger: ledgerResult.entries,
      minLinkedIssues,
      maxDuplicateChecks,
      previouslyProposed,
    };
    const proposalRun = await ctx.step("propose", proposeInput, async () => {
      const res = await ctx.agent.run<ProposalResult>({
        cwd: ws.path,
        input: proposeInput,
        submitResult: {
          schema: proposalSchema,
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
      baseSha: ws.baseSha,
      proposal: { ...proposal, linkedNumbers: linked },
      minLinkedIssues,
      previouslyProposed,
      linkedIssues: backlog.openIssues.filter(({ number }) => linkedSet.has(number)),
      linkedMergedPrs: signalLedger.filter(({ number }) => linkedSet.has(number)),
      mergedLedger: signalLedger,
      openPrs: backlog.openPrs,
    };
    const critiqueRun = await ctx.step("critique", critiqueInput, async () => {
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
