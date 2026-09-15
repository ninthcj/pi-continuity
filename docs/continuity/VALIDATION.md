# Validation

Validation date: 2026-09-15. Environment: Windows, Node.js v24.19.0, built-in node:sqlite, Pi @earendil-works/pi-coding-agent 0.85.1 and js-tiktoken 1.0.21. No external provider credentials were used for this validation pass.

## Executed

- npm test: **83 passed, 0 failed, 0 skipped** (about 11 seconds). A fresh source directory repeated npm ci --offline --ignore-scripts, npm run build and all 83 tests successfully before the public release.
- npm run demo: passed; task creation, checkpoint inspection and strict resume into epoch 2 succeeded.
- npm pack --pack-destination releases: passed; the archive contains 20 selected package files (compiled JavaScript, bilingual READMEs, documentation and MIT license), with no project database, session or credential files.
- Fresh temporary consumer install with npm --offline --ignore-scripts: passed. All seven public package exports and the installed Pi SDK loaded; notebook creation, measured compression, checkpoint/resume, source recall, zero-call budget rejection, native tool registration and the packaged CLI passed.

The 83 tests include all 65 baseline tests plus 18 new notebook/integration regressions. Existing coverage includes scope and epoch gates, explicit contract confirmation, immutable checkpoints, operation idempotency and unknown-operation recovery, evidence redaction and blob archiving, image restoration, memory snapshots and merges, portable filesystem snapshots, Pi extension lifecycle, SDK stream gates, and replacement-aware host recovery.

## Notebook and budget regression evidence

- Unlabelled Chinese user corrections survive recent-window selection and budget pressure; a correction at the end of an archived long input is restored in full.
- Impossible manifest/compaction budgets reject explicitly. Failed compaction does not publish candidate memories or replace the prior view. The actual rendered manifest/summary is counted, including headings and metadata.
- Notes update as immutable versions with evidence IDs; stale updates and cross-task evidence are rejected. Repeated old evidence cannot reactivate retired or revised observations.
- The observer cannot create instruction notes, self-confirm, rewrite confirmed notes or commit a partial invalid batch. Cancelled, malformed, truncated and stale observer results are rejected by the corresponding guards; malformed/truncated output and stale epoch are directly covered.
- A checkpoint freezes notebook and legacy note IDs. Three compaction/restart/resume cycles preserve user instructions and source reads; post-checkpoint edits do not leak into strict recovery.
- Full SDK input checks include original system content, messages and tool schemas. Over-budget inputs produce zero provider calls. A provider-specific counter can inspect the complete native context without rewriting its fields.
- Real Pi AgentSession tests use the installed SDK with a faux provider. They exercise native notebook write/recall tools, optional semantic-observer invocation, compaction cancellation with no provider fallback, images, tools, off/record preservation and replacement-aware host gating.

## Limits

These tests establish storage, retention, authority and integration behavior. They do not establish live-model summarization quality or production readiness. No live semantic-quality benchmark or exhaustive Pi retry/queue matrix was run. The default cl100k request estimate is not an exact token/billing count for every provider, especially multimodal requests; a provider-specific counter is the exact-count extension point.

The extension alone cannot guarantee the final provider gate. Use the SDK host/runtime wrapper for strict active requests. Multiple independent hosts in one process still require external coordination/isolation. UI rendering and whole-worktree restoration were not tested.

## Earlier provider evidence

The preceding integration audit recorded a real Pi 0.85.1 CLI run with the configured DeepSeek provider and a synthetic sentinel: one task, two manifests, one model request, two provider requests, one tool call and one tool result. Its synthetic artifacts were removed afterward. That earlier run was not a test of this release's semantic observer and was not repeated during the offline notebook validation.
