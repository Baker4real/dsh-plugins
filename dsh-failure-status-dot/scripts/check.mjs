import { spawnSync } from 'node:child_process';

const cwd = new URL('../', import.meta.url);
for (const args of [
  ['scripts/build.mjs', '--check'],
  ['--check', 'index.js'],
  ['--check', 'client.js'],
  ['--test', 'tests/*.test.js'],
]) {
  const { error, status, signal } = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (error) throw error;
  if (signal) console.error(`node ${args.join(' ')} terminated by ${signal}`);
  if (status !== 0) {
    process.exitCode = status ?? 1;
    break;
  }
}
