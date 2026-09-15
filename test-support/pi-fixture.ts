import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';
import { Type } from '../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs';
import { ContinuityStore } from '../src/core.ts';

export { sdk };
const agentEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
export const ai = await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', agentEntry).href);
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
export const image = () => ({ type: 'image' as const, data: PNG.toString('base64'), mimeType: 'image/png' });
export function removeFixture(root: string) {
  const path = resolve(root);
  assert.ok(relative(projectRoot, path).startsWith('.tmp-pi-'), 'cleanup must stay inside the test workspace');
  rmSync(path, { recursive: true, force: true });
}
export function readStore(root: string, mode = 'active') {
  const pointer = JSON.parse(readFileSync(join(root, '.pi/continuity-task.json'), 'utf8'));
  const store = new ContinuityStore(join(root, '.pi/continuity.db'), { mode });
  return { store, taskId: pointer.taskId };
}
export async function createPiFixture(options: {
  mode?: 'off' | 'record' | 'active'; budget?: number; extension?: boolean;
  responses?: unknown[]; settings?: Record<string, unknown>; customTools?: unknown[]; tools?: string[];
} = {}) {
  const root = mkdtempSync(join(projectRoot, '.tmp-pi-integration-'));
  const agentDir = join(root, 'agent'); mkdirSync(agentDir, { recursive: true });
  const previous = { mode: process.env.PI_CONTINUITY_MODE, host: process.env.PI_CONTINUITY_HOST, budget: process.env.PI_CONTINUITY_BUDGET };
  process.env.PI_CONTINUITY_MODE = options.mode ?? 'active';
  delete process.env.PI_CONTINUITY_HOST;
  process.env.PI_CONTINUITY_BUDGET = String(options.budget ?? 12000);
  const contexts: unknown[] = [], events: unknown[] = [], errors: unknown[] = [];
  const faux = ai.fauxProvider({ models: [{ id: 'continuity-offline-test', input: ['text', 'image'], contextWindow: 8192, maxTokens: 512 }] });
  const modelRuntime = await sdk.ModelRuntime.create({ refreshOnCreate: false, authPath: join(agentDir, 'auth.json'), modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const responses = options.responses ?? [ai.fauxAssistantMessage('done')];
  faux.setResponses(responses.map(step => async (context, streamOptions, state, model) => {
    assert.equal(model.id, 'continuity-offline-test');
    contexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages ?? []) });
    return typeof step === 'function' ? await step(context, streamOptions, state, model) : step;
  }));
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 128 },
    retry: { enabled: false }, ...options.settings,
  });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: options.extension === false ? [] : [join(projectRoot, '.pi/extensions/continuity.js')],
    systemPrompt: 'Deterministic local integration test. Use only the scripted test provider.',
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, [], 'real Pi extension loader must accept the project extension');
  const sessionManager = sdk.SessionManager.create(root, join(root, 'sessions'));
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime, model: faux.getModel(),
    thinkingLevel: 'off', resourceLoader, settingsManager, sessionManager,
    tools: options.tools ?? options.customTools?.map(tool => tool.name) ?? [], customTools: options.customTools,
  });
  session.subscribe(event => events.push(structuredClone(event)));
  await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) });
  return { root, agentDir, faux, session, sessionManager, modelRuntime, resourceLoader, settingsManager, contexts, events, errors,
    async close() {
      try {
        if (session.isStreaming) await session.abort();
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      } finally {
        for (const [key, value] of Object.entries({ PI_CONTINUITY_MODE: previous.mode, PI_CONTINUITY_HOST: previous.host, PI_CONTINUITY_BUDGET: previous.budget })) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        removeFixture(root);
      }
    },
  };
}
