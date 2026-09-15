# Validation

Validation date: 2026-09-15. Release: 0.1.2. Environment: Windows, Node.js v24.19.0, built-in node:sqlite, Pi @earendil-works/pi-coding-agent 0.85.1 and js-tiktoken 1.0.21.

## Executed

- `npm test`: **102 passed, 0 failed, 0 skipped** (about 12 seconds). This includes the previous 83 tests and 19 additional recovery, observer-progress and scaling regressions.
- `npm run build` and `npm pack --pack-destination releases`: compiled JavaScript and a distributable archive, including bilingual READMEs, MIT license, specification and the synthetic measurement reports.
- Fresh temporary consumer install with `npm --offline --ignore-scripts`: all seven public package exports and the installed Pi SDK loaded; notebook creation, measured compression, checkpoint/resume, source recall, zero-call budget rejection, native tool registration and the packaged CLI passed. The 0.1.2 smoke also exercises frozen memory recovery and stale writes through the installed package.
- The synthetic compression benchmark independently verifies rendered token counts and preserved Chinese instructions. Its [before/after report](benchmarks/README.md) records measurements and reproduction steps.
- The configured DeepSeek provider passed all three [live development fixtures](evaluations/README.md) in the final eight-call run. Earlier failures and timeouts are retained. These cases informed prompt changes and are not a held-out quality benchmark.

## Recovery and observer regression evidence

- Strict recovery excludes later direct memories, compression candidates and conflicts from ordinary recall, manifests and compaction. Explicit history reads remain possible.
- Checkpoints and memory snapshots preserve immutable versions of status, origin and evidence. Candidate promotions after a checkpoint cannot rewrite its frozen state. Legacy checkpoint horizons and audited database migration have targeted coverage.
- Old-epoch writes, including duplicates, confirmations, promotions and imports, fail before mutation. Supplied stale revisions also reject. Snapshot forks and practical imports preserve the selected versions, including duplicates recorded after recovery.
- Oversized source events progress through complete contiguous Unicode-safe fragments. A durable offset survives process restart and checkpoint recovery; later evidence is not silently skipped. A large archived resume payload retains its full pending queue.
- Malformed or cancelled observer output and late responses leave the cursor unchanged. Notes and successful fragment offsets commit together. Cross-task provenance, confirmation and instruction rewrites remain prohibited. A late native response cannot add response evidence to a new epoch.
- Large notebooks use bounded relevant previews without deleting excluded notes. Failed compaction rolls back candidate versions and the incremental extraction cursor. Repeated compaction reuses old event projections and does not re-extract unchanged evidence.

## Existing notebook and integration evidence

- Unlabelled Chinese user corrections survive recent-window selection and budget pressure; a correction at the end of an archived long input is restored in full.
- Impossible manifest/compaction budgets reject explicitly. Failed compaction does not publish candidate memories or replace the prior view. The actual rendered manifest/summary is counted, including headings and metadata.
- Notes update as immutable versions with evidence IDs. Repeated old evidence cannot reactivate retired or revised observations. Three compaction/restart/resume cycles preserve user instructions and source reads.
- Full SDK input checks include original system content, messages and tool schemas. Over-budget inputs produce zero provider calls. A provider-specific counter can inspect the complete native context without rewriting its fields.
- Real Pi AgentSession tests use the installed SDK with a faux provider. They exercise notebook tools, optional semantic-observer invocation, compaction cancellation with no provider fallback, images, tools, off/record preservation and replacement-aware host gating.
- Baseline coverage retains contract confirmation, operation idempotency and unknown-operation recovery, evidence redaction, blob archiving, memory merge, portable filesystem snapshots and workspace scope checks.

## Limits

These checks establish the tested storage, retention, authority and integration behavior. Three development fixtures do not establish general live-model summarization quality or production readiness. No exhaustive Pi retry/queue matrix was run. The default cl100k request estimate is not an exact token/billing count for every provider, especially multimodal requests; a provider-specific counter is the exact-count extension point.

The extension alone cannot guarantee the final provider gate. Use the SDK host/runtime wrapper for strict active requests. Multiple independent hosts in one process still require external coordination/isolation. UI rendering and whole-worktree restoration were not tested. Performance results are individual same-machine samples, not latency guarantees.
