import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContinuityStore } from '../src/core.mjs';
import { PiAdapter } from '../src/adapter.mjs';

const setup = () => {
  const d = mkdtempSync(join(tmpdir(), 'pi-memory-'));
  const store = new ContinuityStore(join(d, 'c.db'), { mode: 'active' });
  const task = store.createTask('project', 'main', 'ship feature');
  return { d, store, task };
};
const close = ({ d, store }) => { store.close(); rmSync(d, { recursive: true, force: true }); };
const confirmed = (value, id) => ({ subject: 'api', predicate: 'compatibility', value, status: 'confirmed', sourceEvent: { actor: 'host', id } });

test('memory claims deduplicate normalized values and retain evidence', () => {
  const x = setup();
  const first = x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'api', predicate: 'compatibility', value: 'Backward Compatible', status: 'proposed', evidenceIds: ['evt-a'] });
  const confirmedProposal = x.store.recordMemoryClaim(x.task.task_id, 1, { ...confirmed('  backward   compatible ', 'm-2'), evidenceIds: ['evt-b'] });
  const duplicate = x.store.recordMemoryClaim(x.task.task_id, 1, { ...confirmed('BACKWARD COMPATIBLE', 'm-3'), evidenceIds: ['evt-c'] });
  assert.equal(first.kind, 'new');
  assert.equal(confirmedProposal.kind, 'confirmed');
  assert.equal(duplicate.kind, 'duplicate');
  assert.equal(duplicate.memory.memory_id, first.memory.memory_id);
  assert.equal(confirmedProposal.memory.status, 'confirmed');
  assert.deepEqual(confirmedProposal.memory.evidenceIds, ['evt-a', 'evt-b']);
  close(x);
});

test('scoped memory recall returns bounded previews and full reads stay explicit', () => {
  const x = setup();
  const memory = x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'database', predicate: 'engine', value: 'SQLite', status: 'confirmed', scope: 'project', sourceEvent: { actor: 'host', id: 'recall-1' }, evidenceIds: ['evt-db'] }).memory;
  x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'database', predicate: 'engine', value: 'Postgres', status: 'proposed', scope: 'task' });
  const recalled = x.store.recallMemory(x.task.task_id, 'database engine sqlite', { scope: 'project' });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].memory_id, memory.memory_id);
  assert.ok(recalled[0].preview.length <= 500);
  assert.deepEqual(x.store.readMemory(memory.memory_id, x.task.task_id).evidenceIds, ['evt-db']);
  close(x);
});

test('conflicting claims remain visible while snapshots provide rollback history', () => {
  const x = setup();
  const left = x.store.recordMemoryClaim(x.task.task_id, 1, confirmed('backward compatible', 'm-left'));
  const right = x.store.recordMemoryClaim(x.task.task_id, 1, confirmed('breaking changes allowed', 'm-right'));
  assert.equal(right.kind, 'conflict');
  assert.equal(right.conflicts.length, 1);
  assert.equal(x.store.memoryConflicts(x.task.task_id).length, 1);
  const conflictColumns = x.store.db.prepare('PRAGMA table_info(memory_conflicts)').all().map(c => c.name);
  assert.deepEqual(conflictColumns, ['conflict_id','task_id','project_id','branch','conflict_key','left_memory_id','right_memory_id','created_at']);
  const claimColumns = x.store.db.prepare('PRAGMA table_info(memory_claims)').all().map(c => c.name);
  assert.equal(claimColumns.includes('supersedes_memory_id'), false);
  assert.equal('memoryConflicts' in x.store.buildManifest(x.task.task_id), true);
  assert.equal('openMemoryConflicts' in x.store.buildManifest(x.task.task_id), false);
  assert.doesNotThrow(() => x.store.buildManifest(x.task.task_id));
  const provider = { calls: 0, complete() { this.calls++; return 'ok'; } };
  new PiAdapter(x.store, x.task.task_id, provider).request({ messages: [] });
  assert.equal(provider.calls, 1);
  close(x);
});

test('three-way memory merge keeps both parents, auto-merges independent claims, and preserves history', () => {
  const x = setup();
  const baseClaim = x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'api', predicate: 'compatibility', value: 'backward', status: 'confirmed', sourceEvent: { actor: 'host', id: 'base' } }).memory;
  const base = x.store.createMemorySnapshot(x.task.task_id, { memoryIds: [baseClaim.memory_id], message: 'base' });
  const testClaim = x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'tests', predicate: 'required', value: 'unit', status: 'proposed' }).memory;
  const ours = x.store.createMemorySnapshot(x.task.task_id, { parentIds: [base.snapshot_id], memoryIds: [baseClaim.memory_id, testClaim.memory_id], message: 'ours' });
  const docsClaim = x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'docs', predicate: 'required', value: 'readme', status: 'proposed' }).memory;
  const theirs = x.store.createMemorySnapshot(x.task.task_id, { parentIds: [base.snapshot_id], memoryIds: [baseClaim.memory_id, docsClaim.memory_id], message: 'theirs' });
  const proposal = x.store.proposeMemoryMerge(x.task.task_id, { baseSnapshotId: base.snapshot_id, oursSnapshotId: ours.snapshot_id, theirsSnapshotId: theirs.snapshot_id });
  assert.equal(proposal.status, 'ready');
  assert.equal(proposal.conflicts.length, 0);
  const merged = x.store.commitMemoryMerge(x.task.task_id, proposal.mergeId, { sourceEvent: { actor: 'host', id: 'merge-1' } });
  assert.deepEqual(merged.parentIds, [ours.snapshot_id, theirs.snapshot_id]);
  assert.deepEqual(merged.memories.map(m => m.memory_id).sort(), [baseClaim.memory_id, testClaim.memory_id, docsClaim.memory_id].sort());
  assert.equal(x.store.memorySnapshot(base.snapshot_id, x.task.task_id).memories.length, 1);
  close(x);
});

test('three-way merge chooses a current claim while preserving both parent histories', () => {
  const x = setup();
  const baseClaim = x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'deploy', predicate: 'target', value: 'staging', status: 'confirmed', sourceEvent: { actor: 'host', id: 'base' } }).memory;
  const base = x.store.createMemorySnapshot(x.task.task_id, { memoryIds: [baseClaim.memory_id] });
  const oursClaim = x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'deploy', predicate: 'target', value: 'production', status: 'proposed' }).memory;
  const ours = x.store.createMemorySnapshot(x.task.task_id, { parentIds: [base.snapshot_id], memoryIds: [oursClaim.memory_id] });
  const theirsClaim = x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'deploy', predicate: 'target', value: 'preview', status: 'proposed' }).memory;
  const theirs = x.store.createMemorySnapshot(x.task.task_id, { parentIds: [base.snapshot_id], memoryIds: [theirsClaim.memory_id] });
  const proposal = x.store.proposeMemoryMerge(x.task.task_id, { baseSnapshotId: base.snapshot_id, oursSnapshotId: ours.snapshot_id, theirsSnapshotId: theirs.snapshot_id });
  assert.equal(proposal.status, 'ready');
  assert.equal(proposal.conflicts.length, 1);
  const merged = x.store.commitMemoryMerge(x.task.task_id, proposal.mergeId);
  assert.deepEqual(merged.memories.map(m => m.memory_id), [theirsClaim.memory_id]);
  assert.equal(x.store.memorySnapshot(base.snapshot_id, x.task.task_id).memories[0].value, 'staging');
  close(x);
});

test('portable bundles and deterministic compression preserve claim sources', () => {
  const x = setup();
  x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'db', predicate: 'engine', value: 'sqlite' });
  x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'db', predicate: 'engine', value: 'postgres' });
  const bundle = x.store.exportMemory(x.task.task_id);
  assert.equal(bundle.format, 'pi-continuity-memory-bundle-v1');
  const compact = x.store.compressMemorySnapshot(bundle.sourceSnapshot.snapshotId, x.task.task_id);
  assert.equal(compact.claimCount, 2);
  assert.equal(compact.groups[0].memoryIds.length, 2);
  close(x);
});

test('manifest compression trims context without deleting memory history', () => {
  const x = setup();
  for (let i = 0; i < 30; i++) x.store.recordEvent(x.task.task_id, 'model_response', { text: 'context '.repeat(80), i });
  x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'history', predicate: 'kept', value: true });
  const manifest = x.store.buildManifest(x.task.task_id, { budget: 900, recent: 30 });
  assert.equal(manifest.compressed, true);
  assert.ok(x.store.memoryClaims(x.task.task_id).some(m => m.subject === 'history'));
  close(x);
});

test('portable workspace snapshots do not depend on git and retain old file bytes', () => {
  const x = setup();
  const root = join(x.d, 'workspace');
  const file = join(root, 'note.txt');
  mkdirSync(root);
  writeFileSync(file, 'before');
  const snap = x.store.createWorkspaceSnapshot(x.task.task_id, { root, files: ['note.txt'] });
  writeFileSync(file, 'after');
  assert.equal(x.store.workspaceSnapshot(snap.snapshot_id, x.task.task_id).backend, 'portable-cas');
  assert.equal(x.store.readWorkspaceSnapshotFile(snap.snapshot_id, x.task.task_id, 'note.txt').toString(), 'before');
  close(x);
});

test('native snapshot capability probing is side-effect free', () => {
  const x = setup();
  const caps = x.store.nativeSnapshotCapabilities(x.d);
  assert.equal(typeof caps.platform, 'string');
  assert.equal(typeof caps.available, 'boolean');
  close(x);
});

test('native snapshot backend mode persists as an application feature setting', () => {
  const x = setup();
  assert.equal(x.store.nativeSnapshotMode(), 'portable-cas');
  assert.equal(x.store.setNativeSnapshotMode('auto'), 'auto');
  assert.equal(x.store.nativeSnapshotMode(), 'auto');
  close(x);
});

test('memory history is readable across task epochs without a freshness gate', () => {
  const x = setup();
  const claim = x.store.recordMemoryClaim(x.task.task_id, 99, { subject: 'history', predicate: 'epoch', value: 99, status: 'proposed' }).memory;
  assert.equal(x.store.readMemory(claim.memory_id, x.task.task_id).value, 99);
  assert.equal(x.store.recallMemory(x.task.task_id, 'history epoch 99').length, 1);
  close(x);
});

test('compression extracts key claims and can expand omitted history', () => {
  const x = setup();
  x.store.recordEvent(x.task.task_id, 'model_response', { text: 'Decision: use SQLite\nNext step: add an index' });
  for (let i = 0; i < 12; i++) x.store.recordEvent(x.task.task_id, 'tool_result', { output: `verbose result ${i} ${'x'.repeat(180)}` });
  const view = x.store.compressContext(x.task.task_id, { budget: 700 });
  assert.equal(view.format, 'pi-continuity-compression-v1');
  assert.ok(view.extracted.some(claim => claim.predicate === 'decision'));
  assert.ok(view.extracted.some(claim => claim.predicate === 'next_step'));
  assert.ok(view.omittedEventIds.length > 0);
  assert.ok(view.tokensAfter <= 700);
  const reopened = x.store.compressionView(view.viewId, x.task.task_id);
  assert.deepEqual(reopened.omittedEventIds, view.omittedEventIds);
  const expanded = x.store.expandCompressionView(view.viewId, x.task.task_id, { includeOmitted: true });
  assert.equal(expanded.events.length, view.sourceEventIds.length);
  assert.ok(expanded.memories.some(memory => memory.predicate === 'decision'));
  close(x);
});

test('compression preserves full extracted claims when no budget is imposed', () => {
  const x = setup();
  const decision = `Decision: ${'retain this architectural decision '.repeat(80)}`;
  x.store.recordEvent(x.task.task_id, 'model_response', { text: decision });
  const view = x.store.compressContext(x.task.task_id, { budget: 0 });
  const claim = view.extracted.find(item => item.predicate === 'decision');
  assert.ok(claim.value.length > 600);
  assert.equal(view.omittedEventIds.length, 0);
  close(x);
});

test('compression candidates stay separate from authoritative memory until promoted', () => {
  const x = setup();
  const candidate = x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'deploy', predicate: 'target', value: 'preview', status: 'proposed', origin: 'compression', evidenceIds: ['evt-compress'] }).memory;
  assert.equal(candidate.origin, 'compression');
  assert.equal(x.store.memoryClaims(x.task.task_id).length, 0);
  assert.equal(x.store.memoryClaims(x.task.task_id, { includeCandidates: true }).length, 1);
  assert.equal(x.store.recallMemory(x.task.task_id, 'deploy target').length, 0);
  assert.equal(x.store.recallMemory(x.task.task_id, 'deploy target', { includeCandidates: true }).length, 1);
  const promoted = x.store.recordMemoryClaim(x.task.task_id, 1, { subject: 'deploy', predicate: 'target', value: 'preview', status: 'confirmed', evidenceIds: ['evt-direct'] });
  assert.equal(promoted.kind, 'promoted');
  assert.equal(x.store.memoryClaims(x.task.task_id)[0].origin, 'direct');
  assert.deepEqual(x.store.memoryClaims(x.task.task_id)[0].evidenceIds, ['evt-compress', 'evt-direct']);
  close(x);
});
