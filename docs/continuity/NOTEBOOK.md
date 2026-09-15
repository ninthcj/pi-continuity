# Notebook compression and project integration

This release adds an incremental notebook to Pi Continuity. It reuses the existing SQLite event/notes store and Pi extension lifecycle. The observer/reflector pattern is informed by [Mastra Observational Memory](https://mastra.ai/docs/memory/observational-memory); the readable projection follows the approach of [Letta MemFS](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta_local_memfs.md). Neither framework is required at runtime.

## Install in another Pi project

Use Node 24 (verified with v24.19.0; package minimum is 22.19.0). Clone the repository, run `npm ci`, then run `npm pack` to create `pi-continuity-0.1.1.tgz`. In the destination project, install that archive using its actual path:

```powershell
npm install ../pi-continuity/pi-continuity-0.1.1.tgz
New-Item -ItemType Directory -Force .pi/extensions
```

Create `.pi/extensions/continuity.mjs` containing:

```js
export { default } from 'pi-continuity/extension';
```

Then start Pi with `npx pi`. For the strict final provider gate use:

```powershell
npx pi-continuity-pi "Your task objective" --runtime
```

The wrapper is a one-prompt CLI; it does not promise an unattended endless loop. For a long-lived application use `createContinuityPiSession` from `pi-continuity/pi-host` and its `session`, `checkpoint`, `resume`, and `close` APIs. Keep the extension enabled because it owns compaction and native notebook tools. When explicitly restricting Pi tools, include `continuity_note` and `continuity_recall` in the allowed list.

The package contains compiled `.mjs` files; consumers do not need TypeScript loading inside `node_modules`. No existing project files or global Pi configuration are installed automatically.

## Modes

The default notebook is deterministic and makes no extra model calls. At model-request/compaction boundaries it captures new user statements verbatim, ignores bare acknowledgements such as “continue”, and extracts explicitly labelled assistant observations as proposed notes. Ordinary prose from the user does not need labels to be protected.

For semantic note consolidation with the current Pi model:

```powershell
$env:PI_CONTINUITY_NOTEBOOK='semantic'
npx pi
```

This enables one bounded native observer batch before compaction. It can incur additional provider usage. `/continuity observe` also runs one batch on demand. The observer can revise or retire proposed notes, but cannot confirm a claim or change confirmed user/host instructions. Invalid JSON, unsupported evidence, cancellation, budget overflow, and stale responses leave the previous semantic notebook intact; the raw ledger remains available.

For a custom host, `store.observeNotebook(taskId, observer)` accepts an async observer returning `{entries:[{key,category,text,evidenceIds,retire?}]}`. `createNotebookObserver` from `pi-continuity/notebook-observer` adapts an existing native `complete(model, context, options)` callback. It records request provenance and returned usage. This is optional; the default offline path needs no API key.

## Use the notebook

- `/continuity notes`: show the current Markdown projection.
- `/continuity source <eventId>`: read the original task-scoped event, expanding an archived text blob.
- `/continuity note <json>`: explicitly create, revise or retire a named note as the host.
- `continuity_note`: agent tool for proposed notes only.
- `continuity_recall`: paginated agent tool for the notebook, a note ID, or an event ID.

A host update has this shape:

```json
{"key":"release-target","category":"constraint","text":"Deploy to staging only","status":"confirmed","evidenceIds":["an-existing-task-event-id"]}
```

Reuse `key` to create a new version; pass `expectedNoteId` to reject stale updates. Pass `retire:true` and new evidence when the item is withdrawn or complete. Previous note versions and source events are never deleted. Model tools cannot retire confirmed notes. Read a note's `supersedes_note_id` to follow its history.

## Retention and recovery

User instructions, current task constraints/acceptance, confirmed notes, checkpoint pending work and unresolved operations are required context. Budget pressure removes optional observations first. If required material still cannot fit, the request/compaction fails explicitly; it does not silently truncate user corrections. A host can revise or retire an obsolete instruction using its notebook key and new evidence.

Checkpoints freeze notebook head IDs and legacy note IDs. Resume loads that exact snapshot plus new-epoch changes; notes written after the checkpoint are not silently imported. Practical resume imports only explicit event IDs. Old checkpoint formats seed their notebook from the checkpoint's visible event horizon.

Compression stores an immutable view, source/omission IDs, required-instruction retention counts, and the rendered output's token count. Retired extracted observations are not promoted again by a later compression. Original tool/event records remain historical evidence, even after their derived notes are retired.

## Token budgets

`js-tiktoken` **1.0.21 (MIT)** is reused for `cl100k_base` text tokenization: [upstream](https://github.com/dqbd/tiktoken/blob/main/js/README.md). Both the complete rendered manifest and the actual compression summary are counted. The SDK wrapper separately checks the full input context, including original system prompt, messages, tools and Continuity, with output tokens reserved.

`cl100k_base` is not every provider's tokenizer. The default full-request count is explicitly labelled an estimate with a margin. Supply `countRequestTokens(context, model)` to the SDK wrapper/host for a provider-specific synchronous counter, and optionally `inputBudget`/`outputReserve`. The native request objects are not rewritten by counting. Multimodal billing and proprietary provider serialization need provider-specific counters; this release does not claim exact cross-provider billing.

## Verified scope and limits

The regression suite covers unlabelled Chinese corrections, archived long inputs, strict budget rejection, actual rendered counts, note versioning/retirement, provenance and authority checks, observer rollback, full-request gates, repeated compaction and restart/resume. Real Pi SDK tests use an offline faux provider to exercise tools and semantic-observer calls.

No live-model semantic-quality benchmark has been run. Source validation proves where a proposed observation came from, not that the model interpreted it correctly. Multiple simultaneously bound independent hosts still need external process isolation; Pi extension hooks alone do not provide the strict final provider gate.
