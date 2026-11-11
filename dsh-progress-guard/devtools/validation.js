import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Hash only product and check inputs; generated reports and transient probes are not source. */
export async function projectFingerprint(root) {
  const paths = ['package.json', 'index.js', 'policy.js', 'client.js', 'cordis.patch.yml', 'icon.svg'];
  async function collect(directory) {
    for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      if (item.isSymbolicLink()) throw new Error('Check input contains a symbolic link');
      const file = `${directory}/${item.name}`;
      if (item.isDirectory()) await collect(file);
      else if (item.isFile()) paths.push(file);
    }
  }
  for (const directory of ['scripts', 'tests', 'locale', 'devtools']) await collect(directory);
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Check input must be a regular project file');
    if (info.size > 2 * 1024 * 1024) throw new Error('Check input exceeds 2 MiB');
    hash.update(path); hash.update('\0'); hash.update(await readFile(join(root, path))); hash.update('\0');
  }
  return hash.digest('hex');
}

/** Delivery admission through the public check CLI and actual connected Client. */
export class ProjectValidationGate {
  constructor({ fingerprint, run, client }) {
    this.fingerprint = fingerprint;
    this.run = run;
    this.client = client;
    this.cached = undefined;
    this.latest = { status: 'not-run', runs: 0, cliRuns: 0, automatic: true };
  }
  async verify({ agent, reason, signal = new AbortController().signal }) {
    signal.throwIfAborted();
    const summary = { status: 'failed', reason, fingerprint: null, runs: this.latest.runs + 1, cliRuns: this.latest.cliRuns, automatic: true, observedAt: new Date().toISOString() };
    this.latest = summary;
    let stage = 'fingerprint';
    try {
      const fingerprint = await this.fingerprint();
      summary.fingerprint = fingerprint;
      let report;
      if (this.cached?.fingerprint === fingerprint) { report = this.cached.report; summary.cached = true; }
      else {
        summary.cliRuns++;
        stage = 'cli';
        report = await this.run({ signal, fingerprint });
        summary.cached = false;
        if (report.status !== 'passed') { summary.failure = 'PROJECT_CHECK_FAILED'; summary.checks = (report.checks ?? []).map(row => ({ name: row.name, status: row.status })); return summary; }
      }
      signal.throwIfAborted();
      if (await this.fingerprint() !== fingerprint) { summary.failure = 'SOURCE_CHANGED'; return summary; }
      stage = 'client';
      const client = reason === 'install' ? { status: 'deferred', reason: 'Client mount is verified at turn stopping, after installation.' } : await this.client({ agent, signal });
      signal.throwIfAborted();
      summary.client = client;
      if (client.status !== 'passed' && client.status !== 'deferred') { summary.failure = client.code ?? 'CLIENT_CHECK_FAILED'; return summary; }
      if (await this.fingerprint() !== fingerprint) { summary.failure = 'SOURCE_CHANGED'; return summary; }
      this.cached = { fingerprint, report };
      summary.status = 'passed';
      summary.report = report.reportPath ?? null;
      summary.checks = (report.checks ?? []).map(row => ({ name: row.name, status: row.status }));
      return summary;
    } catch (error) {
      if (signal.aborted) throw error;
      summary.failedStage = stage;
      summary.failure = stage === 'client' ? 'CLIENT_QUERY_UNAVAILABLE' : typeof error.code === 'string' ? error.code : 'CHECK_EXECUTION_FAILED';
      return summary;
    }
  }
}

/** Attribute a contribution to its live top-level owner, so reviewers never owe another Agent's UI check. */
export function deliveryOwner(registry, agent) {
  const all = registry.list();
  const roots = new Set(registry.roots().map(root => root.id));
  let current = agent;
  for (let count = 0; count <= all.length && !roots.has(current.id); count++) {
    const parent = all.find(candidate => registry.isOwnedBy(current.id, candidate));
    if (parent === undefined) break;
    current = parent;
  }
  return current;
}

export function sameProject(directory, root) {
  return typeof directory === 'string' && resolve(directory).toLowerCase() === resolve(root).toLowerCase();
}
