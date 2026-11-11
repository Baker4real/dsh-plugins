import * as fileSystem from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HMR_VERSION = '0.2.2-rc.1';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const reasonSet = new Set(['unmanaged-plugin', 'host-module', 'module-comparison']);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function within(root, path) {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
function directory(value) {
  if (typeof value !== 'string' || value.length > 2048 || !isAbsolute(value) || /[\x00-\x1f]/u.test(value)) fail('invalid-directory');
  return resolve(value);
}
function localFile(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || isAbsolute(value) || /[:\x00-\x1f]/u.test(value) || value.split(/[\\/]/u).some(part => part === '..' || !part)) fail('invalid-file');
  return value;
}
function compactError(error) {
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : 'read-failed';
}
function targets(value, result = []) {
  if (typeof value === 'string') result.push(localFile(value));
  else if (Array.isArray(value)) for (const child of value) targets(child, result);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) if (key !== 'types') targets(child, result);
  if (result.length > 12) fail('too-many-entry-files');
  return result;
}

/**
 * Read-only deployment evidence, not an installation or page-verification gate.
 *
 * Public contracts: pluginManager.listPlugins()/listBundles(), as inspected on
 * 2026-11-10. PluginInfo.patchId identifies a writable patch, NOT HMR ownership.
 *
 * Narrow internal adapter: @deepseek-ai/dsh-hmr@0.2.2-rc.1/lib/index.js,
 * loadedUrls:809-813, hasEsmCache:797-800, planReplacement:1219-1261.
 * The latter explicitly plans "without changing anything". It traverses static
 * importers and requires an affected Loader entry's own fiber to own each
 * running fiber (1238-1246). We never call stopPlanned or reconcileProfile.
 * This adapter is version/capability gated; other runtimes remain unknown.
 */
export class DeploymentPreflight {
  constructor({ pluginManager, hmr, runtimeRoot, fileSystem: fs = fileSystem } = {}) {
    this.pluginManager = pluginManager;
    this.hmr = hmr;
    this.runtimeRoot = runtimeRoot;
    this.fs = fs;
  }

  async bytes(root, file) {
    const target = await this.fs.realpath(join(root, localFile(file)));
    if (!within(root, target)) fail('file-outside-package');
    const info = await this.fs.stat(target);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) fail('invalid-entry-file');
    const bytes = await this.fs.readFile(target);
    if (bytes.length > MAX_FILE_BYTES) fail('invalid-entry-file');
    return bytes;
  }

  async package(path, name) {
    try {
      const realPath = await this.fs.realpath(path);
      if (!(await this.fs.stat(realPath)).isDirectory()) fail('invalid-directory');
      const manifest = JSON.parse((await this.bytes(realPath, 'package.json')).toString('utf8'));
      if (manifest.name !== name) fail('package-identity-mismatch');
      return { path, realPath, linked: (await this.fs.lstat(path)).isSymbolicLink(), version: typeof manifest.version === 'string' ? manifest.version : null, manifest };
    } catch (error) {
      if (['package-identity-mismatch', 'invalid-directory', 'file-outside-package', 'invalid-entry-file'].includes(error?.code)) throw error;
      fail(`package-${compactError(error)}`);
    }
  }

  async inventory(packageName) {
    if (!this.pluginManager) return { status: 'unknown', reason: 'plugin-manager-unavailable', plugins: [] };
    try {
      const [plugins, bundles] = await Promise.all([this.pluginManager.listPlugins(), this.pluginManager.listBundles()]);
      if (!Array.isArray(plugins) || !Array.isArray(bundles)) fail('inventory-contract');
      const bundle = bundles.find(item => item.name === packageName);
      const rowIds = new Set((bundle?.rows ?? []).map(row => row.entryId).filter(Boolean));
      const rows = plugins.filter(row => row.moduleName === packageName || row.moduleName?.startsWith(`${packageName}/`) || rowIds.has(row.entryId));
      return {
        status: 'observed',
        bundle: bundle ? { installed: bundle.installed === true, enabled: bundle.enabled === true, availability: bundle.availability, version: bundle.version ?? null } : null,
        plugins: rows.slice(0, 20).map(row => ({ entryId: row.entryId, moduleName: row.moduleName, enabled: row.enabled, fiberPhase: row.fiberPhase, ...(typeof row.patchId === 'string' ? { patchId: row.patchId } : {}), ...(['management-required', 'unaddressable'].includes(row.readOnlyReason) ? { readOnlyReason: row.readOnlyReason } : {}) })),
        omitted: Math.max(0, rows.length - 20),
      };
    } catch { return { status: 'unknown', reason: 'inventory-unavailable', plugins: [] }; }
  }

  async ownership(root) {
    const unknown = reason => ({ status: 'unknown', reason, adapter: 'hmr-read-only-plan', version: null });
    if (!this.hmr) return unknown('hmr-unavailable');
    let version;
    try {
      const manifest = JSON.parse((await this.fs.readFile(join(directory(this.runtimeRoot), 'node_modules/@deepseek-ai/dsh-hmr/package.json'))).toString('utf8'));
      if (manifest.name !== '@deepseek-ai/dsh-hmr') return unknown('hmr-identity-mismatch');
      version = manifest.version;
    } catch { return unknown('hmr-version-unavailable'); }
    if (version !== HMR_VERSION) return { ...unknown('unsupported-hmr-version'), version };
    if (['hasEsmCache', 'loadedUrls', 'planReplacement'].some(name => typeof this.hmr[name] !== 'function')) return { ...unknown('hmr-capability-unavailable'), version };
    try {
      if (!this.hmr.hasEsmCache()) return { ...unknown('module-cache-unavailable'), version };
      const urls = [...new Set([...this.hmr.loadedUrls()].filter(url => typeof url === 'string' && url.startsWith('file:') && within(root, fileURLToPath(url))))];
      if (!urls.length) return { ...unknown('no-loaded-package-modules'), version };
      if (urls.length > 256) return { ...unknown('too-many-loaded-modules'), version };
      // Hypothetical replacement of every currently loaded module in this package.
      // Equal on-disk bytes do not remove an ownership/restart limitation.
      const plan = await this.hmr.planReplacement(urls, [root.endsWith(sep) ? root : root + sep]);
      if (!Array.isArray(plan?.pending) || !(plan.evicted instanceof Set) || !(plan.fibers instanceof Set) || plan.pending.some(row => !urls.includes(row.url) || !reasonSet.has(row.reason))) return { ...unknown('hmr-plan-contract'), version };
      const reasons = [...new Set(plan.pending.map(row => row.reason))];
      const reason = ['host-module', 'unmanaged-plugin', 'module-comparison'].find(value => reasons.includes(value));
      const complete = urls.every(url => plan.evicted.has(url) || plan.pending.some(row => row.url === url));
      if (!complete) return { ...unknown('incomplete-module-plan'), version };
      return {
        status: reason === 'unmanaged-plugin' ? 'unmanaged' : reason === 'host-module' ? 'host-owned' : reason ? 'unknown' : plan.fibers.size ? 'managed' : 'unknown',
        reason: reason ?? (plan.fibers.size ? 'owned-module-plan' : 'no-running-plugin-fibers'),
        version, adapter: 'hmr-read-only-plan', loadedModules: urls.length, affectedFibers: plan.fibers.size,
        scope: 'hypothetical-replacement-of-loaded-package-modules',
      };
    } catch { return { ...unknown('hmr-plan-unavailable'), version }; }
  }

  async inspect(input = {}) {
    const { packageName, installedDirectory, sourceDirectory, files: selected, maxBytes = 10000 } = input;
    if (typeof packageName !== 'string' || packageName.length > 214 || !packagePattern.test(packageName)) fail('invalid-package-name');
    const installedPath = directory(installedDirectory);
    const sourcePath = directory(sourceDirectory);
    if (!Number.isInteger(maxBytes) || maxBytes < 800 || maxBytes > 16000) fail('invalid-maxBytes');
    if (selected !== undefined && (!Array.isArray(selected) || !selected.length || selected.length > 12)) fail('invalid-files');
    selected?.forEach(localFile);
    const [installed, source] = await Promise.all([this.package(installedPath, packageName), this.package(sourcePath, packageName)]);
    const entryFiles = manifest => {
      const exports = manifest.exports;
      const main = exports && typeof exports === 'object' && Object.keys(exports).some(key => key.startsWith('.')) ? exports['.'] : exports;
      return [...targets(main ?? manifest.main), ...targets(exports?.['./client']), ...(typeof manifest.dsh?.bundle?.patch === 'string' ? [localFile(manifest.dsh.bundle.patch)] : [])];
    };
    const files = [...new Set(['package.json', ...(selected ?? [...entryFiles(installed.manifest), ...entryFiles(source.manifest)])])];
    if (files.length > 13) fail('too-many-entry-files');
    const hashes = [];
    for (const file of files) {
      const hash = async root => {
        try { return { sha256: createHash('sha256').update(await this.bytes(root, file)).digest('hex') }; }
        catch (error) {
          if (['file-outside-package', 'invalid-entry-file', 'invalid-file'].includes(error?.code)) throw error;
          return { error: compactError(error) };
        }
      };
      const [left, right] = await Promise.all([hash(installed.realPath), hash(source.realPath)]);
      hashes.push({ file, installed: left, source: right, same: left.sha256 && right.sha256 ? left.sha256 === right.sha256 : null });
    }
    const [inventory, management] = await Promise.all([this.inventory(packageName), this.ownership(installed.realPath)]);
    const restart = reasonSet.has(management.reason);
    const hasEntry = files.some(file => file !== 'package.json');
    const comparison = hashes.some(row => row.same === false) ? false : hasEntry && hashes.every(row => row.same === true) ? true : null;
    const result = {
      status: 'observed', readOnly: true, packageName,
      identity: {
        installed: { path: installed.path, realPath: installed.realPath, version: installed.version, linked: installed.linked },
        source: { path: source.path, realPath: source.realPath, version: source.version },
        relationship: installed.realPath === source.realPath ? installed.linked ? 'symlink-to-source' : installed.path === source.path ? 'same-directory' : 'same-real-directory' : installed.linked ? 'symlink-to-other' : 'separate-directory',
      },
      files: { sameBytes: comparison, scope: 'selected-entry-files-only', entries: hashes },
      inventory, management,
      requirements: { host: restart ? 'restart-required' : management.status === 'managed' ? 'live-reload-candidate' : 'unknown', reason: management.reason, refresh: 'unknown', application: 'not-attempted' },
      page: { status: 'not-verified', required: 'Verify the current document and loaded revision after the actual application result.' },
      actions: [restart ? 'Arrange an authorized Host restart before changing the installation; inspect the actual application result afterwards.' : management.status === 'managed' ? 'Use the supported plugin manager for an authorized change and read application/nextStep; this plan is not a success guarantee.' : 'Resolve unknown runtime ownership before relying on a live reload.', ...(comparison === false ? ['Resolve the installed/source file mismatch before deployment.'] : comparison === null ? ['Resolve missing entry-file evidence before deployment.'] : []), 'Verify the actual Client document separately; file equality does not prove loaded code.'],
      evidence: ['pluginManager.listPlugins: patchId is patch addressability, not HMR ownership.', `@deepseek-ai/dsh-hmr@${HMR_VERSION}/lib/index.js:809-813,1219-1261; version-gated read-only plan.`, 'Filesystem realpath/lstat and SHA-256; no registry, installation, refresh, or restart operations.'],
      limitations: ['A non-atomic read-only snapshot; rerun after runtime or source changes.', 'Only loaded modules and selected entry files are covered; package relocation, activation errors and actual apply outcomes remain unverified.'],
    };
    if (Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') > maxBytes - 128) fail('deployment-output-exceeds-maxBytes');
    return result;
  }
}
