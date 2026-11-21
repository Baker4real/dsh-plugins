import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const runAll = args.has('--all');

function run(command, commandArgs, cwd = root) {
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit', windowsHide: true });
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

const files = runAll ? [] : stagedFiles();
if (!runAll && !files.length) process.exit(0);

const needsSourceCheck = runAll || files.some(file => /\.(?:[cm]?js)$|package\.json$|pnpm-lock\.yaml$/u.test(file));
if (needsSourceCheck) {
  console.log('[pre-commit] running scripts/check-source.mjs');
  run(process.execPath, [join(root, 'scripts', 'check-source.mjs')]);
}

const targets = [
  {
    name: 'dsh-compaction-256k/agent-reliability',
    match: file => file.startsWith('dsh-compaction-256k/agent-reliability/'),
    cwd: join(root, 'dsh-compaction-256k', 'agent-reliability'),
    args: ['--test', 'tests/*.test.js'],
  },
  {
    name: 'dsh-compaction-256k/daily-update-guards',
    match: file => file.startsWith('dsh-compaction-256k/daily-update-guards/'),
    cwd: join(root, 'dsh-compaction-256k'),
    args: ['--test', 'daily-update-guards/tests/*.test.js'],
  },
  {
    name: 'dsh-compaction-256k',
    match: file => file.startsWith('dsh-compaction-256k/')
      && !file.startsWith('dsh-compaction-256k/agent-reliability/')
      && !file.startsWith('dsh-compaction-256k/daily-update-guards/'),
    cwd: join(root, 'dsh-compaction-256k'),
    args: ['--test', 'tests/*.test.js'],
  },
  {
    name: 'dsh-skills-root-guard',
    match: file => file.startsWith('dsh-skills-root-guard/'),
    cwd: join(root, 'dsh-skills-root-guard'),
    args: ['--test', 'tests/*.test.js'],
  },
  {
    name: 'dsh-gpt-image-playground-magpie',
    match: file => file.startsWith('dsh-gpt-image-playground-magpie/'),
    cwd: join(root, 'dsh-gpt-image-playground-magpie'),
    args: ['--test', 'test/*.test.mjs'],
  },
  {
    name: 'dsh-failure-status-dot',
    match: file => file.startsWith('dsh-failure-status-dot/'),
    cwd: join(root, 'dsh-failure-status-dot'),
    args: ['scripts/check.mjs'],
  },
  {
    name: 'dsh-progress-guard/devtools',
    match: file => file.startsWith('dsh-progress-guard/devtools/'),
    cwd: join(root, 'dsh-progress-guard', 'devtools'),
    args: ['--test', 'tests/*.test.js'],
  },
];

for (const target of targets) {
  if (!existsSync(target.cwd)) continue;
  if (!runAll && !files.some(target.match)) continue;
  console.log(`[pre-commit] testing ${target.name}`);
  run(process.execPath, target.args, target.cwd);
}
