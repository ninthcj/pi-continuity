import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContinuityPiSession, createContinuityPiRuntime } from '../src/pi-host.mjs';
import { GateError } from '../src/core.mjs';

test('real SDK host binds the continuity runtime and records Pi entries', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-host-'));
  const calls = [];
  const sdk = {
    async createAgentSession({ modelRuntime }) {
      const listeners = [];
      return { session: {
        subscribe(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
        async prompt() { modelRuntime.streamSimple({ provider: 'fake', id: 'fake' }, { systemPrompt: '', messages: [] }); listeners.forEach(fn => fn({ type: 'entry_appended', entry: { type: 'message', message: { role: 'user', content: 'x' } } })); },
        dispose() {},
      } };
    },
  };
  const baseRuntime = { streamSimple(_model, context) { calls.push(context); return {}; } };
  const result = await createContinuityPiSession({ sdk, modelRuntime: baseRuntime, cwd, goal: 'host test' });
  await result.session.prompt('go');
  assert.equal(calls.length, 1);
  assert.match(calls[0].systemPrompt, /continuity manifest/);
  assert.ok(result.store.events(result.task.task_id).some(event => event.source === 'pi_session_entry'));
  result.store.transition(result.task.task_id, 'RECOVERY_REQUIRED', 'test');
  assert.throws(() => result.preflight(), GateError);
  await result.close();
  rmSync(cwd, { recursive: true, force: true });
});

test('replacement-aware SDK runtime recreates a gated session in the same project scope', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-runtime-'));
  const host = await createContinuityPiSession({
    sdk: {
      async createAgentSession() { return { session: { subscribe() { return () => {}; }, dispose() {} } }; },
    },
    modelRuntime: { streamSimple() { return {}; } },
    cwd,
    goal: 'runtime test',
  });
  const store = host.store;
  const taskId = store.row('SELECT task_id FROM tasks').task_id;
  const calls = [];
  const sdk = {
    SessionManager: { create: () => ({}) },
    async createAgentSessionServices() { return { modelRuntime: { streamSimple(_m, context) { calls.push(context); return {}; } }, diagnostics: [] }; },
    async createAgentSessionFromServices({ services }) { return { session: { subscribe() { return () => {}; }, dispose() {}, services } }; },
    async createAgentSessionRuntime(factory, options) { const first = await factory({ cwd: options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager }); return { session: first.session, async newSession() { const next = await factory({ cwd: options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager }); this.session = next.session; } }; },
  };
  const runtime = await createContinuityPiRuntime({ sdk, cwd, store, taskId, modelRuntime: {} });
  await runtime.newSession();
  assert.ok(runtime.session);
  await host.close();
  rmSync(cwd, { recursive: true, force: true });
});

test('host checkpoint and resume coordinate a new epoch with replacement-aware runtime', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-resume-'));
  let creations = 0;
  const sdk = {
    SessionManager: { create: () => ({}) },
    async createAgentSessionServices() { return { modelRuntime: { streamSimple() { return {}; } }, diagnostics: [] }; },
    async createAgentSessionFromServices() { creations++; return { session: { isStreaming: false, subscribe() { return () => {}; }, dispose() {} } }; },
    async createAgentSessionRuntime(factory, options) {
      const make = async () => (await factory({ cwd: options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager })).session;
      const runtime = { session: await make(), async newSession() { this.session = await make(); }, async dispose() { this.session.dispose(); } };
      return runtime;
    },
  };
  const host = await createContinuityPiSession({ sdk, modelRuntime: { streamSimple() { return {}; } }, cwd, goal: 'resume test', replacementAware: true });
  const cid = await host.checkpoint();
  const resumed = await host.resume(cid);
  assert.equal(resumed.epoch, 2);
  assert.equal(creations, 2);
  await host.close();
  rmSync(cwd, { recursive: true, force: true });
});
