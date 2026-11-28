import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkflowContext } from "scrat";

const execFileAsync = promisify(execFile);

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelOverride = { provider?: string; model?: string; thinkingLevel?: ThinkingLevel };
type Device = "mobile" | "desktop";
type Summary = Awaited<ReturnType<WorkflowContext["storefront"]["lighthouse"]>>;
type Group = NonNullable<Summary["devices"][Device]>;
type Insight = Group["topInsights"][number];
type OpenItem = Awaited<ReturnType<WorkflowContext["github"]["listOpenItems"]>>["issues"][number];
type D1 = WorkflowContext["d1"];

type CandidateKind = "deletion" | "performance" | "ux_conversion" | "agentic";
type Candidate = {
  slug: string;
  title: string;
  kind: CandidateKind;
  targetPages: string[];
  evidence: string;
  lighthouseInsights: string[];
  files: string[];
  hypothesis: string;
  expectedImpact: string;
  implementationPlan: string;
  acceptanceCriteria: string[];
  risks: string;
};
type FileRejection = { path: string; reason: string };
type ValidCandidate = Candidate & { rejectedFiles?: FileRejection[] };
type ScoredCandidate = ValidCandidate & { d1?: { scores: Record<D1Key, number>; mean: number; meetsThreshold: boolean } };
type RejectedCandidate = { slug: string; reasons: string[] };
type HuntResult = { status?: "complete" | "incomplete" | "needs_decision"; candidates: Candidate[]; notes?: string };
type CritiqueResult = {
  status?: "complete" | "incomplete" | "needs_decision";
  approved: boolean;
  winnerSlug?: string;
  reason: string;
  sharpenedTitle?: string;
  sharpenedBody?: string;
  acceptanceCriteria?: string[];
};

type CompactInsight = {
  id: string;
  title: string;
  score: number | null;
  displayValue?: string;
  metricSavings?: Record<string, number>;
  items?: unknown[];
  runs?: number;
};
type CompactGroup = {
  runs: number;
  scored: number;
  scores?: Group["scores"];
  metrics?: Group["metrics"];
  agenticBrowsing?: Group["agenticBrowsing"];
  topInsights: CompactInsight[];
};
type CompactDevices = Partial<Record<Device, CompactGroup>>;
type Baseline = {
  measuredAt: string;
  liveUrl: string | null;
  pages: string[];
  devices: CompactDevices;
  byPage: Record<string, CompactDevices>;
  errors: Summary["errors"];
};
type BaselineSnapshot = Partial<Record<Device, { scores?: Group["scores"]; metrics?: Group["metrics"]; agentic?: { passed: number; total: number } }>>;
type LedgerEntry = {
  slug: string;
  title: string;
  kind: CandidateKind;
  targetPages: string[];
  lighthouseInsights: string[];
  files: string[];
  issueKey: string;
  issueNumber?: number;
  dryRun?: boolean;
  proposedAt: string;
  baseline: BaselineSnapshot;
};
/** Immutable record of the one issue this workflow is about to open; survives crashes and retries. */
type PublicationIntent = {
  issueKey: string;
  slug: string;
  kind: CandidateKind;
  title: string;
  body: string;
  labels: string[];
  targetPages: string[];
  lighthouseInsights: string[];
  files: string[];
  baseline: BaselineSnapshot;
  createdAt: string;
};

const DEVICES: readonly Device[] = ["mobile", "desktop"];
const KINDS: readonly CandidateKind[] = ["deletion", "performance", "ux_conversion", "agentic"];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const MARKER = "scrat-cro-experiment";
const ISSUE_KEY_PREFIX = "cro-";
const PREVIEW_CONTROL_PARAMS = new Set(["preview_theme_id", "preview_key", "_ab", "_fd", "_sc"]);
const SCORE_KEYS = ["performance", "accessibility", "best-practices", "seo"] as const;
const SCORE_LABELS: Record<(typeof SCORE_KEYS)[number], string> = { performance: "Performance", accessibility: "Accessibility", "best-practices": "Best Practices", seo: "SEO" };
const METRIC_KEYS = [
  ["largest-contentful-paint", "LCP", " s", 2],
  ["cumulative-layout-shift", "CLS", "", 3],
  ["total-blocking-time", "TBT", " ms", 0],
  ["first-contentful-paint", "FCP", " s", 2],
  ["speed-index", "Speed Index", " s", 2],
] as const;
const D1_QUESTIONS = {
  impact: "Would shipping this change plausibly produce a measurable improvement in storefront conversion or Core Web Vitals on the target pages?",
  proof: "Is the candidate backed by concrete, source-level evidence (specific theme files, Lighthouse culprit items, or browser diagnostics) rather than generic CRO advice?",
  reversible: "Is the change small, surgical, and reversible with a single revert?",
  checkout_safe: "Does the change carry low risk of breaking add-to-cart, cart, or checkout?",
} as const;
type D1Key = keyof typeof D1_QUESTIONS;
const D1_KEYS = Object.keys(D1_QUESTIONS) as D1Key[];

const labelOf = (label: string | { name?: string | null }) => typeof label === "string" ? label : (label.name ?? "");
const trimText = (text: string, max: number) => !max || text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const fmt = (value: number | undefined, digits: number, unit = "") => value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}${unit}`;
/** Markdown table cell: single line, pipes escaped. */
const cell = (text: string) => oneLine(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
/** Inline code span that stays intact even when the value contains backticks. */
function code(value: string): string {
  const clean = oneLine(value);
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = longest || clean.startsWith("`") || clean.endsWith("`") ? " " : "";
  return `${fence}${pad}${clean}${pad}${fence}`;
}
const isAborted = (ctx: WorkflowContext) => ctx.signal.aborted;

/** Canonical storefront path: "/" prefix, on-origin, no fragment, no Shopify preview controls. */
function pageProblem(page: unknown): string | undefined {
  if (typeof page !== "string" || !page) return "must be a non-empty string";
  if (!page.startsWith("/") || page.startsWith("//")) return "must start with a single /";
  if (/[\s#\\]/.test(page)) return "must not contain whitespace, # or backslashes";
  let url: URL;
  try {
    url = new URL(page, "https://storefront.invalid");
  } catch {
    return "is not a valid path";
  }
  if (url.origin !== "https://storefront.invalid") return "must stay on the storefront origin";
  if (`${url.pathname}${url.search}` !== page) return "is not canonical (encode it the way the browser would)";
  const control = [...url.searchParams.keys()].find((key) => PREVIEW_CONTROL_PARAMS.has(key.toLowerCase()));
  return control ? `must not carry the Shopify preview control ${control}` : undefined;
}

/** Repo-relative path in canonical form, or a reason it can't be one. Never rewrites an invalid path into a valid one. */
function canonicalFile(raw: unknown): { path: string } | { reason: string } {
  if (typeof raw !== "string" || !raw) return { reason: "empty path" };
  if (raw !== raw.trim()) return { reason: "leading or trailing whitespace" };
  if (/[\0\\]/.test(raw)) return { reason: "backslash or NUL in path" };
  if (raw.startsWith("/")) return { reason: "absolute path" };
  const path = raw.startsWith("./") ? raw.slice(2) : raw;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return { reason: "empty, . or .. path segment" };
  return { path };
}

/** Tracked regular files (blob 100644/100755) at `sha`, keyed by path. Directories, symlinks and submodules are excluded. */
async function trackedRegularFiles(ctx: WorkflowContext, cwd: string, sha: string, paths: string[], timeout: number, maxBuffer: number) {
  const found = new Map<string, string>();
  if (!paths.length) return found;
  const { stdout } = await execFileAsync("git", ["--literal-pathspecs", "-c", "core.quotePath=false", "ls-tree", "-z", "--full-tree", sha, "--", ...paths], {
    cwd, encoding: "utf8", timeout, maxBuffer, signal: ctx.signal,
  });
  for (const entry of stdout.split("\0")) {
    const match = entry.match(/^(\d{6}) (\w+) [0-9a-f]+\t(.+)$/s);
    if (match) found.set(match[3], `${match[1]} ${match[2]}`);
  }
  return found;
}

function readModelOverride(raw: unknown, key: string): ModelOverride {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`revenue-hill-climber config.${key} must be an object`);
  const record = raw as Record<string, unknown>;
  const out: ModelOverride = {};
  for (const name of Object.keys(record)) {
    if (!["provider", "model", "thinkingLevel"].includes(name)) throw new Error(`revenue-hill-climber config.${key}.${name}: unknown key`);
  }
  for (const name of ["provider", "model"] as const) {
    const value = record[name];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) throw new Error(`revenue-hill-climber config.${key}.${name} must be a non-empty string`);
    out[name] = value.trim();
  }
  if (record.thinkingLevel !== undefined) {
    if (typeof record.thinkingLevel !== "string" || !THINKING_LEVELS.includes(record.thinkingLevel as ThinkingLevel)) {
      throw new Error(`revenue-hill-climber config.${key}.thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
    }
    out.thinkingLevel = record.thinkingLevel as ThinkingLevel;
  }
  return out;
}

function readConfig(ctx: WorkflowContext) {
  const cfg = ctx.workflow.config;
  const fail = (key: string, rule: string): never => {
    throw new Error(`revenue-hill-climber config.${key} must be ${rule}`);
  };
  for (const removed of ["channel", "announceStart"]) {
    if (cfg[removed] !== undefined) fail(removed, "removed: revenue-hill-climber is GitHub-only; configure Slack on cro-scorecard");
  }
  const int = (key: string, fallback: number, min = 0) => {
    const value = cfg[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) fail(key, min ? `an integer >= ${min}` : "a non-negative integer");
    return value as number;
  };
  const fraction = (key: string, fallback: number) => {
    const value = cfg[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail(key, "a number between 0 and 1");
    return value as number;
  };
  const bool = (key: string, fallback: boolean) => {
    const value = cfg[key] ?? fallback;
    if (typeof value !== "boolean") fail(key, "a boolean");
    return value as boolean;
  };
  const text = (key: string, fallback: string) => {
    const value = cfg[key] ?? fallback;
    if (typeof value !== "string" || !value.trim()) fail(key, "a non-empty string");
    return (value as string).trim();
  };
  const texts = (key: string, fallback: string[], minItems: number) => {
    const value = cfg[key] ?? fallback;
    if (!Array.isArray(value) || value.length < minItems || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
      fail(key, `a list of non-empty strings${minItems ? ` with at least ${minItems} entr${minItems === 1 ? "y" : "ies"}` : ""}`);
    }
    return [...new Set((value as string[]).map((entry) => entry.trim()))];
  };

  const targetPages = texts("targetPages", ["/"], 1);
  for (const page of targetPages) {
    const problem = pageProblem(page);
    if (problem) fail("targetPages", `canonical storefront paths (${JSON.stringify(page)} ${problem})`);
  }
  const minCandidates = int("minCandidates", 3, 1);
  const maxCandidates = int("maxCandidates", 5);
  if (maxCandidates && maxCandidates < minCandidates) fail("maxCandidates", `0 (unlimited) or >= minCandidates (${minCandidates})`);

  return {
    croLabel: text("croLabel", "cro-experiment"),
    autoImplement: bool("autoImplement", true),
    maxOpenExperiments: int("maxOpenExperiments", 1),
    targetPages,
    lighthouseRuns: int("lighthouseRuns", 2, 1),
    lighthouseTimeoutSeconds: int("lighthouseTimeoutSeconds", 600),
    requireBaseline: bool("requireBaseline", true),
    maxInsightItems: int("maxInsightItems", 5),
    maxInsightItemChars: int("maxInsightItemChars", 400),
    browserSteps: int("browserSteps", 160, 1),
    browserSeconds: int("browserSeconds", 1800, 1),
    minCandidates,
    maxCandidates,
    requireDeletionCandidate: bool("requireDeletionCandidate", true),
    gitTimeoutMs: int("gitTimeoutMs", 10000),
    gitMaxBufferBytes: int("gitMaxBufferBytes", 8 * 1024 * 1024, 1),
    d1MinScore: fraction("d1MinScore", 0.5),
    d1TimeoutMs: int("d1TimeoutMs", 8000),
    d1BudgetMs: int("d1BudgetMs", 60000),
    d1Concurrency: int("d1Concurrency", 3, 1),
    d1MaxStateChars: int("d1MaxStateChars", 12000),
    maxLedgerEntries: int("maxLedgerEntries", 60),
    mandatoryAcceptanceCriteria: texts("mandatoryAcceptanceCriteria", [], 0),
    critique: readModelOverride(cfg.critique, "critique"),
  };
}
type Config = ReturnType<typeof readConfig>;

function compactItem(item: unknown, maxChars: number): unknown {
  if (!maxChars) return item;
  const serialized = JSON.stringify(item) ?? "null";
  return serialized.length <= maxChars ? item : trimText(serialized, maxChars);
}

function compactGroup(group: Group, maxItems: number, maxItemChars: number): CompactGroup {
  return {
    runs: group.runs,
    scored: group.scored,
    ...(group.scores ? { scores: group.scores } : {}),
    ...(group.metrics ? { metrics: group.metrics } : {}),
    ...(group.agenticBrowsing ? { agenticBrowsing: group.agenticBrowsing } : {}),
    topInsights: group.topInsights.map((insight: Insight): CompactInsight => {
      const items = Array.isArray(insight.items) ? (maxItems ? insight.items.slice(0, maxItems) : insight.items) : undefined;
      return {
        id: insight.id,
        title: insight.title,
        score: insight.score,
        ...(insight.displayValue ? { displayValue: insight.displayValue } : {}),
        ...(insight.metricSavings && Object.keys(insight.metricSavings).length ? { metricSavings: insight.metricSavings } : {}),
        ...(items?.length ? { items: items.map((item) => compactItem(item, maxItemChars)) } : {}),
        ...(insight.runs !== undefined ? { runs: insight.runs } : {}),
      };
    }),
  };
}

function compactDevices(devices: Partial<Record<Device, Group>>, maxItems: number, maxItemChars: number): CompactDevices {
  const out: CompactDevices = {};
  for (const device of DEVICES) {
    const group = devices[device];
    if (group) out[device] = compactGroup(group, maxItems, maxItemChars);
  }
  return out;
}

function snapshotOf(devices: CompactDevices): BaselineSnapshot {
  const out: BaselineSnapshot = {};
  for (const device of DEVICES) {
    const group = devices[device];
    if (!group?.scored) continue;
    out[device] = {
      ...(group.scores ? { scores: group.scores } : {}),
      ...(group.metrics ? { metrics: group.metrics } : {}),
      ...(group.agenticBrowsing ? { agentic: { passed: group.agenticBrowsing.passed, total: group.agenticBrowsing.total } } : {}),
    };
  }
  return out;
}

function baselineTable(devices: CompactDevices): string {
  const present = DEVICES.filter((device) => devices[device]?.scored);
  if (!present.length) return "_No scored Lighthouse runs._";
  const header = `| Metric | ${present.map((device) => device[0].toUpperCase() + device.slice(1)).join(" | ")} |`;
  const divider = `| --- | ${present.map(() => "---:").join(" | ")} |`;
  const rows = [
    ...SCORE_KEYS.map((key) => `| ${SCORE_LABELS[key]} | ${present.map((device) => fmt(devices[device]?.scores?.[key], 0)).join(" | ")} |`),
    ...METRIC_KEYS.map(([key, label, unit, digits]) => `| ${label} | ${present.map((device) => fmt(devices[device]?.metrics?.[key], digits, unit)).join(" | ")} |`),
    `| Agentic Browsing | ${present.map((device) => {
      const agentic = devices[device]?.agenticBrowsing;
      return agentic ? `${agentic.passed}/${agentic.total}` : "—";
    }).join(" | ")} |`,
  ];
  return [header, divider, ...rows].join("\n");
}

function insightLines(devices: CompactDevices, ids: string[]): string[] {
  const wanted = new Set(ids);
  return DEVICES.flatMap((device) => (devices[device]?.topInsights ?? [])
    .filter((insight) => !wanted.size || wanted.has(insight.id))
    .map((insight) => {
      const savings = insight.metricSavings
        ? Object.entries(insight.metricSavings).filter(([, value]) => Number.isFinite(value) && value > 0).map(([metric, value]) => `${metric} −${Math.round(value)}${metric === "CLS" ? "" : " ms"}`).join(", ")
        : "";
      return `- **${device}** ${code(insight.id)} — ${cell(insight.title)}${insight.displayValue ? ` (${cell(insight.displayValue)})` : ""}${savings ? `; potential savings: ${savings}` : ""}`;
    }));
}

function encodeMarker(payload: unknown) {
  // Escape < and > so the JSON can never terminate the HTML comment early.
  return `<!-- ${MARKER}: ${JSON.stringify(payload).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
}

async function inWaves<T, R>(ctx: WorkflowContext, items: readonly T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width) {
    const slice = items.slice(i, i + width);
    const done = await ctx.parallel(Object.fromEntries(slice.map((item, index) => [String(index), () => run(item)])));
    out.push(...slice.map((_, index) => done[String(index)] as R));
  }
  return out;
}

const huntSchema = (cfg: Config, slugMax: number) => ({
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    notes: { type: "string", description: "Short notes on what was investigated and ruled out, including whether the browser tool was available." },
    candidates: {
      type: "array",
      minItems: cfg.minCandidates,
      ...(cfg.maxCandidates ? { maxItems: cfg.maxCandidates } : {}),
      ...(cfg.requireDeletionCandidate ? { contains: { type: "object", properties: { kind: { const: "deletion" } }, required: ["kind"] } } : {}),
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "title", "kind", "targetPages", "evidence", "lighthouseInsights", "files", "hypothesis", "expectedImpact", "implementationPlan", "acceptanceCriteria", "risks"],
        properties: {
          slug: { type: "string", pattern: SLUG_RE.source, minLength: 2, maxLength: slugMax, description: "Stable kebab-case id for this experiment." },
          title: { type: "string", minLength: 5 },
          kind: { type: "string", enum: KINDS },
          targetPages: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: cfg.targetPages }, description: "Subset of the measured targetPages, copied exactly." },
          evidence: { type: "string", minLength: 20, description: "Concrete, verified evidence: browser diagnostics, Lighthouse items, and repo file/line references." },
          lighthouseInsights: { type: "array", items: { type: "string" }, description: "Lighthouse 13 insight/audit ids this targets (from the baseline)." },
          files: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "Tracked theme files to change, repo-relative (e.g. sections/main-product.liquid)." },
          hypothesis: { type: "string", minLength: 10 },
          expectedImpact: { type: "string", minLength: 5 },
          implementationPlan: { type: "string", minLength: 20 },
          acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 5 } },
          risks: { type: "string", minLength: 5 },
        },
      },
    },
  },
});

const critiqueSchema = (slugs: string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["approved", "reason"],
  if: { properties: { approved: { const: true } }, required: ["approved"] },
  then: { required: ["winnerSlug"] },
  properties: {
    approved: { type: "boolean", description: "True only when exactly one candidate clears the bar." },
    winnerSlug: { type: "string", enum: slugs },
    reason: { type: "string", minLength: 10 },
    sharpenedTitle: { type: "string", minLength: 5 },
    sharpenedBody: { type: "string", description: "Optional Markdown brief that tightens the winner's plan; inaccurate claims removed." },
    acceptanceCriteria: { type: "array", items: { type: "string", minLength: 5 } },
  },
});

/** Structural + repo validation for hunt output. Invalid candidates are rejected with reasons, never repaired. */
async function validateCandidates(ctx: WorkflowContext, cfg: Config, cwd: string, baseSha: string, slugMax: number, raw: Candidate[], ledgerSlugs: Set<string>) {
  const measured = new Set(cfg.targetPages);
  const rejected: RejectedCandidate[] = [];
  const seen = new Set<string>();
  const staged: Array<{ candidate: Candidate; files: string[]; fileRejections: FileRejection[] }> = [];
  for (const candidate of raw) {
    const reasons: string[] = [];
    const slug = typeof candidate?.slug === "string" ? candidate.slug : "";
    if (!SLUG_RE.test(slug) || slug.length < 2 || slug.length > slugMax) reasons.push("invalid slug");
    if (seen.has(slug)) reasons.push("duplicate slug");
    if (ledgerSlugs.has(slug)) reasons.push("already in the experiment ledger");
    if (!KINDS.includes(candidate?.kind)) reasons.push("invalid kind");
    const pages = Array.isArray(candidate?.targetPages) ? candidate.targetPages : [];
    if (!pages.length) reasons.push("no targetPages");
    for (const page of pages) {
      const problem = pageProblem(page);
      if (problem) reasons.push(`targetPage ${JSON.stringify(page)} ${problem}`);
      else if (!measured.has(page)) reasons.push(`targetPage ${JSON.stringify(page)} was not measured`);
    }
    if (new Set(pages).size !== pages.length) reasons.push("duplicate targetPages");
    const files: string[] = [];
    const fileRejections: FileRejection[] = [];
    for (const file of Array.isArray(candidate?.files) ? candidate.files : []) {
      const result = canonicalFile(file);
      if ("reason" in result) fileRejections.push({ path: String(file), reason: result.reason });
      else if (!files.includes(result.path)) files.push(result.path);
    }
    seen.add(slug);
    if (reasons.length) rejected.push({ slug: slug || "(none)", reasons });
    else staged.push({ candidate, files, fileRejections });
  }

  const tracked = await trackedRegularFiles(ctx, cwd, baseSha, [...new Set(staged.flatMap(({ files }) => files))], cfg.gitTimeoutMs, cfg.gitMaxBufferBytes);
  const valid: ValidCandidate[] = [];
  for (const { candidate, files, fileRejections } of staged) {
    const verified = files.filter((file) => {
      const entry = tracked.get(file);
      if (entry && /^100(644|755) blob$/.test(entry)) return true;
      fileRejections.push({ path: file, reason: entry ? `not a regular file at baseSha (${entry})` : "not a tracked regular file at baseSha" });
      return false;
    });
    if (!verified.length) {
      rejected.push({ slug: candidate.slug, reasons: ["no verified tracked files at baseSha", ...fileRejections.map(({ path, reason }) => `${path}: ${reason}`)] });
      continue;
    }
    valid.push({ ...candidate, files: verified, ...(fileRejections.length ? { rejectedFiles: fileRejections } : {}) });
  }
  return { valid, rejected };
}

/** d1 pre-screen that fails open: only a complete, valid score set can filter a candidate. */
async function screenWithD1(ctx: WorkflowContext, d1: D1, cfg: Config, baseline: Baseline, candidates: ValidCandidate[]): Promise<ScoredCandidate[]> {
  const deadline = cfg.d1BudgetMs ? Date.now() + cfg.d1BudgetMs : Infinity;
  return inWaves(ctx, candidates, cfg.d1Concurrency, async (candidate): Promise<ScoredCandidate> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      ctx.log.warn({ event: "revenue-hill-climber.d1_budget_spent", slug: candidate.slug });
      return candidate;
    }
    const state = JSON.stringify({ liveUrl: ctx.storefront.liveUrl, baseline: snapshotOf(baseline.byPage[candidate.targetPages[0]] ?? baseline.devices), candidate });
    if (cfg.d1MaxStateChars && state.length > cfg.d1MaxStateChars) return candidate;
    const timeoutMs = Number.isFinite(deadline) ? Math.min(cfg.d1TimeoutMs || remaining, remaining) : cfg.d1TimeoutMs || undefined;
    try {
      const result = await d1.score({ state, questions: { ...D1_QUESTIONS }, timeoutMs });
      if (!result.ok) {
        ctx.log.warn({ event: "revenue-hill-climber.d1_failed", slug: candidate.slug, reason: result.reason });
        return candidate;
      }
      const values = D1_KEYS.map((key) => result.scores[key]);
      if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) {
        ctx.log.warn({ event: "revenue-hill-climber.d1_partial", slug: candidate.slug, keys: Object.keys(result.scores) });
        return candidate;
      }
      const scores = Object.fromEntries(D1_KEYS.map((key, index) => [key, values[index]])) as Record<D1Key, number>;
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return { ...candidate, d1: { scores, mean, meetsThreshold: mean >= cfg.d1MinScore } };
    } catch (error) {
      if (isAborted(ctx)) throw error;
      ctx.log.warn({ event: "revenue-hill-climber.d1_error", slug: candidate.slug, err: error });
      return candidate;
    }
  });
}

function buildIssueBody(args: {
  winner: ScoredCandidate;
  critique: CritiqueResult;
  baseline: Baseline;
  winnerBaseline: CompactDevices;
  criteria: string[];
  meta: Record<string, unknown>;
}): string {
  const { winner, critique, baseline, winnerBaseline, criteria, meta } = args;
  const pages = winner.targetPages;
  const pageBaselines = pages.length > 1
    ? pages.flatMap((page) => baseline.byPage[page] ? [`#### ${code(page)}\n\n${baselineTable(baseline.byPage[page])}`] : [])
    : [];
  const insights = insightLines(winnerBaseline, winner.lighthouseInsights);
  const sections = [
    `> **CRO experiment** · kind: ${code(winner.kind)} · pages: ${pages.map(code).join(", ")}${baseline.liveUrl ? ` · live: <${encodeURI(baseline.liveUrl)}>` : ""}`,
    `## Hypothesis\n\n${winner.hypothesis.trim()}\n\n**Expected impact:** ${winner.expectedImpact.trim()}`,
    critique.sharpenedBody?.trim() ? `## Brief\n\n${critique.sharpenedBody.trim()}` : "",
    `## Live baseline (Lighthouse 13, measured ${baseline.measuredAt})\n\n${baselineTable(winnerBaseline)}${pages.length > 1 ? "\n\n_Averaged across the target pages._" : ""}${pageBaselines.length ? `\n\n${pageBaselines.join("\n\n")}` : ""}`,
    `## Culprits\n\n**Targeted insight ids:** ${winner.lighthouseInsights.length ? winner.lighthouseInsights.map(code).join(", ") : "_none (UX/agentic experiment)_"}\n\n${insights.length ? `${insights.join("\n")}\n\n` : ""}**Evidence (runtime diagnostics + source):**\n\n${winner.evidence.trim()}`,
    `## Target files\n\nVerified as tracked regular files at ${code(String(meta.baseSha))}:\n\n${winner.files.map((file) => `- ${code(file)}`).join("\n")}${winner.rejectedFiles?.length ? `\n\n> Ignored (unverifiable): ${winner.rejectedFiles.map(({ path, reason }) => `${code(path)} (${cell(reason)})`).join(", ")}` : ""}`,
    `## Implementation plan\n\n${winner.implementationPlan.trim()}`,
    `## Acceptance criteria\n\n${criteria.map((entry) => `- [ ] ${entry}`).join("\n")}`,
    `## Risks\n\n${winner.risks.trim()}`,
    `## Why this one\n\n${critique.reason.trim()}${winner.d1 ? `\n\nd1 pre-screen: ${D1_KEYS.map((key) => `${key} ${winner.d1!.scores[key].toFixed(2)}`).join(" · ")} (mean ${winner.d1.mean.toFixed(2)})` : ""}`,
    encodeMarker(meta),
  ];
  return sections.filter(Boolean).join("\n\n");
}

function recordLedger(ctx: WorkflowContext, cfg: Config, entry: LedgerEntry) {
  ctx.state.update<LedgerEntry[]>("experiments", (current = []) => {
    const next = [entry, ...current.filter(({ slug, issueKey }) => slug !== entry.slug && issueKey !== entry.issueKey)];
    return cfg.maxLedgerEntries ? next.slice(0, cfg.maxLedgerEntries) : next;
  });
}

/**
 * Publish a persisted intent exactly once: live admission check (unless our own issue already exists),
 * create via the idempotent fingerprinted effect, record the ledger immediately, then clear the intent.
 */
async function publishIntent(ctx: WorkflowContext, cfg: Config, intent: PublicationIntent, resumed: boolean) {
  const recorded = (ctx.state.get<LedgerEntry[]>("experiments") ?? []).find(({ issueKey }) => issueKey === intent.issueKey);
  if (recorded?.issueNumber || recorded?.dryRun) {
    ctx.state.delete("publicationIntent");
    return { status: "existing", resumed, slug: intent.slug, issue: { number: recorded.issueNumber ?? 0, created: false, ...(recorded.dryRun ? { dryRun: true } : {}) } };
  }

  const fingerprint = `<!-- scrat-fingerprint:workflow:${ctx.workflow.name}:${intent.issueKey} -->`;
  const croLabel = cfg.croLabel.toLowerCase();
  const marker = `<!-- ${MARKER}:`;
  const { issues, pullRequests } = await ctx.github.listOpenItems();
  const ownIssue = issues.find((issue) => (issue.body ?? "").trimEnd().endsWith(fingerprint));
  if (!ownIssue && cfg.maxOpenExperiments > 0) {
    const isExperiment = (item: OpenItem) => item.labels.some((label) => labelOf(label).toLowerCase() === croLabel) || (item.body ?? "").includes(marker);
    const openCount = issues.filter(isExperiment).length + pullRequests.filter(isExperiment).length;
    if (openCount >= cfg.maxOpenExperiments) {
      ctx.state.delete("publicationIntent");
      ctx.log.info({ event: "revenue-hill-climber.admission_denied", slug: intent.slug, openCount });
      return { status: "admission_denied", resumed, slug: intent.slug, reason: `${openCount} open ${cfg.croLabel} item(s) appeared before publication (maxOpenExperiments: ${cfg.maxOpenExperiments}).` };
    }
  }

  const issue = await ctx.github.issue({ key: intent.issueKey, title: intent.title, body: intent.body, labels: intent.labels });
  recordLedger(ctx, cfg, {
    slug: intent.slug,
    title: intent.title,
    kind: intent.kind,
    targetPages: intent.targetPages,
    lighthouseInsights: intent.lighthouseInsights,
    files: intent.files,
    issueKey: intent.issueKey,
    ...(issue.number ? { issueNumber: issue.number } : {}),
    ...(issue.dryRun ? { dryRun: true } : {}),
    proposedAt: intent.createdAt,
    baseline: intent.baseline,
  });
  ctx.state.delete("publicationIntent");
  return {
    status: issue.dryRun ? "dry_run" : issue.created ? "opened" : "existing",
    resumed,
    slug: intent.slug,
    kind: intent.kind,
    title: intent.title,
    labels: intent.labels,
    issue,
  };
}

export default async function revenueHillClimber(ctx: WorkflowContext) {
  const cfg = readConfig(ctx);
  const workflowName = ctx.workflow.name;

  if (!ctx.storefront.enabled) {
    ctx.log.info({ event: "revenue-hill-climber.skipped", reason: "storefront_disabled" });
    return { status: "skipped", reason: "Storefront is not enabled for this deployment (storefront.enabled)." };
  }

  // A crash or retry after the intent was persisted resumes publication instead of hunting again.
  const pending = ctx.state.get<PublicationIntent>("publicationIntent");
  if (pending) return publishIntent(ctx, cfg, pending, true);

  // Idempotency keys must fit 128 chars including the `workflow:<name>:` prefix.
  const slugMax = Math.max(2, 128 - `workflow:${workflowName}:`.length - ISSUE_KEY_PREFIX.length);

  // 1. Early guard (checkpointed). Publication re-checks admission live right before creating the issue.
  const markerText = `<!-- ${MARKER}:`;
  const croLabel = cfg.croLabel.toLowerCase();
  const guard = await ctx.step("check_open_experiments", { croLabel: cfg.croLabel, maxOpenExperiments: cfg.maxOpenExperiments }, async () => {
    const { issues, pullRequests } = await ctx.github.listOpenItems();
    const isExperiment = (item: OpenItem) => item.labels.some((label) => labelOf(label).toLowerCase() === croLabel) || (item.body ?? "").includes(markerText);
    const openIssues = issues.filter(isExperiment).map(({ number, title }) => ({ number, title }));
    const openPrs = pullRequests.filter(isExperiment).map(({ number, title }) => ({ number, title }));
    return { openIssues, openPrs, openCount: openIssues.length + openPrs.length };
  });
  if (cfg.maxOpenExperiments > 0 && guard.openCount >= cfg.maxOpenExperiments) {
    ctx.log.info({ event: "revenue-hill-climber.skipped", reason: "open_experiments", openCount: guard.openCount, maxOpenExperiments: cfg.maxOpenExperiments });
    return {
      status: "skipped",
      reason: `${guard.openCount} open ${cfg.croLabel} item(s) already in flight (maxOpenExperiments: ${cfg.maxOpenExperiments}).`,
      openIssues: guard.openIssues,
      openPrs: guard.openPrs,
    };
  }

  // 2. Live Lighthouse 13 baseline.
  const lighthouseOptions = {
    pages: cfg.targetPages,
    runs: cfg.lighthouseRuns,
    devices: [...DEVICES],
    timeoutSeconds: cfg.lighthouseTimeoutSeconds,
    includeAgenticBrowsing: true,
  };
  const measured = await ctx.step("measure_baseline", { lighthouseOptions, maxInsightItems: cfg.maxInsightItems, maxInsightItemChars: cfg.maxInsightItemChars }, async () => {
    const [siteMap, summary] = await Promise.all([
      ctx.storefront.siteMap().catch((error: unknown) => {
        if (isAborted(ctx)) throw error;
        ctx.log.warn({ event: "revenue-hill-climber.sitemap_failed", err: error });
        return undefined;
      }),
      ctx.storefront.lighthouse(lighthouseOptions),
    ]);
    const baseline: Baseline = {
      measuredAt: new Date().toISOString(),
      liveUrl: ctx.storefront.liveUrl,
      pages: cfg.targetPages,
      devices: compactDevices(summary.devices, cfg.maxInsightItems, cfg.maxInsightItemChars),
      byPage: Object.fromEntries(Object.entries(summary.pages).map(([page, devices]) => [page, compactDevices(devices, cfg.maxInsightItems, cfg.maxInsightItemChars)])),
      errors: summary.errors,
    };
    return { siteMap: siteMap ?? null, baseline };
  });
  const { baseline, siteMap } = measured;
  if (!DEVICES.some((device) => baseline.devices[device]?.scored) && cfg.requireBaseline) {
    ctx.log.warn({ event: "revenue-hill-climber.baseline_failed", errors: baseline.errors });
    return { status: "baseline_failed", reason: "No device produced a scored Lighthouse run.", errors: baseline.errors };
  }

  const ledger = ctx.state.get<LedgerEntry[]>("experiments") ?? [];
  const ledgerSlugs = new Set(ledger.map(({ slug }) => slug));

  const outcome = await ctx.workspace.withCheckout(ctx.workspace.baseBranch, async (ws) => {
    // 3. CRO & deletion hunt. All Lighthouse evidence is inline; report files are outside the agent's read roots.
    const huntInput = {
      baseSha: ws.baseSha,
      liveUrl: ctx.storefront.liveUrl,
      publicHost: ctx.storefront.publicHost,
      targetPages: cfg.targetPages,
      siteMap,
      baseline,
      experimentLedger: ledger,
      openExperiments: { issues: guard.openIssues, pullRequests: guard.openPrs },
      rules: {
        minCandidates: cfg.minCandidates,
        maxCandidates: cfg.maxCandidates || null,
        requireDeletionCandidate: cfg.requireDeletionCandidate,
        browserSteps: cfg.browserSteps,
        browserSeconds: cfg.browserSeconds,
        viewports: { mobile: "390x844", desktop: "1280x800" },
      },
    };
    const huntRun = await ctx.step("hunt_candidates", huntInput, async () => {
      const res = await ctx.agent.run<HuntResult>({
        cwd: ws.path,
        skill: "HUNT.md",
        tools: ["read", "grep", "find", "ls", "git", "browser"],
        input: huntInput,
        submitResult: { schema: huntSchema(cfg, slugMax), description: "Submit the verified CRO / performance / deletion experiment candidates." },
      });
      const status = res.outcome === "complete" ? res.data?.status ?? res.outcome : res.outcome;
      if (status !== "complete" || !res.data) throw new Error(`Hunt agent did not complete (outcome: ${status})`);
      return { text: res.text, data: res.data };
    });
    const notes = huntRun.data.notes ?? huntRun.text;

    const { valid, rejected } = await validateCandidates(ctx, cfg, ws.path, ws.baseSha, slugMax, huntRun.data.candidates, ledgerSlugs);
    if (rejected.length) ctx.log.info({ event: "revenue-hill-climber.candidates_rejected", rejected });
    if (valid.length < cfg.minCandidates) {
      return { status: "insufficient_candidates", found: valid.length, minCandidates: cfg.minCandidates, rejected, notes };
    }
    if (cfg.requireDeletionCandidate && !valid.some(({ kind }) => kind === "deletion")) {
      return { status: "missing_deletion_candidate", found: valid.map(({ slug, kind }) => ({ slug, kind })), rejected, notes };
    }

    // 4a. d1 pre-screen, checkpointed on its own so a critic retry never re-scores.
    const d1 = ctx.d1.enabled ? ctx.d1 : undefined;
    const screened = await ctx.step("screen_candidates", {
      baseSha: ws.baseSha, candidates: valid, d1Enabled: !!d1, d1MinScore: cfg.d1MinScore, d1TimeoutMs: cfg.d1TimeoutMs, d1BudgetMs: cfg.d1BudgetMs, d1MaxStateChars: cfg.d1MaxStateChars, d1Concurrency: cfg.d1Concurrency,
    }, async () => {
      const scored: ScoredCandidate[] = d1 ? await screenWithD1(ctx, d1, cfg, baseline, valid) : valid;
      const shortlist = scored.filter((candidate) => !candidate.d1 || candidate.d1.meetsThreshold)
        .sort((a, b) => (b.d1?.mean ?? -1) - (a.d1?.mean ?? -1));
      const screenedOut = scored.flatMap((candidate) => candidate.d1 && !candidate.d1.meetsThreshold ? [{ slug: candidate.slug, mean: candidate.d1.mean }] : []);
      return { shortlist, screenedOut };
    });
    const { shortlist, screenedOut } = screened;
    if (!shortlist.length) return { status: "screened_out", reason: `No candidate met d1MinScore ${cfg.d1MinScore}.`, screenedOut, rejected };

    // 4b. Adversarial critique.
    const critiqueInput = {
      baseSha: ws.baseSha,
      liveUrl: ctx.storefront.liveUrl,
      targetPages: cfg.targetPages,
      baseline,
      candidates: shortlist,
      screenedOut,
      rejected,
      experimentLedger: ledger,
      openExperiments: { issues: guard.openIssues, pullRequests: guard.openPrs },
      mandatoryAcceptanceCriteria: cfg.mandatoryAcceptanceCriteria,
      browserSteps: cfg.browserSteps,
      browserSeconds: cfg.browserSeconds,
    };
    const critique = await ctx.step("select_winner", { critiqueInput, critique: cfg.critique }, async () => {
      const res = await ctx.agent.run<CritiqueResult>({
        cwd: ws.path,
        skill: "CRITIQUE.md",
        ...cfg.critique,
        input: critiqueInput,
        submitResult: { schema: critiqueSchema(shortlist.map(({ slug }) => slug)), description: "Submit the adversarial CRO verdict: approve at most one surgical, reversible winner." },
      });
      const status = res.outcome === "complete" ? res.data?.status ?? res.outcome : res.outcome;
      if (status !== "complete" || !res.data) throw new Error(`Critique agent did not complete (outcome: ${status})`);
      return res.data;
    });

    const winner = critique.approved ? shortlist.find(({ slug }) => slug === critique.winnerSlug) : undefined;
    if (!winner) return { status: "critique_rejected", reason: critique.reason, candidates: shortlist.map(({ slug, kind }) => ({ slug, kind })) };
    // Defence in depth: the winner must still satisfy the publication invariants.
    const measuredPages = new Set(cfg.targetPages);
    if (!winner.files.length || !winner.targetPages.length || winner.targetPages.some((page) => !measuredPages.has(page) || pageProblem(page))) {
      return { status: "winner_invalid", slug: winner.slug, reason: "Winner lacks verified files or a valid subset of measured pages." };
    }
    if (ledgerSlugs.has(winner.slug)) return { status: "already_in_ledger", slug: winner.slug };

    // 5. Render the experiment (checkpointed).
    const draft = await ctx.step("publish_experiment", {
      baseSha: ws.baseSha, winner, critique, measuredAt: baseline.measuredAt, croLabel: cfg.croLabel, autoImplement: cfg.autoImplement, botSlug: ctx.bot.slug, mandatoryAcceptanceCriteria: cfg.mandatoryAcceptanceCriteria,
    }, async () => {
      const title = oneLine(critique.sharpenedTitle?.trim() || winner.title);
      const criteria = [...new Set([
        ...(critique.acceptanceCriteria?.length ? critique.acceptanceCriteria : winner.acceptanceCriteria).map(oneLine).filter(Boolean),
        ...cfg.mandatoryAcceptanceCriteria,
      ])];
      const winnerBaseline = winner.targetPages.length === 1 && baseline.byPage[winner.targetPages[0]] ? baseline.byPage[winner.targetPages[0]] : baseline.devices;
      const snapshot = snapshotOf(winnerBaseline);
      const meta = {
        version: 1,
        slug: winner.slug,
        kind: winner.kind,
        targetPages: winner.targetPages,
        lighthouseInsights: winner.lighthouseInsights,
        baseSha: ws.baseSha,
        measuredAt: baseline.measuredAt,
        baseline: snapshot,
      };
      const body = buildIssueBody({ winner, critique, baseline, winnerBaseline, criteria, meta });
      const labels = [cfg.croLabel, ...(cfg.autoImplement && ctx.bot.slug && ctx.bot.slug.toLowerCase() !== croLabel ? [ctx.bot.slug] : [])];
      return { title, body, labels, snapshot };
    });

    return {
      status: "ready" as const,
      intent: {
        issueKey: `${ISSUE_KEY_PREFIX}${winner.slug}`,
        slug: winner.slug,
        kind: winner.kind,
        title: draft.title,
        body: draft.body,
        labels: draft.labels,
        targetPages: winner.targetPages,
        lighthouseInsights: winner.lighthouseInsights,
        files: winner.files,
        baseline: draft.snapshot,
        createdAt: new Date().toISOString(),
      } satisfies PublicationIntent,
      candidates: shortlist.map(({ slug, kind, d1: score }) => ({ slug, kind, d1: score?.mean })),
      rejected,
    };
  });

  const ready = "intent" in outcome ? outcome.intent : undefined;
  if (!ready) return outcome;
  // Persist one immutable intent before any create. If another run already persisted one, publish that instead.
  const intent = ctx.state.update<PublicationIntent>("publicationIntent", (current) => current ?? ready);
  const published = await publishIntent(ctx, cfg, intent, intent.issueKey !== ready.issueKey);
  return { ...published, candidates: outcome.candidates, rejected: outcome.rejected };
}
