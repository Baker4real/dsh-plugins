import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SourceNavigator } from '../source-nav.js';

const base = 'D:/Codex/tmp/dsh-retro-source-tests';
await mkdir(base, { recursive: true });
async function fixture() {
  const root = await mkdtemp(join(base, 'fixture-'));
  const directory = join(root, 'node_modules', '@fixture', 'package');
  await mkdir(join(directory, 'lib'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@fixture/package', version: '1.0.0', exports: { '.': { import: './lib/index.js', types: './lib/missing.d.ts' }, './client': './lib/client.js' } }));
  await writeFile(join(directory, 'lib', 'index.js'), 'export const marker = true;\n');
  await writeFile(join(directory, 'lib', 'client.js'), 'x'.repeat(10000) + 'TARGET_NEEDLE' + 'y'.repeat(10000));
  return { root, directory, nav: new SourceNavigator(root) };
}

test('resolve reports the real export targets and missing declaration without guessing paths', async () => {
  const { nav } = await fixture();
  const result = await nav.resolve({ packageName: '@fixture/package' });
  assert.equal(result.version, '1.0.0');
  assert.equal(result.targets.find(item => item.path.endsWith('index.js')).exists, true);
  assert.equal(result.targets.find(item => item.path.endsWith('missing.d.ts')).exists, false);
  assert.equal(result.targets.length, 2);
});

test('search centers a bounded snippet on a match far into a minified line', async () => {
  const { nav } = await fixture();
  const result = await nav.search({ packageName: '@fixture/package', file: 'lib/client.js', needle: 'TARGET_NEEDLE', contextChars: 24, maxBytes: 1000 });
  assert.equal(result.matches[0].line, 1);
  assert.equal(result.matches[0].column, 10001);
  assert.match(result.matches[0].text, /TARGET_NEEDLE/);
  assert.ok(result.matches[0].text.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) <= 1000);
});

test('tiny byte budgets count the complete pretty-printed source result', async () => {
  const { nav } = await fixture();
  const result = await nav.search({ packageName: '@fixture/package', file: 'lib/client.js', needle: 'x', contextChars: 0, maxMatches: 25, maxBytes: 800 });
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') <= 800);
  assert.equal(result.truncated, true);
  assert.ok(result.nextOffset > 0);
});

test('navigation remains inside the selected package and paginates actual files', async () => {
  const { nav, directory, root } = await fixture();
  const result = await nav.files({ packageName: '@fixture/package', directory: 'lib', limit: 1 });
  assert.equal(result.files.length, 1);
  assert.equal(result.nextOffset, 1);
  await assert.rejects(nav.search({ packageName: '@fixture/package', file: '../outside.js', needle: 'secret' }), /relative|inside|traversal/);
  await assert.rejects(nav.resolve({ packageName: '../package' }), /package/);
  const outside = join(root, 'outside.js');
  await writeFile(outside, 'outside');
  await symlink(outside, join(directory, 'lib', 'escape.js'));
  await assert.rejects(nav.search({ packageName: '@fixture/package', file: 'lib/escape.js', needle: 'outside' }), /outside|inside/);
});
