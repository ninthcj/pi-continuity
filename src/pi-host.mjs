import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ContinuityStore, ScopeError, CheckpointError } from './core.mjs';
import { createContinuityModelRuntime, assertContinuityReady } from './pi-sdk.mjs';

/**
 * Create a real Pi SDK session with continuity attached to the SDK's own
 * ModelRuntime. The SDK is injected for deterministic tests; production
 * callers may omit it and install @earendil-works/pi-coding-agent 0.85.1.
 */
export async function createContinuityPiSession({
  sdk,
  cwd = process.cwd(),
  dbPath = join(cwd, '.pi', 'continuity.db'),
  mode = 'active',
  budget = 12000,
  projectId = resolve(cwd),
  branch,
  goal,
  acceptance = [],
  constraints = [],
  modelRuntime,
  countRequestTokens,
  inputBudget,
  outputReserve,
  ...sessionOptions
} = {}) {
  const pi = sdk ?? await import('@earendil-works/pi-coding-agent');
  if (!goal) throw new TypeError('goal is required when creating a continuity session');
  mkdirSync(resolve(cwd, '.pi'), { recursive: true });
  const actualBranch = branch ?? (() => { try { return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'detached'; } catch { return 'unknown'; } })();
  const store = new ContinuityStore(dbPath, { mode });
  const task = store.createTask(projectId, actualBranch, goal, { acceptance, constraints });
  const piAgentDir = sessionOptions.agentDir ?? (typeof pi.getAgentDir === 'function' ? pi.getAgentDir() : join(homedir(), '.pi', 'agent'));
  const runtime = modelRuntime ?? await pi.ModelRuntime.create({
    authPath: sessionOptions.authPath ?? join(piAgentDir, 'auth.json'),
    modelsPath: sessionOptions.modelsPath ?? join(piAgentDir, 'models.json'),
    refreshOnCreate: false,
  });
  const gatedRuntime = createContinuityModelRuntime(runtime, store, task.task_id, { budget, countRequestTokens, inputBudget, outputReserve });
  const replacementAware = sessionOptions.replacementAware === true;
  delete sessionOptions.replacementAware;
  const previousHostFlag = process.env.PI_CONTINUITY_HOST;
  const previousMode = process.env.PI_CONTINUITY_MODE;
  process.env.PI_CONTINUITY_HOST = '1';
  process.env.PI_CONTINUITY_MODE = mode;
  writeFileSync(join(cwd, '.pi', 'continuity-task.json'), JSON.stringify({ taskId: task.task_id }, null, 2));
  let sessionResult;
  try {
    if (replacementAware) {
      sessionResult = await createContinuityPiRuntime({ sdk: pi, cwd, store, taskId: task.task_id, modelRuntime: runtime, budget, countRequestTokens, inputBudget, outputReserve, ...sessionOptions });
    } else {
      sessionResult = await pi.createAgentSession({ ...sessionOptions, cwd, modelRuntime: gatedRuntime });
    }
  } catch (error) {
    if (previousHostFlag === undefined) delete process.env.PI_CONTINUITY_HOST; else process.env.PI_CONTINUITY_HOST = previousHostFlag;
    if (previousMode === undefined) delete process.env.PI_CONTINUITY_MODE; else process.env.PI_CONTINUITY_MODE = previousMode;
    store.close();
    throw error;
  }
  let unsubscribe;
  const recordEvidence = (source, payload, epoch) => {
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, 'utf8') > 8000) {
      const blobId = store.saveBlob(encoded);
      store.recordEvent(task.task_id, source, { blobId, bytes: Buffer.byteLength(encoded, 'utf8'), preview: encoded.slice(0, 1200) }, { epoch });
    } else {
      store.recordEvent(task.task_id, source, payload, { epoch });
    }
  };
  const seenUserMessages = new Set();
  const recordUserMessage = (message, entryId) => {
    if (message?.role !== 'user') return;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const content = Array.isArray(message.content)
      ? blocks.filter(block => block?.type === 'text').map(block => block.text).join(' ')
      : String(message.content ?? '');
    const images = blocks.filter(block => block?.type === 'image');
    const key = entryId ?? String(message.timestamp ?? '') + ':' + content + ':' + images.length;
    if (seenUserMessages.has(key)) return;
    seenUserMessages.add(key);
    const epoch = store.getTask(task.task_id).epoch;
    const payload = { text: content, sessionEntryId: entryId };
    if (images.length) payload.images = images;
    store.recordEvent(task.task_id, 'user_input', payload, { epoch });
  };
  const onSessionEvent = event => {
    const epoch = store.getTask(task.task_id).epoch;
    if (event.type === 'turn_start' || event.type === 'turn_end' || event.type === 'agent_settled' || event.type === 'queue_update' || event.type === 'compaction_start' || event.type === 'compaction_end' || event.type === 'auto_retry_start' || event.type === 'auto_retry_end') {
      store.recordWork(task.task_id, `pi_${event.type}`, event, { epoch });
    } else if (event.type === 'tool_execution_start') {
      recordEvidence('tool_call', { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }, epoch);
    } else if (event.type === 'tool_execution_end') {
      recordEvidence('tool_result', { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: event.result }, epoch);
    } else if (event.type === 'agent_end' && event.willRetry) {
      store.recordWork(task.task_id, 'pi_agent_retry', { willRetry: true }, { epoch });
    } else if (event.type === 'message_end') {
      recordUserMessage(event.message, event.message?.id);
    } else if (event.type === 'entry_appended') {
      recordEvidence('pi_session_entry', { entry: event.entry }, epoch);
    }
  };
  const bindSession = () => { unsubscribe?.(); unsubscribe = sessionResult.session.subscribe(onSessionEvent); };
  bindSession();
  if (replacementAware) {
    for (const method of ['newSession', 'switchSession', 'fork', 'importFromJsonl']) {
      if (typeof sessionResult[method] !== 'function') continue;
      const original = sessionResult[method].bind(sessionResult);
      sessionResult[method] = async (...args) => { const result = await original(...args); bindSession(); return result; };
    }
  }
  const close = async () => { unsubscribe?.(); if (typeof sessionResult.dispose === 'function') await sessionResult.dispose(); else sessionResult.session.dispose?.(); store.close(); if (previousHostFlag === undefined) delete process.env.PI_CONTINUITY_HOST; else process.env.PI_CONTINUITY_HOST = previousHostFlag; if (previousMode === undefined) delete process.env.PI_CONTINUITY_MODE; else process.env.PI_CONTINUITY_MODE = previousMode; };
  const checkpoint = async ({ files = [], pending = [], notes = [] } = {}) => {
    if (sessionResult.session.isStreaming) await sessionResult.session.agent?.waitForIdle?.();
    const current = store.getTask(task.task_id);
    const workspace = store.captureWorkspace(cwd, files);
    const memorySnapshot = store.createMemorySnapshot(task.task_id, { epoch: current.epoch, revision: current.revision, message: 'Pi checkpoint', author: 'host' });
    return store.handoff(task.task_id, { expectedRevision: current.revision, epoch: current.epoch, workspace, pending, notes, memorySnapshotId: memorySnapshot.snapshot_id });
  };
  const inspect = checkpointId => store.inspect(checkpointId, task.task_id);
  const correct = (change, expectedRevision = store.getTask(task.task_id).revision) => store.correct(task.task_id, expectedRevision, store.getTask(task.task_id).epoch, { ...change, sourceEvent: { actor: 'host', id: `host-correct-${Date.now()}` } });
  const resume = async (checkpointId, { mode: resumeMode = 'strict', files, importEventIds = [] } = {}) => {
    if (!replacementAware || typeof sessionResult.newSession !== 'function') throw new CheckpointError('resume requires replacement-aware SDK runtime');
    const checkpointRecord = store.inspect(checkpointId, task.task_id);
    const selected = files ?? (checkpointRecord.payload.workspace?.files ?? []).map(entry => typeof entry === 'string' ? entry : entry.path).filter(Boolean);
    const currentWorkspace = store.captureWorkspace(cwd, selected);
    const current = store.getTask(task.task_id);
    const resumed = store.forkResume(checkpointId, task.task_id, current.revision, { mode: resumeMode, currentWorkspace, importEventIds });
    try { await sessionResult.newSession(); return resumed; }
    catch (error) { try { store.transition(task.task_id, 'RECOVERY_REQUIRED', `session replacement failed: ${error.message}`); } catch {} throw error; }
  };
  const api = {
    ...sessionResult,
    task,
    store,
    modelRuntime: gatedRuntime,
    preflight: () => assertContinuityReady(store, task.task_id, { budget }),
    checkpoint,
    inspect,
    correct,
    resume,
    close,
  };
  // AgentSessionRuntime exposes `session` through a prototype getter;
  // spreading it would otherwise drop the live replacement session.
  Object.defineProperty(api, 'session', { enumerable: true, get: () => sessionResult.session });
  if (replacementAware) {
    for (const method of ['newSession', 'switchSession', 'fork', 'importFromJsonl', 'dispose']) {
      if (typeof sessionResult[method] === 'function') api[method] = (...args) => sessionResult[method](...args);
    }
  }
  return api;
}

/**
 * Create Pi's replacement-aware AgentSessionRuntime with the same continuity
 * store and gate on every newly created session. Use this for /new, /resume,
 * /fork and imported sessions so subscriptions and cwd-bound services are
 * rebuilt instead of being reused across a session boundary.
 */
export async function createContinuityPiRuntime({
  sdk,
  cwd = process.cwd(),
  agentDir,
  sessionManager,
  store,
  taskId,
  budget = 12000,
  modelRuntime,
  countRequestTokens,
  inputBudget,
  outputReserve,
  ...sessionOptions
} = {}) {
  const pi = sdk ?? await import('@earendil-works/pi-coding-agent');
  if (!store || !taskId) throw new TypeError('store and taskId are required');
  if (typeof pi.createAgentSessionRuntime !== 'function' || typeof pi.createAgentSessionServices !== 'function' || typeof pi.createAgentSessionFromServices !== 'function') {
    throw new TypeError('Pi SDK runtime replacement APIs are required');
  }
  const targetAgentDir = agentDir ?? (typeof pi.getAgentDir === 'function' ? pi.getAgentDir() : join(homedir(), '.pi', 'agent'));
  const targetSessionManager = sessionManager ?? pi.SessionManager.create(cwd);
  const createRuntime = async ({ cwd: targetCwd, agentDir: targetDir, sessionManager: targetManager, sessionStartEvent }) => {
    if (resolve(targetCwd) !== resolve(cwd)) throw new ScopeError('session replacement cwd is outside the bound project');
    const services = await pi.createAgentSessionServices({ cwd: targetCwd, agentDir: targetDir, modelRuntime });
    services.modelRuntime = createContinuityModelRuntime(services.modelRuntime, store, taskId, { budget, countRequestTokens, inputBudget, outputReserve });
    const result = await pi.createAgentSessionFromServices({ services, sessionManager: targetManager, sessionStartEvent, ...sessionOptions });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  return pi.createAgentSessionRuntime(createRuntime, { cwd, agentDir: targetAgentDir, sessionManager: targetSessionManager });
}
