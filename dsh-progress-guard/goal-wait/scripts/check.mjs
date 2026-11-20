import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe';
const bound = error => String(error?.message ?? error).slice(-6000);
export async function runProjectChecks({ runtime, report, dshRoot } = {}) {
  let result;
  const executable = resolve(runtime || process.env.DSH_DESKTOP_EXE || (process.versions.electron ? process.execPath : desktop));
  try {
    if (!existsSync(executable) || !lstatSync(executable).isFile()) throw new Error('Installed Electron runtime not found.');
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(dshRoot ? { DSH_GOAL_WAIT_DSH_ROOT: dshRoot } : {}) };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(executable, [resolve(here, 'check-runtime.mjs'), ...(report ? ['--full-diagnostics'] : [])], {
      env, cwd: resolve(here, '..'), encoding: 'utf8', timeout: 90000, maxBuffer: 512 * 1024, windowsHide: true,
    });
    if (child.error) throw child.error;
    try { result = JSON.parse(child.stdout); }
    catch { throw new Error(bound(child.stderr || `Check exited ${child.status} without a report`)); }
    if ((result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : -1) !== child.status || !Array.isArray(result.checks)) {
      throw new Error('Invalid check worker report.');
    }
  } catch (error) { result = { schemaVersion: 1, status: 'failed', checks: [{ name: 'runtime', status: 'failed', error: bound(error) }] }; }
  if (report) {
    try {
      if (!isAbsolute(report) || !/^[dD]:[\\/]/.test(report) || (existsSync(report) && lstatSync(report).isSymbolicLink())) throw new Error('Report must be an absolute D-drive regular-file path.');
      writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      result.reportPath = report;
    } catch (error) { result.status = 'failed'; result.checks.push({ name: 'report', status: 'failed', error: bound(error) }); }
    for (const check of result.checks) if (check.details) delete check.details.output;
  }
  return result;
}
function args(values) {
  const result = {};
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i];
    if (!['--runtime', '--report', '--dsh-root'].includes(key) || !values[i + 1] || values[i + 1].startsWith('--')) throw new Error('Use --runtime, --report, or --dsh-root with one path each.');
    const name = key === '--dsh-root' ? 'dshRoot' : key.slice(2);
    if (Object.hasOwn(result, name)) throw new Error('Duplicate check option.');
    result[name] = values[i + 1];
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try { result = await runProjectChecks(args(process.argv.slice(2))); }
  catch (error) { result = { schemaVersion: 1, status: 'failed', checks: [{ name: 'arguments', status: 'failed', error: bound(error) }] }; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
}
