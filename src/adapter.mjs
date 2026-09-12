import { GateError, EpochMismatch } from './core.mjs';

export class FakeProvider {
  constructor(responses = ['continue']) { this.responses = [...responses]; this.calls = []; }
  complete(messages) { this.calls.push(messages); return this.responses.shift() ?? 'continue'; }
}

export class SideEffectTool {
  constructor(fn) { this.fn = fn; this.calls = []; }
  run(arg) { this.calls.push(arg); return this.fn(arg); }
}

/** The host boundary owns the final provider call and gate. */
export class PiAdapter {
  constructor(store, taskId, provider) { this.store = store; this.taskId = taskId; this.provider = provider; }

  request({ messages, budget = 12000 }) {
    if (this.store.mode === 'off') return this.provider.complete(messages);
    this.store.startRun(this.taskId);
    const manifest = this.store.buildManifest(this.taskId, { budget });
    const effectiveMessages = this.store.mode === 'active'
      ? [{ role: 'system', content: `[continuity manifest]\n${JSON.stringify(manifest)}` }, ...messages]
      : messages;
    const requestBlobId = this.store.saveBlob(JSON.stringify({ messages: effectiveMessages }));
    this.store.recordEvent(this.taskId, 'model_request', { manifestId: manifest.manifestId, requestBlobId });
    try {
      const result = this.provider.complete(effectiveMessages);
      this.store.recordEvent(this.taskId, 'model_response', { text: result });
      return result;
    } catch (error) {
      this.store.recordEvent(this.taskId, 'model_error', { error: String(error) });
      throw error;
    }
  }

  runSideEffect(arg, tool, { opId } = {}) {
    const task = this.store.getTask(this.taskId);
    const oid = this.store.beginOperation(this.taskId, task.epoch, 'tool', opId);
    const existing = this.store.operation(oid);
    if (existing?.status === 'succeeded' || existing?.status === 'failed') {
      return existing.result == null ? undefined : JSON.parse(existing.result);
    }
    if (existing?.status === 'unknown') throw new GateError(`operation ${oid} is unknown; reconcile before retry`);
    this.store.recordEvent(this.taskId, 'tool_call', { opId: oid, arg }, { epoch: task.epoch, opId: oid });
    this.store.recordWork(this.taskId, 'tool_execution_intent', { opId: oid, arg }, { epoch: task.epoch });
    try {
      const result = tool.run(arg);
      this.store.finishOperation(this.taskId, task.epoch, oid, 'succeeded', result);
      this.store.recordWork(this.taskId, 'tool_execution_result', { opId: oid, status: 'succeeded' }, { epoch: task.epoch });
      return result;
    } catch (error) {
      this.store.finishOperation(this.taskId, task.epoch, oid, 'failed', { error: String(error) });
      this.store.recordWork(this.taskId, 'tool_execution_result', { opId: oid, status: 'failed' }, { epoch: task.epoch });
      throw error;
    }
  }

  rejectLate(epoch) { if (this.store.getTask(this.taskId).epoch !== epoch) throw new EpochMismatch('late adapter result'); }
}
