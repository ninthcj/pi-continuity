import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { ContinuityStore, GateError, StaleRevision } from '../src/core.mjs';
import { createNotebookObserver } from '../src/notebook-observer.mjs';
import { countRequest } from '../src/context-budget.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'continuity-observer-progress-'));
  const x = { root, store: new ContinuityStore(join(root, 'c.db'), { mode: 'active' }) };
  x.taskId = x.store.createTask('project', 'main', 'Keep source evidence and unfinished work').task_id;
  x.reopen = () => { x.store.close(); x.store = new ContinuityStore(join(root, 'c.db'), { mode: 'active' }); };
  t.after(() => {
    x.store.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('continuity-observer-progress-'));
    rmSync(root, { recursive: true, force: true });
  });
  return x;
}
const progress = x => x.store.row('SELECT * FROM notebook_observer_progress WHERE task_id=? AND epoch=?', x.taskId, x.store.getTask(x.taskId).epoch);
const input = request => JSON.parse(request.messages[0].content[0].text);

test('oversized events advance in complete contiguous fragments across restart and reach later evidence', async t => {
  const x = fixture(t), ranges = [];
  const source = x.store.recordEvent(x.taskId, 'tool_result', { output: '日志 中文 🚀 '.repeat(900) + ' TAIL_OBSERVER_MARKER' });
  const later = x.store.recordEvent(x.taskId, 'tool_result', { output: 'FOLLOWUP_OBSERVER_MARKER' });
  const original = JSON.stringify(x.store.readEvent(x.taskId, source).payload);
  let calls = 0, lastProgress = 0;
  for (let batch = 0; batch < 40; batch++) {
    const observer = createNotebookObserver({ store: x.store, taskId: x.taskId, model: { id: 'fixture' }, inputBudget: 2000, complete: async (_model, request) => {
      calls++;
      assert.ok(countRequest(request).tokens <= 2000);
      const entries = [];
      for (const event of input(request).events) {
        const payload = event.payload;
        const text = payload.fragment ? payload.text : JSON.stringify(payload);
        if (event.eventId === source) ranges.push(payload.fragment ? payload : { from: 0, to: text.length, totalChars: text.length, text });
        if (text.includes('TAIL_OBSERVER_MARKER')) entries.push({ key: 'tail', category: 'observation', text: 'Tail evidence reached', evidenceIds: [source] });
        if (event.eventId === later) entries.push({ key: 'followup', category: 'pending', text: 'Follow-up evidence reached', evidenceIds: [later] });
      }
      return JSON.stringify({ entries });
    } });
    await x.store.observeNotebook(x.taskId, observer, { maxEvents: 16 });
    const current = progress(x);
    if (current) {
      assert.ok(current.offset > lastProgress, 'each successful partial batch must move forward');
      lastProgress = current.offset;
    }
    if (batch === 0) { assert.ok(current, 'the first batch must leave a durable fragment cursor'); x.reopen(); }
    if (x.store.notebookEntries(x.taskId).some(note => note.entry_key === 'followup')) break;
  }
  assert.ok(calls > 1);
  assert.ok(x.store.notebookEntries(x.taskId).some(note => note.entry_key === 'tail'));
  assert.ok(x.store.notebookEntries(x.taskId).some(note => note.entry_key === 'followup'));
  assert.equal(progress(x), undefined);
  assert.equal(ranges.map(range => range.text).join(''), original, 'every source character, including Unicode, must be observed exactly once');
  assert.equal(ranges[0].from, 0);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].from, ranges[i - 1].to);
  assert.equal(ranges.at(-1).to, original.length);
});

test('invalid observer output rolls back the fragment offset and retries the same source range', async t => {
  const x = fixture(t);
  x.store.recordEvent(x.taskId, 'tool_result', { output: 'large tool output '.repeat(2000) });
  const requests = [];
  let invalid = false;
  const observer = createNotebookObserver({ store: x.store, taskId: x.taskId, model: {}, inputBudget: 1400, complete: async (_model, request) => {
    requests.push(input(request).events);
    return invalid ? '{' : '{"entries":[]}';
  } });
  await x.store.observeNotebook(x.taskId, observer);
  const saved = progress(x);
  assert.ok(saved.offset > 0);
  invalid = true;
  await assert.rejects(x.store.observeNotebook(x.taskId, observer), SyntaxError);
  assert.deepEqual(progress(x), saved);
  invalid = false;
  await x.store.observeNotebook(x.taskId, observer);
  assert.deepEqual(requests[1], requests[2]);
  assert.ok(progress(x).offset > saved.offset);
});

test('large notebooks are selected within budget without deleting excluded notes', async t => {
  const x = fixture(t);
  const source = x.store.recordEvent(x.taskId, 'tool_result', { output: 'Verify authentication failure' });
  for (let i = 0; i < 25; i++) x.store.recordNotebookEntry(x.taskId, 1, { key: 'topic-' + i, text: 'Historical diagnostic note '.repeat(80), evidenceIds: [source] });
  const before = x.store.notebookEntries(x.taskId).map(note => note.note_id);
  let selection;
  const observer = createNotebookObserver({ store: x.store, taskId: x.taskId, model: {}, inputBudget: 1800, complete: async (_model, request) => {
    assert.ok(countRequest(request).tokens <= 1800);
    selection = input(request).notebookSelection;
    return '{"entries":[]}';
  } });
  await x.store.observeNotebook(x.taskId, observer);
  assert.ok(selection.supplied < selection.total);
  assert.deepEqual(x.store.notebookEntries(x.taskId).map(note => note.note_id), before);
});

test('late native observer response does not write response evidence into the new epoch', async t => {
  const x = fixture(t);
  const observer = createNotebookObserver({ store: x.store, taskId: x.taskId, model: {}, complete: async () => {
    x.store.bumpEpoch(x.taskId, 1);
    return '{"entries":[]}';
  } });
  await assert.rejects(x.store.observeNotebook(x.taskId, observer), StaleRevision);
  assert.equal(x.store.events(x.taskId).some(event => event.source === 'notebook_observer_response'), false);
  assert.equal(progress(x), undefined);
});

test('cancelled native observation cannot advance a fragment cursor', async t => {
  const x = fixture(t), controller = new AbortController();
  x.store.recordEvent(x.taskId, 'tool_result', { output: 'long text '.repeat(1200) });
  const observer = createNotebookObserver({ store: x.store, taskId: x.taskId, model: {}, inputBudget: 1400, complete: async () => {
    controller.abort();
    return '{"entries":[]}';
  } });
  await assert.rejects(x.store.observeNotebook(x.taskId, observer, { signal: controller.signal }), GateError);
  assert.equal(progress(x), undefined);
});


test('checkpoint recovery continues the frozen source fragment and excludes later events', async t => {
  const x = fixture(t), seen = [];
  const source = x.store.recordEvent(x.taskId, 'tool_result', { output: 'recover this source '.repeat(1600) });
  const makeObserver = () => createNotebookObserver({ store: x.store, taskId: x.taskId, model: {}, inputBudget: 1600, complete: async (_model, request) => {
    seen.push(...input(request).events);
    return '{"entries":[]}';
  } });
  await x.store.observeNotebook(x.taskId, makeObserver());
  const offset = progress(x).offset;
  const cp = x.store.createCheckpoint(x.taskId, { expectedRevision: 1, epoch: 1, workspace: { root: x.root, files: [] } });
  const future = x.store.recordEvent(x.taskId, 'tool_result', { output: 'ABANDONED_FUTURE_EVENT' });
  x.store.forkResume(cp, x.taskId, 1);
  x.reopen();
  const before = seen.length;
  await x.store.observeNotebook(x.taskId, makeObserver());
  assert.equal(seen[before].eventId, source);
  assert.equal(seen[before].payload.from, offset);
  for(let i=0;i<30 && x.store.notebook.observerState(x.taskId).rows.length;i++) await x.store.observeNotebook(x.taskId, makeObserver());
  assert.equal(x.store.notebook.observerState(x.taskId).rows.length, 0);
  assert.equal(seen.some(event => event.eventId === future), false);
  const pieces = seen.filter(event => event.eventId === source).map(event => event.payload.fragment ? event.payload.text : JSON.stringify(event.payload));
  assert.equal(pieces.join(''), JSON.stringify(x.store.readEvent(x.taskId, source).payload));
});

test('a large archived resume payload retains its entire observer source queue', async t => {
  const x = fixture(t);
  const sources = x.store.notebook.observerState(x.taskId).rows.map(row => row.event_id);
  for (let i = 0; i < 260; i++) sources.push(x.store.recordEvent(x.taskId, 'tool_result', { output: 'source ' + i }));
  const cp = x.store.createCheckpoint(x.taskId, { expectedRevision: 1, epoch: 1, workspace: { root: x.root, files: [] } });
  const future = x.store.recordEvent(x.taskId, 'tool_result', { output: 'future' });
  x.store.forkResume(cp, x.taskId, 1);
  const resume = x.store.events(x.taskId).findLast(event => event.source === 'resume');
  assert.ok(JSON.parse(resume.payload).blobId, 'this fixture must exercise the archived resume path');
  x.reopen();
  assert.deepEqual(x.store.notebook.observerState(x.taskId).rows.map(row => row.event_id), sources);
  const seen = [];
  while (x.store.notebook.observerState(x.taskId).rows.length) {
    await x.store.observeNotebook(x.taskId, async ({ events }) => { seen.push(...events.map(event => event.event_id)); return { entries: [] }; }, { maxEvents: 128 });
  }
  assert.deepEqual(seen, sources);
  assert.equal(seen.includes(future), false);
});
