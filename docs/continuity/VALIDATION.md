# Validation

Environment: Node.js `v24.19.0`; built-in `node:sqlite` loads successfully. Local Pi `@earendil-works/pi-coding-agent` `0.85.1` is installed from npm; the former WinGet package has been removed. The offline suite uses no provider credentials.

Executed:

```text
npm test
```

Result: 53 tests passed, 0 failed. The tests cover early constraints surviving “continue”, scope and epoch gates, read-only inspect and new-epoch resume, zero provider calls on a critical budget gate, idempotent side effects, late-result rejection, off-mode baseline behavior, ordered handoff publication, workspace fingerprint mismatch, strict/practical history selection, restart marking of unknown operations, explicit unknown-operation reconciliation, recovery-required gating, authority-plus-blob backups, strict resume import rejection, workspace path containment, credential-shaped field redaction, bounded long evidence, confirmed correction revisions, bounded raw input manifests, evidence-linked notes, durable long-payload blobs, normalized memory duplicate detection, scoped bounded-preview recall with explicit full reads across epochs, informational memory conflicts without resolution state that do not block manifests, deterministic compression views with key-claim extraction and reversible expansion, immutable memory snapshots, automatic three-way merge proposals, newest-claim merge selection with parent-history preservation, portable bundle export, deterministic compression views, portable Git-free workspace snapshots, side-effect-free native capability probing including elevation metadata, the real Pi 0.85 extension boundary, the SDK stream boundary wrapper, the real SDK host binding, replacement-aware runtime rebinding, and host checkpoint/resume coordination.

```text
npm run demo
```

This is the two-window local demonstration: create a task, record a provider request, execute a side-effect operation, publish a checkpoint, inspect it, and fork/resume into epoch 2.

```text
node --check src/core.mjs; node --check src/adapter.mjs; node --check src/pi-sdk.mjs; node --check src/pi-host.mjs; node --check .pi/extensions/continuity.js; node --check bin/pi-continuity.mjs; node --check bin/pi-continuity-pi.mjs; node --check examples/demo.mjs; node --check examples/pi-faux-sdk.mjs
```

Result: all nine JavaScript syntax checks passed.

The real Pi SDK boundary was also exercised offline with the published `@earendil-works/pi-coding-agent` `0.85.1` package and its faux provider: two actual `AgentSession.prompt()` calls across a checkpoint/resume replacement produced two faux provider calls, both through the continuity manifest gate; a real faux tool-call stream produced one operation intent and one result; and a `RECOVERY_REQUIRED` state produced zero faux provider calls. No external model credentials were used.

Not executed: provider-backed model quality tests, exhaustive Pi retry/compaction/queue matrices, UI rendering tests, and worktree restoration tests; the offline SDK run covers a real tool-call/result stream. The current test suite is evidence for the independent core, fake boundary, and offline Pi SDK faux boundary; it is not evidence of improved model quality or production readiness.

Pi integration audit: the npm native CLI reports version `0.85.1`. A real `pi --approve --print` run with the default read tool and the configured DeepSeek provider returned the synthetic sentinel exactly; the Continuity ledger recorded 1 task, 2 manifests, 1 model request, 2 provider requests, 1 tool call, and 1 tool result. All synthetic session files and database artifacts were removed afterward.
