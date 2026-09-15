import { createHash, randomUUID } from 'node:crypto';

const id = prefix => prefix + '_' + randomUUID().replaceAll('-', '');
const decode = row => ({ ...row, value: JSON.parse(row.value_json), evidenceIds: JSON.parse(row.evidence_ids_json) });

/** Immutable versions over the existing claim identities. Reads distinguish active context from history. */
export class MemoryLedger {
  constructor(store, errors) {
    this.store = store;
    this.errors = errors;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_versions(
        version_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memory_claims,
        task_id TEXT NOT NULL REFERENCES tasks, epoch INTEGER NOT NULL,
        event_seq INTEGER NOT NULL, payload_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_versions_scope ON memory_versions(task_id,epoch,event_seq);
      CREATE INDEX IF NOT EXISTS memory_versions_claim ON memory_versions(memory_id,event_seq);
      CREATE TABLE IF NOT EXISTS memory_snapshot_versions(
        snapshot_id TEXT NOT NULL REFERENCES memory_snapshots,
        memory_id TEXT NOT NULL REFERENCES memory_claims,
        version_id TEXT NOT NULL REFERENCES memory_versions,
        PRIMARY KEY(snapshot_id,memory_id));
    `);
    this.migrate();
  }

  version(versionId, taskId) {
    const row = this.store.row('SELECT * FROM memory_versions WHERE version_id=? AND task_id=?', versionId, taskId);
    if (!row) throw new this.errors.ScopeError('memory version scope mismatch');
    return { ...JSON.parse(row.payload_json), version_id: row.version_id };
  }

  append(memory, eventSeq, epoch) {
    const versionId = id('mver');
    const { version_id, ...payload } = memory;
    this.store.db.prepare('INSERT INTO memory_versions VALUES(?,?,?,?,?,?)').run(versionId, memory.memory_id, memory.task_id, epoch, eventSeq, JSON.stringify(payload));
    return { ...payload, version_id: versionId };
  }

  resume(taskId, epoch, limit = Number.MAX_SAFE_INTEGER) {
    const row = this.store.row("SELECT event_id FROM events WHERE task_id=? AND epoch=? AND seq<=? AND source='resume' ORDER BY seq DESC LIMIT 1", taskId, epoch, limit);
    return row ? this.store.readEvent(taskId, row.event_id).payload : null;
  }

  /** Includes candidates here: filtering origin must happen after choosing the visible version. */
  visible(taskId, { epoch, limit = Number.MAX_SAFE_INTEGER, includeHistory = false } = {}) {
    const task = this.store.getTask(taskId);
    epoch ??= task.epoch;
    const resume = includeHistory ? null : this.resume(taskId, epoch, limit);
    const selected = new Map();
    if (resume) {
      const versions = resume.memoryVersionIds ?? this.checkpointVersions(this.store.inspect(resume.checkpointId, taskId), epoch);
      for (const versionId of versions) {
        const memory = this.version(versionId, taskId);
        selected.set(memory.memory_id, memory);
      }
    }
    const epochFilter = resume ? 'AND epoch=?' : '';
    const args = [taskId, limit, ...(resume ? [epoch] : [])];
    const rows = this.store.db.prepare(`SELECT version_id FROM (
      SELECT version_id,event_seq,ROW_NUMBER() OVER (PARTITION BY memory_id ORDER BY event_seq DESC,version_id DESC) AS rank
      FROM memory_versions WHERE task_id=? AND event_seq<=? ${epochFilter})
      WHERE rank=1 ORDER BY event_seq,version_id`).all(...args);
    for (const row of rows) {
      const memory = this.version(row.version_id, taskId);
      selected.set(memory.memory_id, memory);
    }
    return [...selected.values()].sort((a, b) => a.created_at - b.created_at || a.memory_id.localeCompare(b.memory_id));
  }

  list(taskId, { includeCandidates = false, includeHistory = false } = {}) {
    return this.visible(taskId, { includeHistory }).filter(memory => includeCandidates || memory.origin === 'direct');
  }

  read(memoryId, taskId) {
    this.store.getTask(taskId);
    const row = this.store.row('SELECT version_id FROM memory_versions WHERE memory_id=? AND task_id=? ORDER BY event_seq DESC,version_id DESC LIMIT 1', memoryId, taskId);
    if (!row) throw new this.errors.ScopeError('memory claim scope mismatch');
    return this.version(row.version_id, taskId);
  }

  checkpointVersions(checkpoint, destinationEpoch = Infinity) {
    const { payload, task_id: taskId } = checkpoint;
    if (checkpoint.epoch >= destinationEpoch) throw new this.errors.CheckpointError('memory recovery must originate from an earlier epoch');
    if (Array.isArray(payload.memoryVersionIds)) return payload.memoryVersionIds;
    if (payload.memorySnapshotId) return this.snapshot(payload.memorySnapshotId, taskId).memories.map(memory => memory.version_id);
    // Legacy checkpoints without a memory snapshot use their visible event horizon.
    return this.visible(taskId, { epoch: checkpoint.epoch, limit: payload.visibleSeq ?? 0 }).map(memory => memory.version_id);
  }

  importVersions(taskId, eventIds) {
    const selected=[];
    for(const eventId of eventIds) {
      const event=this.store.readEvent(taskId,eventId);
      if(!['memory_proposed','memory_confirmed','memory_promoted','memory_duplicate'].includes(event.source))continue;
      const row=event.payload.memoryVersionId ? { version_id: event.payload.memoryVersionId } : this.store.row('SELECT version_id FROM memory_versions WHERE task_id=? AND memory_id=? AND event_seq<=? ORDER BY event_seq DESC,version_id DESC LIMIT 1',taskId,event.payload.memoryId,event.seq);
      if(!row)throw new this.errors.ScopeError('imported memory event has no matching version');
      selected.push(this.version(row.version_id,taskId));
    }
    return selected;
  }

  record(taskId, epoch, change = {}) {
    return this.store.tx(() => {
      const task = this.store.getTask(taskId);
      epoch ??= task.epoch;
      if (epoch !== task.epoch) throw new this.errors.EpochMismatch('stale memory epoch');
      if (change.revision !== undefined && change.revision !== task.revision) throw new this.errors.StaleRevision('stale memory revision');
      const { scope = 'task', subject, predicate, value, evidenceIds = [], status = 'confirmed', sourceEvent, origin = 'direct' } = change;
      if (!['proposed', 'confirmed'].includes(status)) throw new this.errors.ContinuityError('new memory claims must be proposed or confirmed');
      if (!['direct', 'compression'].includes(origin)) throw new this.errors.ContinuityError('memory claim origin must be direct or compression');
      if (!Array.isArray(evidenceIds) || evidenceIds.some(item => typeof item !== 'string')) throw new this.errors.ContinuityError('memory evidenceIds must be strings');
      const normalized = this.store.normalizeMemoryClaim({ scope, subject, predicate, value });
      const identity = this.store.row('SELECT * FROM memory_claims WHERE task_id=? AND fingerprint=?', taskId, normalized.fingerprint);
      const current = identity ? this.visible(taskId).find(memory => memory.memory_id === identity.memory_id) : undefined;
      const memoryId = identity?.memory_id ?? id('mem');
      const mergedEvidence = [...new Set([...(current?.evidenceIds ?? []), ...evidenceIds])];
      const nextStatus = current?.status === 'confirmed' ? 'confirmed' : status;
      const nextOrigin = current?.origin === 'direct' ? 'direct' : origin;
      const promoted = current?.origin === 'compression' && nextOrigin === 'direct';
      const confirmed = current?.status === 'proposed' && nextStatus === 'confirmed';
      const memory = {
        memory_id: memoryId, task_id: taskId, project_id: task.project_id, branch: task.branch,
        epoch, revision: task.revision, scope: normalized.scope, subject: normalized.subject,
        predicate: normalized.predicate, value_json: JSON.stringify(normalized.value),
        conflict_key: normalized.conflictKey, fingerprint: normalized.fingerprint,
        status: nextStatus, origin: nextOrigin, evidence_ids_json: JSON.stringify(mergedEvidence),
        created_at: current?.created_at ?? Date.now() / 1000,
        value: normalized.value, evidenceIds: mergedEvidence,
      };
      const changed = !current || promoted || confirmed || JSON.stringify(current.evidenceIds) !== JSON.stringify(mergedEvidence);
      if (!identity) {
        this.store.db.prepare('INSERT INTO memory_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          memoryId, taskId, task.project_id, task.branch, epoch, task.revision,
          memory.scope, memory.subject, memory.predicate, memory.value_json,
          memory.conflict_key, memory.fingerprint, nextStatus, nextOrigin, memory.evidence_ids_json, memory.created_at);
      } else if (changed) {
        this.store.db.prepare('UPDATE memory_claims SET epoch=?,revision=?,status=?,origin=?,evidence_ids_json=? WHERE memory_id=?').run(epoch, task.revision, nextStatus, nextOrigin, memory.evidence_ids_json, memoryId);
      }
      const rivals = this.store.db.prepare('SELECT memory_id FROM memory_claims WHERE task_id=? AND conflict_key=? AND memory_id<>?').all(taskId, memory.conflict_key, memoryId);
      for (const rival of rivals) {
        const [left, right] = [memoryId, rival.memory_id].sort();
        this.store.db.prepare('INSERT OR IGNORE INTO memory_conflicts VALUES(?,?,?,?,?,?,?,?)').run(id('conflict'), taskId, task.project_id, task.branch, memory.conflict_key, left, right, Date.now() / 1000);
      }
      const source = promoted ? 'memory_promoted' : confirmed ? 'memory_confirmed' : current ? 'memory_duplicate' : 'memory_' + nextStatus;
      const eventId = this.store.recordEvent(taskId, source, {
        memoryId, subject: memory.subject, predicate: memory.predicate, value: memory.value,
        status: nextStatus, origin: nextOrigin, evidenceIds: mergedEvidence, sourceEvent,
        memoryVersionId: changed ? undefined : current.version_id,
      }, { epoch });
      const seq = this.store.row('SELECT seq FROM events WHERE event_id=?', eventId).seq;
      const result = changed ? this.append(memory, seq, epoch) : current;
      const conflicts = rivals.length ? this.conflicts(taskId).filter(conflict => conflict.left_memory_id === memoryId || conflict.right_memory_id === memoryId) : [];
      return { kind: promoted ? 'promoted' : confirmed ? 'confirmed' : current ? 'duplicate' : conflicts.length ? 'conflict' : 'new', memory: result, conflicts };
    });
  }

  conflicts(taskId, { includeHistory = false } = {}) {
    const visible = new Map(this.visible(taskId, { includeHistory }).map(memory => [memory.memory_id, memory]));
    return this.store.db.prepare('SELECT * FROM memory_conflicts WHERE task_id=? ORDER BY created_at,conflict_id').all(taskId)
      .filter(row => visible.has(row.left_memory_id) && visible.has(row.right_memory_id))
      .map(row => ({ ...row, left: visible.get(row.left_memory_id), right: visible.get(row.right_memory_id) }));
  }

  snapshot(snapshotId, taskId) {
    const row = this.store.row('SELECT * FROM memory_snapshots WHERE snapshot_id=? AND task_id=?', snapshotId, taskId);
    if (!row) throw new this.errors.ScopeError('memory snapshot scope mismatch');
    const items = this.store.db.prepare(`SELECT v.version_id FROM memory_snapshot_items i
      JOIN memory_snapshot_versions v ON v.snapshot_id=i.snapshot_id AND v.memory_id=i.memory_id
      WHERE i.snapshot_id=? ORDER BY i.position`).all(snapshotId);
    const expected = this.store.row('SELECT COUNT(*) AS n FROM memory_snapshot_items WHERE snapshot_id=?', snapshotId).n;
    if (items.length !== expected) throw new this.errors.CheckpointError('memory snapshot has incomplete version references');
    return { ...row, parentIds: JSON.parse(row.parent_ids_json), memories: items.map(item => this.version(item.version_id, taskId)) };
  }

  createSnapshot(taskId, { epoch, revision, parentIds = [], message = '', author = 'host', memoryIds, versionIds, includeCandidates = false } = {}) {
    return this.store.tx(() => {
      const task = this.store.getTask(taskId);
      epoch ??= task.epoch; revision ??= task.revision;
      if (epoch !== task.epoch) throw new this.errors.EpochMismatch('stale memory snapshot epoch');
      if (revision !== task.revision) throw new this.errors.StaleRevision('stale memory snapshot revision');
      for (const parentId of parentIds) this.snapshot(parentId, taskId);
      let memories;
      if (versionIds) {
        memories = versionIds.map(versionId => this.version(versionId, taskId));
      } else {
        const active = this.list(taskId, { includeCandidates: true });
        memories = memoryIds ? memoryIds.map(memoryId => active.find(memory => memory.memory_id === memoryId) ?? this.read(memoryId, taskId))
          : active.filter(memory => includeCandidates || memory.origin === 'direct');
      }
      memories = [...new Map(memories.map(memory => [memory.memory_id, memory])).values()].sort((a, b) => a.memory_id.localeCompare(b.memory_id));
      const snapshotId = id('msnap');
      const treeHash = createHash('sha256').update(JSON.stringify(memories.map(memory => [memory.memory_id, memory.version_id]))).digest('hex');
      this.store.db.prepare('INSERT INTO memory_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(snapshotId, taskId, task.project_id, task.branch, epoch, revision, JSON.stringify(parentIds), treeHash, String(message), String(author), Date.now() / 1000);
      memories.forEach((memory, position) => {
        this.store.db.prepare('INSERT INTO memory_snapshot_items VALUES(?,?,?)').run(snapshotId, memory.memory_id, position);
        this.store.db.prepare('INSERT INTO memory_snapshot_versions VALUES(?,?,?)').run(snapshotId, memory.memory_id, memory.version_id);
      });
      this.store.recordEvent(taskId, 'memory_snapshot', { snapshotId, parentIds, treeHash, message, author }, { epoch });
      return this.snapshot(snapshotId, taskId);
    });
  }

  /** Additive migration: reconstruct old promotions from their audit events before freezing snapshots. */
  migrate() {
    if (this.store.row("SELECT value FROM meta WHERE key='memory_versions_migrated'")?.value === '1') return;
    this.store.tx(() => {
      const claims = this.store.db.prepare('SELECT * FROM memory_claims ORDER BY created_at,memory_id').all();
      const eventsByMemory = new Map(), snapshotEvents = new Map();
      for (const row of this.store.db.prepare("SELECT event_id,task_id,seq,epoch,source FROM events WHERE source IN ('memory_proposed','memory_confirmed','memory_promoted','memory_duplicate','memory_snapshot') ORDER BY seq").all()) {
        const payload = this.store.readEvent(row.task_id, row.event_id).payload;
        if (row.source === 'memory_snapshot') snapshotEvents.set(payload.snapshotId, row.seq);
        else if (payload.memoryId) {
          const events = eventsByMemory.get(payload.memoryId) ?? [];
          events.push({ ...row, payload });
          eventsByMemory.set(payload.memoryId, events);
        }
      }
      for (const row of claims) {
        if (this.store.row('SELECT 1 FROM memory_versions WHERE memory_id=?', row.memory_id)) continue;
        const events = eventsByMemory.get(row.memory_id) ?? [];
        let state;
        for (const [eventIndex,event] of events.entries()) {
          const { payload, source } = event;
          if (!state) {
            state = { ...decode(row), epoch: event.epoch, status: payload.status ?? (source === 'memory_proposed' ? 'proposed' : 'confirmed'), origin: payload.origin ?? row.origin, evidenceIds: payload.evidenceIds ?? [] };
          } else if (source === 'memory_duplicate') continue;
          else {
            state = { ...state, epoch: event.epoch, evidenceIds: [...new Set([...state.evidenceIds, ...(payload.evidenceIds ?? [])])] };
            if (source === 'memory_promoted') state.origin = 'direct';
            if(payload.status)state.status=payload.status;
            else if(source==='memory_confirmed')state.status='confirmed';
            else if(source==='memory_promoted'&&!events.slice(eventIndex+1).some(item=>item.source==='memory_confirmed'))state.status=row.status;
          }
          state.evidence_ids_json = JSON.stringify(state.evidenceIds);
          this.append(state, event.seq, event.epoch);
        }
        if (!state) {
          const seq = this.store.row('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE task_id=? AND created_at<=?', row.task_id, row.created_at).seq;
          this.append(decode(row), seq, row.epoch);
        }
      }
      const snapshots = this.store.db.prepare('SELECT * FROM memory_snapshots').all().map(row => ({ ...row,
        seq: snapshotEvents.get(row.snapshot_id) ?? this.store.row('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE task_id=? AND created_at<=?', row.task_id, row.created_at).seq,
      })).sort((a, b) => a.seq - b.seq);
      for (const snapshot of snapshots) {
        const active = this.visible(snapshot.task_id, { epoch: snapshot.epoch, limit: snapshot.seq });
        for (const item of this.store.db.prepare('SELECT memory_id FROM memory_snapshot_items WHERE snapshot_id=?').all(snapshot.snapshot_id)) {
          const memory = active.find(candidate => candidate.memory_id === item.memory_id);
          if (!memory) throw new this.errors.CheckpointError('cannot reconstruct legacy snapshot memory at its event horizon');
          this.store.db.prepare('INSERT OR IGNORE INTO memory_snapshot_versions VALUES(?,?,?)').run(snapshot.snapshot_id, item.memory_id, memory.version_id);
        }
      }
      this.store.db.prepare("INSERT OR REPLACE INTO meta VALUES('memory_versions_migrated','1')").run();
    });
  }
}
