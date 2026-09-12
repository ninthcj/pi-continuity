import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContinuityStore, ContinuityError, GateError } from '../src/core.mjs';
import { FakeProvider, PiAdapter, SideEffectTool } from '../src/adapter.mjs';

const setup = () => {
  const d = mkdtempSync(join(tmpdir(), 'pi-reliability-'));
  const store = new ContinuityStore(join(d, 'c.db'), { mode: 'active' });
  const task = store.createTask('project', 'main', 'ship feature', { constraints: ['keep API'] });
  return { d, store, task };
};
const close = ({ d, store }) => { store.close(); rmSync(d, { recursive: true, force: true }); };

test('active adapter sends the immutable continuity manifest to the provider', () => {
  const x = setup();
  const provider = new FakeProvider(['ok']);
  new PiAdapter(x.store, x.task.task_id, provider).request({ messages: [{ role: 'user', content: 'continue' }] });
  assert.equal(provider.calls.length, 1);
  assert.match(JSON.stringify(provider.calls[0]), /keep API/);
  assert.match(JSON.stringify(provider.calls[0]), /continuity/);
  close(x);
});

test('model proposals do not mutate the active contract', () => {
  const x = setup();
  const proposed = x.store.updateContract(x.task.task_id, 1, 1, { constraints: ['model invented'] });
  assert.deepEqual(proposed.constraints, ['keep API']);
  assert.equal(proposed.revision, 1);
  assert.equal(x.store.events(x.task.task_id).at(-1).source, 'model_proposal');
  close(x);
});

test('unknown operation is held for reconciliation and never replayed', () => {
  const x = setup();
  x.store.beginOperation(x.task.task_id, 1, 'write', 'uncertain');
  x.store.close();
  x.store = new ContinuityStore(join(x.d, 'c.db'), { mode: 'active' });
  const tool = new SideEffectTool(() => 'must not run');
  assert.throws(() => new PiAdapter(x.store, x.task.task_id, new FakeProvider()).runSideEffect('x', tool, { opId: 'uncertain' }), GateError);
  assert.equal(tool.calls.length, 0);
  x.store.reconcileOperation(x.task.task_id, 1, 'uncertain', 'succeeded', { reconciled: true }, { actor: 'host', sourceEvent: { actor: 'host', id: 'confirm-1' } });
  assert.deepEqual(new PiAdapter(x.store, x.task.task_id, new FakeProvider()).runSideEffect('x', tool, { opId: 'uncertain' }), { reconciled: true });
  assert.equal(tool.calls.length, 0);
  close(x);
});

test('provider failure is recorded and never leaks a credential-shaped payload', () => {
  const x = setup();
  const provider = { calls: [], complete(messages) { this.calls.push(messages); throw new Error('provider down'); } };
  assert.throws(() => new PiAdapter(x.store, x.task.task_id, provider).request({ messages: [{ role: 'user', content: 'x' }] }));
  const sources = x.store.events(x.task.task_id).map(e => e.source);
  assert.ok(sources.includes('model_error'));
  close(x);
});

test('resume transitions runtime back to RUNNING and stale checkpoint evidence stays isolated', () => {
  const x = setup();
  const cid = x.store.createCheckpoint(x.task.task_id, { expectedRevision: 1, epoch: 1, workspace: { root: x.d, files: [] } });
  x.store.recordEvent(x.task.task_id, 'user_input', { text: 'later' });
  const resumed = x.store.forkResume(cid, x.task.task_id, 1);
  assert.equal(resumed.epoch, 2);
  assert.equal(x.store.runtimeState(x.task.task_id).state, 'RUNNING');
  assert.equal(x.store.checkpointEvents(cid, x.task.task_id).some(e => JSON.parse(e.payload).text === 'later'), false);
  close(x);
});

test('correct creates a new confirmed contract revision without rewriting checkpoints', () => {
  const x = setup();
  const cid = x.store.createCheckpoint(x.task.task_id, { expectedRevision: 1, epoch: 1, workspace: { root: x.d, files: [] } });
  const updated = x.store.correct(x.task.task_id, 1, 1, { constraints: ['new confirmed limit'], sourceEvent: { actor: 'host', id: 'confirm-2' } });
  assert.equal(updated.revision, 2);
  assert.deepEqual(x.store.inspect(cid, x.task.task_id).payload.workspace.files, []);
  assert.equal(x.store.inspect(cid, x.task.task_id).revision, 1);
  close(x);
});

test('manifest remains bounded across a long raw input stream while retaining the task anchor', () => {
  const x = setup();
  for (let i = 0; i < 200; i++) x.store.recordEvent(x.task.task_id, 'user_input', { text: `follow-up ${i} ${'x'.repeat(100)}` });
  const manifest = x.store.buildManifest(x.task.task_id, { budget: 12000, recent: 8 });
  assert.ok(manifest.events.length <= 10);
  assert.ok(manifest.events.some(event => JSON.parse(JSON.stringify(event.payload)).text === undefined || event.payload.text === undefined));
  assert.equal(manifest.goal, 'ship feature');
  close(x);
});

test('notes are evidence-linked and confirmations are host-controlled', () => {
  const x = setup();
  assert.throws(() => x.store.recordNote(x.task.task_id, 1, 'unsafe', { status: 'confirmed' }), ContinuityError);
  const note = x.store.recordNote(x.task.task_id, 1, 'expensive finding', { evidenceIds: ['evt-1'], status: 'confirmed', sourceEvent: { actor: 'host', id: 'note-1' } });
  const manifest = x.store.buildManifest(x.task.task_id);
  assert.equal(note.status, 'confirmed');
  assert.equal(manifest.notes[0].evidenceIds[0], 'evt-1');
  close(x);
});

test('long events are archived as redacted blobs before their event reference is committed', () => {
  const x = setup();
  x.store.recordEvent(x.task.task_id, 'tool_result', { output: 'x'.repeat(20000), apiKey: 'secret' });
  const event = x.store.events(x.task.task_id).at(-1);
  const payload = JSON.parse(event.payload);
  assert.equal(payload.truncated, true);
  assert.ok(payload.blobId);
  assert.ok(x.store.row('SELECT COUNT(*) AS n FROM blobs').n >= 1);
  close(x);
});
