import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';

let encoder;
/** Exact for cl100k text, an explicitly labelled estimate for other providers. */
export function countTextTokens(text) {
  encoder ??= new Tiktoken(cl100k);
  return encoder.encode(String(text), [], []).length;
}

export function checkedCount(counter, text) {
  const value = counter(String(text));
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('token counter must return a non-negative safe integer');
  return value;
}

export function validateBudget(budget, { allowUnlimited = false } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 0 || (!allowUnlimited && budget === 0)) {
    throw new RangeError('context budget must be a positive integer (compression alone accepts 0 for unlimited)');
  }
}

/** Includes metadata and the count field itself, not only selected body fields. */
export function measureManifest(payload, counter = countTextTokens) {
  let maximum = 0;
  for (let i = 0; i < 12; i++) {
    const measured = checkedCount(counter, JSON.stringify(payload));
    maximum = Math.max(maximum, measured);
    if (payload.estimatedTokens >= measured) return payload.estimatedTokens;
    payload.estimatedTokens = maximum;
  }
  // A conservative fixed-width reserve also handles counters with unusual digit boundaries.
  payload.estimatedTokens = maximum + 16;
  if (checkedCount(counter, JSON.stringify(payload)) > payload.estimatedTokens) throw new TypeError('unstable token counter');
  return payload.estimatedTokens;
}

export const MANIFEST_PREFIX = '[continuity manifest]\n';
export function renderManifest(payload) { return MANIFEST_PREFIX + JSON.stringify(payload); }

export function renderCompression(view) {
  return [
    '## Goal', view.goal || '(none)',
    '## Acceptance', ...(view.acceptance ?? []).map(x => '- ' + x),
    '## Constraints', ...(view.constraints ?? []).map(x => '- ' + x),
    '## User instructions (verbatim, chronological; later explicit corrections take precedence)',
    ...(view.instructions ?? []).map(x => '- [' + x.eventId + '] ' + x.text),
    '## Notebook (proposed observations are not confirmed requirements)',
    ...(view.notebook ?? []).map(x => '- [' + x.status + '/' + x.category + '] ' + x.text + ' (note ' + x.noteId + ')'),
    '## Memory', ...(view.memories ?? []).map(x => '- [' + x.status + '] ' + x.subject + ' ' + x.predicate + ': ' + JSON.stringify(x.value) + ' (memory ' + x.memoryId + ')'),
    '## Pending work', ...(view.pending ?? []).map(x => '- ' + (typeof x === 'string' ? x : JSON.stringify(x))),
    '## Compressed Context', ...view.keptEvents.map(x => '- [' + x.source + '] ' + x.text),
    '## Extracted Memory', ...view.extracted.map(x => '- ' + x.predicate + ': ' + x.value + ' (memory ' + x.memoryId + ')'),
    '## Recovery', 'compression view ' + view.viewId + '; omitted events: ' + view.omittedEventIds.length,
  ].join('\n');
}

/** Count the complete transport-shaped context without rewriting its native payload. */
export function countRequest(context, { model, countRequestTokens, counter = countTextTokens } = {}) {
  if (countRequestTokens) {
    const value = countRequestTokens(context, model);
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('request token counter must return a non-negative safe integer');
    return { tokens: value, method: 'provider-counter' };
  }
  // Opaque state and base64 remain in the counted serialization: this can overestimate,
  // but never silently strips them from the actual provider request.
  const tokens = checkedCount(counter, JSON.stringify(context));
  return { tokens: Math.ceil(tokens * 1.1) + 64, method: 'cl100k-transport-estimate-with-margin' };
}
