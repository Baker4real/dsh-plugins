#!/usr/bin/env node
// Read-only ASAR companion to skill_resource_closure.py; run with DSH Electron in Node mode.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), status: 'fail', checks: [], failures: [] };
function failure(label, error) { report.failures.push({ label, error: String(error.message || error) }); }
function required(file, label) {
  try {
    const info = fs.statSync(file);
    if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024) throw new Error('Required file must be nonempty and at most 1 MiB');
    const bytes = fs.readFileSync(file);
    report.checks.push({ label, path: file, status: 'pass', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    return bytes.toString('utf8');
  } catch (error) { report.checks.push({ label, path: file, status: 'fail' }); failure(label, error); return null; }
}
function ensure(condition, message) { if (!condition) throw new Error(message); }
function main() {
  const args = process.argv.slice(2), extra = [];
  let skill;
  while (args.length) {
    const option = args.shift(), value = args.shift();
    ensure(value, `Missing value for ${option}`);
    if (option === '--skill') skill = value;
    else if (option === '--extra-required') extra.push(value);
    else throw new Error(`Unknown option: ${option}`);
  }
  ensure(skill, '--skill is required');
  ensure(process.versions.electron, 'Use DSH_NODE_EXECUTABLE with ELECTRON_RUN_AS_NODE=1');
  const installDir = process.env.DSH_INSTALL_DIR;
  ensure(installDir && installDir.toLowerCase().includes('app.asar'), 'DSH_INSTALL_DIR must identify the installed Desktop ASAR');
  const cli = JSON.parse(required(path.join(installDir, 'package.json'), 'cli-manifest'));
  ensure(cli?.name === '@deepseek-ai/dsh', 'Unexpected CLI identity');
  const presetPath = require.resolve('@deepseek-ai/dsh-agent-preset/package.json', { paths: [installDir] });
  const preset = JSON.parse(required(presetPath, 'preset-manifest'));
  ensure(preset?.name === '@deepseek-ai/dsh-agent-preset' && preset.version === cli.version, 'CLI/preset identity or version differs');
  const base = path.join(path.dirname(presetPath), 'skills', 'dsh-doc');
  const docPath = path.join(base, 'SKILL.md');
  const doc = required(docPath, 'dsh-doc-entry');
  ensure(doc, 'Installed dsh-doc is unreadable');
  required(path.join(installDir, 'docs/user/index.md'), 'installed-user-docs');
  required(path.join(installDir, 'docs/upgrade-guide/README.md'), 'installed-upgrade-index');
  const entries = [...new Set(doc.split(/\r?\n/).filter(line => line.startsWith('|')).flatMap(line => [...line.matchAll(/`((?:references|templates)\/[^`]+)`/g)].map(match => match[1])))];
  for (const entry of ['references/locate-docs.md', 'references/plugin-development.md']) ensure(entries.includes(entry), `Missing published authoring route: ${entry}`);
  for (const template of ['decoration', 'mcp']) ensure(entries.some(entry => entry.startsWith(`templates/${template}/`)), `Missing published ${template} template`);
  for (const entry of [...entries, ...extra]) {
    ensure(!path.isAbsolute(entry) && !entry.split(/[\\/]/).includes('..'), 'Required entry must stay in the installed skill');
    const target = path.join(base, entry);
    if (entry.endsWith('/locale')) {
      try {
        const names = fs.readdirSync(target).sort();
        ensure(names.length > 0 && names.length <= 100, 'Locale directory must contain 1..100 files');
        for (const name of names) required(path.join(target, name), `${entry}/${name}`);
      } catch (error) { failure(entry, error); }
    } else required(target, entry);
  }
  const override = required(path.resolve(skill), 'override-entry');
  ensure(override, 'Override is unreadable');
  const sections = override.split(/^## Authoring\s*$/m);
  ensure(sections.length === 2, 'Expected exactly one Authoring section');
  const pointers = [...sections[1].matchAll(/`([A-Za-z]:[\\/][^`\r\n]+[\\/]SKILL\.md)`/g)].map(match => match[1]);
  ensure(pointers.length === 1, 'Expected one absolute Authoring skill pointer');
  required(pointers[0], 'authoring-pointer');
  if (path.resolve(pointers[0]).toLowerCase() !== path.resolve(docPath).toLowerCase()) failure('authoring-owner', 'Authoring must point to dsh-doc in the current installation');
  report.runtime = { electron: process.versions.electron, node: process.versions.node, cliVersion: cli.version, presetVersion: preset.version };
  report.scope = { authority: 'Installed dsh-doc published table and documentation indices', publishedEntries: entries.length, extraRequired: extra };
  report.status = report.failures.length ? 'fail' : 'pass';
}
try { main(); } catch (error) { failure('checker', error); }
report.summary = { passed: report.checks.filter(row => row.status === 'pass').length, failedChecks: report.checks.filter(row => row.status === 'fail').length, failures: report.failures.length };
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.status === 'pass' ? 0 : 1;
