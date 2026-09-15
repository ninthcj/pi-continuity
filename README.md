# Pi Continuity

**Evidence-backed memory, notebook compression, and checkpoint recovery for long-running coding tasks.**

English | [简体中文](README.zh-CN.md) · [MIT License](LICENSE)

Pi Continuity keeps task goals, user corrections, notes, and source evidence in a local SQLite ledger. It builds a bounded context view for the next model request and retains the original records for recall. A Pi extension and SDK host connect the same core to [Pi](https://github.com/earendil-works/pi).

## What it does

- **Preserves user corrections.** Explicit user statements, confirmed notes, and required pending work survive context trimming. If required content cannot fit, the operation fails explicitly.
- **Maintains an incremental notebook.** Notes have stable keys, evidence links, immutable revisions, and retirement records. Model-generated observations remain proposed; they cannot rewrite confirmed instructions.
- **Compresses without deleting evidence.** Compression views retain source and omission IDs. Original text, tool results, and archived images can be retrieved when needed.
- **Resumes from a frozen checkpoint.** Checkpoints capture notebook versions and task state. Strict resume starts a new epoch without silently importing later edits.
- **Checks requests before model execution.** The SDK wrapper checks the full input, including system content, messages, tool schemas, and Continuity context, with room reserved for output.
- **Tracks memory and operations.** Structured claims support deduplication, snapshots, and three-way merge proposals. The operation ledger records completed or uncertain effects for explicit reconciliation.

## Quick start

Requires **Node.js 22.19+**. The current release is verified on **Node.js 24.19.0 / Windows** with Pi **0.85.1**. Node's built-in `node:sqlite` is used.

```sh
git clone https://github.com/ninthcj/pi-continuity.git
cd pi-continuity
npm ci
npm run build
npm test
```

Run the offline checkpoint/resume demonstration:

```sh
npm run demo
```

The demo writes to `.demo/` and needs no model credentials.

To use the Pi terminal interface in this checkout:

```sh
npx pi
```

The project extension is discovered automatically and defaults to `active` mode. Pi uses its existing configuration and credentials in `~/.pi/agent`.

## Use in another Pi project

Build an installable archive in this repository:

```sh
npm pack
```

In your destination project, install the archive. Replace the example path with the actual archive path:

```sh
npm install ../pi-continuity/pi-continuity-0.1.1.tgz
```

Create `.pi/extensions/continuity.mjs` in the destination project:

```js
export { default } from 'pi-continuity/extension';
```

Start the Pi interface with `npx pi`. For the strict final provider gate, use the SDK host:

```sh
npx pi-continuity-pi "Complete the requested feature" --runtime
```

This CLI handles one prompt and exits. For a persistent application, use `createContinuityPiSession` from `pi-continuity/pi-host`; it exposes the session, checkpoint, resume, and close operations. Keep the extension enabled for compaction and native notebook tools. **The extension alone does not guarantee that a failed check blocks the final provider call.**

The archive contains compiled JavaScript. Consumers do not need TypeScript loading inside `node_modules`.

## Notebook workflow

The default notebook makes **no extra model calls**. It incrementally captures user statements verbatim, skips bare acknowledgements such as “continue,” and extracts labelled observations as proposed notes.

| Command or tool | Purpose |
| --- | --- |
| `/continuity` | Show current task and recovery status |
| `/continuity notes` | Show the current notebook |
| `/continuity source <eventId>` | Read original evidence |
| `/continuity note <json>` | Create, revise, or retire a note as the host |
| `/continuity observe` | Run one semantic-observation batch with the current Pi model |
| `continuity_note` | Agent tool for maintaining proposed notes |
| `continuity_recall` | Agent tool for paginated notebook and evidence retrieval |

If your Pi configuration restricts available tools, allow `continuity_note` and `continuity_recall` explicitly.

For optional semantic consolidation before compaction, set `PI_CONTINUITY_NOTEBOOK=semantic`. For example, in PowerShell:

```powershell
$env:PI_CONTINUITY_NOTEBOOK = 'semantic'
npx pi
```

This uses the current Pi model and can incur provider usage. The observer may revise or retire proposed observations; it cannot confirm requirements or replace confirmed user/host notes. See the [notebook guide](docs/continuity/NOTEBOOK.md) for note updates, provenance, custom observers, and recovery behavior.

## Core API

The core can be used independently of a Pi session. After installing the archive:

```js
import { ContinuityStore } from 'pi-continuity';

const store = new ContinuityStore('./continuity.db', { mode: 'active' });
try {
  const task = store.createTask('my-project', 'main', 'Fix login', {
    constraints: ['Preserve the existing public API'],
  });
  store.recordEvent(task.task_id, 'user_input', {
    text: 'Reproduce the timeout first; leave billing unchanged.',
  });

  const manifest = store.buildManifest(task.task_id, { budget: 2000 });
  const compact = store.compressContext(task.task_id, { budget: 2000 });
  console.log(manifest.instructions, compact.viewId);
} finally {
  store.close();
}
```

Public entry points: `pi-continuity`, `/adapter`, `/pi-sdk`, `/pi-host`, `/extension`, `/notebook-observer`, and `/context-budget`.

## Modes and local data

Set `PI_CONTINUITY_MODE` for the Pi extension or pass `mode` to the core/host:

| Mode | Behavior |
| --- | --- |
| `off` | Preserve the native model request without Continuity injection |
| `record` | Record evidence without changing the caller's model messages |
| `active` | Build Continuity context and apply the available integration gates |

The Pi integration stores its database and task pointer under the project's `.pi/` directory. Large payloads use a content-addressed blob store. Pi's native JSONL sessions remain managed by Pi. Preserve the database and its referenced blobs together when moving or backing up state.

Memory snapshots and merges preserve claim history. Selected-file snapshots provide portable byte storage; they do not restore a whole worktree. Optional OS snapshot support depends on the filesystem and process permissions.

## Validation and limits

The current offline suite has **83 passing tests**. It covers retention of Chinese corrections, long archived inputs, budget rejection, note revision/retirement, checkpoint recovery, observer authority, and real Pi SDK integration using a faux provider. A separate fresh-project package installation also passed.

- Live-model semantic quality has not been benchmarked. Evidence links establish provenance, not the correctness of an interpretation.
- Default token counts use `cl100k_base` with a margin for full requests. Supply `countRequestTokens(context, model)` for a provider-specific counter; multimodal and proprietary serialization costs are not universally exact.
- Independent hosts still need process coordination or isolation. This library is not a filesystem sandbox.
- Checkpoint recovery does not perform automatic code/worktree rollback, and unknown external operations are not automatically replayed.

Details: [validation results](docs/continuity/VALIDATION.md) · [audit boundaries](docs/continuity/AUDIT.md) · [compression research](docs/continuity/COMPRESSION_RESEARCH.md).

## License and acknowledgements

Copyright © 2026 **ninthcj**. Released under the [MIT License](LICENSE). You may use, modify, distribute, and sell the software; copies or substantial portions must retain the copyright and permission notices.

Pi integration uses the official [Pi SDK](https://github.com/earendil-works/pi). Text tokenization uses [js-tiktoken](https://github.com/dqbd/tiktoken). Dependencies retain their own licenses. Notebook design references are listed in the [notebook guide](docs/continuity/NOTEBOOK.md).
