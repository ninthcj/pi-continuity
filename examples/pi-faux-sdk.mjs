#!/usr/bin/env node
// Offline contract demonstration. Install Pi 0.85.1 in this project first.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createContinuityPiSession } from '../src/pi-host.mjs';

const sdk = await import('@earendil-works/pi-coding-agent');
let ai;
try { ai = await import('@earendil-works/pi-ai'); }
catch {
  const agentEntry = await import.meta.resolve('@earendil-works/pi-coding-agent');
  ai = await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', agentEntry).href);
}
const faux = ai.fauxProvider({ models: [{ id: 'continuity-test', name: 'Continuity test' }] });
faux.setResponses([ai.fauxAssistantMessage('first window'), ai.fauxAssistantMessage('second window')]);
const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, authPath: join(process.cwd(), '.pi', 'test-auth.json') });
runtime.registerNativeProvider(faux.provider);
const cwd = join(process.cwd(), '.pi-faux-sdk-cwd');
const host = await createContinuityPiSession({ sdk, modelRuntime: runtime, model: faux.getModel(), cwd, goal: 'verify continuity', noTools: 'all', sessionManager: sdk.SessionManager.inMemory(cwd), replacementAware: true });
try {
  await host.session.prompt('first');
  const checkpointId = await host.checkpoint();
  const resumed = await host.resume(checkpointId);
  await host.session.prompt('second');
  console.log(JSON.stringify({ providerCalls: faux.state.callCount, resumedEpoch: resumed.epoch, status: host.store.status(host.task.task_id) }, null, 2));
} finally {
  await host.close();
  rmSync(cwd, { recursive: true, force: true });
}
