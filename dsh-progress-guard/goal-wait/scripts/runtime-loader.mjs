import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.DSH_GOAL_WAIT_DSH_ROOT || 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh';
const anchor = pathToFileURL(`${root}/package.json`).href;
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
// Like DSH for a linked bundle, a runtime module gets the shipped Host copy only for a package that a package.json at or
// above it lists in peerDependencies, so an undeclared import fails here as it does in the client. Tests and scripts may
// import any Host package.
function declaredPeers(file) {
  const peers = new Set();
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) for (const name of Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).peerDependencies ?? {})) peers.add(name);
    if (dirname(directory) === directory) return peers;
  }
}
function isRuntimeModule(url) {
  if (!url?.startsWith('file:')) return false;
  const local = relative(packageRoot, fileURLToPath(url));
  return local !== '' && !local.startsWith('..') && !isAbsolute(local) && !/^(?:tests|scripts)[\\/]/.test(local);
}
registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@deepseek-ai/') && specifier !== 'zod') return nextResolve(specifier, context);
  const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
  const undeclared = isRuntimeModule(context.parentURL) && !declaredPeers(fileURLToPath(context.parentURL)).has(name);
  return nextResolve(specifier, undeclared ? context : { ...context, parentURL: anchor });
} });
