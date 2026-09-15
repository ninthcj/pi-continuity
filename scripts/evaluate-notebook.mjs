import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';
import { ModelRuntime, getAgentDir } from '@earendil-works/pi-coding-agent';
import { ContinuityStore } from '../src/core.mjs';
import { createNotebookObserver } from '../src/notebook-observer.mjs';

if (!process.argv.includes('--live')) {
  console.error('Explicit live evaluation only: node scripts/evaluate-notebook.mjs --live [--output report.json]');
  process.exit(2);
}
const value = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const agentDir = getAgentDir();
const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
const provider = value('--provider') ?? settings.defaultProvider;
const modelId = value('--model') ?? settings.defaultModel;
const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false });
const model = runtime.getModel(provider, modelId);
if (!model || !runtime.hasConfiguredAuth(provider)) throw new Error('The selected Pi model is not configured for live evaluation');
const root = mkdtempSync(join(tmpdir(), 'continuity-live-evaluation-'));
const report = { date: new Date().toISOString(), provider, model: modelId, data: 'synthetic fixtures only', cases: [], calls: [] };
let store;
const connect = () => { store = new ContinuityStore(join(root, 'c.db'), { mode: 'active' }); };
connect();
const rows = taskId => store.notebookEntries(taskId, { includeRetired: true });
const active = taskId => rows(taskId).filter(note => note.status !== 'retired' && note.category !== 'instruction');
const blocked = (taskId, pattern) => active(taskId).some(note => ['pending', 'blocker'].includes(note.category) && pattern.test(note.text));
const restore = taskId => {
  const task = store.getTask(taskId);
  const cp = store.createCheckpoint(taskId, { expectedRevision: task.revision, epoch: task.epoch, workspace: { root, files: [] } });
  store.forkResume(cp, taskId, task.revision);
  store.close(); connect();
};
const observe = async (caseName, taskId, { inputBudget = 6000 } = {}) => {
  for (let batch = 0; batch < 10; batch++) {
    if (!store.notebook.observerState(taskId).rows.length) return;
    if (report.calls.length >= 14) throw new Error('Evaluation call limit reached');
    const observer = createNotebookObserver({ store, taskId, model, inputBudget, maxTokens: 1200, complete: async (nativeModel, context, options) => {
      const start = performance.now();
      const response = await runtime.completeSimple(nativeModel, context, { ...options, temperature: 0 });
      report.calls.push({ case: caseName, batch, milliseconds: Math.round(performance.now() - start), stopReason: response.stopReason, usage: response.usage, sourceEventIds:JSON.parse(context.messages[0].content[0].text).events.map(event=>event.eventId), observations:(response.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n') });
      console.error('Completed live notebook batch ' + report.calls.length + ' (' + caseName + ')');
      return response;
    } });
    await store.observeNotebook(taskId, observer, { maxEvents: 16, signal: AbortSignal.timeout(60000) });
  }
  if (store.notebook.observerState(taskId).rows.length) throw new Error('Evaluation source queue did not drain within its batch limit');
};
const runCase = async (name, action) => {
  try { await action(); } catch (error) { report.cases.push({ name, passed: false, error: { name: error.name, message: error.message } }); }
};
const finish = (name, taskId, checks, stages) => {
  const notes = rows(taskId).map(note => ({ key: note.entry_key, category: note.category, status: note.status, text: note.text }));
  report.cases.push({ name, passed: Object.values(checks).every(Boolean), checks, stages, notes });
};

try {
  await runCase('failed-plan', async () => {
    const taskId = store.createTask('evaluation', 'main', 'Validate the staging migration plan').task_id;
    const correction = '用户纠正：仅允许在 staging 验证，禁止更改 production。';
    store.recordEvent(taskId, 'user_input', { text: correction });
    store.recordEvent(taskId, 'model_response', { text: 'I intend to run a migration. This is a plan; no command has been executed.' });
    store.recordEvent(taskId, 'tool_result', { output: 'Connection to staging failed (ECONNREFUSED). No migration ran. No tests passed.' });
    await observe('failed-plan', taskId);
    const failureRetained = blocked(taskId, /staging|connection|连接/i);
    const firstView = store.compressContext(taskId, { budget: 3000 });
    restore(taskId);
    store.recordEvent(taskId, 'tool_result', { output: 'Connection to staging succeeded. Dry-run validation passed. No production deployment was performed.' });
    await observe('failed-plan', taskId);
    const finalView = store.compressContext(taskId, { budget: 3000 });
    finish('failed-plan', taskId, {
      failureRetained,
      correctionSurvivedCompactionAndRecovery: [firstView, finalView].every(view => view.instructions.some(note => note.text === correction)),
      resolvedConnectionNotStillBlocked: !blocked(taskId, /connection.*(?:failed|refused)|连接.*失败|ECONNREFUSED/i),
      modelObservationsRemainProposed: active(taskId).every(note => note.status === 'proposed'),
    }, 2);
  });
  await runCase('partial-completion', async () => {
    const taskId = store.createTask('evaluation', 'main', 'Fix authentication and billing; finish both requested fixes').task_id;
    const correction = 'Do not mark the whole task complete after the first fix.';
    store.recordEvent(taskId, 'user_input', { text: correction });
    const evidence = store.recordEvent(taskId, 'tool_result', { output: 'Authentication requests time out. Billing integration is unverified.' });
    store.recordNotebookEntry(taskId, 1, { key: 'auth-timeout', category: 'pending', text: 'Resolve the authentication timeout and verify its test.', evidenceIds: [evidence] });
    await observe('partial-completion', taskId);
    store.compressContext(taskId, { budget: 3000 }); restore(taskId);
    store.recordEvent(taskId, 'tool_result', { output: 'Authentication timeout fixed; the auth test passed. Billing integration test failed with an invoice mismatch. The overall task is unfinished.' });
    await observe('partial-completion', taskId);
    const authRetired = rows(taskId).some(note => note.entry_key === 'auth-timeout' && note.status === 'retired');
    const billingStillPending = blocked(taskId, /billing|invoice|计费|账单/i);
    store.compressContext(taskId, { budget: 3000 }); restore(taskId);
    store.recordEvent(taskId, 'tool_result', { output: 'Billing integration test now passed. The auth regression test also passed. Both requested fixes are verified.' });
    await observe('partial-completion', taskId);
    const finalView = store.compressContext(taskId, { budget: 3000 });
    finish('partial-completion', taskId, {
      completedAuthItemRetired: authRetired,
      unrelatedBillingFailureRemainedPending: billingStillPending,
      verifiedBillingNoLongerPending: !blocked(taskId, /billing|invoice|计费|账单/i),
      wholeTaskCorrectionRetained: finalView.instructions.some(note => note.text === correction),
    }, 3);
  });
  await runCase('large-event-tail', async () => {
    const taskId = store.createTask('evaluation', 'main', 'Read the entire large diagnostic result, including its final failure').task_id;
    store.recordEvent(taskId, 'tool_result', { output: 'Progress: processed a synthetic record; no final result yet. '.repeat(220) + '\nFINAL RESULT: backup verification failed due to a checksum mismatch. The release remains blocked.' });
    await observe('large-event-tail', taskId, { inputBudget: 2200 });
    const view = store.compressContext(taskId, { budget: 3000 });
    finish('large-event-tail', taskId, {
      finalFailureRetained: blocked(taskId, /checksum|backup|校验|备份/i),
      allSourceFragmentsProcessed: store.notebook.observerState(taskId).rows.length === 0,
      compressionWithinBudget: view.tokensAfter <= 3000,
    }, 1);
  });
} catch (error) {
  report.error = { name: error.name, message: error.message };
} finally {
  store.close();
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('continuity-live-evaluation-'));
  rmSync(root, { recursive: true, force: true });
}
report.passed = !report.error && report.cases.length === 3 && report.cases.every(item => item.passed);
report.scope = 'A small development fixture set used to refine the observer prompt; not a held-out benchmark or a general quality guarantee.';
const encoded = JSON.stringify(report, null, 2);
if (value('--output')) writeFileSync(resolve(value('--output')), encoded + '\n');
console.log(encoded);
if (!report.passed) process.exitCode = 1;
