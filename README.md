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

## Rules

- **Load order:** built-in `workflows/` < `shared/` < `clients/<vm>/` < VM-local `workflows.directory`.
- **Overrides:** Any bundle in `shared/` or `clients/<vm>/` that shadows a lower-layer workflow must set `override: true` in its `workflow.yaml`.
- **Pinned deploy:** Each VM pins an exact 40-char commit SHA under `workflows.repo.ref` in `scrat.local.json`. Update `ref`, run `npm run workflow -- sync` (validates with `workflow check` before flipping atomically), then restart `scrat.service`.
- **Zero external deps:** `run.ts` scripts may use `import type { WorkflowContext } from "scrat"` and `node:*` built-ins only.
- **No symlinks:** `workflow sync` rejects any symlink inside a checkout.
