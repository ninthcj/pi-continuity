import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { ContinuityStore, EpochMismatch, StaleRevision } from '../src/core.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'continuity-memory-recovery-'));
  const x = { root, store: new ContinuityStore(join(root, 'c.db'), { mode: 'active' }) };
  x.taskId = x.store.createTask('project', 'main', 'Recover only the chosen checkpoint').task_id;
  x.reopen = () => { x.store.close(); x.store = new ContinuityStore(join(root, 'c.db'), { mode: 'active' }); };
  t.after(() => {
    x.store.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('continuity-memory-recovery-'));
    rmSync(root, { recursive: true, force: true });
  });
  return x;
}
const claim = (value, extra = {}) => ({ subject: 'release', predicate: 'target', value, ...extra });
const checkpoint = (x, options = {}) => {
  const task = x.store.getTask(x.taskId);
  return x.store.createCheckpoint(x.taskId, { expectedRevision: task.revision, epoch: task.epoch, workspace: { root: x.root, files: [] }, ...options });
};
const counts = store => ['memory_claims', 'memory_versions', 'memory_conflicts', 'memory_snapshots', 'events'].map(table => store.row('SELECT COUNT(*) AS n FROM ' + table).n);

test('strict resume excludes later direct/candidate memories and conflicts from requests and compaction', t => {
  const x = fixture(t), { store, taskId } = x;
  store.recordMemoryClaim(taskId, 1, claim('staging'));
  const cp = checkpoint(x);
  const future = store.recordMemoryClaim(taskId, 1, claim('future-production')).memory;
  store.recordMemoryClaim(taskId, 1, { subject: 'future-candidate', predicate: 'decision', value: 'future-hidden', status: 'proposed', origin: 'compression' });
  store.forkResume(cp, taskId, 1);
  for (const context of [store.buildManifest(taskId), store.compressContext(taskId, { budget: 0 })]) assert.equal(JSON.stringify(context).includes('future-'), false);
  assert.equal(store.memoryConflicts(taskId).length, 0);
  assert.equal(store.recallMemory(taskId, 'future').length, 0);
  assert.equal(store.readMemory(future.memory_id, taskId).value, 'future-production', 'explicit history reads remain possible');
  assert.ok(store.memoryClaims(taskId, { includeHistory: true }).some(memory => memory.memory_id === future.memory_id));
  store.recordMemoryClaim(taskId, 2, { subject: 'new-epoch', predicate: 'verified', value: true });
  const cp2 = checkpoint(x);
  store.forkResume(cp2, taskId, 1);
  x.reopen();
  assert.deepEqual(x.store.memoryClaims(taskId).map(memory => memory.subject).sort(), ['new-epoch', 'release']);
});

test('a checkpoint pins claim status, origin and evidence before a later promotion', t => {
  const x = fixture(t), { store, taskId } = x;
  const first = store.recordMemoryClaim(taskId, 1, claim('staging', { status: 'proposed', origin: 'compression', evidenceIds: ['before'] })).memory;
  const snapshot = store.createMemorySnapshot(taskId, { includeCandidates: true });
  const cp = checkpoint(x, { memorySnapshotId: snapshot.snapshot_id });
  store.recordMemoryClaim(taskId, 1, claim('staging', { evidenceIds: ['after'] }));
  assert.deepEqual(store.memorySnapshot(snapshot.snapshot_id, taskId).memories[0].evidenceIds, ['before']);
  assert.equal(store.memorySnapshot(snapshot.snapshot_id, taskId).memories[0].status, 'proposed');
  store.forkResume(cp, taskId, 1);
  assert.equal(store.memoryClaims(taskId).length, 0);
  const restored = store.memoryClaims(taskId, { includeCandidates: true })[0];
  assert.equal(restored.version_id, first.version_id);
  assert.equal(restored.origin, 'compression');
  assert.equal(restored.status, 'proposed');
  assert.deepEqual(restored.evidenceIds, ['before']);
  const promoted = store.recordMemoryClaim(taskId, 2, claim('staging', { evidenceIds: ['current'] })).memory;
  assert.deepEqual(promoted.evidenceIds, ['before', 'current'], 'the abandoned future must not contribute evidence');
  assert.deepEqual(store.memorySnapshot(snapshot.snapshot_id, taskId).memories[0].evidenceIds, ['before']);
});

test('old-epoch new writes, duplicates, confirmation and promotion fail before any mutation', t => {
  const x = fixture(t), { store, taskId } = x;
  store.recordMemoryClaim(taskId, 1, claim('confirmed'));
  store.recordMemoryClaim(taskId, 1, claim('proposed', { status: 'proposed' }));
  store.recordMemoryClaim(taskId, 1, claim('candidate', { status: 'proposed', origin: 'compression' }));
  store.bumpEpoch(taskId, 1);
  const before = counts(store);
  for (const value of ['new', 'confirmed', 'proposed', 'candidate']) {
    assert.throws(() => store.recordMemoryClaim(taskId, 1, claim(value)), EpochMismatch);
    assert.deepEqual(counts(store), before);
  }
  assert.throws(() => store.recordMemoryClaim(taskId, 2, claim('new', { revision: 99 })), StaleRevision);
  assert.deepEqual(counts(store), before);
  assert.doesNotThrow(() => store.recordMemoryClaim(taskId, 2, claim('new')));
});

test('practical resume imports only explicitly selected memory events', t => {
  const x = fixture(t), { store, taskId } = x;
  store.recordMemoryClaim(taskId, 1, claim('staging'));
  const cp = checkpoint(x);
  const wanted = store.recordMemoryClaim(taskId, 1, { subject: 'wanted', predicate: 'result', value: 'verified' }).memory;
  const event = store.events(taskId).find(event => JSON.parse(event.payload).memoryId === wanted.memory_id);
  store.recordMemoryClaim(taskId, 1, { subject: 'unselected', predicate: 'result', value: 'future' });
  store.forkResume(cp, taskId, 1, { mode: 'practical', importEventIds: [event.event_id] });
  assert.deepEqual(store.memoryClaims(taskId).map(memory => memory.subject).sort(), ['release', 'wanted']);
});

test('legacy checkpoints without snapshot IDs obey the captured event horizon', t => {
  const x = fixture(t), { store, taskId } = x;
  store.recordMemoryClaim(taskId, 1, claim('before'));
  const cp = checkpoint(x);
  const payload = store.checkpoint(cp).payload;
  delete payload.memoryVersionIds; payload.format = 2;
  store.db.prepare('UPDATE checkpoints SET payload=? WHERE checkpoint_id=?').run(JSON.stringify(payload), cp);
  store.recordMemoryClaim(taskId, 1, claim('after'));
  store.forkResume(cp, taskId, 1);
  assert.deepEqual(store.memoryClaims(taskId).map(memory => memory.value), ['before']);
});

test('legacy databases reconstruct frozen snapshot versions from audited transitions', t => {
  const x = fixture(t), { store, taskId } = x;
  store.recordMemoryClaim(taskId, 1, claim('staging', { status: 'proposed', origin: 'compression', evidenceIds: ['before'] }));
  const snapshot = store.createMemorySnapshot(taskId, { includeCandidates: true });
  const cp = checkpoint(x, { memorySnapshotId: snapshot.snapshot_id });
  const payload = store.checkpoint(cp).payload;
  delete payload.memoryVersionIds; payload.format = 2;
  store.db.prepare('UPDATE checkpoints SET payload=? WHERE checkpoint_id=?').run(JSON.stringify(payload), cp);
  store.recordMemoryClaim(taskId, 1, claim('staging', { evidenceIds: ['after'] }));
  store.db.exec("DROP TABLE memory_snapshot_versions; DROP TABLE memory_versions; DELETE FROM meta WHERE key='memory_versions_migrated';");
  x.reopen();
  assert.equal(x.store.memorySnapshot(snapshot.snapshot_id, taskId).memories[0].status, 'proposed');
  x.store.forkResume(cp, taskId, 1);
  assert.deepEqual(x.store.memoryClaims(taskId, { includeCandidates: true })[0].evidenceIds, ['before']);
});

test('forking a memory snapshot preserves versions after the live claim changes', t => {
  const x = fixture(t), { store, taskId } = x;
  store.recordMemoryClaim(taskId, 1, claim('staging', { status: 'proposed', evidenceIds: ['before'] }));
  const snapshot = store.createMemorySnapshot(taskId);
  store.recordMemoryClaim(taskId, 1, claim('staging', { evidenceIds: ['after'] }));
  const fork = store.forkMemorySnapshot(snapshot.snapshot_id, taskId);
  assert.equal(fork.tree_hash, snapshot.tree_hash);
  assert.equal(fork.memories[0].status, 'proposed');
  assert.deepEqual(fork.memories[0].evidenceIds, ['before']);
});

test('stale snapshot creation and imported bundles leave no partial memory state', t => {
  const x = fixture(t), { store, taskId } = x;
  store.bumpEpoch(taskId, 1);
  const before = counts(store);
  assert.throws(() => store.createMemorySnapshot(taskId, { epoch: 1 }), EpochMismatch);
  assert.throws(() => store.createMemorySnapshot(taskId, { revision: 99 }), StaleRevision);
  assert.throws(() => store.importMemory(taskId, 1, { format: 'pi-continuity-memory-bundle-v1', claims: [claim('stale')] }), EpochMismatch);
  assert.deepEqual(counts(store), before);
});

test('an imported duplicate uses the version visible when it was recorded after recovery', t => {
  const x = fixture(t), { store, taskId } = x;
  const original = store.recordMemoryClaim(taskId, 1, claim('staging', { status: 'proposed', origin: 'compression', evidenceIds: ['before'] })).memory;
  const cp = checkpoint(x);
  store.recordMemoryClaim(taskId, 1, claim('staging', { evidenceIds: ['abandoned-future'] }));
  store.forkResume(cp, taskId, 1);
  store.recordMemoryClaim(taskId, 2, claim('staging', { status: 'proposed', origin: 'compression', evidenceIds: ['before'] }));
  const duplicate = store.events(taskId).findLast(event => event.source === 'memory_duplicate');
  store.forkResume(cp, taskId, 1, { mode: 'practical', importEventIds: [duplicate.event_id] });
  const restored = store.memoryClaims(taskId, { includeCandidates: true })[0];
  assert.equal(restored.version_id, original.version_id);
  assert.equal(restored.status, 'proposed');
  assert.equal(restored.origin, 'compression');
  assert.deepEqual(restored.evidenceIds, ['before']);
});
