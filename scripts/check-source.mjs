import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['node_modules', '.git', '.scratch', '.cache', '.okf-cache', '.dsh-plugin-smoke', '.dsh-graph', 'run-evidence']);
const source = [];
const manifests = new Map();
const lockfiles = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (['.js', '.mjs', '.cjs'].includes(extname(path))) source.push(path);
    else if (entry.name === 'package.json') manifests.set(directory, JSON.parse(readFileSync(path, 'utf8')));
    else if (entry.name === 'pnpm-lock.yaml') lockfiles.push(path);
  }
}
walk(root);
if (!source.length) throw new Error('No source files found.');
for (const file of source) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// DSH resolves a bare import in a linked bundle to its shipped Host copy only when a package.json at or above the importing
// file lists the package in peerDependencies; any other bare import falls back to plain Node resolution. Probed on
// 0.2.2-rc.1 on 2026-11-09 and hit again on 0.2.2-rc.3, where a bundle whose own checks passed did not load because one
// Host import was undeclared. So every bare import reachable from a bundle's exports must be declared at or above it:
// @deepseek-ai/* and the packages the Host ships with them as peers, so the bundle shares the Host copy; anything else as
// a peer or an installed dependency.
const builtins = new Set(builtinModules);
// The Host also ships what its @deepseek-ai/* packages depend on (zod, for one). Listed under dependencies, such a package
// loads as a private copy beside the Host's: a second module instance, and one more tree for a cold start to read
// (2026-11-14: agent-reliability's private zod cost 81 Defender scans, about 1 s). The lockfiles name these packages in
// the dependency maps of their @deepseek-ai/* entries.
function hostShippedPackages(files) {
  const shipped = new Set();
  for (const file of files) {
    let hostEntry = false;
    let dependencyMap = false;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const text = line.trim();
      if (!text || text.startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= 2) {
        hostEntry = indent === 2 && /^'?@deepseek-ai\//.test(text);
        dependencyMap = false;
      } else if (indent === 4) {
        dependencyMap = hostEntry && /^(?:optionalD|d)ependencies:$/.test(text);
      } else if (indent === 6 && dependencyMap) {
        const name = text.startsWith("'") ? text.slice(1, text.indexOf("'", 1)) : text.slice(0, text.indexOf(':'));
        if (name && !name.startsWith('@deepseek-ai/')) shipped.add(name);
      }
    }
  }
  return shipped;
}
const hostShipped = hostShippedPackages(lockfiles);
const importPatterns = [
  /(?:^|[^\w$.])(?:import|export)\b\s*(?:[^'"()]*?\bfrom\s*)?['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
// In ESM, require comes from createRequire and resolves from wherever it is anchored (devtools anchors it at the Host),
// so only a CommonJS module's own require calls count.
const requirePattern = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const packageName = specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
const isBare = specifier => !/^(?:\.|\/|[a-zA-Z]:|node:|file:|data:|https?:)/.test(specifier);
const exportTargets = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(exportTargets) : [];
// Client modules load in the renderer through DSH's module loader, which supplies React and the client packages itself;
// this rule covers the Host side, where Node resolution applies.
function hostEntries(manifest) {
  const { exports } = manifest;
  const subpaths = exports && typeof exports === 'object' && Object.keys(exports).some(key => key.startsWith('.'));
  const targets = subpaths ? Object.entries(exports).filter(([key]) => key !== './client').flatMap(([, value]) => exportTargets(value)) : exportTargets(exports);
  return [...targets, ...(manifest.main ? [manifest.main] : [])].filter(target => /\.[cm]?js$/.test(target) && !target.includes('*'));
}
function nearestManifest(file) {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    if (manifests.has(directory)) return manifests.get(directory);
    if (directory === root || dirname(directory) === directory) return undefined;
  }
}
const isCommonJs = file => file.endsWith('.cjs') || !file.endsWith('.mjs') && nearestManifest(file)?.type !== 'module';
function declarations(file) {
  const peers = new Set();
  const dependencies = new Set();
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const manifest = manifests.get(directory);
    for (const name of Object.keys(manifest?.peerDependencies ?? {})) peers.add(name);
    for (const name of Object.keys(manifest?.dependencies ?? {})) dependencies.add(name);
    if (directory === root || dirname(directory) === directory) return { peers, dependencies };
  }
}
function resolveRelative(from, specifier) {
  const target = resolve(dirname(from), specifier.split(/[?#]/, 1)[0]);
  return [target, `${target}.js`, `${target}.mjs`, join(target, 'index.js')].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
}
const problems = [];
const bundles = [];
for (const [directory, manifest] of manifests) {
  if (!manifest.dsh?.bundle) continue;
  const queue = [...new Set(hostEntries(manifest))].map(target => resolve(directory, target));
  const seen = new Set();
  const imports = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const shown = relative(root, file).replaceAll('\\', '/');
    if (!existsSync(file)) { problems.push(`${shown}: module is missing`); continue; }
    const text = readFileSync(file, 'utf8');
    const { peers, dependencies } = declarations(file);
    const patterns = isCommonJs(file) ? [...importPatterns, requirePattern] : importPatterns;
    for (const pattern of patterns) for (const [, specifier] of text.matchAll(pattern)) {
      if (!isBare(specifier)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolveRelative(file, specifier);
        if (target) queue.push(target);
        else problems.push(`${shown}: relative import '${specifier}' does not resolve`);
        continue;
      }
      const name = packageName(specifier);
      if (builtins.has(name)) continue;
      imports.add(name);
      const peerOnly = name.startsWith('@deepseek-ai/') || hostShipped.has(name);
      if (peerOnly ? !peers.has(name) : !peers.has(name) && !dependencies.has(name)) {
        const shipped = !name.startsWith('@deepseek-ai/') && hostShipped.has(name) ? ' (the Host ships it with its @deepseek-ai packages; under dependencies it loads a private copy)' : '';
        problems.push(`${shown}: '${name}' is imported, but no package.json at or above it lists it in ${peerOnly ? 'peerDependencies' : 'peerDependencies or dependencies'}${shipped}`);
      }
    }
  }
  bundles.push({ name: manifest.name, modules: seen.size, imports: [...imports].sort() });
}
if (problems.length) {
  console.error(`Undeclared bundle imports (DSH falls back to plain Node resolution for these):\n${[...new Set(problems)].join('\n')}`);
  process.exit(1);
}
console.log(JSON.stringify({ status: 'passed', syntaxFiles: source.length, hostShipped: [...hostShipped].sort(), bundles }));
