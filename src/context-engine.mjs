import { randomUUID } from 'node:crypto';
import { checkedCount, measureManifest, renderCompression, renderManifest, validateBudget } from './context-budget.mjs';
import { labelledObservations, visibleText, observationKey } from './notebook.mjs';

const id = prefix => prefix + '_' + randomUUID().replaceAll('-', '');
const noteProjection = note => ({ noteId: note.note_id, category: note.category ?? 'observation', status: note.status, text: note.text, evidenceIds: note.evidenceIds });
const memoryProjection = memory => ({ memoryId: memory.memory_id, scope: memory.scope, subject: memory.subject, predicate: memory.predicate, value: memory.value, status: memory.status, evidenceIds: memory.evidenceIds, origin: memory.origin });
const requiredNote = note => note.status === 'confirmed';
const eventText = payload => {
  const refs=[];
  const collect=value=>{if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object'){if(value.kind==='image'||value.type==='image')refs.push(value);else Object.values(value).forEach(collect)}};
  collect(payload);
  const text=visibleText(payload);
  return text ? text+(refs.length?'\nAssets: '+JSON.stringify(refs):'') : JSON.stringify(payload);
};
const usefulSources = new Set(['user_input', 'user_confirmation', 'resume', 'model_response', 'tool_call', 'tool_result', 'model_error', 'image']);

export class ContextEngine {
  constructor(store, errors) { this.store = store; this.errors = errors; }

  ready(taskId) {
    const state = this.store.runtimeState(taskId)?.state;
    if (['FAILED', 'RECOVERY_REQUIRED', 'QUIESCING', 'PERSISTING', 'BUILDING', 'VALIDATING'].includes(state)) throw new this.errors.GateError('continuity runtime state is ' + state);
    return this.store.getTask(taskId);
  }

  budget(value, allowUnlimited = false) {
    try { validateBudget(value, { allowUnlimited }); }
    catch (error) { throw new this.errors.GateError(error.message); }
  }

  state(taskId, checkpointId) {
    const task = this.store.getTask(taskId);
    const entries = this.store.notebook.refresh(taskId);
    const resume = this.store.notebook.resumeContext(taskId);
    const checkpoint = checkpointId ? this.store.inspect(checkpointId, taskId) : resume.checkpointId ? this.store.inspect(resume.checkpointId, taskId) : this.store.row("SELECT checkpoint_id,payload FROM checkpoints WHERE task_id=? AND epoch=? AND state='READY' ORDER BY created_at DESC LIMIT 1", taskId, task.epoch);
    const cp = typeof checkpoint?.payload === 'string' ? JSON.parse(checkpoint.payload) : checkpoint?.payload;
    const operations = this.store.db.prepare("SELECT op_id,kind,status FROM operations WHERE task_id=? AND status IN ('intent','unknown') ORDER BY created_at,op_id").all(taskId);
    return {
      instructions: entries.filter(note => note.category === 'instruction' && note.status === 'confirmed').sort((a,b)=>this.store.readEvent(taskId,a.evidenceIds[0]).seq-this.store.readEvent(taskId,b.evidenceIds[0]).seq).map(note => ({ eventId: note.evidenceIds[0], text: note.text })),
      notebook: entries.filter(note => note.category !== 'instruction').map(noteProjection),
      notes: this.store.notes(taskId, task.epoch).map(noteProjection),
      checkpointId: checkpoint?.checkpoint_id,
      pending: [...(cp?.pending ?? []), ...operations.map(op => ({ opId: op.op_id, kind: op.kind, status: op.status }))],
    };
  }

  buildManifest(taskId, { budget = 12000, recent = 12, checkpointId = null, countTokens = this.store.countTokens } = {}) {
    const store = this.store, task = store.getTask(taskId);
    if (store.mode === 'off') return { mode: 'off', taskId };
    this.ready(taskId);
    this.budget(budget);
    const state = this.state(taskId, checkpointId);
    const rows = store.db.prepare('SELECT * FROM events WHERE task_id=? AND epoch=? ORDER BY seq').all(taskId, task.epoch).filter(row => usefulSources.has(row.source));
    const anchor = rows.find(row => row.source === 'user_input');
    const selected = [...new Map([...(anchor ? [anchor] : []), ...rows.slice(-Math.max(1, recent))].map(row => [row.event_id, row])).values()];
    const events = selected.map(row => {
      const encoded = JSON.stringify(store.notebook.source(taskId, row.event_id).payload);
      return { event_id: row.event_id, source: row.source, seq: row.seq,
        payload: encoded.length > 2400 ? { truncated: true, preview: encoded.slice(0, 2400), bytes: Buffer.byteLength(encoded), eventId: row.event_id } : JSON.parse(encoded) };
    });
    const payload = {
      manifestId: id('manifest'), taskId, contractRevision: task.revision, epoch: task.epoch,
      goal: task.goal, acceptance: task.acceptance, constraints: task.constraints,
      instructions: state.instructions, events, notes: state.notes, notebook: state.notebook,
      memories: store.memoryClaims(taskId).slice(-16).map(memoryProjection),
      memoryConflicts: store.memoryConflicts(taskId).slice(0, 8).map(c => ({ conflictId: c.conflict_id, left: memoryProjection(c.left), right: memoryProjection(c.right) })),
      checkpointId: state.checkpointId, pending: state.pending, budget, estimatedTokens: 0,
      tokenCounter: countTokens === store.countTokens ? store.tokenCounterName : 'caller-provided',
      omitted: { events: 0, notes: 0, memories: 0 },
    };
    const measure = () => {
      payload.estimatedTokens = 0;
      measureManifest(payload, text => checkedCount(countTokens, '[continuity manifest]\n' + text));
      return payload.estimatedTokens;
    };
    const trim = () => {
      const eventIndex = payload.events.findIndex(row => row.event_id !== anchor?.event_id);
      if (eventIndex >= 0) { payload.events.splice(eventIndex, 1); payload.omitted.events++; return true; }
      for (const list of [payload.notes, payload.notebook]) {
        const index = list.findLastIndex(note => !requiredNote(note));
        if (index >= 0) { list.splice(index, 1); payload.omitted.notes++; return true; }
      }
      if (payload.memories.length) { payload.memories.shift(); payload.omitted.memories++; return true; }
      if (payload.memoryConflicts.length) { payload.memoryConflicts.pop(); return true; }
      return false;
    };
    if (measure() > budget) payload.compressed = true;
    while (measure() > budget && trim()) { /* required text is never shortened */ }
    if (measure() > budget) throw new this.errors.GateError('continuity budget cannot fit user instructions, confirmed notes and pending work; increase the budget or explicitly revise/retire them');
    store.db.prepare('INSERT INTO manifests VALUES(?,?,?,?,?,?)').run(payload.manifestId, taskId, task.revision, task.epoch, JSON.stringify(payload), Date.now() / 1000);
    return payload;
  }

  compressContext(taskId, { epoch, revision, budget = 12000, extract = true, query, includeHistory = false, countTokens = this.store.countTokens } = {}) {
    const store = this.store, task = store.getTask(taskId);
    epoch ??= task.epoch; revision ??= task.revision;
    if (epoch !== task.epoch) throw new this.errors.EpochMismatch('stale compression epoch');
    if (revision !== task.revision) throw new this.errors.StaleRevision('stale compression revision');
    this.budget(budget, true);
    const state = this.state(taskId);
    const rows = includeHistory ? store.db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY seq').all(taskId) : store.db.prepare('SELECT * FROM events WHERE task_id=? AND epoch=? ORDER BY seq').all(taskId, epoch);
    const decoded = rows.map(row => ({ ...row, fullPayload: store.notebook.source(taskId, row.event_id).payload }));
    // Candidate writes and the new view commit together. A failed compaction preserves the old view.
    return store.tx(() => {
      const noteHeads=new Map(store.notebook.heads(taskId).map(note=>[note.entry_key,note]));
      const currentObservation=(category,text)=>{const head=noteHeads.get(observationKey(category,text));return !head||(head.status!=='retired'&&head.text===text)};
      const extracted = [];
      if (extract) for (const row of decoded) {
        if (!['user_input', 'model_response', 'tool_result', 'pi_session_entry'].includes(row.source)) continue;
        for (const observation of labelledObservations(row.fullPayload)) {
          if(!currentObservation(observation.category,observation.text))continue;
          const predicate = observation.category === 'pending' ? 'next_step' : observation.category;
          const result = store.recordMemoryClaim(taskId, epoch, { scope: 'task', subject: 'session', predicate, value: observation.text, evidenceIds: [row.event_id], status: 'proposed', origin: 'compression' });
          if (!extracted.some(item => item.memoryId === result.memory.memory_id)) extracted.push({ memoryId: result.memory.memory_id, sourceEventId: row.event_id, predicate, value: observation.text });
        }
      }
      const memories = store.memoryClaims(taskId, { includeCandidates: true }).filter(memory=>memory.origin!=='compression'||currentObservation(memory.predicate==='next_step'?'pending':memory.predicate,memory.value)).map(memoryProjection);
      const sourceMemoryIds = memories.map(memory => memory.memoryId);
      const view = {
        format: 'pi-continuity-compression-v1', viewId: id('cview'), taskId, epoch, revision, query: query ?? null,
        goal: task.goal, acceptance: task.acceptance, constraints: task.constraints,
        instructions: state.instructions, notebook: [...state.notes, ...state.notebook], pending: state.pending,
        keptEventIds: rows.map(row => row.event_id),
        keptEvents: decoded.map(row => ({ eventId: row.event_id, seq: row.seq, epoch: row.epoch, source: row.source, text: eventText(row.fullPayload) })),
        extracted, memories,
        sourceEventIds: [...new Set([...rows.map(row => row.event_id), ...state.instructions.map(x => x.eventId), ...state.notebook.flatMap(note => note.evidenceIds)])],
        omittedEventIds: [], tokenCounter: store.tokenCounterName,
      };
      const count = () => checkedCount(countTokens, renderCompression(view));
      const initialTokens = count();
      const requiredEventIds = new Set(rows.filter(row => row.source === 'user_confirmation').slice(-1).map(row => row.event_id));
      const anchor = rows.find(row => row.source === 'user_input');
      if (anchor) requiredEventIds.add(anchor.event_id);
      const priority = row => ({ provider_request: 0, model_request: 0, compression_view: 0, user_input: 90, model_response: 60, tool_result: 40, model_error: 85, resume: 85 }[row.source] ?? 10);
      const removable = [...rows].sort((a, b) => priority(a) - priority(b) || a.seq - b.seq);
      for (const row of removable) {
        if (!budget || count() <= budget) break;
        const group = row.op_id ? rows.filter(other => other.op_id === row.op_id) : [row];
        if (group.some(other => requiredEventIds.has(other.event_id))) continue;
        const ids = new Set(group.map(other => other.event_id));
        view.keptEvents = view.keptEvents.filter(event => !ids.has(event.eventId));
      }
      while (budget && count() > budget && view.memories.length) view.memories.pop();
      while (budget && count() > budget) {
        const index = view.notebook.findLastIndex(note => !requiredNote(note));
        if (index < 0) break;
        view.notebook.splice(index, 1);
      }
      while (budget && count() > budget && view.extracted.length) view.extracted.pop();
      view.keptEventIds = view.keptEvents.map(event => event.eventId);
      const kept = new Set(view.keptEventIds);
      view.omittedEventIds = view.sourceEventIds.filter(eventId => !kept.has(eventId));
      const tokensAfter = count();
      if (budget && tokensAfter > budget) throw new this.errors.GateError('compression budget cannot fit required instructions, confirmed notes and pending work; previous view is unchanged');
      view.metrics = { requiredInstructions: state.instructions.length, retainedInstructions: view.instructions.length, omittedEvents: view.omittedEventIds.length };
      store.db.prepare('INSERT INTO compression_views VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(view.viewId, taskId, task.project_id, task.branch, epoch, revision, 'notebook-extract-v4', JSON.stringify(view.sourceEventIds), JSON.stringify(sourceMemoryIds), JSON.stringify(view.omittedEventIds), JSON.stringify(view), initialTokens, tokensAfter, Date.now() / 1000);
      store.recordEvent(taskId, 'compression_view', { viewId: view.viewId, strategy: 'notebook-extract-v4', tokensBefore: initialTokens, tokensAfter, omittedCount: view.omittedEventIds.length }, { epoch });
      return { ...view, tokensBefore: initialTokens, tokensAfter };
    });
  }
}
