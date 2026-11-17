import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const node = process.execPath;

async function fixture(operation) {
  const scratch = join(root, '.scratch');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'build-'));
  try {
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await copyFile(join(root, 'scripts/build.mjs'), join(directory, 'scripts/build.mjs'));
    await writeFile(join(directory, 'policy.js'), 'export const enabled = true;\n');
    await writeFile(join(directory, 'src/client.js'), '(() => { /* @policy */ })();\n');
    const run = (...args) => spawnSync(node, [join(directory, 'scripts/build.mjs'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    await operation(directory, run);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('check detects a stale generated client without rewriting it', async () => {
  await fixture(async (directory, run) => {
    const target = join(directory, 'client.js');
    await writeFile(target, 'stale client\n');
    const before = await stat(target);
    const result = run('--check');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /stale|out.of.date/iu);
    assert.equal(await readFile(target, 'utf8'), 'stale client\n');
    assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  });
});

test('build repairs the output and check accepts it from another working directory', async () => {
  await fixture(async (directory, run) => {
    assert.equal(run().status, 0);
    assert.match(await readFile(join(directory, 'client.js'), 'utf8'), /const enabled = true/u);
    assert.equal(run('--check').status, 0);
    await writeFile(join(directory, 'policy.js'), 'export const enabled = false;\n');
    assert.equal(run('--check').status, 1);
  });
});

test('missing or duplicate template insertion points fail instead of emitting a broken bundle', async () => {
  await fixture(async (directory, run) => {
    for (const template of ['(() => {})();', '/* @policy */ /* @policy */']) {
      await writeFile(join(directory, 'src/client.js'), template);
      assert.equal(run().status, 1);
    }
  });
});
