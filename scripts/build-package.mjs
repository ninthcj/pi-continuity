import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'src');
const output = join(root, 'dist');
mkdirSync(join(output, 'bin'), { recursive: true });
const modules = readdirSync(source).filter(file => file.endsWith('.mjs'));
for (const file of readdirSync(output)) {
  if (file !== 'bin' && !modules.includes(file)) throw new Error('Unexpected file in package output: ' + file);
}
for (const file of modules) {
  const contents = file === 'core.mjs'
    ? stripTypeScriptTypes(readFileSync(join(source, 'core.ts'), 'utf8'), { mode: 'strip' })
    : readFileSync(join(source, file), 'utf8');
  writeFileSync(join(output, file), contents);
}
for (const file of readdirSync(join(root, 'bin')).filter(file => file.endsWith('.mjs'))) {
  const contents = readFileSync(join(root, 'bin', file), 'utf8').replaceAll("'../src/", "'../");
  writeFileSync(join(output, 'bin', file), contents);
}
console.log('Built distributable JavaScript modules; no TypeScript loader is needed by consumers.');
