// Runs only inside Electron's Node mode; its fs implementation understands ASAR.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

const bounded = value => String(value).slice(-6000);

function runtimeAnchor(resources) {
  assert.ok(process.versions.electron, 'Checks require a real Electron runtime in ELECTRON_RUN_AS_NODE mode.');
  const candidates = [join(resources, 'app.asar', 'dsh', 'package.json'), join(resources, 'dsh', 'package.json'), join(resources, 'package.json')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
    if (manifest.dependencies?.['@deepseek-ai/dsh-session']) return { path: candidate, manifest };
  }
  throw new Error('Cannot locate the installed DSH package under --resources (resources directory, app.asar, or dsh root).');
}

if (process.env.DSH_CHECK_LOADER === '1') {
  const anchor = pathToFileURL(runtimeAnchor(process.env.DSH_CHECK_RESOURCES).path).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier, specifier.startsWith('@deepseek-ai/') || specifier === 'zod' ? { ...context, parentURL: anchor } : context);
    },
  });
}

function checkProject(root, resources) {
  const checks = [];
  const report = { schemaVersion: 1, status: 'failed', checks, coverage: { clientLifecycle: 'not-covered', clientRuntime: 'not-covered' } };
  function stage(name, action) {
    const started = Date.now();
    try {
      const details = action();
      checks.push({ name, status: 'passed', durationMs: Date.now() - started, ...(details ? { details } : {}) });
      return true;
    } catch (error) {
      checks.push({ name, status: 'failed', durationMs: Date.now() - started, error: bounded(error?.message ?? error) });
      return false;
    }
  }
  let anchor;
  if (!stage('runtime', () => {
    anchor = runtimeAnchor(resources);
    const require = createRequire(pathToFileURL(anchor.path));
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-llm', 'zod']) require.resolve(name);
    report.runtime = { executable: process.execPath, electron: process.versions.electron, node: process.versions.node, resources, dshVersion: anchor.manifest.version };
  })) return report;

  const contained = name => {
    assert.ok(typeof name === 'string' && !isAbsolute(name), `Expected a relative project resource: ${name}`);
    const target = resolve(root, name);
    const rel = relative(root, target);
    assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `Resource escapes project: ${name}`);
    if (existsSync(target)) {
      const real = relative(realpathSync(root), realpathSync(target));
      assert.ok(real !== '..' && !real.startsWith(`..${sep}`) && !isAbsolute(real), `Resource symlink escapes project: ${name}`);
    }
    return target;
  };
  const read = name => readFileSync(contained(name), 'utf8');
  let manifest;
  let files;
  function expand(pattern) {
    assert.ok(typeof pattern === 'string' && !/[?\[\]{}!]/.test(pattern) && !pattern.includes('**'), `Unsupported distribution pattern: ${pattern}`);
    if (!pattern.includes('*')) {
      assert.ok(existsSync(contained(pattern)) && statSync(contained(pattern)).isFile(), `Missing distribution resource: ${pattern}`);
      return [pattern.replaceAll('\\', '/')];
    }
    const folder = dirname(pattern);
    assert.ok(!folder.includes('*'), `Wildcard directories are not supported: ${pattern}`);
    const leaf = pattern.slice(folder === '.' ? 0 : folder.length + 1);
    const matcher = new RegExp(`^${leaf.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    const matches = readdirSync(contained(folder)).filter(name => matcher.test(name)).map(name => join(folder, name).replaceAll('\\', '/'));
    assert.ok(matches.length > 0, `Missing distribution resources: ${pattern}`);
    for (const match of matches) assert.ok(statSync(contained(match)).isFile(), `Expected file resource: ${match}`);
    return matches;
  }
  if (!stage('manifest-resources', () => {
    manifest = JSON.parse(read('package.json'));
    assert.equal(manifest.name, '@local/dsh-progress-guard');
    assert.equal(manifest.type, 'module');
    assert.equal(typeof manifest.version, 'string');
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'package.files must declare distribution resources');
    files = new Set(manifest.files.flatMap(expand));
    for (const required of ['index.js', 'policy.js', 'client.js', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'scripts/check.mjs', 'scripts/check-runtime.mjs', 'tests/progress.test.js', 'tests/boundaries.test.js', 'tests/incident-replay.test.js', 'tests/fixtures/incident-replay.json']) {
      assert.ok(files.has(required), `Required resource is missing from package.files: ${required}`);
    }
    assert.equal(manifest.scripts?.check, 'node scripts/check.mjs');
    assert.equal(manifest.exports?.['.'], './index.js');
    assert.equal(manifest.exports?.['./client'], './client.js');
    assert.equal(manifest.exports?.['./icon'], './icon.svg');
    assert.equal(manifest.exports?.['./locale/*.json'], './locale/*.json');
    assert.ok(manifest.dsh?.client?.platform === 'web' && manifest.dsh.client.immediately === true, 'Client manifest must declare immediate web loading');
    assert.ok(manifest.dsh.client.inject?.includes('@deepseek-ai/dsh-client-ui-chat'), 'Client requires the official chat renderer');
    const patch = manifest.dsh?.bundle?.patch;
    assert.ok(typeof patch === 'string' && files.has(patch.replace(/^\.\//, '')), 'Bundle patch is outside distribution');
    // The package owns this deliberately small composition; reject undeclared/extra YAML rather than approximating a YAML parser.
    assert.match(read(patch).trim(), /^- insert:\s+- id: progress-guard\s+name: ['"]@local\/dsh-progress-guard['"]$/);
    for (const target of Object.values(manifest.exports)) {
      assert.equal(typeof target, 'string', 'Only local string exports are supported');
      for (const name of expand(target)) assert.ok(files.has(name.replace(/^\.\//, '')), `Export is missing from package.files: ${name}`);
    }
    // Include relative ESM dependencies of both runtime and shipped checks/tests.
    for (const file of files) {
      if (!/\.[cm]?js$/.test(file)) continue;
      for (const match of read(file).matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
        const dependency = relative(root, contained(join(dirname(file), match[1]))).replaceAll('\\', '/');
        assert.ok(files.has(dependency), `Distribution dependency missing: ${file} -> ${dependency}`);
      }
    }
    for (const language of ['en', 'zh']) {
      const locale = JSON.parse(read(`locale/${language}.json`));
      assert.ok(typeof locale.meta?.title === 'string' && locale.meta.title.trim(), `Missing ${language} locale title`);
      assert.ok(typeof locale.meta?.description === 'string' && locale.meta.description.trim(), `Missing ${language} locale description`);
      assert.deepEqual(Object.keys(locale.meta).sort(), ['description', 'title'], `Unexpected ${language} locale keys`);
    }
    const icon = read('icon.svg').trim();
    assert.match(icon, /^<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>[\s\S]*<\/svg>$/);
    assert.match(icon, /\bviewBox="[^"]+"/);
    assert.doesNotMatch(icon, /<script\b|\bon\w+\s*=|(?:href|src)\s*=/i);
    return { distributionFiles: files.size, locales: ['en', 'zh'], icon: 'inline-svg' };
  })) return report;

  if (!stage('syntax', () => {
    const source = read('client.js');
    new Script(source, { filename: 'client.js' });
    assert.match(source, /window\.__ModuleLoader__\.load\s*\(/, 'Client must be a ModuleLoader artifact');
    assert.match(source, /id:\s*['"]@local\/dsh-progress-guard['"]/);
    const sources = [...files].filter(file => /\.[cm]?js$/.test(file)).sort();
    for (const file of sources) {
      const result = spawnSync(process.execPath, ['--check', contained(file)], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000, maxBuffer: 32 * 1024, windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`Syntax check failed: ${file}\n${bounded(result.error?.message || result.stderr || result.stdout)}`);
    }
    return { sources: sources.length, client: 'ModuleLoader syntax only; behavior and real DOM mount are separate coverage fields' };
  })) return report;

  function runTests(tests) {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CHECK_LOADER: '1', DSH_CHECK_RESOURCES: resources, DSH_CHECK_RUNTIME: process.execPath };
    // A check may itself be called by node:test. Inheriting this internal flag
    // disables the independent --test runner and can hide assertion failures.
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['--import', import.meta.url, '--test', '--test-reporter=spec', '--test-timeout=120000', ...tests.map(name => contained(join('tests', name)))], {
      cwd: root, encoding: 'utf8', env, timeout: 125_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
  }

  const tests = readdirSync(contained('tests')).filter(name => name.endsWith('.test.js')).sort();
  if (tests.includes('client-lifecycle.test.js')) {
    stage('client-lifecycle', () => {
      const result = runTests(['client-lifecycle.test.js']);
      if (result.error || result.status !== 0) throw new Error(`Client lifecycle tests failed (exit ${result.status ?? 'unavailable'}): ${bounded(result.error?.message || `${result.stdout}\n${result.stderr}`)}`);
      report.coverage.clientLifecycle = 'passed';
      return { file: 'tests/client-lifecycle.test.js', runtime: 'VM Slot boundary; no React/DOM mount' };
    });
  } else {
    checks.push({ name: 'client-lifecycle', status: 'not-covered', details: { reason: 'tests/client-lifecycle.test.js is absent; syntax alone is not behavior coverage' } });
  }

  if (!stage('host-tests', () => {
    const hostTests = tests.filter(name => !['client-lifecycle.test.js', 'diagnostic.test.js'].includes(name));
    assert.ok(hostTests.length > 0, 'No Host tests found');
    const result = runTests(hostTests);
    if (result.error || result.status !== 0) throw new Error(`Host tests failed (exit ${result.status ?? 'unavailable'}): ${bounded(result.error?.message || `${result.stdout}\n${result.stderr}`)}`);
    return { files: hostTests, runtime: 'installed Electron and real Host dependencies; excludes separately reported Client lifecycle and local diagnostics' };
  })) return report;
  report.status = 'passed';
  return report;
}

if (process.env.DSH_CHECK_LOADER !== '1' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report;
  try { report = checkProject(resolve(process.argv[2]), resolve(process.argv[3])); }
  catch (error) { report = { schemaVersion: 1, status: 'failed', checks: [{ name: 'runtime', status: 'failed', error: bounded(error?.message ?? error) }] }; }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
