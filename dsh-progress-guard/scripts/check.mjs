import { execFile } from 'node:child_process';
import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const installedDesktop = 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe';
const bounded = error => String(error?.message ?? error).slice(0, 6000);

function selectRuntime(explicit) {
  const candidates = explicit ? [explicit] : [
    ...(process.versions.electron ? [process.execPath] : []),
    process.env.DSH_DESKTOP_EXE,
    installedDesktop,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (existsSync(path) && lstatSync(path).isFile()) return path;
  }
  throw new Error('Electron runtime not found; use --runtime <exe> or DSH_DESKTOP_EXE.');
}

/** Run the same bounded, real-Electron checks used by the CLI. Never installs dependencies. */
export async function runProjectChecks({ runtime, resources, report, projectRoot = resolve(here, '..') } = {}) {
  const started = Date.now();
  let result;
  try {
    if (report && !isAbsolute(report)) throw new Error('--report must be an absolute JSON path.');
    const executable = selectRuntime(runtime);
    const resourcesPath = resolve(resources || process.env.DSH_DESKTOP_RESOURCES || join(dirname(executable), 'resources'));
    const { stdout } = await execute(executable, [join(here, 'check-runtime.mjs'), resolve(projectRoot), resourcesPath], {
      cwd: resolve(projectRoot),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CHECK_RUNTIME: executable, DSH_CHECK_RESOURCES: resourcesPath, DSH_CHECK_LOADER: '' },
      timeout: 150_000, maxBuffer: 128 * 1024, windowsHide: true,
    });
    result = JSON.parse(stdout);
    if (!['passed', 'failed'].includes(result.status) || !Array.isArray(result.checks)) throw new Error('Invalid Electron check report.');
  } catch (error) {
    // The worker uses exit 0 to transport its report; only the public CLI maps failure to exit 1.
    result = { schemaVersion: 1, status: 'failed', checks: [{ name: 'runtime', status: 'failed', error: bounded(error) }] };
  }
  result.durationMs = Date.now() - started;
  if (report) {
    try {
      if (!isAbsolute(report)) throw new Error('--report must be an absolute JSON path.');
      if (existsSync(report) && lstatSync(report).isSymbolicLink()) throw new Error('--report must not be a symbolic link.');
      // Write exactly the caller's file. Do not create parents or choose an evidence destination.
      writeFileSync(report, `${JSON.stringify(result)}\n`, 'utf8');
    } catch (error) {
      result.status = 'failed';
      result.checks.push({ name: 'report', status: 'failed', error: bounded(error) });
    }
  }
  return result;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--runtime', '--resources', '--report'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    if (args[index + 1] === undefined || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (Object.hasOwn(options, key.slice(2))) throw new Error(`Duplicate argument: ${key}`);
    options[key.slice(2)] = args[index + 1];
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try { result = await runProjectChecks(parseArgs(process.argv.slice(2))); }
  catch (error) { result = { schemaVersion: 1, status: 'failed', checks: [{ name: 'arguments', status: 'failed', error: bounded(error) }] }; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
}
