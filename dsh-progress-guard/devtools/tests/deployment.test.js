import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeploymentPreflight } from '../deployment.js';

// Filesystem and runtime are external boundaries. No fixture touches the profile or disk.
function fixture({ pending = 'unmanaged-plugin', linked = true, hmrVersion = '0.2.2-rc.1' } = {}) {
  const packageName = 'dsh-subagent-workspace-ui';
  const installedDirectory = resolve('D:/fixture/profile/node_modules', packageName);
  const sourceDirectory = resolve('D:/fixture/source');
  const runtimeRoot = resolve('D:/fixture/runtime');
  const realInstalled = linked ? sourceDirectory : installedDirectory;
  const manifest = JSON.stringify({ name: packageName, version: '1.0.0', exports: { '.': './index.js', './client': './client.js' }, privateSecret: 'DO_NOT_RETURN' });
  const files = new Map([
    [join(sourceDirectory, 'package.json'), manifest],
    [join(sourceDirectory, 'index.js'), 'export const host = 1;'],
    [join(sourceDirectory, 'client.js'), 'export const client = 1;'],
    [join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-hmr/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-hmr', version: hmrVersion })],
  ]);
  if (!linked) for (const file of ['package.json', 'index.js', 'client.js']) files.set(join(installedDirectory, file), files.get(join(sourceDirectory, file)));
  const canonical = path => {
    const value = resolve(path);
    return linked && (value === installedDirectory || value.startsWith(installedDirectory + sep)) ? sourceDirectory + value.slice(installedDirectory.length) : value;
  };
  const fail = code => { throw Object.assign(new Error('DO_NOT_RETURN'), { code }); };
  const directories = new Set([sourceDirectory, realInstalled]);
  const reads = [];
  const fs = {
    async realpath(path) { const key = canonical(path); if (files.has(key) || directories.has(key)) return key; return fail('ENOENT'); },
    async lstat(path) { return { isSymbolicLink: () => linked && resolve(path) === installedDirectory }; },
    async stat(path) {
      const key = canonical(path);
      if (!files.has(key) && !directories.has(key)) return fail('ENOENT');
      return { isFile: () => files.has(key), isDirectory: () => directories.has(key), size: Buffer.byteLength(files.get(key) ?? '') };
    },
    async readFile(path) { const key = canonical(path); reads.push(key); if (!files.has(key)) return fail('ENOENT'); return Buffer.from(files.get(key)); },
  };
  const url = pathToFileURL(join(realInstalled, 'index.js')).href;
  const calls = [];
  const forbidden = () => { throw new Error('MUTATION_ATTEMPTED'); };
  const hmr = {
    hasEsmCache: () => true,
    *loadedUrls() { yield url; },
    async planReplacement(stale, roots) {
      calls.push({ stale, roots });
      return { pending: pending ? [{ url, reason: pending }] : [], evicted: new Set(pending ? [] : [url]), manifests: new Set(), plugins: new Set(), fibers: new Set(pending ? [] : [{}]) };
    },
    reconcileProfile: forbidden, stopPlanned: forbidden, evict: forbidden, runExclusive: forbidden,
  };
  const pluginManager = {
    async listPlugins() { return [{ entryId: 'include:subagent-workspace-manager', moduleName: packageName, enabled: true, fiberPhase: 'active', patchId: 'subagent-workspace-manager', diagnostic: 'DO_NOT_RETURN', config: { secret: 'DO_NOT_RETURN' } }]; },
    async listBundles() { return [{ name: packageName, version: '1.0.0', installed: true, enabled: true, availability: 'profile', rows: [{ rowId: 'subagent-workspace-manager', moduleName: packageName }], source: 'https://user:DO_NOT_RETURN@registry.invalid', config: { secret: 'DO_NOT_RETURN' } }]; },
    removeBundle: forbidden, installBundle: forbidden, setPlugin: forbidden,
  };
  const inspector = new DeploymentPreflight({ pluginManager, hmr, runtimeRoot, fileSystem: fs });
  return { inspector, input: { packageName, installedDirectory, sourceDirectory }, files, fs, hmr, pluginManager, runtimeRoot, sourceDirectory, installedDirectory, realInstalled, calls, reads, url };
}

test('an unmanaged plugin still requires restart when patchId exists and a symlink has identical bytes', async () => {
  const f = fixture();
  const result = await f.inspector.inspect(f.input);
  assert.equal(result.identity.relationship, 'symlink-to-source');
  assert.equal(result.files.sameBytes, true);
  assert.equal(result.management.status, 'unmanaged');
  assert.equal(result.requirements.host, 'restart-required');
  assert.equal(result.requirements.reason, 'unmanaged-plugin');
  assert.equal(result.page.status, 'not-verified');
  assert.equal(result.readOnly, true);
  assert.deepEqual(f.calls[0].stale, [f.url]);
  assert.deepEqual(f.calls[0].roots, [f.realInstalled + sep]);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_RETURN|https:\/\/user|"config"/);
});

test('a managed replacement plan remains a candidate and does not prove application or Client state', async () => {
  const f = fixture({ pending: null, linked: false });
  const result = await f.inspector.inspect(f.input);
  assert.equal(result.identity.relationship, 'separate-directory');
  assert.equal(result.management.status, 'managed');
  assert.equal(result.requirements.host, 'live-reload-candidate');
  assert.equal(result.requirements.application, 'not-attempted');
  assert.equal(result.page.status, 'not-verified');
});

test('unsupported runtime, unavailable module cache and failed planning remain unknown', async () => {
  const unsupported = fixture({ hmrVersion: '0.2.3' });
  assert.equal((await unsupported.inspector.inspect(unsupported.input)).management.reason, 'unsupported-hmr-version');
  assert.equal(unsupported.calls.length, 0);
  const uncached = fixture();
  uncached.hmr.hasEsmCache = () => false;
  const result = await uncached.inspector.inspect(uncached.input);
  assert.equal(result.requirements.host, 'unknown');
  assert.equal(result.management.reason, 'module-cache-unavailable');
  assert.equal(uncached.calls.length, 0);
  const failed = fixture();
  failed.hmr.planReplacement = async () => { throw new Error('DO_NOT_RETURN'); };
  const unknown = await failed.inspector.inspect(failed.input);
  assert.equal(unknown.management.reason, 'hmr-plan-unavailable');
  assert.doesNotMatch(JSON.stringify(unknown), /DO_NOT_RETURN/);
});

test('same bytes are not claimed for missing or changed entry files', async () => {
  const f = fixture({ linked: false });
  f.files.set(join(f.sourceDirectory, 'client.js'), 'export const changed = true;');
  const changed = await f.inspector.inspect(f.input);
  assert.equal(changed.files.sameBytes, false);
  f.files.delete(join(f.sourceDirectory, 'client.js'));
  const missing = await f.inspector.inspect(f.input);
  assert.equal(missing.files.sameBytes, null);
  assert.ok(missing.files.entries.some(row => row.file === './client.js' && row.source.error === 'ENOENT'));
});

test('invalid file paths, escaping symlinks, mismatched package identity and insufficient budgets fail closed', async () => {
  const f = fixture();
  for (const file of ['../secret', 'D:/secret', 'nested/../../secret']) await assert.rejects(f.inspector.inspect({ ...f.input, files: [file] }), /invalid-file/u);
  await assert.rejects(f.inspector.inspect({ ...f.input, maxBytes: 800 }), /deployment-output-exceeds-maxBytes/u);
  const originalRealpath = f.fs.realpath;
  f.fs.realpath = async path => String(path).endsWith('client.js') ? resolve('D:/fixture/elsewhere/client.js') : originalRealpath(path);
  await assert.rejects(f.inspector.inspect(f.input), /file-outside-package/u);
  const other = fixture();
  other.files.set(join(other.sourceDirectory, 'package.json'), JSON.stringify({ name: 'another-package' }));
  await assert.rejects(other.inspector.inspect(other.input), /package-identity-mismatch/u);
});
