import type { WorkflowContext } from "scrat";

type Device = "mobile" | "desktop";
type Summary = Awaited<ReturnType<WorkflowContext["storefront"]["lighthouse"]>>;
type Comparison = ReturnType<WorkflowContext["storefront"]["compareLighthouse"]>;
type DeviceComparison = NonNullable<Comparison["devices"][Device]>;
type Group = NonNullable<Summary["devices"][Device]>;
type Insight = Group["topInsights"][number];
type ScoreKey = keyof NonNullable<Group["scores"]>;
type MetricKey = keyof NonNullable<Group["metrics"]>;
type Delta = { before: number; after: number; delta: number };
type Label = string | { name?: string | null };
type PullRequest = Awaited<ReturnType<WorkflowContext["github"]["getPr"]>>;

type InsightSide = { score: number | null; displayValue?: string; savingsMs: number; savingsCls: number; items: number };
/**
 * resolved: preview explicitly scores it >= insightPassScore.
 * not_reported: flagged live, absent from the preview's capped topInsights (not a confirmed pass).
 */
type InsightStatus = "resolved" | "not_reported" | "improved" | "regressed" | "new" | "unchanged";
type InsightDelta = { page: string; id: string; title: string; status: InsightStatus; before?: InsightSide; after?: InsightSide };
type AgenticSide = { passed: number; total: number };
type AgenticDelta = {
  pages: number;
  before?: AgenticSide;
  after?: AgenticSide;
  comparable: boolean;
  fixed: Array<{ id: string; title: string }>;
  newlyFailed: Array<{ id: string; title: string }>;
};
type DeviceReport = { matchedPages: string[]; unmatchedPages: string[]; insights: InsightDelta[]; agentic: AgenticDelta };
type Report = { devices: Partial<Record<Device, DeviceReport>>; matchedPairs: number; matchedPages: string[] };

type ExperimentMeta = {
  version: 1;
  slug: string;
  kind?: string;
  targetPages: string[];
  lighthouseInsights: string[];
  baseline?: Partial<Record<Device, { scores?: Partial<Record<ScoreKey, number>>; metrics?: Partial<Record<MetricKey, number>> }>>;
};
type ScoredHead = {
  scoredAt: string;
  commentKey: string;
  commentId?: number;
  slug?: string;
  /** Slack is tracked separately so a Slack failure never re-runs Lighthouse or loses the comment receipt. */
  slack?: { key: string; channel: string; text: string; posted: boolean; ts?: string };
};
type ReviewEvent = { outcome: string; publication: string; grade?: string; headSha?: string };
type Identity =
  | { ok: true; pr: PullRequest; headSha: string; themeId: number }
  | { ok: false; kind: "closed" | "pending" | "stale_review"; reason: string; problems: string[]; headSha?: string };

const DEVICES: readonly Device[] = ["mobile", "desktop"];
const KINDS = new Set(["deletion", "performance", "ux_conversion", "agentic"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const MARKER_RE = /<!--\s*scrat-cro-experiment:\s*([\s\S]*?)\s*-->/g;
const CLOSING_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+#(\d+)\b/gi;
const PREVIEW_CONTROL_PARAMS = new Set(["preview_theme_id", "preview_key", "_ab", "_fd", "_sc"]);
const SCORE_ROWS: ReadonlyArray<readonly [ScoreKey, string]> = [
  ["performance", "Performance"],
  ["accessibility", "Accessibility"],
  ["best-practices", "Best Practices"],
  ["seo", "SEO"],
];
const METRIC_ROWS: ReadonlyArray<readonly [MetricKey, string, string, number]> = [
  ["largest-contentful-paint", "LCP", "s", 2],
  ["cumulative-layout-shift", "CLS", "", 3],
  ["total-blocking-time", "TBT", "ms", 0],
  ["first-contentful-paint", "FCP", "s", 2],
  ["speed-index", "Speed Index", "s", 2],
];
const STATUS_LABEL: Record<InsightStatus, string> = {
  resolved: "✅ **resolved**",
  not_reported: "❔ **not reported in preview**",
  improved: "🟢 **improved**",
  regressed: "🔴 **regressed**",
  new: "🆕 **new**",
  unchanged: "⚪ **unchanged**",
};

const labelOf = (label: Label) => typeof label === "string" ? label : (label.name ?? "");
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const titleCase = (device: Device) => device[0].toUpperCase() + device.slice(1);
const errorStatus = (error: unknown) => error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

// ---------- context-safe escaping ----------
/** Markdown table cell / inline text: single line, backslashes and pipes escaped. */
const cell = (text: string) => oneLine(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
/** Inline code span that survives backticks in the value. */
function code(value: string): string {
  const clean = oneLine(value);
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = longest || clean.startsWith("`") || clean.endsWith("`") ? " " : "";
  return `${fence}${pad}${clean}${pad}${fence}`;
}
/** Markdown link with escaped label and a URL that can't break out of `(...)`. */
const mdLink = (label: string, url: string) =>
  `[${oneLine(label).replace(/[\\[\]]/g, "\\$&")}](${url.replace(/[()<>\s]/g, (char) => encodeURIComponent(char))})`;
/** Slack mrkdwn text escaping. */
const slackText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Slack link: URL may not contain | < > raw; label is escaped and loses pipes. */
const slackLink = (url: string, label: string) =>
  `<${url.replace(/\|/g, "%7C").replace(/</g, "%3C").replace(/>/g, "%3E")}|${slackText(oneLine(label)).replace(/\|/g, "¦")}>`;

// ---------- pages & URLs ----------
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
  if (`${url.pathname}${url.search}` !== page) return "is not canonical";
  const control = [...url.searchParams.keys()].find((key) => PREVIEW_CONTROL_PARAMS.has(key.toLowerCase()));
  return control ? `must not carry the Shopify preview control ${control}` : undefined;
}

/** Live and Preview links built from the same canonical page URL; Preview explicitly sets preview_theme_id. */
function pageLinks(liveOrigin: string, page: string, themeId: number) {
  const live = new URL(page, liveOrigin);
  const preview = new URL(live.href);
  preview.searchParams.set("preview_theme_id", String(themeId));
  return { live: live.href, preview: preview.href };
}

// ---------- metadata & references ----------
function validateMeta(raw: unknown): { meta: ExperimentMeta } | { problem: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: "marker is not a JSON object" };
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return { problem: "marker version must be 1" };
  if (typeof record.slug !== "string" || !SLUG_RE.test(record.slug) || record.slug.length < 2 || record.slug.length > 128) return { problem: "marker slug is invalid" };
  if (!Array.isArray(record.targetPages) || !record.targetPages.length) return { problem: "marker targetPages must be a non-empty array" };
  for (const page of record.targetPages) {
    const problem = pageProblem(page);
    if (problem) return { problem: `marker targetPage ${JSON.stringify(page)} ${problem}` };
  }
  if (new Set(record.targetPages).size !== record.targetPages.length) return { problem: "marker targetPages contains duplicates" };
  if (record.kind !== undefined && (typeof record.kind !== "string" || !KINDS.has(record.kind))) return { problem: "marker kind is invalid" };
  if (record.lighthouseInsights !== undefined && (!Array.isArray(record.lighthouseInsights) || record.lighthouseInsights.some((id) => typeof id !== "string"))) {
    return { problem: "marker lighthouseInsights must be a string array" };
  }
  const baseline = record.baseline && typeof record.baseline === "object" && !Array.isArray(record.baseline) ? record.baseline as ExperimentMeta["baseline"] : undefined;
  return {
    meta: {
      version: 1,
      slug: record.slug,
      ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
      targetPages: record.targetPages as string[],
      lighthouseInsights: (record.lighthouseInsights as string[] | undefined) ?? [],
      ...(baseline ? { baseline } : {}),
    },
  };
}

/** Parses the single experiment marker. Several markers in one body is ambiguous and rejected. */
function parseMeta(body: string | null | undefined): { meta?: ExperimentMeta; problem?: string } {
  const matches = [...(body ?? "").matchAll(MARKER_RE)];
  if (!matches.length) return {};
  if (matches.length > 1) return { problem: "multiple scrat-cro-experiment markers" };
  try {
    const result = validateMeta(JSON.parse(matches[0][1]));
    return "meta" in result ? { meta: result.meta } : { problem: result.problem };
  } catch {
    return { problem: "marker is not valid JSON" };
  }
}

/** Closing references in prose only: fenced code, inline code, blockquotes and HTML comments are ignored. */
function closingRefs(body: string | null | undefined, self: number): number[] {
  const prose: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of (body ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, " ").split("\n")) {
    const opener = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (opener && opener[1][0] === fence.char && opener[1].length >= fence.length && !line.slice(opener[0].length).trim()) fence = undefined;
      continue;
    }
    if (opener) {
      fence = { char: opener[1][0], length: opener[1].length };
      continue;
    }
    if (/^ {0,3}>/.test(line)) continue;
    prose.push(line.replace(/(`+)[\s\S]*?\1/g, " "));
  }
  return [...new Set([...prose.join("\n").matchAll(CLOSING_RE)].map(([, number]) => Number(number)))].filter((number) => number > 0 && number !== self);
}

// ---------- comparison over matched (page, device) pairs ----------
function insightSide(insight: Insight): InsightSide {
  const savings = Object.entries(insight.metricSavings ?? {}).filter(([, value]) => Number.isFinite(value) && value > 0);
  return {
    score: insight.score,
    ...(insight.displayValue ? { displayValue: insight.displayValue } : {}),
    // Per-metric savings overlap (FCP and LCP often share a culprit), so report the largest, not the sum.
    savingsMs: Math.max(0, ...savings.filter(([metric]) => metric !== "CLS").map(([, value]) => value)),
    savingsCls: Math.max(0, ...savings.filter(([metric]) => metric === "CLS").map(([, value]) => value)),
    items: Array.isArray(insight.items) ? insight.items.length : 0,
  };
}

function insightStatus(before: InsightSide | undefined, after: InsightSide | undefined, pass: number): InsightStatus | undefined {
  const failing = (side: InsightSide) => side.score === null || side.score < pass;
  if (!before) return after && failing(after) ? "new" : undefined;
  if (!after) return failing(before) ? "not_reported" : undefined;
  if (failing(before) && !failing(after)) return "resolved";
  const scoreDelta = (after.score ?? 0) - (before.score ?? 0);
  if (scoreDelta) return scoreDelta > 0 ? "improved" : "regressed";
  const savingsDelta = Math.round(after.savingsMs) - Math.round(before.savingsMs) || Math.round((after.savingsCls - before.savingsCls) * 1000);
  if (savingsDelta) return savingsDelta < 0 ? "improved" : "regressed";
  if (after.items !== before.items) return after.items < before.items ? "improved" : "regressed";
  return "unchanged";
}

function buildReport(live: Summary, preview: Summary, comparison: Comparison, pass: number): Report {
  const devices: Report["devices"] = {};
  let matchedPairs = 0;
  const matchedPages = new Set<string>();
  for (const device of DEVICES) {
    const compared = comparison.devices[device];
    if (!compared) continue;
    const insights: InsightDelta[] = [];
    let agenticPages = 0;
    let comparable = true;
    const before: AgenticSide = { passed: 0, total: 0 };
    const after: AgenticSide = { passed: 0, total: 0 };
    const fixed = new Map<string, { id: string; title: string }>();
    const newlyFailed = new Map<string, { id: string; title: string }>();
    for (const page of compared.matchedPages) {
      const from = live.pages[page]?.[device];
      const to = preview.pages[page]?.[device];
      if (!from?.scores || !to?.scores) continue;
      matchedPairs++;
      matchedPages.add(page);
      const fromInsights = new Map(from.topInsights.map((insight) => [insight.id, insight]));
      const toInsights = new Map(to.topInsights.map((insight) => [insight.id, insight]));
      for (const id of new Set([...fromInsights.keys(), ...toInsights.keys()])) {
        const b = fromInsights.get(id);
        const a = toInsights.get(id);
        const status = insightStatus(b && insightSide(b), a && insightSide(a), pass);
        if (status) insights.push({ page, id, title: (a ?? b)!.title, status, ...(b ? { before: insightSide(b) } : {}), ...(a ? { after: insightSide(a) } : {}) });
      }
      // Agentic: only pages where both sides ran the checks; fixes are claimed only when coverage matches.
      const fromAgentic = from.agenticBrowsing;
      const toAgentic = to.agenticBrowsing;
      if (fromAgentic && toAgentic) {
        agenticPages++;
        before.passed += fromAgentic.passed;
        before.total += fromAgentic.total;
        after.passed += toAgentic.passed;
        after.total += toAgentic.total;
        if (fromAgentic.total === toAgentic.total) {
          const failedAfter = new Set(toAgentic.failed.map(({ id }) => id));
          const failedBefore = new Set(fromAgentic.failed.map(({ id }) => id));
          for (const entry of fromAgentic.failed) if (!failedAfter.has(entry.id)) fixed.set(entry.id, { id: entry.id, title: entry.title });
          for (const entry of toAgentic.failed) if (!failedBefore.has(entry.id)) newlyFailed.set(entry.id, { id: entry.id, title: entry.title });
        } else {
          comparable = false;
        }
      }
    }
    const order: Record<InsightStatus, number> = { resolved: 0, improved: 1, not_reported: 2, new: 3, regressed: 4, unchanged: 5 };
    insights.sort((x, y) => order[x.status] - order[y.status] || (y.before?.savingsMs ?? 0) - (x.before?.savingsMs ?? 0) || x.page.localeCompare(y.page));
    devices[device] = {
      matchedPages: compared.matchedPages,
      unmatchedPages: compared.unmatchedPages,
      insights,
      agentic: {
        pages: agenticPages,
        ...(agenticPages ? { before, after } : {}),
        comparable: agenticPages > 0 && comparable && before.total === after.total,
        fixed: [...fixed.values()],
        newlyFailed: [...newlyFailed.values()],
      },
    };
  }
  return { devices, matchedPairs, matchedPages: [...matchedPages] };
}

// ---------- rendering ----------
function fmtValue(value: number | undefined, digits: number, unit: string) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
}

function fmtDelta(d: Delta | undefined, digits: number, unit: string, higherIsBetter: boolean) {
  if (!d || !Number.isFinite(d.delta)) return "—";
  const rounded = Number(d.delta.toFixed(digits));
  const suffix = unit ? ` ${unit}` : "";
  if (!rounded) return `⚪ ±0${suffix}`;
  const good = higherIsBetter ? rounded > 0 : rounded < 0;
  return `${good ? "🟢" : "🔴"} ${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(digits)}${suffix}`;
}

const ratio = (side?: AgenticSide) => side ? `${side.passed}/${side.total}` : "—";

function agenticDeltaCell(agentic: AgenticDelta | undefined) {
  if (!agentic?.before || !agentic.after) return "—";
  if (!agentic.comparable) return `≠ coverage (${agentic.before.total} vs ${agentic.after.total} checks)`;
  return fmtDelta({ before: agentic.before.passed, after: agentic.after.passed, delta: agentic.after.passed - agentic.before.passed }, 0, "", true);
}

function scorecardTable(comparison: Comparison, report: Report): string {
  const devices = DEVICES.filter((device) => comparison.devices[device]?.matchedPages.length);
  if (!devices.length) return "_No (page, device) pair scored on both Live and Preview._";
  const header = `| Metric | ${devices.map((device) => `${titleCase(device)} Live | ${titleCase(device)} Preview | Δ`).join(" | ")} |`;
  const divider = `| --- | ${devices.map(() => "---: | ---: | ---:").join(" | ")} |`;
  const rows = [
    ...SCORE_ROWS.map(([key, label]) => `| ${label} | ${devices.map((device) => {
      const d = comparison.devices[device]!.scores?.[key];
      return `${fmtValue(d?.before, 0, "")} | ${fmtValue(d?.after, 0, "")} | ${fmtDelta(d, 0, "", true)}`;
    }).join(" | ")} |`),
    ...METRIC_ROWS.map(([key, label, unit, digits]) => `| ${label} | ${devices.map((device) => {
      const d = comparison.devices[device]!.metrics?.[key];
      return `${fmtValue(d?.before, digits, unit)} | ${fmtValue(d?.after, digits, unit)} | ${fmtDelta(d, digits, unit, false)}`;
    }).join(" | ")} |`),
    `| Agentic Browsing | ${devices.map((device) => {
      const agentic = report.devices[device]?.agentic;
      return `${ratio(agentic?.before)} | ${ratio(agentic?.after)} | ${agenticDeltaCell(agentic)}`;
    }).join(" | ")} |`,
  ];
  return [header, divider, ...rows].join("\n");
}

function coverageLines(report: Report): string[] {
  return DEVICES.flatMap((device) => {
    const d = report.devices[device];
    if (!d) return [];
    const total = d.matchedPages.length + d.unmatchedPages.length;
    const missing = d.unmatchedPages.length ? ` · not comparable: ${d.unmatchedPages.map(code).join(", ")}` : "";
    return [`- **${titleCase(device)}:** ${d.matchedPages.length}/${total} page(s) scored on both sides${missing}`];
  });
}

function insightSection(report: Report, maxRows: number, targeted: Set<string>, multiPage: boolean): string {
  const blocks = DEVICES.flatMap((device) => {
    const insights = report.devices[device]?.insights ?? [];
    if (!insights.length) return [];
    const rows = maxRows ? insights.slice(0, maxRows) : insights;
    const side = (value?: InsightSide) => {
      if (!value) return "not reported";
      const parts = [
        value.score === null ? "" : `score ${value.score.toFixed(2)}`,
        value.savingsMs ? `${Math.round(value.savingsMs)} ms savings` : "",
        value.savingsCls ? `CLS ${value.savingsCls.toFixed(3)} savings` : "",
        value.items ? `${value.items} culprit${value.items === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      return parts.length ? parts.join(", ") : (value.displayValue ? cell(value.displayValue) : "flagged");
    };
    const lines = rows.map((insight) =>
      `- ${STATUS_LABEL[insight.status]} ${code(insight.id)}${targeted.has(insight.id) ? " 🎯" : ""}${multiPage ? ` on ${code(insight.page)}` : ""} — ${cell(insight.title)} · live: ${side(insight.before)} → preview: ${side(insight.after)}`);
    const more = rows.length < insights.length ? `\n- …${insights.length - rows.length} more` : "";
    return [`**${titleCase(device)}**\n\n${lines.join("\n")}${more}`];
  });
  return blocks.length ? blocks.join("\n\n") : "_No Lighthouse insights flagged on the compared pages._";
}

function agenticSection(report: Report): string {
  const lines = DEVICES.flatMap((device) => {
    const d = report.devices[device];
    if (!d) return [];
    const agentic = d.agentic;
    if (!agentic.pages) return [`- **${titleCase(device)}:** agentic checks did not run on both sides for any compared page`];
    const parts = [`- **${titleCase(device)}:** Live ${ratio(agentic.before)} → Preview ${ratio(agentic.after)} across ${agentic.pages} page(s)`];
    if (!agentic.comparable) parts.push("  - ⚠️ check coverage differs between Live and Preview, so passes are not compared");
    if (agentic.fixed.length) parts.push(`  - ✅ now passing: ${agentic.fixed.map(({ id, title }) => `${code(id)} ${cell(title)}`).join("; ")}`);
    if (agentic.newlyFailed.length) parts.push(`  - 🔴 newly failing: ${agentic.newlyFailed.map(({ id, title }) => `${code(id)} ${cell(title)}`).join("; ")}`);
    return parts;
  });
  return lines.length ? lines.join("\n") : "_Agentic browsing checks did not run._";
}

function verdict(comparison: Comparison): { icon: string; label: string } {
  const device = DEVICES.map((name) => comparison.devices[name]).find((d) => d?.matchedPages.length && d.scores && d.metrics);
  if (!device?.scores || !device.metrics) return { icon: "⚪", label: "Incomplete" };
  const signals = [
    device.scores.performance.delta,
    -device.metrics["largest-contentful-paint"].delta,
    -device.metrics["cumulative-layout-shift"].delta,
    -device.metrics["total-blocking-time"].delta,
  ].filter((value) => Number.isFinite(value) && value !== 0);
  const wins = signals.filter((value) => value > 0).length;
  const losses = signals.filter((value) => value < 0).length;
  if (wins && !losses) return { icon: "🟢", label: "Net win" };
  if (losses && !wins) return { icon: "🔴", label: "Net regression" };
  if (wins || losses) return { icon: "🟡", label: "Mixed" };
  return { icon: "⚪", label: "Neutral" };
}

function slackDeviceLine(device: Device, d: DeviceComparison | undefined): string | undefined {
  if (!d?.matchedPages.length || !d.scores || !d.metrics) return undefined;
  const arrow = (delta: Delta, digits: number, unit: string, higherIsBetter: boolean) =>
    `${fmtValue(delta.before, digits, unit)} → ${fmtValue(delta.after, digits, unit)} (${fmtDelta(delta, digits, unit, higherIsBetter)})`;
  return `*${titleCase(device)}* · Perf ${arrow(d.scores.performance, 0, "", true)} · LCP ${arrow(d.metrics["largest-contentful-paint"], 2, "s", false)} · CLS ${arrow(d.metrics["cumulative-layout-shift"], 3, "", false)}`;
}

// ---------- config ----------
function readConfig(ctx: WorkflowContext) {
  const cfg = ctx.workflow.config;
  const fail = (key: string, rule: string): never => {
    throw new Error(`cro-scorecard config.${key} must be ${rule}`);
  };
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
  const text = (key: string, fallback: string, allowEmpty: boolean) => {
    const value = cfg[key] ?? fallback;
    if (typeof value !== "string" || (!allowEmpty && !value.trim())) fail(key, allowEmpty ? "a string" : "a non-empty string");
    return (value as string).trim();
  };
  const choices = (key: string, fallback: string[], allowed: readonly string[]) => {
    const value = cfg[key] ?? fallback;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !allowed.includes(entry))) fail(key, `a list drawn from: ${allowed.join(", ")}`);
    return [...new Set(value as string[])];
  };
  const pagesValue = cfg.targetPages ?? ["/"];
  if (!Array.isArray(pagesValue) || !pagesValue.length) fail("targetPages", "a non-empty list of storefront paths");
  for (const page of pagesValue as unknown[]) {
    const problem = pageProblem(page);
    if (problem) fail("targetPages", `canonical storefront paths (${JSON.stringify(page)} ${problem})`);
  }
  return {
    channel: text("channel", "", true),
    announceChannel: bool("announceChannel", true),
    croLabel: text("croLabel", "cro-experiment", false),
    targetPages: [...new Set(pagesValue as string[])],
    lighthouseRuns: int("lighthouseRuns", 2, 1),
    lighthouseTimeoutSeconds: int("lighthouseTimeoutSeconds", 600),
    skipIfNoPreview: bool("skipIfNoPreview", true),
    requireFreshPreview: bool("requireFreshPreview", true),
    passingReviewOutcomes: choices("passingReviewOutcomes", ["complete"], ["complete", "incomplete", "needs_decision"]),
    passingGrades: choices("passingGrades", ["S", "A", "B"], ["S", "A", "B", "C", "D", "F"]),
    passingPublications: choices("passingPublications", ["published"], ["published", "not_needed", "pending"]),
    commentOnIncomplete: bool("commentOnIncomplete", true),
    insightPassScore: fraction("insightPassScore", 0.9),
    maxInsightRows: int("maxInsightRows", 0),
    maxScoredHeads: int("maxScoredHeads", 500),
  };
}
type Config = ReturnType<typeof readConfig>;

function positiveInt(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readReviewEvent(ctx: WorkflowContext): ReviewEvent | undefined {
  if (ctx.trigger.kind !== "event") return undefined;
  const input = ctx.trigger.input;
  const str = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    outcome: str(input.outcome) ?? "",
    publication: str(input.publication) ?? "",
    ...(str(input.grade) ? { grade: str(input.grade)!.toUpperCase() } : {}),
    ...(str(input.headSha) ? { headSha: str(input.headSha) } : {}),
  };
}

/** Live identity check, deliberately outside checkpoints: PR head, preview head and reviewed head must agree. */
async function checkIdentity(ctx: WorkflowContext, cfg: Config, prNumber: number, event: ReviewEvent | undefined): Promise<Identity> {
  const pr = await ctx.github.getPr(prNumber);
  if (pr.state !== "open") return { ok: false, kind: "closed", reason: `PR #${prNumber} is ${pr.state}.`, problems: [] };
  const head = pr.head.sha;
  if (cfg.requireFreshPreview && event?.headSha && event.headSha !== head) {
    return { ok: false, kind: "stale_review", reason: `review_pr reviewed ${event.headSha.slice(0, 8)}, but PR head is now ${head.slice(0, 8)}; the newer head's review will trigger its own scorecard.`, problems: [], headSha: head };
  }
  const preview = ctx.storefront.previewOfPr(prNumber);
  if (!preview || !preview.available || !preview.themeId) {
    return { ok: false, kind: "pending", reason: "Shopify preview theme is not available yet.", problems: preview?.problems ?? [], headSha: head };
  }
  if (cfg.requireFreshPreview && preview.headSha !== head) {
    return { ok: false, kind: "pending", reason: `Preview is synced to ${preview.headSha ? preview.headSha.slice(0, 8) : "an unknown commit"}, PR head is ${head.slice(0, 8)}.`, problems: preview.problems, headSha: head };
  }
  return { ok: true, pr, headSha: cfg.requireFreshPreview ? head : preview.headSha ?? head, themeId: preview.themeId };
}

export default async function croScorecard(ctx: WorkflowContext) {
  const cfg = readConfig(ctx);
  if (!ctx.storefront.enabled) return { status: "skipped", reason: "Storefront is not enabled for this deployment (storefront.enabled)." };

  const input = ctx.trigger.input;
  const event = readReviewEvent(ctx);
  const triggerItem = ctx.trigger.item ?? (input.item && typeof input.item === "object" ? input.item as { kind?: unknown; number?: unknown } : undefined);
  if (triggerItem && triggerItem.kind !== undefined && triggerItem.kind !== "pr") {
    return { status: "skipped", reason: `Trigger subject is a ${String(triggerItem.kind)}, not a PR.` };
  }
  const prNumber = positiveInt(triggerItem?.number) ?? positiveInt(input.pr) ?? positiveInt(input.number);
  if (!prNumber) return { status: "skipped", reason: "No PR number on the trigger (pass { pr: <number> } for manual runs)." };
  if (event) {
    const gates: Array<[string, string | undefined, string[]]> = [
      ["outcome", event.outcome, cfg.passingReviewOutcomes],
      ["grade", event.grade, cfg.passingGrades],
      ["publication", event.publication, cfg.passingPublications],
    ];
    for (const [name, value, allowed] of gates) {
      if (allowed.length && (!value || !allowed.includes(value))) {
        return { status: "skipped", prNumber, reason: `review_pr ${name} ${JSON.stringify(value ?? null)} is not in the passing set (${allowed.join(", ")}).` };
      }
    }
    if (cfg.requireFreshPreview && !event.headSha) {
      return { status: "skipped", prNumber, reason: "review_pr completion carries no reviewed head, so freshness can't be proven." };
    }
  }
  const force = ctx.trigger.manual && input.force === true;
  const croLabel = cfg.croLabel.toLowerCase();
  const hasCroLabel = (labels: Label[]) => labels.some((label) => labelOf(label).toLowerCase() === croLabel);

  // 1. Eligibility (checkpointed): CRO experiment? which pages? Transient GitHub errors propagate so Scrat retries.
  const resolved = await ctx.step("resolve_pr", { prNumber, croLabel: cfg.croLabel, targetPages: cfg.targetPages }, async () => {
    let pr: PullRequest;
    try {
      pr = await ctx.github.getPr(prNumber);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404 || status === 410 || /is not a pull request/i.test(errorText(error))) {
        return { cro: false as const, reason: `#${prNumber} is not a pull request.` };
      }
      throw error;
    }
    const metadataProblems: string[] = [];
    const prParsed = parseMeta(pr.body);
    if (prParsed.problem) metadataProblems.push(`PR #${prNumber}: ${prParsed.problem}`);
    let linked: { number: number; title: string; url: string; meta?: ExperimentMeta } | undefined;
    for (const number of closingRefs(pr.body, prNumber)) {
      let issue: Awaited<ReturnType<WorkflowContext["github"]["getIssue"]>> | undefined;
      try {
        issue = await ctx.github.getIssue(number);
      } catch (error) {
        const status = errorStatus(error);
        if (status === 404 || status === 410 || /is a pull request, not an issue/i.test(errorText(error))) continue;
        throw error;
      }
      if (!issue) continue;
      const parsed = parseMeta(issue.body);
      if (parsed.problem) metadataProblems.push(`issue #${number}: ${parsed.problem}`);
      if (hasCroLabel(issue.labels) || parsed.meta) {
        linked = { number, title: issue.title, url: issue.html_url, ...(parsed.meta ? { meta: parsed.meta } : {}) };
        break;
      }
    }
    if (!hasCroLabel(pr.labels) && !linked && !prParsed.meta) {
      return { cro: false as const, reason: `PR #${prNumber} has no ${cfg.croLabel} label or valid experiment marker (directly or via an issue it closes).` };
    }
    // A valid linked marker wins; a malformed one never overrides valid PR metadata.
    const meta = linked?.meta ?? prParsed.meta;
    return {
      cro: true as const,
      linkedIssue: linked ? { number: linked.number, title: linked.title, url: linked.url } : undefined,
      experiment: meta ?? null,
      targetPages: meta?.targetPages ?? cfg.targetPages,
      targetPagesSource: linked?.meta ? "linked_issue" : prParsed.meta ? "pr" : "config",
      metadataProblems,
    };
  });
  if (!resolved.cro) return { status: "skipped", prNumber, reason: resolved.reason };

  const notReady = async (identity: Extract<Identity, { ok: false }>, stage: string) => {
    if (identity.kind === "pending" && !cfg.skipIfNoPreview && identity.headSha) {
      const problems = identity.problems.length ? `\n\n${identity.problems.map((problem) => `- ${cell(problem)}`).join("\n")}` : "";
      const comment = await ctx.github.comment({
        key: `cro-scorecard-${prNumber}-pending`,
        number: prNumber,
        body: `### 🧪 CRO Scorecard: waiting for preview\n\n${cell(identity.reason)} The Live vs. Preview scorecard will post once the Shopify preview theme is synced to head ${code(identity.headSha.slice(0, 8))}.${problems}`,
      });
      return { status: "pending_preview", prNumber, stage, reason: identity.reason, comment };
    }
    return { status: identity.kind === "pending" ? "pending_preview" : "skipped", prNumber, stage, reason: identity.reason };
  };

  // 2a. Live identity check right before measuring.
  const before = await checkIdentity(ctx, cfg, prNumber, event);
  if (!before.ok) return notReady(before, "before_measure");
  const sha8 = before.headSha.slice(0, 8);
  const dedupeKey = `${prNumber}:${before.headSha}`;
  const commentKey = `cro-scorecard-${prNumber}-${sha8}`;
  const slackWanted = Boolean(cfg.channel && cfg.announceChannel);

  const prior = ctx.state.get<Record<string, ScoredHead>>("scoredHeads")?.[dedupeKey];
  if (prior && !force) {
    // Comment already published for this head. Only finish a Slack post that previously failed.
    if (slackWanted && prior.slack && !prior.slack.posted) {
      const slack = await ctx.slack.post({ key: prior.slack.key, channel: prior.slack.channel, text: prior.slack.text });
      ctx.state.update<Record<string, ScoredHead>>("scoredHeads", (current = {}) => {
        const entry = current[dedupeKey];
        return entry?.slack ? { ...current, [dedupeKey]: { ...entry, slack: { ...entry.slack, posted: true, ts: slack.ts } } } : current;
      });
      return { status: "slack_completed", prNumber, headSha: before.headSha, slack };
    }
    return { status: "skipped", prNumber, reason: `Head ${sha8} was already scored at ${prior.scoredAt}.` };
  }

  // 2b. Live vs. preview Lighthouse 13, sequential so the batches don't compete for CPU. Keyed by head + theme.
  const lighthouseBase = {
    pages: resolved.targetPages,
    runs: cfg.lighthouseRuns,
    devices: [...DEVICES],
    timeoutSeconds: cfg.lighthouseTimeoutSeconds,
    includeAgenticBrowsing: true,
  };
  const measured = await ctx.step("compare_live_vs_preview", { dedupeKey, themeId: before.themeId, lighthouseBase }, async () => {
    const live = await ctx.storefront.lighthouse(lighthouseBase);
    const preview = await ctx.storefront.lighthouse({ ...lighthouseBase, previewThemeId: before.themeId });
    return { measuredAt: new Date().toISOString(), live, preview };
  });
  // Numeric deltas come from Scrat and only average (page, device) pairs scored on both sides.
  const comparison = ctx.storefront.compareLighthouse(measured.live, measured.preview);
  const report = buildReport(measured.live, measured.preview, comparison, cfg.insightPassScore);

  const liveOrigin = new URL(ctx.storefront.liveUrl ?? `https://${ctx.storefront.publicHost}/`).origin;
  const links = resolved.targetPages.map((page) => ({ page, ...pageLinks(liveOrigin, page, before.themeId) }));
  const errorLines = [
    ...measured.live.errors.map((error) => ({ side: "live", ...error })),
    ...measured.preview.errors.map((error) => ({ side: "preview", ...error })),
  ].map(({ side, device, page, run, error }) => `- ${side} · ${device} · ${code(page)} · run ${run}: ${cell(error)}`);
  const errorSection = errorLines.length ? `<details><summary>⚠️ ${errorLines.length} Lighthouse run error(s)</summary>\n\n${errorLines.join("\n")}\n\n</details>` : "";

  // 2c. Zero matched pairs: incomplete. Never "Net win", never Slack, never recorded as scored.
  if (!report.matchedPairs) {
    const comment = cfg.commentOnIncomplete
      ? await ctx.github.comment({
        key: commentKey,
        number: prNumber,
        body: [
          `## 🧪 CRO Scorecard: Live vs. Preview · ⚪ Incomplete`,
          `**Head:** ${code(sha8)} · **Preview theme:** ${code(String(before.themeId))} · measured ${measured.measuredAt}`,
          `No page scored on both Live and Preview for any device, so there is nothing to compare yet. The next \`review_pr\` completion (or a manual run with \`{ "pr": ${prNumber} }\`) retries.`,
          `**Coverage:**\n${coverageLines(report).join("\n") || "- no Lighthouse groups returned"}`,
          errorSection,
        ].filter(Boolean).join("\n\n"),
      })
      : undefined;
    return { status: "incomplete", prNumber, headSha: before.headSha, matchedPairs: 0, comment };
  }

  // 3. Render (checkpointed).
  const draft = await ctx.step("publish_scorecard", { commentKey, measuredAt: measured.measuredAt, maxInsightRows: cfg.maxInsightRows, insightPassScore: cfg.insightPassScore, slackWanted }, async () => {
    const result = verdict(comparison);
    const targeted = new Set(resolved.experiment?.lighthouseInsights ?? []);
    const multiPage = report.matchedPages.length > 1;
    const experimentParts = [
      resolved.experiment?.slug ? code(resolved.experiment.slug) : "",
      resolved.experiment?.kind ? `(${code(resolved.experiment.kind)})` : "",
      resolved.linkedIssue ? `· #${resolved.linkedIssue.number}` : "",
    ].filter(Boolean);
    const proposal = resolved.experiment?.baseline?.mobile;
    const drift = typeof proposal?.scores?.performance === "number"
      ? `\n\n_At proposal time, live mobile Performance was ${proposal.scores.performance} and LCP ${fmtValue(proposal.metrics?.["largest-contentful-paint"], 2, "s")}; the Live column is re-measured now._`
      : "";
    const partial = DEVICES.some((device) => report.devices[device]?.unmatchedPages.length);
    const body = [
      `## 🧪 CRO Scorecard: Live vs. Preview · ${result.icon} ${result.label}`,
      `${experimentParts.length ? `**Experiment:** ${experimentParts.join(" ")}\n` : ""}**Head:** ${code(sha8)} · **Preview theme:** ${code(String(before.themeId))} · Lighthouse 13 · ${cfg.lighthouseRuns} run(s)/device · measured ${measured.measuredAt}`,
      `**Thumb-test:**\n${links.map(({ page, live, preview }) => `- ${code(page)}: ${mdLink("Live", live)} vs. ${mdLink("Preview", preview)}`).join("\n")}`,
      `### Before (Live) vs. After (Preview)\n\n${scorecardTable(comparison, report)}\n\n_Averages cover only (page, device) pairs that scored on both Live and Preview._${drift}`,
      `**Coverage:**${partial ? " ⚠️ partial" : ""}\n${coverageLines(report).join("\n")}`,
      `### Lighthouse insights${targeted.size ? " (🎯 = targeted by the experiment)" : ""}\n\n${insightSection(report, cfg.maxInsightRows, targeted, multiPage)}\n\n_"Resolved" means the preview explicitly scores the insight ≥ ${cfg.insightPassScore}. "Not reported" means it dropped out of the preview's capped top insights, which is not a confirmed pass._`,
      `### Agentic browsing\n\n${agenticSection(report)}`,
      resolved.metadataProblems.length ? `<details><summary>Experiment metadata warnings</summary>\n\n${resolved.metadataProblems.map((problem) => `- ${cell(problem)}`).join("\n")}\n\n</details>` : "",
      errorSection,
    ].filter(Boolean).join("\n\n");

    const resolvedIds = [...new Set(DEVICES.flatMap((device) => (report.devices[device]?.insights ?? []).filter(({ status }) => status === "resolved").map(({ id }) => id.replace(/-insight$/, ""))))];
    const agentic = report.devices.mobile?.agentic.pages ? report.devices.mobile.agentic : report.devices.desktop?.agentic;
    const slack = [
      `${result.icon} *CRO preview ready to thumb-test*: ${slackLink(before.pr.html_url, `#${before.pr.number}`)} ${slackText(oneLine(before.pr.title))}${resolved.experiment?.kind ? ` (${slackText(resolved.experiment.kind)})` : ""}`,
      // Links go right under the headline so length limits can never clip them.
      `👉 ${links.map(({ page, live, preview }) => `${slackText(page)}: ${slackLink(live, "Live")} vs ${slackLink(preview, "Preview")}`).join(" · ")}`,
      ...DEVICES.map((device) => slackDeviceLine(device, comparison.devices[device])).filter((line): line is string => !!line),
      resolvedIds.length ? `✅ Insights resolved: ${resolvedIds.map(slackText).join(", ")}` : "",
      agentic?.before && agentic.after ? `🤖 Agentic browsing: ${ratio(agentic.before)} → ${ratio(agentic.after)}${agentic.comparable ? "" : " (coverage differs)"}` : "",
      partial ? `⚠️ Partial coverage: ${report.matchedPages.length}/${resolved.targetPages.length} page(s) compared` : "",
    ].filter(Boolean).join("\n");
    return { body, slack, verdict: result };
  });

  // 3b. Live identity check right before publication: a push mid-measurement must not publish head A's numbers as head B.
  const after = await checkIdentity(ctx, cfg, prNumber, event);
  if (!after.ok) return notReady(after, "before_publish");
  if (after.headSha !== before.headSha || after.themeId !== before.themeId) {
    return { status: "skipped", prNumber, stage: "before_publish", reason: `PR or preview moved during measurement (${sha8} → ${after.headSha.slice(0, 8)}); not publishing stale numbers.` };
  }

  const comment = await ctx.github.comment({ key: commentKey, number: prNumber, body: draft.body });
  // Record the comment receipt before Slack so a Slack failure can be retried without re-measuring.
  const record: ScoredHead = {
    scoredAt: new Date().toISOString(),
    commentKey,
    ...(comment.commentId ? { commentId: comment.commentId } : {}),
    ...(resolved.experiment?.slug ? { slug: resolved.experiment.slug } : {}),
    ...(slackWanted ? { slack: { key: commentKey, channel: cfg.channel, text: draft.slack, posted: false } } : {}),
  };
  ctx.state.update<Record<string, ScoredHead>>("scoredHeads", (current = {}) => {
    const next = { ...current, [dedupeKey]: record };
    if (!cfg.maxScoredHeads) return next;
    return Object.fromEntries(Object.entries(next).sort(([, a], [, b]) => b.scoredAt.localeCompare(a.scoredAt)).slice(0, cfg.maxScoredHeads));
  });

  let slack: { ts: string; dryRun?: boolean; previewPath?: string } | undefined;
  if (record.slack) {
    slack = await ctx.slack.post({ key: record.slack.key, channel: record.slack.channel, text: record.slack.text });
    const ts = slack.ts;
    ctx.state.update<Record<string, ScoredHead>>("scoredHeads", (current = {}) => {
      const entry = current[dedupeKey];
      return entry?.slack ? { ...current, [dedupeKey]: { ...entry, slack: { ...entry.slack, posted: true, ts } } } : current;
    });
  }

  return {
    status: comment.dryRun ? "dry_run" : "published",
    prNumber,
    headSha: before.headSha,
    verdict: draft.verdict,
    matchedPairs: report.matchedPairs,
    matchedPages: report.matchedPages,
    targetPages: resolved.targetPages,
    targetPagesSource: resolved.targetPagesSource,
    comment,
    slack,
  };
}
