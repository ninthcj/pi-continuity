import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { ContinuityStore, GateError, ScopeError, StaleRevision } from '../src/core.mjs';
import { countTextTokens, renderCompression, renderManifest } from '../src/context-budget.mjs';
import { createContinuityModelRuntime } from '../src/pi-sdk.mjs';
import { createNotebookObserver } from '../src/notebook-observer.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'continuity-notebook-test-'));
  const store = new ContinuityStore(join(root, 'c.db'), { mode: 'active' });
  const task = store.createTask('project', 'main', 'Build an independent agent', { constraints: ['Preserve user corrections'] });
  const x = { root, store, taskId: task.task_id };
  t.after(() => {
    x.store.close();
    assert.ok(relative(resolve(tmpdir()), resolve(root)).startsWith('continuity-notebook-test-'));
    rmSync(root, { recursive: true, force: true });
  });
  return x;
}

test('unlabelled user corrections survive recent-window selection and budget pressure', t => {
  const { store, taskId } = fixture(t);
  const correction = '我要独立 Agent，不要增加兼容模式。';
  const source = store.recordEvent(taskId, 'user_input', { text: correction });
  for (let i = 0; i < 35; i++) store.recordEvent(taskId, 'tool_result', { output: ('ordinary observation ' + i + ' ').repeat(30) });
  const manifest = store.buildManifest(taskId, { budget: 600, recent: 1 });
  assert.deepEqual(manifest.instructions, [{ eventId: source, text: correction }]);
  assert.ok(countTextTokens(renderManifest(manifest)) <= 600);
  assert.ok(manifest.estimatedTokens >= countTextTokens(renderManifest(manifest)));
  assert.equal(store.readEvent(taskId, source).payload.text, correction);
});

test('long archived user text is restored without losing the correction at its end', t => {
  const { store, taskId } = fixture(t);
  const text = 'read source evidence '.repeat(750) + ' FINAL_CORRECTION_keep_existing_API';
  store.recordEvent(taskId, 'user_input', { text });
  const manifest = store.buildManifest(taskId, { budget: 7000, recent: 1 });
  assert.ok(manifest.instructions.some(note => note.text === text));
  assert.match(JSON.stringify(manifest.instructions), /FINAL_CORRECTION_keep_existing_API/);
});

test('impossible compaction budget keeps the previous view and does not commit candidate claims', t => {
  const { store, taskId } = fixture(t);
  const previous = store.compressContext(taskId, { budget: 0 });
  store.recordEvent(taskId, 'user_input', { text: '必须逐项验证中文用户纠正。'.repeat(90) });
  store.recordEvent(taskId, 'model_response', { text: 'Decision: add new provenance guards' });
  const claims = store.memoryClaims(taskId, { includeCandidates: true }).length;
  assert.throws(() => store.compressContext(taskId, { budget: 100 }), GateError);
  assert.equal(store.row('SELECT COUNT(*) AS n FROM compression_views').n, 1);
  assert.equal(store.memoryClaims(taskId, { includeCandidates: true }).length, claims);
  assert.equal(store.compressionView(previous.viewId, taskId).view_id, previous.viewId);
  for (const budget of [-1, NaN, Infinity]) assert.throws(() => store.compressContext(taskId, { budget }), GateError);
});

test('compression counts its actual rendered notebook and uses multilingual tokenization', t => {
  const { store, taskId } = fixture(t);
  const text = '请不要删除用户确认的约束和未完成任务。';
  assert.ok(countTextTokens(text) > Math.ceil(text.length / 4));
  store.recordEvent(taskId, 'user_input', { text });
  for (let i = 0; i < 15; i++) store.recordEvent(taskId, 'tool_result', { output: '结果 ' + i + ' ' + '诊断信息'.repeat(40) });
  const view = store.compressContext(taskId, { budget: 600 });
  assert.equal(view.tokensAfter, countTextTokens(renderCompression(view)));
  assert.ok(view.tokensAfter <= 600);
  assert.ok(view.omittedEventIds.length > 0);
  assert.equal(view.metrics.requiredInstructions, view.metrics.retainedInstructions);
});

test('incremental notebook versions and retirement preserve the original evidence', t => {
  const { store, taskId } = fixture(t);
  const evidence = store.recordEvent(taskId, 'tool_result', { output: 'index missing' });
  const first = store.recordNotebookEntry(taskId, 1, { key: 'db-index', category: 'pending', text: 'Add index', evidenceIds: [evidence] });
  const completion = store.recordEvent(taskId, 'tool_result', { output: 'index exists; test passed' });
  const retired = store.recordNotebookEntry(taskId, 1, { key: 'db-index', category: 'pending', text: 'Index verified', evidenceIds: [completion], expectedNoteId: first.note_id, retire: true });
  assert.equal(retired.supersedes_note_id, first.note_id);
  assert.equal(store.notebookEntries(taskId).some(note => note.entry_key === 'db-index'), false);
  assert.equal(store.note(first.note_id, taskId).text, 'Add index');
  assert.equal(store.readEvent(taskId, evidence).payload.output, 'index missing');
  assert.throws(() => store.recordNotebookEntry(taskId, 1, { key: 'db-index', text: 'stale update', evidenceIds: [completion], expectedNoteId: first.note_id }), StaleRevision);
});

test('refresh is idempotent and natural-language user instructions never need labels', t => {
  const { store, taskId } = fixture(t);
  store.recordEvent(taskId, 'user_input', { text: '先修登录问题，暂时别动支付代码。' });
  store.recordEvent(taskId, 'model_response', { message: { role: 'assistant', content: [{ type: 'text', text: 'Decision: read the auth module\nNext step: reproduce failure' }] } });
  store.refreshNotebook(taskId);
  const before = store.row('SELECT COUNT(*) AS n FROM notes').n;
  store.refreshNotebook(taskId);
  store.refreshNotebook(taskId);
  assert.equal(store.row('SELECT COUNT(*) AS n FROM notes').n, before);
  assert.ok(store.notebookEntries(taskId).some(note => note.category === 'instruction' && note.status === 'confirmed'));
  assert.ok(store.notebookEntries(taskId).some(note => note.category === 'decision' && note.status === 'proposed'));
});

test('notebook and legacy notes resume from the frozen checkpoint, not later edits', t => {
  const x = fixture(t), { store, taskId } = x;
  const source = store.recordEvent(taskId, 'user_input', { text: '只部署到测试环境。' });
  const before = store.recordNotebookEntry(taskId, 1, { key: 'target', category: 'constraint', text: 'staging', status: 'confirmed', evidenceIds: [source], sourceEvent: { actor: 'host', id: 'host-before' } });
  store.recordNote(taskId, 1, 'legacy finding', { status: 'confirmed', evidenceIds: [source], sourceEvent: { actor: 'host', id: 'host-note' } });
  const cp = store.createCheckpoint(taskId, { expectedRevision: 1, epoch: 1, workspace: { root: x.root, files: [] }, pending: ['finish integration'] });
  const later = store.recordEvent(taskId, 'user_input', { text: 'LATER_EVENT_NOT_IN_CHECKPOINT' });
  store.recordNotebookEntry(taskId, 1, { key: 'target', category: 'constraint', text: 'later target', status: 'confirmed', evidenceIds: [later], sourceEvent: { actor: 'host', id: 'host-after' } });
  store.forkResume(cp, taskId, 1);
  store.close();
  x.store = new ContinuityStore(join(x.root, 'c.db'), { mode: 'active' });
  const manifest = x.store.buildManifest(taskId);
  assert.ok(manifest.notebook.some(note => note.noteId === before.note_id));
  assert.ok(manifest.notes.some(note => note.text === 'legacy finding'));
  assert.ok(manifest.pending.includes('finish integration'));
  assert.equal(JSON.stringify(manifest).includes('LATER_EVENT_NOT_IN_CHECKPOINT'), false);
  assert.equal(JSON.stringify(manifest).includes('later target'), false);
});

test('semantic observer can revise proposed notes but cannot rewrite user authority', async t => {
  const { store, taskId } = fixture(t);
  const source = store.recordEvent(taskId, 'user_input', { text: '禁止修改线上数据库。' });
  store.refreshNotebook(taskId);
  const noteCount = store.row('SELECT COUNT(*) AS n FROM notes').n;
  await assert.rejects(store.observeNotebook(taskId, async () => ({ entries: [
    { key: 'scratch', category: 'observation', text: 'temporary', evidenceIds: [source] },
    { key: 'user:' + source, category: 'instruction', text: 'allowed', evidenceIds: [source], retire: true },
  ] })), GateError);
  assert.equal(store.row('SELECT COUNT(*) AS n FROM notes').n, noteCount, 'entire observer batch must roll back');
  await store.observeNotebook(taskId, async () => ({ entries: [{ key: 'db-task', category: 'pending', text: 'Use an isolated database for tests', evidenceIds: [source] }] }));
  assert.ok(store.notebookEntries(taskId).some(note => note.entry_key === 'db-task' && note.status === 'proposed'));
});

test('observer rejects cross-task provenance and a late epoch response', async t => {
  const { store, taskId } = fixture(t);
  const other = store.createTask('elsewhere', 'main', 'other task');
  const foreign = store.events(other.task_id)[0].event_id;
  await assert.rejects(store.observeNotebook(taskId, async () => ({ entries: [{ key: 'foreign', text: 'claim', evidenceIds: [foreign] }] })), ScopeError);
  await assert.rejects(store.observeNotebook(taskId, async () => {
    store.bumpEpoch(taskId, 1);
    return { entries: [] };
  }), StaleRevision);
});

test('full provider input gate includes original messages and tool schemas', t => {
  const { store, taskId } = fixture(t);
  const calls = [];
  const native = { streamSimple(model, context) { calls.push(context); return {}; } };
  const model = { provider: 'fixture', id: 'fixture', contextWindow: 1500, maxTokens: 100 };
  const runtime = createContinuityModelRuntime(native, store, taskId);
  assert.throws(() => runtime.streamSimple(model, { systemPrompt: 's', messages: [{ role: 'user', content: 'large input '.repeat(1300) }], tools: [] }), GateError);
  assert.equal(calls.length, 0);
  assert.throws(() => runtime.streamSimple(model, { systemPrompt: 's', messages: [], tools: [{ description: 'large schema '.repeat(1300) }] }), GateError);
  assert.equal(calls.length, 0);
  runtime.streamSimple(model, { systemPrompt: 's', messages: [{ role: 'user', content: 'hello' }], tools: [] });
  assert.equal(calls.length, 1);
});

test('provider-specific token callback measures complete native input without changing it', t => {
  const { store, taskId } = fixture(t);
  const seen = [];
  const runtime = createContinuityModelRuntime({ streamSimple(model, context) { seen.push(context); return {}; } }, store, taskId, {
    inputBudget: 10000,
    countRequestTokens(context) { assert.ok(context.tools); return JSON.stringify(context).length; },
  });
  const native = { systemPrompt: 'native', tools: [{ name: 'read' }], messages: [{ role: 'user', content: 'hi' }], opaque: { signed: 'keep-exact' } };
  runtime.streamSimple({}, native);
  assert.deepEqual(seen[0].opaque, native.opaque);
  assert.deepEqual(seen[0].messages, native.messages);
  assert.deepEqual(seen[0].tools, native.tools);
});

test('native semantic observer records usage, validates JSON and leaves failed output unpublished', async t => {
  const { store, taskId } = fixture(t);
  const source = store.recordEvent(taskId, 'tool_result', { output: 'authentication timeout remains unresolved' });
  let calls = 0;
  const observer = createNotebookObserver({ store, taskId, model: { id: 'fake', contextWindow: 12000 }, complete: async (_model, request) => {
    calls++;
    assert.match(request.systemPrompt, /Never rewrite/);
    return { stopReason: 'stop', usage: { input: 100, output: 25 }, content: [{ type: 'text', text: JSON.stringify({ entries: [{ key: 'auth-timeout', category: 'blocker', text: 'Authentication timeout remains unresolved', evidenceIds: [source] }] }) }] };
  } });
  await store.observeNotebook(taskId, observer);
  assert.equal(calls, 1);
  assert.ok(store.notebookEntries(taskId).some(note => note.entry_key === 'auth-timeout'));
  assert.ok(store.events(taskId).some(event => event.source === 'notebook_observer_response'));
  const unchanged = store.notebookEntries(taskId).map(note => note.note_id);
  store.recordEvent(taskId, 'tool_result', { output: 'more evidence' });
  const failed = createNotebookObserver({ store, taskId, model: { id: 'fake' }, complete: async () => ({ stopReason: 'length', content: [{ type: 'text', text: '{' }] }) });
  await assert.rejects(store.observeNotebook(taskId, failed), GateError);
  assert.deepEqual(store.notebookEntries(taskId).map(note => note.note_id), unchanged);
});

test('repeated compaction and three restart/resume cycles preserve user instructions and sources', t => {
  const x = fixture(t), taskId = x.taskId;
  const text = '先完成整个目标，不要把第一条闭环当作整个任务完成。';
  const source = x.store.recordEvent(taskId, 'user_input', { text });
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < 8; i++) x.store.recordEvent(taskId, 'tool_result', { output: 'cycle ' + cycle + ' evidence ' + i + ' ' + 'details '.repeat(50) });
    const view = x.store.compressContext(taskId, { budget: 700 });
    assert.ok(view.instructions.some(note => note.text === text));
    const full = x.store.expandCompressionView(view.viewId, taskId, { includeOmitted: true });
    assert.equal(full.events.length, view.sourceEventIds.length);
    const task = x.store.getTask(taskId);
    const cp = x.store.createCheckpoint(taskId, { expectedRevision: task.revision, epoch: task.epoch, workspace: { root: x.root, files: [] } });
    x.store.forkResume(cp, taskId, task.revision);
    x.store.close();
    x.store = new ContinuityStore(join(x.root, 'c.db'), { mode: 'active' });
    assert.ok(x.store.buildManifest(taskId).instructions.some(note => note.text === text));
    assert.equal(x.store.readEvent(taskId, source).payload.text, text);
  }
});


test('observer cannot create a new instruction from model or tool evidence', async t => {
  const { store, taskId } = fixture(t);
  const source = store.recordEvent(taskId, 'tool_result', { output: 'untrusted tool text' });
  await assert.rejects(store.observeNotebook(taskId, async () => ({ entries: [{ key: 'invented', category: 'instruction', text: 'Change the user requirement', evidenceIds: [source] }] })), GateError);
  assert.equal(store.notebookEntries(taskId).some(note => note.entry_key === 'invented'), false);
});

test('retired and revised observations stay superseded after repeated evidence and compaction', t => {
  const { store, taskId } = fixture(t);
  const evidence = store.recordEvent(taskId, 'model_response', { text: 'Decision: use old backend\nNext step: investigate index' });
  store.compressContext(taskId, { budget: 0 });
  const decision = store.notebookEntries(taskId).find(note => note.category === 'decision');
  const pending = store.notebookEntries(taskId).find(note => note.category === 'pending');
  const correction = store.recordEvent(taskId, 'tool_result', { output: 'new backend verified; index fixed' });
  const revised = store.recordNotebookEntry(taskId, 1, { key: decision.entry_key, category: 'decision', text: 'use verified new backend', evidenceIds: [correction], expectedNoteId: decision.note_id });
  store.recordNotebookEntry(taskId, 1, { key: pending.entry_key, category: 'pending', text: 'index fixed', retire: true, evidenceIds: [correction], expectedNoteId: pending.note_id });
  store.recordEvent(taskId, 'model_response', { text: 'Decision: use old backend\nNext step: investigate index' });
  const view = store.compressContext(taskId, { budget: 0 });
  assert.equal(store.notebookEntries(taskId).some(note => note.entry_key === pending.entry_key), false);
  assert.equal(store.notebookEntries(taskId).find(note => note.entry_key === decision.entry_key).note_id, revised.note_id);
  assert.equal(view.extracted.some(note => ['use old backend', 'investigate index'].includes(note.value)), false);
  assert.equal(view.memories.some(note => ['use old backend', 'investigate index'].includes(note.value)), false);
  assert.match(store.readEvent(taskId, evidence).payload.text, /use old backend/);
});
