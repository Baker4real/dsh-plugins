import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installed = process.env.DSH_GOAL_WAIT_DSH_ROOT || 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh';
const checks = [];
const report = { schemaVersion: 1, status: 'failed', packageName: '@local/dsh-goal-wait', checks };
const bound = value => String(value?.message ?? value).slice(-10000);
function stage(name, action) {
  const start = Date.now();
  try { const details = action(); checks.push({ name, status: 'passed', durationMs: Date.now() - start, details }); return true; }
  catch (error) { checks.push({ name, status: 'failed', durationMs: Date.now() - start, error: bound(error) }); return false; }
}
function contained(file) {
  const absolute = resolve(root, file);
  assert.ok(!isAbsolute(file) && !relative(root, absolute).startsWith('..'), 'Distribution resource escapes the package.');
  assert.ok(!relative(realpathSync(root), realpathSync(absolute)).startsWith('..'), 'Distribution symlink escapes the package.');
  return absolute;
}
function text(file) { return readFileSync(contained(file), 'utf8'); }
function expand(pattern) {
  assert.ok(!pattern.includes('**') && !/[?\[\]{}!]/.test(pattern), 'Use single-directory distribution patterns.');
  if (!pattern.includes('*')) { assert.ok(statSync(contained(pattern)).isFile()); return [pattern.replace(/^\.\//, '')]; }
  const directory = dirname(pattern);
  const leaf = pattern.slice(directory === '.' ? 0 : directory.length + 1);
  assert.equal(leaf.split('*').length, 2);
  const [prefix, suffix] = leaf.split('*');
  const names = readdirSync(contained(directory)).filter(n => n.startsWith(prefix) && n.endsWith(suffix));
  assert.ok(names.length > 0, `Distribution pattern has no matches: ${pattern}`);
  return names.map(n => join(directory, n).replaceAll('\\', '/'));
}
function main() {
  if (!stage('installed-runtime', () => {
    assert.ok(process.versions.electron, 'Checks must run in installed Electron Node mode.');
    const require = createRequire(pathToFileURL(`${installed}/package.json`));
    const versions = {};
    for (const name of ['@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-goal-round-driver', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-agent-loop']) {
      require.resolve(name);
      versions[name] = require(`${name}/package.json`).version;
      assert.equal(versions[name], '0.2.2-rc.1');
    }
    return { electron: process.versions.electron, node: process.versions.node, versions };
  })) return;
  let files;
  if (!stage('manifest-and-resources', () => {
    const manifest = JSON.parse(text('package.json'));
    assert.equal(manifest.name, '@local/dsh-goal-wait');
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.engines.dsh, '0.2.2-rc.1');
    assert.equal(manifest.scripts.check, 'node scripts/check.mjs');
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(manifest.dependencies, undefined, 'Reuse Host packages; no package installation is needed.');
    assert.equal(manifest.peerDependencies, undefined, 'Shipped Host packages resolve through Harness.');
    files = new Set(manifest.files.flatMap(expand));
    for (const required of ['index.js', 'state.js', 'receipt.js', 'cordis.patch.yml', 'README.md', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'scripts/check.mjs', 'scripts/check-runtime.mjs', 'scripts/runtime-loader.mjs']) assert.ok(files.has(required), `Missing resource: ${required}`);
    for (const [key, target] of Object.entries(manifest.exports)) for (const file of expand(target)) assert.ok(files.has(file), `Export missing from files: ${key}`);
    assert.equal(manifest.exports['.'], './index-v2.js');
    assert.equal(manifest.exports['./icon'], './icon.svg');
    assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
    assert.match(text('cordis.patch.yml').trim(), /^- insert:\s+- id: goal-wait\s+name: '@local\/dsh-goal-wait'\s+config:\s+receiptRoots:\s+- 'D:\/agents\/run-evidence\/dsh-goal-wait-receipts'$/);
    for (const file of files) {
      if (!/\.[cm]?js$/.test(file)) continue;
      for (const match of text(file).matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
        const dependency = relative(root, contained(join(dirname(file), match[1].split(/[?#]/, 1)[0]))).replaceAll('\\', '/');
        assert.ok(files.has(dependency), `Dependency missing from distribution: ${file} -> ${dependency}`);
      }
    }
    for (const language of ['en', 'zh']) {
      const locale = JSON.parse(text(`locale/${language}.json`));
      assert.ok(locale.meta.title.trim() && locale.meta.description.trim());
      assert.deepEqual(Object.keys(locale.meta).sort(), ['description', 'title']);
    }
    const icon = text('icon.svg');
    assert.match(icon, /^<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*<\/svg>\s*$/);
    assert.ok(Buffer.byteLength(icon) <= 256 * 1024);
    assert.doesNotMatch(icon, /<script\b|\bon\w+\s*=|(?:href|src)\s*=/i);
    return { distributionFiles: files.size, locales: ['zh', 'en'], icon: 'original inline SVG; installed rendering requires main-agent verification' };
  })) return;
  if (!stage('syntax', () => {
    const sources = [...files].filter(file => /\.[cm]?js$/.test(file));
    for (const file of sources) {
      const child = spawnSync(process.execPath, ['--check', contained(file)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(child.status, 0, bound(child.error || child.stderr));
    }
    return { sources: sources.length };
  })) return;
  if (!stage('native-cold-public-entry', () => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [contained('scripts/check-cold-entry.mjs')], { env, cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024, windowsHide: true });
    assert.equal(child.status, 0, bound(child.error || `${child.stdout}\n${child.stderr}`));
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, 'passed');
    assert.equal(result.noRegisterHooks, true);
    return result;
  })) return;
  if (!stage('public-lifecycle-and-tool-tests', () => {
    const tests = readdirSync(contained('tests')).filter(file => file.endsWith('.test.js')).sort();
    assert.ok(tests.length >= 5);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(contained('scripts/runtime-loader.mjs')).href, '--test', '--test-reporter=spec', '--test-timeout=30000', ...tests.map(file => contained(`tests/${file}`))], { env, cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 128 * 1024, windowsHide: true });
    assert.equal(child.status, 0, bound(child.error || `${child.stdout}\n${child.stderr}`));
    return { tests, output: child.stdout, coverage: ['official AgentLoop/native executor', 'official Goal/Session/round driver', 'official JSONL reopen', 'direct-human authority and one-shot resume', 'revision/unload/reload fences', 'bounded receipt expiry and deduplication'] };
  })) return;
  report.status = 'passed';
}
main();
process.stdout.write(`${JSON.stringify(report)}\n`);
