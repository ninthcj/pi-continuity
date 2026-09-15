import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { ContinuityStore, GateError } from '../src/core.mjs';
import { countTextTokens, renderCompression } from '../src/context-budget.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'continuity-compression-scale-'));
  const store = new ContinuityStore(join(root, 'c.db'), { mode: 'active' });
  const taskId = store.createTask('project', 'main', 'Finish the original goal').task_id;
  t.after(() => {
    store.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('continuity-compression-scale-'));
    rmSync(root, { recursive: true, force: true });
  });
  return { store, taskId };
}

test('large compression uses logarithmic full measurements and retains exact budget enforcement', t => {
  const { store, taskId } = fixture(t);
  store.recordEvent(taskId, 'user_input', { text: '用户纠正：只更新测试环境，完整完成所有待办。' });
  for (let i = 0; i < 512; i++) store.recordEvent(taskId, 'tool_result', { output: 'diagnostic evidence '.repeat(35) + i });
  const view = store.compressContext(taskId, { budget: 900 });
  assert.ok(view.metrics.fullMeasurements <= 16, 'hundreds of removals must not cause hundreds of full tokenization passes');
  assert.equal(view.tokensAfter, countTextTokens(renderCompression(view)));
  assert.ok(view.tokensAfter <= 900);
  assert.ok(view.instructions.some(note => note.text.includes('完整完成')));
  assert.equal(store.expandCompressionView(view.viewId, taskId, { includeOmitted: true }).events.length, view.sourceEventIds.length);
});

test('unchanged compactions reuse projections and do not re-extract old observations', t => {
  const { store, taskId } = fixture(t);
  store.recordEvent(taskId, 'model_response', { text: 'Decision: preserve source events\nNext step: verify the release' });
  for (let i = 0; i < 64; i++) store.recordEvent(taskId, 'tool_result', { output: 'ordinary evidence '.repeat(30) + i });
  const first = store.compressContext(taskId, { budget: 1200 });
  const versions = store.row('SELECT COUNT(*) AS n FROM memory_versions').n;
  const second = store.compressContext(taskId, { budget: 1200 });
  assert.equal(second.metrics.extractedEvents, 0);
  assert.ok(second.metrics.decodedEvents < 5);
  assert.equal(store.row('SELECT COUNT(*) AS n FROM memory_versions').n, versions);
  assert.deepEqual(second.extracted.map(memory => memory.memoryId).sort(), first.extracted.map(memory => memory.memoryId).sort());
});

test('failed compaction cannot advance incremental extraction or leave candidate versions behind', t => {
  const { store, taskId } = fixture(t);
  store.recordEvent(taskId, 'model_response', { text: 'Decision: retain atomic progress' });
  const before = store.row('SELECT COUNT(*) AS n FROM memory_versions').n;
  assert.throws(() => store.compressContext(taskId, { budget: 1 }), GateError);
  assert.equal(store.row('SELECT COUNT(*) AS n FROM memory_versions').n, before);
  assert.equal(store.row('SELECT COUNT(*) AS n FROM compression_extraction_cursors').n, 0);
  const result = store.compressContext(taskId, { budget: 1500 });
  assert.ok(result.extracted.some(memory => memory.value === 'retain atomic progress'));
});
