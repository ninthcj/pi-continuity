import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPiFixture, readStore, image, PNG, ai, sdk } from '../test-support/pi-fixture.ts';
import { createContinuityPiSession } from '../src/pi-host.mjs';

const opts = { timeout: 20000 };

test('actual Pi: native image survives request while Continuity manifest stores a restorable reference', opts, async () => {
  const f = await createPiFixture();
  try {
    const original = image();
    await f.session.prompt('remember this diagram', { images: [original] });
    assert.equal(f.faux.state.callCount, 1);
    assert.deepEqual(f.errors, []);
    const context = f.contexts[0];
    assert.ok(context.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image' && block.data === original.data)));
    const { store, taskId } = readStore(f.root);
    try {
      const manifest = store.buildManifest(taskId);
      const event = manifest.events.find(event => event.payload.images?.length);
      assert.ok(event, 'Pi images must reach the ledger');
      assert.equal(JSON.stringify(manifest).includes(original.data), false);
      assert.deepEqual(store.loadBlob(event.payload.images[0].assetId), PNG);
      assert.equal(store.row('PRAGMA integrity_check').integrity_check, 'ok');
    } finally { store.close(); }
  } finally { await f.close(); }
});


test('actual Pi: compaction failure is recorded and gates the next provider call', opts, async () => {
  const f = await createPiFixture({ responses: [ai.fauxAssistantMessage('first'), ai.fauxAssistantMessage('must not run')] });
  try {
    await f.session.prompt('before failure');
    await f.session.extensionRunner.emit({ type: 'session_compact_failed', reason: 'manual', aborted: false, willRetry: false, fromExtension: true, errorMessage: 'forced compact failure' });
    const { store, taskId } = readStore(f.root);
    try {
      assert.equal(store.status(taskId).runtime.state, 'RECOVERY_REQUIRED');
      assert.ok(store.row("SELECT COUNT(*) n FROM work_records WHERE task_id=? AND kind='pi_session_compact_failed'", taskId).n >= 1);
    } finally { store.close(); }
    await f.session.prompt('blocked after failure');
    assert.equal(f.faux.state.callCount, 1);
  } finally { await f.close(); }
});

test('actual Pi: failed custom tool records failed operation', opts, async () => {
  let executions = 0;
  const f = await createPiFixture({ customTools: [{ name: 'fixture_fail', label: 'Fail', description: 'Fails once', parameters: { type: 'object', properties: {}, additionalProperties: false }, async execute() { executions++; throw new Error('fixture tool failure'); } }], responses: [ai.fauxAssistantMessage(ai.fauxToolCall('fixture_fail', {}, { id: 'failed-call-1' }), { stopReason: 'toolUse' })] });
  try {
    await f.session.prompt('run failing fixture');
    assert.equal(executions, 1);
    const { store, taskId } = readStore(f.root);
    try {
      assert.equal(store.row('SELECT status FROM operations WHERE task_id=?', taskId).status, 'failed');
      assert.ok(store.events(taskId).some(event => event.source === 'tool_result' && event.payload.includes('fixture tool failure')));
    } finally { store.close(); }
  } finally { await f.close(); }
});

for (const mode of ['off', 'record']) {
  test(`actual Pi: ${mode} preserves native model input`, opts, async () => {
    const f = await createPiFixture({ mode });
    try {
      await f.session.prompt('mode baseline', { images: [image()] });
      assert.equal(f.faux.state.callCount, 1);
      assert.equal(JSON.stringify(f.contexts[0]).includes('continuity manifest'), false);
      assert.equal(JSON.stringify(f.contexts[0]).includes('"customType":"continuity"'), false);
      if (mode === 'off') assert.equal(existsSync(join(f.root, '.pi/continuity.db')), false, 'off must not create a continuity store');
      else {
        const { store, taskId } = readStore(f.root, mode);
        try { assert.ok(store.events(taskId).some(event => JSON.parse(event.payload).images?.length)); }
        finally { store.close(); }
      }
    } finally { await f.close(); }
  });
}

test('actual Pi: compact retains assistant decisions, user images and native JSONL; next turn sees summary', opts, async () => {
  const decision = 'Decision: chosen-connector-7821';
  const f = await createPiFixture({ responses: [ai.fauxAssistantMessage(decision), ai.fauxAssistantMessage('middle'), ai.fauxAssistantMessage('ready'), ai.fauxAssistantMessage('after')] });
  try {
    await f.session.prompt('remember image and design constraints', { images: [image()] });
    await f.session.prompt('continue investigation ' + 'bounded history '.repeat(100));
    await f.session.prompt('finish this phase ' + 'recent evidence '.repeat(50));
    const beforeCalls = f.faux.state.callCount;
    const result = await f.session.compact();
    assert.equal(f.faux.state.callCount, beforeCalls, 'Continuity deterministic compaction must not call a summarizer model');
    assert.ok(result.summary.includes('chosen-connector-7821'), 'assistant decision must survive compaction');
    assert.match(result.summary, /blob_/);
    assert.equal(result.summary.includes(PNG.toString('base64')), false);
    const entries = f.sessionManager.getEntries();
    assert.ok(entries.some(entry => entry.type === 'compaction'));
    const { store: compactStore, taskId: compactTask } = readStore(f.root);
    try { assert.ok(compactStore.row("SELECT COUNT(*) n FROM work_records WHERE task_id=? AND kind='pi_session_compact'", compactTask).n >= 1); } finally { compactStore.close(); }
    assert.ok(readFileSync(f.sessionManager.getSessionFile(), 'utf8').includes(PNG.toString('base64')), 'native raw JSONL must keep image');
    await f.session.prompt('continue after compaction');
    assert.ok(JSON.stringify(f.contexts.at(-1)).includes('chosen-connector-7821'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('actual Pi: tool_result content/details and tool image are archived, operation succeeds', opts, async () => {
  let executions = 0;
  const f = await createPiFixture({ customTools: [{ name: 'fixture_image', label: 'Fixture', description: 'Returns an isolated test image', parameters: { type: 'object', properties: {} },
    async execute() { executions++; return { content: [{ type: 'text', text: 'tool-evidence-4892' }, image()], details: { marker: 'detail-782' } }; },
  }], responses: [ai.fauxAssistantMessage(ai.fauxToolCall('fixture_image', {}, { id: 'fixture-call-1' }), { stopReason: 'toolUse' }), ai.fauxAssistantMessage('tool finished')] });
  try {
    await f.session.prompt('get the fixture image');
    assert.equal(executions, 1);
    const { store, taskId } = readStore(f.root);
    try {
      const events = store.events(taskId).filter(event => event.source === 'tool_result');
      assert.ok(events.some(event => event.availability === 'captured' && event.payload.includes('tool-evidence-4892')));
      assert.ok(events.some(event => event.payload.includes('detail-782')));
      assert.ok(events.some(event => event.payload.includes('assetId')));
      assert.equal(store.row('SELECT status FROM operations WHERE task_id=?', taskId).status, 'succeeded');
    } finally { store.close(); }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('actual Pi: required context exceeding input budget prevents provider execution', opts, async () => {
  const f = await createPiFixture({ budget: 1 });
  try {
    await f.session.prompt('A critical user constraint must not be silently dropped.');
    assert.equal(f.faux.state.callCount, 0);
  } finally { await f.close(); }
});

for (const mode of ['off', 'record']) {
  test(`actual SDK host: ${mode} does not inject Continuity input`, opts, async () => {
    const f = await createPiFixture({ extension: false, mode });
    let host;
    try {
      host = await createContinuityPiSession({ sdk, modelRuntime: f.modelRuntime, model: f.faux.getModel(), mode,
        cwd: f.root, agentDir: f.agentDir, goal: 'host mode baseline', tools: [],
        sessionManager: sdk.SessionManager.inMemory(f.root), settingsManager: f.settingsManager, resourceLoader: f.resourceLoader,
      });
      await host.session.prompt('native request');
      assert.equal(f.faux.state.callCount, 1);
      assert.equal(f.contexts[0].systemPrompt.includes('[continuity manifest]'), false);
    } finally { await host?.close(); await f.close(); }
  });
}

test('actual Pi: notebook tools write proposed notes and retrieve them with task-scoped evidence', opts, async () => {
  let f;
  f = await createPiFixture({ tools: ['continuity_note','continuity_recall'], responses: [
    () => {
      const { store, taskId } = readStore(f.root);
      let source;
      try { source = store.events(taskId).find(event => event.source === 'user_input').event_id; }
      finally { store.close(); }
      return ai.fauxAssistantMessage(ai.fauxToolCall('continuity_note', { key: 'auth-check', category: 'pending', text: 'Verify authentication before release', evidenceIds: [source] }, { id: 'note-write-1' }), { stopReason: 'toolUse' });
    },
    ai.fauxAssistantMessage(ai.fauxToolCall('continuity_recall', { kind: 'notebook' }, { id: 'note-read-1' }), { stopReason: 'toolUse' }),
    ai.fauxAssistantMessage('notebook stored and recalled'),
  ] });
  try {
    await f.session.prompt('Remember the authentication verification task');
    assert.equal(f.faux.state.callCount, 3);
    const { store, taskId } = readStore(f.root);
    try {
      assert.ok(store.notebookEntries(taskId).some(note => note.entry_key === 'auth-check' && note.status === 'proposed'), JSON.stringify(f.events.filter(event=>event.type==='tool_execution_end')));
      assert.ok(store.events(taskId).some(event => event.source === 'tool_result' && event.payload.includes('Verify authentication before release')));
    } finally { store.close(); }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('actual Pi: impossible notebook compaction cancels without a provider fallback', opts, async () => {
  const f = await createPiFixture({ budget: 800, responses: [ai.fauxAssistantMessage('first turn'), ai.fauxAssistantMessage('must not be called')] });
  try {
    await f.session.prompt('Keep the source history');
    const { store, taskId } = readStore(f.root);
    try {
      const source = store.events(taskId).find(event => event.source === 'user_input').event_id;
      store.recordNote(taskId, 1, '必须完整保留的已确认要求。'.repeat(300), { status: 'confirmed', evidenceIds: [source], sourceEvent: { actor: 'host', id: 'required-note' } });
    } finally { store.close(); }
    await assert.rejects(f.session.compact());
    assert.equal(f.faux.state.callCount, 1, 'failed custom compaction must not fall through to native model summarization');
    assert.equal(f.sessionManager.getEntries().filter(entry => entry.type === 'compaction').length, 0);
    await f.session.prompt('continue');
    assert.equal(f.faux.state.callCount, 1, 'recovery gate must block the next request');
  } finally { await f.close(); }
});

test('actual Pi: optional semantic notebook observation uses the native provider and retains provenance', opts, async () => {
  const previous = process.env.PI_CONTINUITY_NOTEBOOK;
  process.env.PI_CONTINUITY_NOTEBOOK = 'semantic';
  let f;
  try {
    f = await createPiFixture({ responses: [ai.fauxAssistantMessage('The authentication regression still needs verification.'), () => {
      const { store, taskId } = readStore(f.root);
      let source;
      try { source = store.events(taskId).find(event => event.source === 'user_input').event_id; }
      finally { store.close(); }
      return ai.fauxAssistantMessage(JSON.stringify({ entries: [{ key: 'auth-verification', category: 'pending', text: 'Authentication regression requires verification', evidenceIds: [source] }] }));
    }] });
    await f.session.prompt('Verify authentication before releasing the project');
    const compacted = await f.session.compact();
    assert.equal(f.faux.state.callCount, 2);
    assert.match(compacted.summary, /Authentication regression requires verification/);
    const { store, taskId } = readStore(f.root);
    try {
      const note = store.notebookEntries(taskId).find(note => note.entry_key === 'auth-verification');
      assert.equal(note.status, 'proposed');
      assert.equal(note.origin, 'observer');
      assert.equal(store.readEvent(taskId, note.evidenceIds[0]).source, 'user_input');
    } finally { store.close(); }
    assert.deepEqual(f.errors, []);
  } finally {
    await f?.close();
    if(previous===undefined)delete process.env.PI_CONTINUITY_NOTEBOOK;else process.env.PI_CONTINUITY_NOTEBOOK=previous;
  }
});
