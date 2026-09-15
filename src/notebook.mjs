import { createHash } from 'node:crypto';

const categories = new Set(['instruction', 'constraint', 'decision', 'fact', 'pending', 'blocker', 'observation']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const observationKey = (category, text) => category + ':' + hash(text);
const acknowledgement = /^(?:continue|go on|proceed|ok|okay|继续|接着做|继续吧|好的|好)[\s.!。！]*$/iu;

export function visibleText(payload) {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  if (payload.kind === 'image' || payload.type === 'image') return '';
  if (payload.message) return visibleText(payload.message);
  if (payload.entry?.message) return visibleText(payload.entry.message);
  if (Array.isArray(payload.content)) return payload.content.filter(x => x?.type === 'text').map(x => x.text ?? '').join('\n');
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.output === 'string') return payload.output;
  if (payload.result) return visibleText(payload.result);
  return '';
}

/** Extractive fallback: never guesses that an arbitrary sentence is a confirmed fact. */
export function labelledObservations(payload) {
  const found = [];
  const labels = { decision: 'decision', fact: 'fact', constraint: 'constraint', nextStep: 'pending', next_step: 'pending', blocker: 'blocker' };
  for (const [key, category] of Object.entries(labels)) {
    if (payload && typeof payload === 'object' && payload[key] != null) {
      found.push({ category, text: typeof payload[key] === 'string' ? payload[key] : JSON.stringify(payload[key]) });
    }
  }
  const names = { decision: 'decision', fact: 'fact', constraint: 'constraint', 'next step': 'pending', next_step: 'pending', blocker: 'blocker', 决定: 'decision', 决策: 'decision', 事实: 'fact', 约束: 'constraint', 下一步: 'pending', 待办: 'pending', 阻塞: 'blocker' };
  for (const match of visibleText(payload).matchAll(/(?:^|\n|\|)\s*(?:[-*]\s*)?(?:\*\*)?(Decision|Fact|Constraint|Next step|Next_Step|Blocker|决定|决策|事实|约束|下一步|待办|阻塞)(?:\*\*)?\s*[:：]\s*([^\n|]+)/gim)) {
    found.push({ category: names[match[1].toLowerCase()], text: match[2].trim() });
  }
  return found;
}

/** Versioned note projection. The existing event ledger and notes remain the authority. */
export class Notebook {
  constructor(store, errors) {
    this.store = store;
    this.errors = errors;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS notebook_entries(
        note_id TEXT PRIMARY KEY REFERENCES notes(note_id), task_id TEXT NOT NULL REFERENCES tasks(task_id),
        epoch INTEGER NOT NULL, entry_key TEXT NOT NULL, category TEXT NOT NULL, origin TEXT NOT NULL,
        supersedes_note_id TEXT REFERENCES notes(note_id), event_seq INTEGER NOT NULL, source_hash TEXT NOT NULL,
        UNIQUE(task_id,epoch,entry_key,source_hash));
      CREATE INDEX IF NOT EXISTS notebook_task_epoch ON notebook_entries(task_id,epoch,event_seq);
      CREATE TABLE IF NOT EXISTS notebook_cursors(
        task_id TEXT NOT NULL REFERENCES tasks(task_id), epoch INTEGER NOT NULL,
        extractor TEXT NOT NULL, last_seq INTEGER NOT NULL, PRIMARY KEY(task_id,epoch,extractor));
    `);
  }

  source(taskId, eventId) {
    this.store.getTask(taskId);
    const row = this.store.row('SELECT * FROM events WHERE event_id=? AND task_id=?', eventId, taskId);
    if (!row) throw new this.errors.ScopeError('notebook evidence must reference an existing event in this task');
    let payload = JSON.parse(row.payload);
    if (payload?.blobId && (payload.preview !== undefined || payload.truncated)) {
      payload = JSON.parse(this.store.loadBlob(payload.blobId).toString('utf8'));
    }
    return { ...row, payload };
  }

  resumeContext(taskId) {
    const task = this.store.getTask(taskId);
    const event = this.store.row("SELECT payload FROM events WHERE task_id=? AND epoch=? AND source='resume' ORDER BY seq DESC LIMIT 1", taskId, task.epoch);
    return event ? JSON.parse(event.payload) : {};
  }

  entry(taskId, noteId) {
    const meta = this.store.row('SELECT * FROM notebook_entries WHERE task_id=? AND note_id=?', taskId, noteId);
    if (!meta) throw new this.errors.ScopeError('notebook entry scope mismatch');
    return { ...this.store.note(noteId, taskId), ...meta };
  }

  heads(taskId) {
    const task = this.store.getTask(taskId);
    const inherited = (this.resumeContext(taskId).notebookIds ?? []).map(noteId => this.entry(taskId, noteId));
    const own = this.store.db.prepare('SELECT note_id FROM notebook_entries WHERE task_id=? AND epoch=? ORDER BY event_seq').all(taskId, task.epoch).map(row => this.entry(taskId, row.note_id));
    const heads = new Map();
    for (const note of [...inherited, ...own]) heads.set(note.entry_key, note);
    return [...heads.values()];
  }

  read(taskId, { includeRetired = false } = {}) {
    return this.heads(taskId).filter(note => includeRetired || note.status !== 'retired');
  }

  snapshot(taskId) { return this.heads(taskId).map(note => note.note_id); }

  put(taskId, epoch, change) {
    return this.store.tx(() => this.apply(taskId, epoch, change));
  }

  apply(taskId, epoch, { key, category = 'observation', text, evidenceIds = [], status = 'proposed', origin = 'host', sourceEvent, expectedNoteId, retire = false }) {
    const task = this.store.getTask(taskId);
    if (task.epoch !== epoch) throw new this.errors.EpochMismatch('stale notebook epoch');
    if (typeof key !== 'string' || !key.trim() || !categories.has(category)) throw new this.errors.ContinuityError('notebook key/category is invalid');
    if (typeof text !== 'string' || !text.trim()) throw new this.errors.ContinuityError('notebook text is required');
    if (!['proposed', 'confirmed'].includes(status)) throw new this.errors.ContinuityError('notebook status must be proposed or confirmed');
    if (!['host', 'user', 'rules', 'observer'].includes(origin)) throw new this.errors.ContinuityError('invalid notebook origin');
    if (category === 'instruction' && !['host', 'user'].includes(origin)) throw new this.errors.GateError('only explicit user/host input can create instruction notes');
    const sources = [...new Set(evidenceIds)];
    if (!sources.length) throw new this.errors.ContinuityError('notebook evidence is required');
    const events = sources.map(eventId => this.source(taskId, eventId));
    const trusted = sourceEvent && ['user', 'host'].includes(sourceEvent.actor) && ['host', 'user'].includes(origin);
    if (status === 'confirmed' && !trusted) throw new this.errors.GateError('model observations cannot self-confirm');
    if (sourceEvent?.actor === 'user' && !events.some(event => event.event_id === sourceEvent.id && ['user_input', 'user_confirmation'].includes(event.source))) {
      throw new this.errors.ScopeError('user note source must be an actual user event');
    }
    const current = this.heads(taskId).find(note => note.entry_key === key);
    if (expectedNoteId !== undefined && expectedNoteId !== (current?.note_id ?? null)) throw new this.errors.StaleRevision('notebook entry changed');
    if (current?.status === 'confirmed' && !trusted) throw new this.errors.GateError('model observations cannot replace or retire confirmed notes');
    const nextStatus = retire ? 'retired' : status;
    if (current?.text === text && current.category === category && current.status === nextStatus && sources.every(x => current.evidenceIds.includes(x))) return current;
    const sourceHash = hash({ text, category, status: nextStatus, sources: [...sources].sort(), supersedes: current?.note_id ?? null });
    const note = this.store.recordNote(taskId, epoch, text, { evidenceIds: sources, status: nextStatus, sourceEvent });
    const seq = this.store.row('SELECT MAX(seq) AS seq FROM events WHERE task_id=?', taskId).seq;
    this.store.db.prepare('INSERT INTO notebook_entries VALUES(?,?,?,?,?,?,?,?,?)').run(note.note_id, taskId, epoch, key, category, origin, current?.note_id ?? null, seq, sourceHash);
    return this.entry(taskId, note.note_id);
  }

  /** Incremental, offline extraction. No re-summarizing an earlier summary. */
  refresh(taskId) {
    const task = this.store.getTask(taskId);
    const cursor = this.store.row("SELECT last_seq FROM notebook_cursors WHERE task_id=? AND epoch=? AND extractor='rules-v1'", taskId, task.epoch)?.last_seq ?? 0;
    const rows = this.store.db.prepare('SELECT * FROM events WHERE task_id=? AND epoch=? AND seq>? ORDER BY seq').all(taskId, task.epoch, cursor);
    const inherited = cursor === 0 ? [...new Set([...(this.resumeContext(taskId).seedEventIds ?? []), ...(this.resumeContext(taskId).importEventIds ?? [])])].map(eventId => this.source(taskId, eventId)) : [];
    const sources = [...inherited, ...rows];
    if (!sources.length) return this.read(taskId);
    this.store.tx(() => {
      for (const row of sources) {
        if (!['user_input', 'model_response', 'tool_result', 'model_error', 'pi_session_entry'].includes(row.source)) continue;
        const source = this.source(taskId, row.event_id);
        const payload = source.payload;
        if (row.source === 'user_input') {
          const text = visibleText(payload);
          if (!text.trim() || acknowledgement.test(text.trim()) || text === task.goal) continue;
          this.apply(taskId, task.epoch, { key: 'user:' + row.event_id, category: 'instruction', text, evidenceIds: [row.event_id], status: 'confirmed', origin: 'user', sourceEvent: { actor: 'user', id: row.event_id } });
          continue;
        }
        for (const item of labelledObservations(payload)) {
          const key = observationKey(item.category, item.text);
          const current = this.heads(taskId).find(note => note.entry_key === key);
          // New copies of old evidence must not undo an explicit revision or retirement.
          if (current && (current.status === 'retired' || current.text !== item.text || current.origin !== 'rules')) continue;
          this.apply(taskId, task.epoch, { key, ...item, origin: 'rules', evidenceIds: [...new Set([...(current?.evidenceIds ?? []), row.event_id])] });
        }
      }
      const last = rows.at(-1)?.seq ?? cursor;
      this.store.db.prepare("INSERT INTO notebook_cursors VALUES(?,?,'rules-v1',?) ON CONFLICT(task_id,epoch,extractor) DO UPDATE SET last_seq=excluded.last_seq").run(taskId, task.epoch, last);
    });
    return this.read(taskId);
  }

  /** Optional semantic observer. Its output is always proposed, validated, and atomic. */
  async observe(taskId, observer, { maxEvents = 32, signal } = {}) {
    if (typeof observer !== 'function') throw new TypeError('notebook observer must be a function');
    this.refresh(taskId);
    const task = this.store.getTask(taskId);
    const cursor = this.store.row("SELECT last_seq FROM notebook_cursors WHERE task_id=? AND epoch=? AND extractor='observer-v1'", taskId, task.epoch)?.last_seq ?? 0;
    const rows = this.store.db.prepare("SELECT event_id,seq FROM events WHERE task_id=? AND epoch=? AND seq>? AND source IN ('user_input','model_response','tool_result','model_error','pi_session_entry') ORDER BY seq LIMIT ?").all(taskId, task.epoch, cursor, Math.max(1, Math.min(128, maxEvents)));
    if (!rows.length) return this.read(taskId);
    const heads = this.heads(taskId);
    const existing = new Map(heads.map(note => [note.entry_key, note.note_id]));
    const events = rows.map(row => this.source(taskId, row.event_id));
    const result = await observer({ task: { goal: task.goal, constraints: task.constraints, acceptance: task.acceptance }, notes: heads, events, signal });
    if (signal?.aborted) throw new this.errors.GateError('notebook observation cancelled');
    const current = this.store.getTask(taskId);
    if (current.epoch !== task.epoch || current.revision !== task.revision) throw new this.errors.StaleRevision('task changed while observing');
    if (!Array.isArray(result?.entries) || result.entries.length > 64) throw new this.errors.ContinuityError('observer must return at most 64 entries');
    const allowed = new Set(events.map(event => event.event_id));
    const keys = new Set();
    this.store.tx(() => {
      const currentCursor=this.store.row("SELECT last_seq FROM notebook_cursors WHERE task_id=? AND epoch=? AND extractor='observer-v1'",taskId,task.epoch)?.last_seq??0;
      if(currentCursor!==cursor)throw new this.errors.StaleRevision('observer cursor advanced concurrently');
      for (const item of result.entries) {
        if (keys.has(item.key) || !item.evidenceIds?.length || item.evidenceIds.some(id => !allowed.has(id))) throw new this.errors.ScopeError('observer has duplicate keys or unsupported evidence');
        if (item.status && item.status !== 'proposed') throw new this.errors.GateError('observer cannot confirm a note');
        keys.add(item.key);
        this.apply(taskId, task.epoch, { key: item.key, category: item.category, text: item.text, evidenceIds: item.evidenceIds, retire: item.retire === true, expectedNoteId: existing.get(item.key) ?? null, status: 'proposed', origin: 'observer' });
      }
      this.store.db.prepare("INSERT INTO notebook_cursors VALUES(?,?,'observer-v1',?) ON CONFLICT(task_id,epoch,extractor) DO UPDATE SET last_seq=excluded.last_seq").run(taskId, task.epoch, rows.at(-1).seq);
    });
    return this.read(taskId);
  }

  markdown(taskId) {
    const task = this.store.getTask(taskId);
    const notes = this.read(taskId);
    return ['# Task notebook', '', 'Goal: ' + task.goal, '',
      ...[...categories].flatMap(category => ['## ' + category, '', ...notes.filter(note => note.category === category).map(note => '- [' + note.status + '] ' + note.text + '\n  Sources: ' + note.evidenceIds.join(', ') + '; note: ' + note.note_id), '']),
    ].join('\n');
  }
}
