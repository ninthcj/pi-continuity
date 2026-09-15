import { randomUUID } from 'node:crypto';
import { checkedCount, measureManifest, renderCompression, renderManifest, validateBudget } from './context-budget.mjs';
import { labelledObservations, visibleText, observationKey } from './notebook.mjs';
import { fitRemovalPrefix } from './context-selection.mjs';

const id = prefix => prefix + '_' + randomUUID().replaceAll('-', '');
const noteProjection = note => ({ noteId: note.note_id, category: note.category ?? 'observation', status: note.status, text: note.text, evidenceIds: note.evidenceIds });
const memoryProjection = memory => ({ memoryId: memory.memory_id, scope: memory.scope, subject: memory.subject, predicate: memory.predicate, value: memory.value, status: memory.status, evidenceIds: memory.evidenceIds, origin: memory.origin, versionId: memory.version_id });
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
  constructor(store, errors) {
    this.store = store; this.errors = errors;
    this.eventCache = new Map(); this.eventCacheBytes = 0;
    store.db.exec('CREATE TABLE IF NOT EXISTS compression_extraction_cursors(task_id TEXT NOT NULL REFERENCES tasks(task_id),epoch INTEGER NOT NULL,last_seq INTEGER NOT NULL,PRIMARY KEY(task_id,epoch))');
  }

  projectEvent(taskId, row) {
    const cached=this.eventCache.get(row.event_id);
    if(cached){this.eventCache.delete(row.event_id);this.eventCache.set(row.event_id,cached);return {text:cached.text,cached:true};}
    const text=eventText(this.store.notebook.source(taskId,row.event_id).payload);
    const bytes=Buffer.byteLength(text);
    if(bytes<=256000){
      this.eventCache.set(row.event_id,{text,bytes});this.eventCacheBytes+=bytes;
      while(this.eventCache.size>8192||this.eventCacheBytes>8*1024*1024){const key=this.eventCache.keys().next().value;this.eventCacheBytes-=this.eventCache.get(key).bytes;this.eventCache.delete(key);}
    }
    return {text,cached:false};
  }

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
    const anchor = store.row("SELECT event_id,source,seq FROM events WHERE task_id=? AND epoch=? AND source='user_input' ORDER BY seq LIMIT 1",taskId,task.epoch);
    const sources=[...usefulSources],limit=Math.max(1,Math.min(10000,Number.isSafeInteger(recent)?recent:12));
    const rows=store.db.prepare('SELECT event_id,source,seq FROM events WHERE task_id=? AND epoch=? AND source IN ('+sources.map(()=>'?').join(',')+') ORDER BY seq DESC LIMIT ?').all(taskId,task.epoch,...sources,limit).reverse();
    const selected = [...new Map([...(anchor ? [anchor] : []), ...rows].map(row => [row.event_id, row])).values()];
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
    const originals={events:payload.events,notes:payload.notes,notebook:payload.notebook,memories:payload.memories,memoryConflicts:payload.memoryConflicts};
    const units=[
      ...payload.events.filter(event=>event.event_id!==anchor?.event_id).map(item=>({section:'events',item})),
      ...['notes','notebook'].flatMap(section=>payload[section].filter(note=>!requiredNote(note)).reverse().map(item=>({section,item}))),
      ...payload.memories.map(item=>({section:'memories',item})),
      ...[...payload.memoryConflicts].reverse().map(item=>({section:'memoryConflicts',item})),
    ];
    const ranks=new Map(units.map((unit,index)=>[unit.item,index+1]));
    if(measure()>budget)payload.compressed=true;
    fitRemovalPrefix({size:units.length,budget,count:measure,
      apply:removed=>{
        for(const [section,items] of Object.entries(originals))payload[section]=items.filter(item=>!ranks.has(item)||ranks.get(item)>removed);
        payload.omitted.events=originals.events.length-payload.events.length;
        payload.omitted.notes=originals.notes.length+originals.notebook.length-payload.notes.length-payload.notebook.length;
        payload.omitted.memories=originals.memories.length-payload.memories.length;
      },
      failure:()=>new this.errors.GateError('continuity budget cannot fit user instructions, confirmed notes and pending work; increase the budget or explicitly revise/retire them'),
    });
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
    const columns='event_id,seq,epoch,source,op_id';
    const rows = includeHistory ? store.db.prepare('SELECT '+columns+' FROM events WHERE task_id=? ORDER BY seq').all(taskId) : store.db.prepare('SELECT '+columns+' FROM events WHERE task_id=? AND epoch=? ORDER BY seq').all(taskId, epoch);
    return store.tx(() => {
      const noteHeads=new Map(store.notebook.heads(taskId).map(note=>[note.entry_key,note]));
      const currentObservation=(category,text)=>{const head=noteHeads.get(observationKey(category,text));return !head||(head.status!=='retired'&&head.text===text)};
      const cursor=includeHistory?0:store.row('SELECT last_seq FROM compression_extraction_cursors WHERE task_id=? AND epoch=?',taskId,epoch)?.last_seq??0;
      let extractedEvents=0;
      if(extract)for(const row of rows){
        if(row.seq<=cursor||!['user_input','model_response','tool_result','pi_session_entry'].includes(row.source))continue;
        extractedEvents++;
        for(const observation of labelledObservations(store.notebook.source(taskId,row.event_id).payload)){
          if(!currentObservation(observation.category,observation.text))continue;
          const predicate=observation.category==='pending'?'next_step':observation.category;
          store.recordMemoryClaim(taskId,epoch,{scope:'task',subject:'session',predicate,value:observation.text,evidenceIds:[row.event_id],status:'proposed',origin:'compression'});
        }
      }
      const sourceMemories=store.memoryClaims(taskId,{includeCandidates:true}).filter(memory=>memory.origin!=='compression'||currentObservation(memory.predicate==='next_step'?'pending':memory.predicate,memory.value));
      const memories=sourceMemories.map(memoryProjection),sourceMemoryIds=memories.map(memory=>memory.memoryId);
      const extracted=memories.filter(memory=>memory.origin==='compression').map(memory=>({memoryId:memory.memoryId,versionId:memory.versionId,sourceEventId:memory.evidenceIds[0],predicate:memory.predicate,value:memory.value}));
      let decodedEvents=0;
      const keptEvents=rows.map(row=>{const projection=this.projectEvent(taskId,row);if(!projection.cached)decodedEvents++;return {eventId:row.event_id,seq:row.seq,epoch:row.epoch,source:row.source,text:projection.text};});
      const view={
        format:'pi-continuity-compression-v1',viewId:id('cview'),taskId,epoch,revision,query:query??null,
        goal:task.goal,acceptance:task.acceptance,constraints:task.constraints,
        instructions:state.instructions,notebook:[...state.notes,...state.notebook],pending:state.pending,
        keptEventIds:rows.map(row=>row.event_id),keptEvents,extracted,memories,
        sourceEventIds:[...new Set([...rows.map(row=>row.event_id),...state.instructions.map(item=>item.eventId),...[...state.notes,...state.notebook].flatMap(note=>note.evidenceIds)])],
        sourceMemoryVersionIds:sourceMemories.map(memory=>memory.version_id),omittedEventIds:[],tokenCounter:countTokens===store.countTokens?store.tokenCounterName:'caller-provided',
      };
      const requiredEventIds=new Set(rows.filter(row=>row.source==='user_confirmation').slice(-1).map(row=>row.event_id));
      const anchor=rows.find(row=>row.source==='user_input');if(anchor)requiredEventIds.add(anchor.event_id);
      const priority=row=>({provider_request:0,model_request:0,compression_view:0,user_input:90,model_response:60,tool_result:40,model_error:85,resume:85}[row.source]??10);
      const groups=new Map();
      for(const row of rows){const key=row.op_id??row.event_id;const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
      const removable=[...groups.values()].filter(group=>!group.some(row=>requiredEventIds.has(row.event_id))).sort((a,b)=>Math.min(...a.map(priority))-Math.min(...b.map(priority))||a[0].seq-b[0].seq);
      const units=[...removable.map(group=>({section:'keptEvents',ids:group.map(row=>row.event_id)})),
        ...[...view.memories].reverse().map(item=>({section:'memories',item})),
        ...view.notebook.filter(note=>!requiredNote(note)).reverse().map(item=>({section:'notebook',item})),
        ...[...view.extracted].reverse().map(item=>({section:'extracted',item})),
      ];
      const ranks=new Map(),eventRanks=new Map();
      units.forEach((unit,index)=>{if(unit.ids)for(const eventId of unit.ids)eventRanks.set(eventId,index+1);else ranks.set(unit.item,index+1);});
      const originals={keptEvents:view.keptEvents,memories:view.memories,notebook:view.notebook,extracted:view.extracted};
      const initiallyKept=new Set(view.keptEventIds);view.omittedEventIds=view.sourceEventIds.filter(eventId=>!initiallyKept.has(eventId));
      const selection=fitRemovalPrefix({size:units.length,budget,count:()=>checkedCount(countTokens,renderCompression(view)),
        apply:removed=>{
          view.keptEvents=originals.keptEvents.filter(event=>!eventRanks.has(event.eventId)||eventRanks.get(event.eventId)>removed);
          for(const section of ['memories','notebook','extracted'])view[section]=originals[section].filter(item=>!ranks.has(item)||ranks.get(item)>removed);
          view.keptEventIds=view.keptEvents.map(event=>event.eventId);
          const kept=new Set(view.keptEventIds);view.omittedEventIds=view.sourceEventIds.filter(eventId=>!kept.has(eventId));
        },failure:()=>new this.errors.GateError('compression budget cannot fit required instructions, confirmed notes and pending work; previous view is unchanged'),
      });
      if(!selection.removed){const kept=new Set(view.keptEventIds);view.omittedEventIds=view.sourceEventIds.filter(eventId=>!kept.has(eventId));}
      const initialTokens=selection.initialTokens,tokensAfter=checkedCount(countTokens,renderCompression(view));
      if(budget&&tokensAfter>budget)throw new this.errors.GateError('compression budget cannot fit required context; previous view is unchanged');
      view.metrics={requiredInstructions:state.instructions.length,retainedInstructions:view.instructions.length,omittedEvents:view.omittedEventIds.length,fullMeasurements:selection.measurements+1,decodedEvents,extractedEvents};
      if(extract&&!includeHistory)store.db.prepare('INSERT INTO compression_extraction_cursors VALUES(?,?,?) ON CONFLICT(task_id,epoch) DO UPDATE SET last_seq=excluded.last_seq').run(taskId,epoch,rows.at(-1)?.seq??cursor);
      store.db.prepare('INSERT INTO compression_views VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(view.viewId, taskId, task.project_id, task.branch, epoch, revision, 'notebook-extract-v5', JSON.stringify(view.sourceEventIds), JSON.stringify(sourceMemoryIds), JSON.stringify(view.omittedEventIds), JSON.stringify(view), initialTokens, tokensAfter, Date.now() / 1000);
      store.recordEvent(taskId, 'compression_view', { viewId: view.viewId, strategy: 'notebook-extract-v5', tokensBefore: initialTokens, tokensAfter, omittedCount: view.omittedEventIds.length }, { epoch });
      return { ...view, tokensBefore: initialTokens, tokensAfter };
    });
  }
}
