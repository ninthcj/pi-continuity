import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const coreUrl = argument('--core') ? pathToFileURL(resolve(argument('--core'))) : new URL('../src/core.mjs', import.meta.url);
const { ContinuityStore } = await import(coreUrl);
const { countTextTokens, renderCompression } = await import(new URL('./context-budget.mjs', coreUrl));
const sizes = (argument('--events') ?? '64,256,1024').split(',').map(Number);
assert.ok(sizes.every(size => Number.isSafeInteger(size) && size > 0 && size <= 10000));
countTextTokens('warm tokenizer');
const results = [];
for (const size of sizes) {
  const root = mkdtempSync(join(tmpdir(), 'continuity-context-benchmark-'));
  let calls = 0, tokenizedCharacters = 0;
  const counter = text => { calls++; tokenizedCharacters += text.length; return countTextTokens(text); };
  const store = new ContinuityStore(join(root, 'c.db'), { mode: 'active', countTokens: counter });
  try {
    const taskId = store.createTask('benchmark', 'main', 'Preserve the whole task').task_id;
    store.recordEvent(taskId, 'user_input', { text: '用户纠正：只能部署到测试环境。' });
    store.recordEvent(taskId, 'model_response', { text: 'Decision: keep original evidence\nNext step: verify all work' });
    for (let i = 0; i < size; i++) store.recordEvent(taskId, 'tool_result', { output: 'diagnostic observation '.repeat(40) + i });
    const runs = [];
    for (let run = 0; run < 2; run++) {
      calls = 0; tokenizedCharacters = 0;
      const start = performance.now();
      const view = store.compressContext(taskId, { budget: 1200 });
      const milliseconds = performance.now() - start;
      assert.ok(view.instructions.some(note => note.text.includes('只能部署到测试环境')));
      assert.equal(view.tokensAfter, countTextTokens(renderCompression(view)));
      assert.ok(view.tokensAfter <= 1200);
      runs.push({ run: run + 1, milliseconds: Math.round(milliseconds * 10) / 10, tokenCounterCalls: calls, tokenizedCharacters, tokensAfter: view.tokensAfter, metrics: view.metrics });
    }
    results.push({ events: size, runs });
  } finally {
    store.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('continuity-context-benchmark-'));
    rmSync(root, { recursive: true, force: true });
  }
}
const report = { date: new Date().toISOString(), node: process.version, platform: process.platform, budget: 1200, results };
const encoded = JSON.stringify(report, null, 2);
if (argument('--output')) writeFileSync(resolve(argument('--output')), encoded + '\n');
console.log(encoded);
