# Implementation audit and boundaries

Current scope (2026-09-15): the core, notebook/context engine, token budget and observer modules, adapters, Pi host/SDK/extension, and 83 offline tests. The verification results are recorded in [VALIDATION.md](VALIDATION.md). This implementation review is not an independent external audit.

## Blocking risk for strict active mode

Pi 0.85.1 exposes `before_provider_request` for payload inspection/replacement, but the extension hook cannot reliably block a request. Pi also documents that extension errors are logged and execution continues. Therefore the project extension alone cannot prove zero provider calls after a continuity failure. The host `PiAdapter.request()` and SDK `ModelRuntime.streamSimple` wrapper do prove this for callers that use them; active production runs must route calls through one of these host seams.

## Accepted residual risks

- The npm Pi package exposes the SDK and native CLI, but final provider serialization and internal retry/compaction behavior remain owned by Pi. The extension records the public lifecycle only.
- The core fingerprints explicitly selected files and Git state. It does not claim whole-worktree equivalence when coverage is `selected` or `none`.
- `practical` resume imports only event ids explicitly supplied by the caller; it does not infer failure experience. Unknown external operations remain unknown and are not replayed.
- The extension stores project-local SQLite data under `.pi`; Pi's own documentation says extensions run with process permissions. Strong isolation still requires a sandbox/container.

## Reproduced checks

The tests assert actual provider/tool call counts, database state, scope, revision, epoch, checkpoint state, restart behavior, path containment, redaction, and bounded manifest output. No test deletes a failure or weakens an isolation assertion to pass.

The previously reproduced user-correction loss and over-budget compression defects are covered by passing regressions. Notebook retirement, checkpoint recovery and observer authority also have targeted coverage. Memory merge is deliberately claim-key based and non-destructive: conflicting claims remain available, while snapshots provide rollback and historical reads. Portable bundles and deterministic compression are presentation/exchange layers; they do not delete claims or rewrite history.

## Notebook release boundaries

The core preserves explicit user statements rather than relying on an observer to infer their importance. Host-authorized note revisions/retirement resolve obsolete instructions; an observer only maintains proposed observations. Failed compaction leaves the prior compression view available. Notebook extraction is an additive projection of the existing event/notes ledger.

The semantic observer runs bounded native-provider batches only when selected. It validates output structure, provenance, authority and freshness; provenance does not prove semantic correctness. Model quality has not been benchmarked against live providers. Text counting reuses pinned js-tiktoken; full-request estimates and provider-specific counters are distinguished explicitly.
