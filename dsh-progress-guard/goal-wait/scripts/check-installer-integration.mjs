import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const runtime = process.env.DSH_DESKTOP_EXE || 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe';
const values = process.argv.slice(2);
if (values.length !== 0 && !(values.length === 2 && values[0] === '--report' && /^[dD]:[\\/]/.test(values[1]))) throw new Error('Use only --report <absolute D-drive JSON path>.');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_TEST_CONTEXT;
const child = spawnSync(runtime, ['--import', pathToFileURL(resolve(here, 'runtime-loader.mjs')).href, resolve(here, '../tests/installer-integration.js')], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 128 * 1024, windowsHide: true });
let result;
try { result = JSON.parse(child.stdout); }
catch { result = { status: 'failed', error: String(child.error || child.stderr || child.stdout).slice(-6000) }; }
if (values.length === 2) writeFileSync(values[1], `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = child.status === 0 && result.status === 'passed' ? 0 : 1;
