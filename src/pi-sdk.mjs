import { GateError } from './core.mjs';
import { countRequest, renderManifest } from './context-budget.mjs';

/**
 * Wrap Pi 0.85 ModelRuntime at the final SDK stream boundary. The wrapper is
 * deliberately dependency-free: callers pass the installed SDK runtime. It
 * can therefore be used with the real package or a contract-test double.
 *
 * Pi's extension before_provider_request hook can rewrite payloads but cannot
 * reliably stop execution. This runtime wrapper performs the continuity gate
 * immediately before Pi's provider stream function is called.
 */
export function createContinuityModelRuntime(modelRuntime, store, taskId, { budget = 12000, inputBudget, countRequestTokens, outputReserve } = {}) {
  if (!modelRuntime || typeof modelRuntime.streamSimple !== 'function') {
    throw new TypeError('modelRuntime.streamSimple is required');
  }
  return new Proxy(modelRuntime, {
    get(target, property, receiver) {
      if (property !== 'streamSimple') return Reflect.get(target, property, receiver);
      return (model, context, options) => {
        if (store.mode !== 'active') return target.streamSimple.call(target, model, context, options);
        store.startRun(taskId);
        const reserve=outputReserve ?? options?.maxTokens ?? model?.maxTokens ?? 4096;
        const limit=inputBudget ?? (Number.isFinite(model?.contextWindow) ? model.contextWindow-reserve : undefined);
        const countOptions={model,countRequestTokens,counter:store.countTokens};
        const base=countRequest(context??{},countOptions);
        if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<=0||base.tokens>=limit)) throw new GateError('full provider input exceeds context budget before Continuity injection');
        const available=limit===undefined?budget:Math.min(budget,Math.max(1,limit-base.tokens));
        const manifest = store.buildManifest(taskId, { budget:available });
        const prior = context?.systemPrompt ?? '';
        const systemPrompt = prior+(prior?'\n\n':'')+renderManifest(manifest);
        const gatedContext = { ...context, systemPrompt };
        const counted=countRequest(gatedContext,countOptions);
        if(limit!==undefined&&counted.tokens>limit) throw new GateError('full provider input including system, messages, tools and Continuity exceeds context budget');
        const requestBlobId = store.saveBlob(JSON.stringify(gatedContext));
        store.recordEvent(taskId, 'model_request', {
          manifestId: manifest.manifestId,
          requestBlobId,
          inputTokens:counted.tokens, tokenCounter:counted.method, inputBudget:limit,
          model: model ? { provider: model.provider, id: model.id } : undefined,
        });
        try {
          return target.streamSimple.call(target, model, gatedContext, options);
        } catch (error) {
          store.recordEvent(taskId, 'model_error', { error: String(error) });
          throw error;
        }
      };
    },
  });
}

/** Preflight helper for hosts that call session.prompt() directly. */
export function assertContinuityReady(store, taskId, { budget = 12000 } = {}) {
  if (store.mode === 'off') return undefined;
  try { return store.buildManifest(taskId, { budget }); }
  catch (error) {
    if (error instanceof GateError) throw error;
    throw new GateError(`continuity preflight failed: ${error.message}`);
  }
}
