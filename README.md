# scrat-workflows

Shared workflow bundles and per-client overlays for UnblockLabs Scrat VMs (`scrat`, `worker-pearl`, `worker-theo`).

## Layout

```text
shared/                 # Workflows shared across all VMs
clients/
  scrat/                # Overlays & custom workflows for Loggie (agent-platform)
  worker-pearl/         # Overlays & custom workflows for Perelel
  worker-theo/          # Overlays & custom workflows for Thesis
```

## Shared workflows

All ship `enabled: false`. To opt in on a VM:

1. Every bundle here ships a `run.ts`, and repo-synced layers count as local scripts, so set `workflows.trustLocalScripts: true` in `scrat.local.json`. Scrat refuses to run them otherwise.
2. Enable the workflow in `scrat.local.json` or a `clients/<vm>/` overlay, and override its `config` there (for example, `targetPages` and `channel`).

| Workflow | Trigger | Publishes | What it does |
| --- | --- | --- | --- |
| `maintainer-sweep` | Mon 13:00 UTC, manual | GitHub issue, optional Slack | Weekly architectural sweep: a rolling merged-PR root-cause ledger plus open issues, then one critic-approved RFC issue for a shared primitive or refactor. |
| `revenue-hill-climber` | Mon & Thu 14:00 UTC, manual | **GitHub issue only** | Storefront CRO and performance hill-climber. Skips while `maxOpenExperiments` `croLabel` items are open, and checks again live just before creating the issue. Measures a live Lighthouse 13 baseline on `targetPages`. `HUNT.md` then finds `minCandidates`–`maxCandidates` experiments, at least one a deletion. Each candidate's files are verified as tracked regular files at the base commit, and its pages must come from `targetPages`. d1 pre-screens them (failing open), and `CRITIQUE.md` approves at most one winner. The issue it opens is labelled `croLabel`, plus `ctx.bot.slug` when `autoImplement` is on, so `implement` → `review_pr` builds the PR and its Shopify preview. The issue carries a versioned `<!-- scrat-cro-experiment: {…} -->` marker. A persisted publication intent plus the state ledger keep retries from opening a second issue. |
| `cro-scorecard` | `review_pr` completed, manual (`{ "pr": 123 }`, optional `"force": true`) | **PR comment + Slack thumb-test card** | Applies to open PRs labelled `croLabel`, or that close a `croLabel` issue. It scores only when the `review_pr` outcome, grade and publication pass and the reviewed head, PR head and preview head agree. That identity is re-checked live before measuring and again before publishing. Lighthouse 13 runs on Live, then on the Preview theme (mobile and desktop). Deltas come from `ctx.storefront.compareLighthouse`, so they average only (page, device) pairs scored on both sides, with coverage shown. The PR comment covers scores, LCP/CLS/TBT/FCP/SI, insight changes and agentic browsing, and the Slack card goes to `channel`. If nothing matched, the result is "incomplete": no Slack, nothing recorded. Comment and Slack receipts are stored separately per `PR:headSha`. |

Limits and thresholds live in each `workflow.yaml` `config`; where a limit allows it, `0` means unlimited. Scrat's own `storefront.lighthouse.insights` settings (`max`, `items`, `valueChars`) cap how much insight detail reaches these workflows. An audit absent from `topInsights` is therefore "not reported", not "passing".

## Rules

- **Load order:** built-in `workflows/` < `shared/` < `clients/<vm>/` < VM-local `workflows.directory`.
- **Overrides:** Any bundle in `shared/` or `clients/<vm>/` that shadows a lower-layer workflow must set `override: true` in its `workflow.yaml`.
- **Pinned deploy:** Each VM pins an exact 40-char commit SHA under `workflows.repo.ref` in `scrat.local.json`. Update `ref`, run `npm run workflow -- sync` (validates with `workflow check` before flipping atomically), then restart `scrat.service`.
- **Zero external deps:** `run.ts` scripts may use `import type { WorkflowContext } from "scrat"` and `node:*` built-ins only.
- **No symlinks:** `workflow sync` rejects any symlink inside a checkout.
