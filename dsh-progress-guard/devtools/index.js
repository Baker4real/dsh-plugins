import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceNavigator } from './source-nav.js';
import { InspectionLens } from './inspect.js?generation=4';
import { PageBridge, registerPageRoutes } from './page-bridge.js';
import { createPageTool } from './page-tool.js?generation=1';
import { createInspectTool } from './inspect-tool.js?generation=7';
import { DeploymentPreflight } from './deployment.js';
import { sourceManifest, inspectManifest, runtimeManifest, desktopManifest, deploymentManifest } from './schemas.js?generation=2';
import { NativeHitTester } from './desktop-native.js';
import { ProjectValidationGate, projectFingerprint, sameProject, deliveryOwner } from './validation.js?generation=2';
import { runCheckProcess } from './check-process.js';

export const inject = ['cordisInspect', 'clientModules', 'pluginManager', 'workingDirectory', 'agents'];
const PACKAGE = '@local/dsh-progress-guard';
const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const EVIDENCE = 'D:/agents/run-evidence/dsh-retro-all-20261109/checks';
const matches = (id, name) => name === undefined || id === name || id.startsWith(`${name}/`);
const inside = (path, root) => { const local = relative(root, path); return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local); };

export function apply(ctx) {
  const navigator = new SourceNavigator(join(process.resourcesPath, 'app.asar', 'dsh'));
  const query = (...args) => ctx.cordisInspect.query(...args);
  const desktop = new NativeHitTester();
  const lens = new InspectionLens({ query, generation: () => createHash('sha256').update(JSON.stringify({ graph: ctx.clientModules.graph().rev, providers: ctx.cordisInspect.list() })).digest('hex') });
  const pageBridge = new PageBridge();
  ctx.effect(() => () => pageBridge.dispose(), 'devtools: pending page operations');
  ctx.inject(['connection'], connectionCtx => connectionCtx.effect(() => registerPageRoutes(connectionCtx.connection, pageBridge, { desktopForwarding: !!process.versions.electron }), 'devtools: authenticated page transport'));
  ctx.inject(['tools'], toolCtx => {
    toolCtx.effect(() => toolCtx.tools.register(createPageTool(ctx, pageBridge)), 'devtools: page tool');
    toolCtx.effect(() => toolCtx.tools.register(createInspectTool(ctx, lens)), 'devtools: compact inspect tool');
  });
  const gate = new ProjectValidationGate({
    fingerprint: () => projectFingerprint(PROJECT),
    async run({ signal }) {
      await mkdir(EVIDENCE, { recursive: true });
      const directory = join(EVIDENCE, randomUUID());
      await mkdir(directory);
      const reportPath = join(directory, 'report.json');
      await runCheckProcess(process.execPath, [join(PROJECT, 'scripts', 'check.mjs'), '--runtime', process.execPath, '--resources', process.resourcesPath, '--report', reportPath], { cwd: PROJECT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, signal });
      const text = await readFile(reportPath, 'utf8');
      if (Buffer.byteLength(text) > 128 * 1024) throw new Error('Project report exceeds its budget');
      const report = JSON.parse(text);
      if (report.schemaVersion !== 1 || report.status !== 'passed' || !Array.isArray(report.checks) || report.checks.length < 4 || report.checks.some(row => row.status !== 'passed')) throw new Error('Project check report did not pass');
      const developerCheck = await runCheckProcess(process.execPath, [join(PROJECT, 'devtools', 'scripts', 'check.mjs')], { cwd: PROJECT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, signal });
      if (JSON.parse(developerCheck.stdout).status !== 'passed') throw new Error('Developer tool checks did not pass');
      report.checks.push({ name: 'devtools', status: 'passed' });
      return { ...report, reportPath };
    },
    async client({ agent, signal }) {
      if (!ctx.cordisInspect.list().some(row => row.platform === 'client' && row.id === 'ProgressGuard')) return { status: 'failed', code: 'CLIENT_NOT_CONNECTED' };
      const current = await query('client', 'ProgressGuard', 'status', {}, agent, signal);
      if (current.active !== true || current.registrant !== PACKAGE || current.errors?.length) return { status: 'failed', code: 'CLIENT_NOT_ACTIVE' };
      const actual = await query('client', 'Runtime', 'status', { packageName: PACKAGE }, agent, signal);
      if (actual.failures.length || actual.slotErrors.length || actual.moduleSystem !== 'available') return { status: 'failed', code: 'CLIENT_MODULE_FAILURE' };
      const advertised = ctx.clientModules.graph().entries.find(row => row.id === PACKAGE);
      const loaded = actual.entries.find(row => row.id === PACKAGE);
      if (!advertised || !loaded || loaded.rev !== advertised.rev) return { status: 'failed', code: 'CLIENT_GENERATION_MISMATCH' };
      return { status: 'passed', registrant: current.registrant, revision: loaded.rev };
    },
  });
  ctx.effect(() => ctx.cordisInspect.register({ manifest: sourceManifest, async query(method, input) {
    if (!['resolve', 'files', 'search'].includes(method)) throw new Error('Unknown SourceNav method');
    return await navigator[method](input);
  } }), 'devtools: SourceNav');
  ctx.effect(() => ctx.cordisInspect.register({ manifest: inspectManifest, async query(method, input = {}, context) {
    if (method === 'providers') return lens.providers(ctx.cordisInspect.list(), input);
    if (method === 'provider') return lens.provider(ctx.cordisInspect.list(), input);
    if (method === 'services' || method === 'method') return await lens[method](input, context);
    throw new Error('Unknown Inspect method');
  } }), 'devtools: Inspect');
  ctx.effect(() => ctx.cordisInspect.register({ manifest: deploymentManifest, async query(method, input = {}, { agent, signal }) {
    if (method !== 'preflight') throw new Error('Unknown Deployment method');
    let installedDirectory = input.installedDirectory;
    if (installedDirectory === undefined) {
      const directory = await query('host', 'Config', 'listConfigs', { name: input.packageName, limit: 1 }, agent, signal);
      if (!directory.entries?.[0]) throw new Error('INSTALLED_PACKAGE_PATH_UNAVAILABLE');
      const entry = await query('host', 'Config', 'listConfigs', { entry: directory.entries[0].id }, agent, signal);
      installedDirectory = entry.packageDir;
      if (typeof installedDirectory !== 'string') throw new Error('INSTALLED_PACKAGE_PATH_UNAVAILABLE');
    }
    const deployment = new DeploymentPreflight({ pluginManager: ctx.pluginManager, hmr: ctx.get('hmr'), runtimeRoot: join(process.resourcesPath, 'app.asar', 'dsh') });
    return await deployment.inspect({ ...input, installedDirectory });
  } }), 'devtools: deployment preflight');
  ctx.effect(() => ctx.cordisInspect.register({ manifest: desktopManifest, query(method, input = {}) {
    if (method !== 'hitTest') throw new Error('Unknown Desktop method');
    return desktop.hitTest(input);
  } }), 'devtools: Desktop');
  ctx.effect(() => ctx.cordisInspect.register({ manifest: runtimeManifest, async query(method, input = {}, { agent, signal }) {
    if (method === 'checks') return structuredClone(gate.latest);
    if (method !== 'status') throw new Error('Unknown Runtime method');
    const offset = input.offset ?? 0, limit = input.limit ?? 20;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid Runtime pagination');
    const rows = (await ctx.pluginManager.listPlugins()).filter(row => matches(row.moduleName, input.packageName));
    let configSchemas = [];
    if (input.packageName !== undefined) {
      const schema = await query('host', 'Config', 'listConfigs', { name: input.packageName }, agent, signal);
      configSchemas = await Promise.all((schema.entries ?? []).map(async row => {
        if (typeof row.packageDir === 'string') return { entry: row.id, schemaStatus: row.status, packageDir: row.packageDir };
        try {
          const detail = await query('host', 'Config', 'listConfigs', { entry: row.id }, agent, signal);
          return { entry: row.id, schemaStatus: row.status, packageDir: typeof detail.packageDir === 'string' ? detail.packageDir : null };
        } catch { return { entry: row.id, schemaStatus: row.status, packageDir: null }; }
      }));
    }
    const entries = ctx.clientModules.graph().entries.filter(row => matches(row.id, input.packageName));
    return { platform: 'host', profile: process.env.DSH_PROFILE ?? null, graphRevision: ctx.clientModules.graph().rev, pageChannel: { connected: pageBridge.connected === true, pages: [...pageBridge.waiters.values()].slice(0, 8).map(row => row.page) }, rows: rows.slice(offset, offset + limit).map(row => ({ entryId: row.entryId, moduleName: row.moduleName, enabled: row.enabled, fiberPhase: row.fiberPhase, patchId: row.patchId })), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null, configSchemas, configSchemaStatusIsActivation: false, clientEntries: entries.slice(0, 25).map(row => ({ id: row.id, rev: row.rev })), ...(input.sessionId === undefined ? {} : { session: { id: input.sessionId, inMemory: ctx.get('sessions')?.get(input.sessionId) !== undefined, persisted: 'not-queried', historyOpenedByThisQuery: false } }) };
  } }), 'devtools: Host Runtime');

  // Only Agents admitting a source edit or an installation owe a delivery check.
  // Read-only reviewers and candidate work in another directory do not own it.
  const touched = new WeakSet();
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow') return decision;
    const args = exec.arguments;
    if (exec.agent && ['write', 'edit'].includes(exec.name) && typeof args?.file_path === 'string' && /\.(?:[cm]?js|json|ya?ml|svg)$/iu.test(args.file_path)) {
      const path = resolve(ctx.workingDirectory.get(exec.agent.session), args.file_path);
      if (inside(path, resolve(PROJECT))) touched.add(deliveryOwner(ctx.agents, exec.agent));
    }
    if (exec.name !== 'plugin_manager' || typeof args?.target !== 'string') return decision;
    let relevant = false;
    if (args.action === 'install_bundle') {
      relevant = args.target === PACKAGE || sameProject(args.target, PROJECT);
      if (!relevant && isAbsolute(args.target)) {
        try { relevant = sameProject(await realpath(args.target), await realpath(PROJECT)); }
        catch { /* The manager reports an invalid unrelated target itself. */ }
      }
    } else if (args.action === 'set_plugin' && args.enabled !== false) {
      relevant = (await ctx.pluginManager.listPlugins()).some(row => row.moduleName === PACKAGE && row.entryId === args.target);
    }
    if (!relevant) return decision;
    const result = await gate.verify({ agent: exec.agent, reason: 'install', signal: exec.signal });
    if (result.status === 'passed' && exec.agent) touched.add(deliveryOwner(ctx.agents, exec.agent));
    return result.status === 'passed' ? decision : { kind: 'deny', reason: `进度插件安装前校验未通过（${result.failure}）。运行项目 check 入口修复后重试；可读取 Runtime.checks 查看阶段。` };
  });
  const objections = new WeakMap();
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!touched.has(agent)) return;
    const result = await gate.verify({ agent, reason: 'turn-stopping', signal });
    if (result.status === 'passed') { objections.delete(agent); touched.delete(agent); return; }
    const objection = turn;
    if (objections.get(agent) === objection) throw new Error(`Project validation is still failing (${result.failure}); delivery did not pass.`);
    objections.set(agent, objection);
    agent.steer({ source: { kind: 'project-check' }, content: [{ type: 'text', text: `交付前自动校验未通过（${result.failure}）。请运行项目 scripts/check.mjs，修复后继续；真实页面需要连接且进度插件保持活跃。可用只读 Runtime.checks 查询阶段状态。` }] });
  });
}
