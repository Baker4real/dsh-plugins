import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
const directory = fileURLToPath(new URL('../', import.meta.url));
const project = resolve(directory, '..');
const runtime = process.env.DSH_DESKTOP_EXE ?? 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe';
try {
  const options = { cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024, windowsHide: true };
  for (const file of readdirSync(directory).filter(file => file.endsWith('.js'))) execFileSync(process.execPath, ['--check', file], options);
  const tests = readdirSync(join(directory, 'tests')).filter(file => file.endsWith('.test.js')).map(file => join('tests', file));
  execFileSync(process.execPath, ['--test', ...tests], options);
  const result = execFileSync(runtime, ['--import', new URL('../../scripts/check-runtime.mjs', import.meta.url).href, 'scripts/validate-runtime.mjs'], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CHECK_LOADER: '1', DSH_CHECK_RESOURCES: process.env.DSH_DESKTOP_RESOURCES ?? join(runtime, '..', 'resources') } });
  if (JSON.parse(result).status !== 'passed') throw new Error('Runtime schema validation failed');
  const native = execFileSync(runtime, ['scripts/verify-native-driver.mjs'], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CHECK_RESOURCES: process.env.DSH_DESKTOP_RESOURCES ?? join(runtime, '..', 'resources') } });
  if (JSON.parse(native).status !== 'passed') throw new Error('Real Windows native driver check failed');
  const override = process.env.DSH_SKILL_OVERRIDE ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skills', 'cordis-plugin-development', 'SKILL.md');
  let skillPointers = { status: 'not-applicable', reason: 'No host-specific override is installed.' };
  if (existsSync(override)) {
    const checked = execFileSync(runtime, [fileURLToPath(new URL('../../../scripts/check-dsh-skill-pointers.cjs', import.meta.url)), '--skill', override], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_INSTALL_DIR: process.env.DSH_INSTALL_DIR ?? join(runtime, '..', 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh') } });
    const pointers = JSON.parse(checked);
    if (pointers.status !== 'pass') throw new Error('Installed skill pointers did not pass');
    skillPointers = { status: 'passed', ...pointers.summary };
  }
  process.stdout.write(JSON.stringify({ status: 'passed', tests: tests.length, runtimeSchemas: 'passed', nativeDriver: 'passed', skillPointers }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ status: 'failed', error: String(error.stderr ?? error.message).slice(-2000) }) + '\n');
  process.exitCode = 1;
}
