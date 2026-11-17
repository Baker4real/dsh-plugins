import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SourceNavigator } from '../source-nav.js';

async function fixture(operation) {
  const base = resolve('D:/agents/run-evidence/dsh-retro-20261116/slot-navigation-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'owned-'));
  const directory = join(root, 'node_modules', '@fixture', 'workspace');
  await mkdir(join(directory, 'src/client'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@fixture/workspace', version: '1.0.0' }));
  const sourceFile = join(directory, 'src/client/index.ts');
  await writeFile(sourceFile, "ctx.slots.register({ name: 'parent', children: {\n  'sidebar.fixture': { kind: 'list', scope: 'root' },\n} }, Component);\n");
  try { await operation(new SourceNavigator(root), { root, directory, sourceFile }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('slot navigation resolves an installed source declaration and its actual source path', async () => {
  await fixture(async (nav, { directory, sourceFile }) => {
    const result = await nav.slot({ root: 'sidebar.fixture' }, { packageNames: ['@fixture/workspace'] });
    assert.equal(result.ownership.status, 'source-verified');
    assert.equal(result.ownership.packageName, '@fixture/workspace');
    assert.equal(result.candidates[0].sourceFile, sourceFile);
    assert.equal(result.candidates[0].packageDirectory, directory);
    assert.equal(result.candidates[0].line, 2);
    assert.match(result.basis, /not.*runtime winner/iu);
  });
});

test('a built component label or a mere source reference is never reported as the owner', async () => {
  await fixture(async (nav, { sourceFile }) => {
    await writeFile(sourceFile, "const reference = 'sidebar.fixture'; const registrant = 'WC';\n");
    const result = await nav.slot({ root: 'sidebar.fixture' }, { packageNames: ['WC', '@fixture/workspace'] });
    assert.equal(result.ownership.status, 'unknown');
    assert.equal(result.candidates.length, 0);
  });
});

test('an external package directory requires matching package identity and honors output bounds', async () => {
  await fixture(async (nav, { directory }) => {
    const options = { packageNames: ['@fixture/workspace'], locatePackage: async () => directory };
    const result = await nav.slot({ root: 'sidebar.fixture', maxBytes: 1600 }, options);
    assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') <= 1600);
    await writeFile(join(directory, 'package.json'), '{"name":"different"}');
    const mismatch = await nav.slot({ root: 'sidebar.fixture' }, options);
    assert.equal(mismatch.ownership.status, 'unknown');
    assert.equal(mismatch.candidates.length, 0);
  });
});
