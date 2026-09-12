import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContinuityStore, GateError } from '../src/core.mjs';
import { createContinuityModelRuntime } from '../src/pi-sdk.mjs';

test('Pi SDK runtime wrapper gates and injects manifest at stream boundary', () => {
  const d = mkdtempSync(join(tmpdir(), 'pi-sdk-'));
  const store = new ContinuityStore(join(d, 'c.db'), { mode: 'active' });
  const task = store.createTask('p', 'main', 'keep task state', { constraints: ['do not reset'] });
  const calls = [];
  const runtime = { streamSimple(model, context) { calls.push({ model, context }); return { end() {} }; } };
  const gated = createContinuityModelRuntime(runtime, store, task.task_id);
  gated.streamSimple({ provider: 'fake', id: 'model' }, { systemPrompt: 'base', messages: [] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].context.systemPrompt, /continuity manifest/);
  assert.match(calls[0].context.systemPrompt, /do not reset/);
  store.transition(task.task_id, 'RECOVERY_REQUIRED', 'test');
  assert.throws(() => gated.streamSimple({}, { systemPrompt: '', messages: [] }), GateError);
  assert.equal(calls.length, 1);
  store.close();
  rmSync(d, { recursive: true, force: true });
});
