# pi-continuity

`pi-continuity` is a small, offline-first continuity core for long coding tasks. It stores task contracts, scoped evidence events, work records, immutable request manifests, checkpoints, and operation intents in SQLite. Large payloads can be placed in a content-addressed blob directory. The `PiAdapter` is a narrow host boundary: in `active` mode it builds and records a manifest before a provider call, and side-effect tools use an operation ledger so a completed operation is not replayed.

The core has no npm Pi dependency: the adapter targets a provider-shaped interface and is tested with `FakeProvider`. A real Pi 0.85.1 extension seam is included separately below. `off` calls the provider unchanged, `record` records context without changing the caller's messages, and `active` requires a valid continuity manifest before the provider call.

## Run

Requires Node.js 22 or newer (Node 24's built-in `node:sqlite` is used; no npm install is required).

```powershell
npm test
npm run demo
node .\bin\pi-continuity.mjs .\local.db create "ship the feature"
node .\bin\pi-continuity.mjs .\local.db status <task_id>
node .\bin\pi-continuity.mjs .\local.db manifest <task_id> --active
node .\bin\pi-continuity.mjs .\local.db inspect <task_id> --checkpoint <checkpoint_id>
node .\bin\pi-continuity.mjs .\local.db resume <task_id> --checkpoint <checkpoint_id> --revision 1
```

The demo writes only to `.demo/`. The core does not install a global Pi package or change user Pi configuration.

For the real SDK host, install the audited Pi version in the project and run:

```powershell
npm install @earendil-works/pi-coding-agent@0.85.1
npx pi-continuity-pi "ship the feature" --record
npx pi-continuity-pi "ship the feature" --runtime
npx pi-continuity-pi "ship the feature" --runtime --off
node examples/pi-faux-sdk.mjs
```

`pi-continuity-pi` wraps Pi's `ModelRuntime.streamSimple` final stream boundary, records session entries, and refuses active requests when continuity is not ready. Add `--runtime` to use Pi's replacement-aware `AgentSessionRuntime` for new, resume, fork, and import flows. It uses Pi's configured credentials; the test suite and demo do not use them.

## Memory branches and merges

Record structured claims instead of asking a free-form note to carry authority. `recordMemoryClaim` normalizes the scope, subject, predicate, and value; an equal fingerprint is returned as a duplicate, while different values for the same subject/predicate remain visible as an informational conflict. `recallMemory` returns a scoped, bounded preview and `readMemory` is the explicit full-record read. `createMemorySnapshot` and `forkMemorySnapshot` create immutable claim-set snapshots. Pass a common base and two descendants to `proposeMemoryMerge`; independent changes are selected automatically and conflicts use the newest claim by default. `commitMemoryMerge` writes a two-parent snapshot while preserving both parent histories.

```js
const proposal = store.proposeMemoryMerge(taskId, {
  baseSnapshotId, oursSnapshotId, theirsSnapshotId,
  agent: 'continuity-agent',
});
const merged = store.commitMemoryMerge(taskId, proposal.mergeId);

const bundle = store.exportMemory(taskId, { snapshotId: merged.snapshot_id });
const compact = store.compressMemorySnapshot(merged.snapshot_id, taskId);
```

## Real Pi 0.85.1 extension

The local WinGet install is `@earendil-works/pi-coding-agent` 0.85.1. The project extension at `.pi/extensions/continuity.mjs` uses its verified lifecycle API, records raw input and tool/provider events, injects a manifest before each agent run in `active` mode, and exposes `/continuity` for a read-only status view. Run it from this repository with `PI_CONTINUITY_MODE=record pi` or `PI_CONTINUITY_MODE=active pi`. The extension is deliberately default-off. Pi's public `before_provider_request` hook has no blocking return, so strict zero-provider-call enforcement remains in the host adapter and is not claimed for an extension-only deployment.

## Scope

Implemented: versioned task contracts with host-confirmed changes, scoped/epoch-checked evidence, durable blobs, request manifests with bounded recent events, idempotent operation intent/result recording and explicit unknown reconciliation, immutable memory claims with duplicate/conflict detection, portable memory bundles, deterministic snapshot compression views, Git-like memory snapshots and three-way merge proposals, inspect and fork/resume checkpoint operations, an adapter gate, and a real Pi SDK host wrapper with offline tests.

Not implemented: Pi TUI widgets, code/worktree rollback, provider-specific message reconstruction, remote thread isolation, real-model quality evaluation, strong filesystem sandboxing, embedding/vector indexes, and filesystem-specific COW snapshot backends. Memory snapshots are immutable SQLite DAG records; compression is a non-destructive presentation view and portable bundles provide the cross-system exchange seam.

The iterative review and stop decision are recorded in [ITERATION.md](D:/pi-continuity/docs/continuity/ITERATION.md) and [AUDIT.md](D:/pi-continuity/docs/continuity/AUDIT.md). The project stops adding features when they would create new authority, replay, or isolation risk without a verified Pi seam or measurable evidence.

## Filesystem snapshots without Git

`createWorkspaceSnapshot` stores selected file bytes in the local content-addressed blob store and records an immutable tree in SQLite. `readWorkspaceSnapshotFile` reads the bytes from any earlier snapshot after the live workspace changes. This portable-CAS backend works on ext4, APFS, and NTFS without Git. `nativeSnapshotCapabilities` probes the host without side effects; passing `backend: 'auto'` opportunistically records an APFS or Windows VSS snapshot reference, while `portable-cas` remains the fallback when native support or privileges are unavailable.

Native acceleration is optional and may require elevation: Windows uses one VSS backend for both NTFS and ReFS and generally requires Administrator or `SE_BACKUP_NAME`; APFS protected volumes may require root or Full Disk Access; Linux Btrfs/LVM snapshots require root or equivalent capabilities. `backend: 'auto'` must never block ordinary use: it falls back to `portable-cas` when the service, filesystem, or permission is unavailable. Use `nativeSnapshotCapabilities(root)` to show the permission requirement before offering an elevated action.

The application preference is persistent: `store.setNativeSnapshotMode('auto')` stores the choice in SQLite and all later snapshots use it until changed to `portable-cas` or `native`. This does not install a system component or permanently grant OS privileges; the operating system may still require the hosting process to run elevated when a native snapshot is created.

`compressContext` builds a durable deterministic context view from the event ledger: it keeps the task anchor and high-value events, extracts labeled decisions, facts, constraints, and next steps into proposed memory claims with evidence links, persists omitted source IDs, and supports reversible expansion with `expandCompressionView`. `compressMemorySnapshot` remains the grouped view for an existing memory snapshot.
