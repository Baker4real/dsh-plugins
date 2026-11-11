import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['node_modules', '.git', '.scratch', '.cache', '.okf-cache', '.dsh-plugin-smoke', '.dsh-graph', 'run-evidence']);
const source = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (['.js', '.mjs', '.cjs'].includes(extname(path))) source.push(path);
    else if (entry.name === 'package.json') JSON.parse(readFileSync(path, 'utf8'));
  }
}
walk(root);
if (!source.length) throw new Error('No source files found.');
for (const file of source) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ status: 'passed', syntaxFiles: source.length }));
