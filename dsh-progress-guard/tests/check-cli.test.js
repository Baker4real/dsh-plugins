import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.DSH_CHECK_RUNTIME || process.env.DSH_DESKTOP_EXE || (process.versions.electron ? process.execPath : 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe');

function fixture(t, { clientLifecycle = true } = {}) {
  const target = mkdtempSync(join(root, '.check-test-'));
  t.after(() => {
    assert.equal(dirname(target), root);
    assert.ok(target.startsWith(join(root, '.check-test-')));
    rmSync(target, { recursive: true, force: true });
  });
  // Copy only the public check inputs, never the workspace, evidence or profile.
  for (const name of ['package.json', 'index.js', 'policy.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale', 'scripts']) {
    if (existsSync(join(root, name))) cpSync(join(root, name), join(target, name), { recursive: true });
  }
  mkdirSync(join(target, 'tests', 'fixtures'), { recursive: true });
  for (const name of ['progress.test.js', 'boundaries.test.js', 'incident-replay.test.js']) {
    cpSync(join(root, 'tests', name), join(target, 'tests', name));
  }
  if (clientLifecycle) cpSync(join(root, 'tests', 'client-lifecycle.test.js'), join(target, 'tests', 'client-lifecycle.test.js'));
  if (existsSync(join(root, 'tests', 'fixtures'))) cpSync(join(root, 'tests', 'fixtures'), join(target, 'tests', 'fixtures'), { recursive: true });
  return target;
}

function check(target, args = []) {
  const resourcesArgs = process.env.DSH_CHECK_RESOURCES ? ['--resources', process.env.DSH_CHECK_RESOURCES] : [];
  const result = spawnSync(process.execPath, [join(target, 'scripts', 'check.mjs'), '--runtime', runtime, ...resourcesArgs, ...args], {
    cwd: target, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 150_000, maxBuffer: 128 * 1024, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.ok(result.stdout.length < 32_000, 'CLI report stays bounded');
  return { ...result, report: JSON.parse(result.stdout) };
}

test('public check CLI rejects a missing distribution resource', { timeout: 160_000 }, t => {
  const target = fixture(t);
  rmSync(join(target, 'icon.svg'));
  const result = check(target);
  assert.equal(result.status, 1);
  assert.equal(result.report.status, 'failed');
  assert.match(JSON.stringify(result.report), /icon\.svg/);
});

test('public check CLI rejects malformed ModuleLoader JavaScript', { timeout: 160_000 }, t => {
  const target = fixture(t);
  writeFileSync(join(target, 'client.js'), 'window.__ModuleLoader__.load({ broken syntax');
  const result = check(target);
  assert.equal(result.status, 1);
  assert.equal(result.report.checks.find(item => item.name === 'syntax').status, 'failed');
});

test('public check CLI propagates a real Host behavior test failure', { timeout: 160_000 }, t => {
  const target = fixture(t);
  writeFileSync(join(target, 'tests', 'progress.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { Context } from '@deepseek-ai/cordis'; test('negative Host control', () => { assert.equal(typeof Context, 'function'); assert.fail('injected Host behavior failure'); });\n");
  const result = check(target);
  assert.equal(result.status, 1);
  const failed = result.report.checks.find(item => item.name === 'host-tests');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /injected Host behavior failure/);
});

test('public check CLI passes real tests and writes the identical absolute report', { timeout: 160_000 }, t => {
  const target = fixture(t);
  const reportPath = join(target, 'check-report.json');
  const result = check(target, ['--report', reportPath]);
  assert.equal(result.status, 0, JSON.stringify(result.report));
  assert.equal(result.report.status, 'passed');
  assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), result.report);
  assert.ok(result.report.runtime.electron);
  assert.ok(result.report.checks.some(item => item.name === 'host-tests' && item.status === 'passed'));
  assert.ok(result.report.checks.some(item => item.name === 'client-lifecycle' && item.status === 'passed'));
  assert.equal(result.report.coverage.clientLifecycle, 'passed');
});

test('public check CLI explicitly marks missing lifecycle behavior as not covered', { timeout: 160_000 }, t => {
  const target = fixture(t, { clientLifecycle: false });
  const result = check(target);
  assert.equal(result.status, 0, JSON.stringify(result.report));
  assert.ok(result.report.checks.some(item => item.name === 'client-lifecycle' && item.status === 'not-covered'));
  assert.equal(result.report.coverage.clientLifecycle, 'not-covered');
  assert.ok(result.report.checks.some(item => item.name === 'host-tests' && item.status === 'passed'));
});
