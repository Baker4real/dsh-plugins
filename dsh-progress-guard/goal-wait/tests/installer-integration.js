// Explicit cross-package integration; not part of the environment-independent unit suite.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { readFileSync: readRawFileSync } = createRequire(import.meta.url)('original-fs');
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import GoalService from '@deepseek-ai/dsh-goal';
import ToolsService from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import * as RoundDriver from '@deepseek-ai/dsh-goal-round-driver';
import * as WaitPlugin from '../index.js';

const own = 'D:/Codex/evidence/dsh-goal-wait-20261110';
const installerRoot = 'D:/agents/projects/misc/dsh-desktop-caption-visibility';
const pwsh = 'C:/Program Files/PowerShell/7/pwsh.exe';
const nonce = randomUUID();
const directory = `${own}/cross-installer-${nonce}`;
assert.ok(!existsSync(directory));
mkdirSync(`${directory}/prepared`, { recursive: true });
const originalText = 'original isolated cross-installer fixture';
const patchedText = 'patched isolated cross-installer fixture';
const target = `${directory}/app.asar`;
const exe = `${directory}/receipt-fixture-node.exe`;
const script = `${directory}/app.cjs`;
const receipt = `${directory}/${nonce}.goal-wait.json`;
const gate = `${directory}/release-original.json`;
const ownerTokenSha256 = createHash('sha256').update(randomBytes(32)).digest('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
copyFileSync('D:/Codex/tools/bin/node.exe', exe);
writeFileSync(target, originalText);
writeFileSync(`${directory}/prepared/app.asar.original`, originalText);
writeFileSync(`${directory}/prepared/app.asar.patched`, patchedText);
save(`${directory}/prepared/manifest.json`, { archivePath: target, originalSha256: hash(originalText), patchedSha256: hash(patchedText) });
writeFileSync(script, `const fs = require('node:fs'); const path = require('node:path');
const root = __dirname; const ownerTokenSha256 = ${JSON.stringify(ownerTokenSha256)};
const original = path.join(root, 'original-ready.json');
const isOriginal = !fs.existsSync(original);
const identity = { pid:process.pid, parentProcessId:process.ppid, executable:process.execPath, ownerTokenSha256, reportedAt:new Date().toISOString() };
function write(name, data) { fs.writeFileSync(path.join(root,name), JSON.stringify(data)); }
if (isOriginal) {
  write('original-ready.json', identity);
  const polling = setInterval(() => { if (fs.existsSync(path.join(root,'release-original.json'))) {
    const release = JSON.parse(fs.readFileSync(path.join(root,'release-original.json'),'utf8'));
    if (release.ownerTokenSha256 === ownerTokenSha256) { clearInterval(polling); write('original-exited.json',{...identity,exitCode:0,reason:'released after Goal idle'}); process.exit(0); }
  } },100);
  setTimeout(() => { write('original-exited.json',{...identity,exitCode:2,reason:'fixture deadline'}); process.exit(2); },60000);
} else {
  write('relaunch-ready.json', identity);
  setTimeout(() => { write('relaunch-exited.json',{...identity,exitCode:0,reason:'fixture self exit'}); process.exit(0); },7000);
}
`);
const report = { schemaVersion: 1, status: 'running', directory, reportPath: `${directory}/cross-integration.json`, source: { installerRoot, startSha256: hash(readFileSync(`${installerRoot}/Start-Installation.ps1`)), completeSha256: hash(readFileSync(`${installerRoot}/Complete-Installation.ps1`)), applySha256: hash(readFileSync(`${installerRoot}/Apply-Patch.ps1`)) }, scope: { target, executable: exe, ownerTokenSha256, productionHostTouched: false }, processes: {}, assertions: [] };
save(report.reportPath, report);
function launch(label, file, args, env = {}) {
  const stdout = openSync(`${directory}/${label}.stdout.log`, 'w');
  const stderr = openSync(`${directory}/${label}.stderr.log`, 'w');
  const entry = report.processes[label] = { launchIntent: { executable: file, args, cwd: directory, lifetime: 'task-scoped', ownerTokenSha256, expectedExitCode: 0 }, state: 'launching' };
  save(report.reportPath, report);
  const childEnv = { ...process.env, ...env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(file, args, { cwd: directory, env: childEnv, stdio: ['ignore', stdout, stderr], windowsHide: true });
  closeSync(stdout); closeSync(stderr);
  entry.pid = child.pid;
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', error => { entry.state = 'launch-failed'; entry.error = error.message; reject(error); });
    child.once('exit', (code, signal) => { entry.state = 'exited'; entry.exitCode = code; entry.signal = signal; save(report.reportPath, report); resolveExit(code); });
  });
  return { child, exited, entry };
}
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function until(predicate, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await delay(100); }
  throw new Error(message);
}
const ctx = new Context();
let original;
let launcher;
let monitor;
let handle;
let goal;
let requests = 0;
try {
  original = launch('original-app', exe, [script]);
  await until(() => existsSync(`${directory}/original-ready.json`), 5000, 'Original fixture readiness timed out.');
  assert.equal(json(`${directory}/original-ready.json`).ownerTokenSha256, ownerTokenSha256);
  await ctx.plugin(SessionStore); await ctx.plugin(ProjectionRegistry); await ctx.plugin(AgentRegistry);
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolsService, {}); await ctx.plugin(NativeExecutor);
  await ctx.plugin(GoalService); await ctx.plugin(RoundDriver); await ctx.plugin(WaitPlugin, { receiptRoots: [directory], receiptPollMs: 250 }); await ctx.plugin(AgentLoop, {});
  class ModelBoundary extends LlmAdapter {
    async *stream() {
      requests++;
      if (requests === 1) {
        goal = ctx.goals.create(handle.agent, { objective: 'fixture安装器成功退出后完成原目标验证', maxGoalRounds: 10 });
        save(`${directory}/receipt-config.json`, { path: receipt, waitId: nonce, goalId: goal.id, revision: goal.revision });
        launcher = launch('installer-launcher', pwsh, ['-NoProfile', '-STA', '-File', `${installerRoot}/Start-Installation.ps1`, '-PreparedDirectory', `${directory}/prepared`, '-Target', target, '-ExecutablePath', exe, '-ExecutableArguments', script, '-RunDirectory', `${directory}/run`, '-TimeoutSeconds', '40', '-ReadyTimeoutSeconds', '15', '-GoalWaitReceipt', `${directory}/receipt-config.json`]);
        assert.equal(await launcher.exited, 0, 'Actual installer launcher failed; inspect installer-launcher.stderr.log.');
        const launchRecord = json(`${directory}/run/installer-launch.json`);
        assert.equal(launchRecord.result, 'ready');
        assert.equal(json(`${directory}/run/installer-state.json`).stage, 'waiting-for-app-exit');
        assert.equal(original.child.exitCode, null);
        assert.equal(existsSync(receipt), false);
        assert.equal(readRawFileSync(target, 'utf8'), originalText);
        monitor = launch('process-monitor', pwsh, ['-NoProfile', '-File', resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/observe-installer-fixture.ps1'), '-FixtureDirectory', directory, '-InstallerRoot', installerRoot]);
        await until(() => existsSync(`${directory}/monitor-ready.json`), 5000, 'Process observer did not bind installer before release.');
        report.processes['installer-worker'] = { identity: launchRecord.worker, ownerTokenSha256: launchRecord.ownerTokenSha256, parent: launchRecord.parent, readiness: 'waiting-for-app-exit before wait_goal' };
        report.assertions.push('Actual installer launched and froze receipt identity before wait_goal; original fixture still live.');
        const args = { goal_id: goal.id, revision: goal.revision, reason: '只剩安装器中的人工步骤', action: '请完成安装器人工步骤；成功回执后继续', wait_id: nonce, receipt_path: receipt, receipt_timeout_seconds: 40 };
        const block = { type: 'tool-call', id: 'actual-installer-wait', name: 'wait_goal', arguments: JSON.stringify(args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        assert.equal(requests, 2);
        const current = ctx.goals.get(handle.agent);
        assert.equal(readRawFileSync(target, 'utf8'), patchedText);
        const wire = json(receipt);
        assert.equal(wire.waitId, nonce); assert.equal(wire.goalId, goal.id); assert.equal(wire.revision, goal.revision);
        ctx.goals.complete(handle.agent, current);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '实际安装器回执后的原目标验证完成。' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '实际安装器回执后的原目标验证完成。' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  ctx.llm.registerAdapter(['actual-installer-model-boundary'], new ModelBoundary());
  handle = await ctx.agents.create({ sessionId: SessionId(`goal-wait-cross-${nonce}`), agentOptions: { provider: 'actual-installer-model-boundary', model: 'local' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '先启动fixture安装器，人工步骤成功后继续目标。' }] }));
  await handle.agent.whenIdle();
  save(`${directory}/session-events.json`, handle.agent.session.snapshotEvents());
  const results = handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/result');
  assert.equal(results.length, 1, JSON.stringify(handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')));
  assert.equal(results[0].data.message.isError, false);
  assert.equal(ctx.goals.get(handle.agent).activation, 'disarmed'); assert.equal(requests, 1);
  assert.equal(original.child.exitCode, null); assert.equal(existsSync(receipt), false);
  report.goalAtIdle = ctx.goals.get(handle.agent);
  report.assertions.push('wait_goal concluded the real AgentLoop turn; idle and disarmed before original app was released.');
  save(gate, { ownerTokenSha256, releasedAt: new Date().toISOString(), goalId: goal.id, revision: goal.revision });
  assert.equal(await original.exited, 0);
  await until(() => ctx.goals.get(handle.agent)?.phase === 'complete', 30000, 'Actual installer receipt did not resume the Goal.');
  await handle.agent.whenIdle();
  assert.equal(await monitor.exited, 0, 'Fixture process exit observer failed.');
  report.processExitEvidence = json(`${directory}/process-exits.json`);
  assert.equal(report.processExitEvidence.status, 'passed');
  report.receipt = json(receipt);
  assert.deepEqual(Object.keys(report.receipt).sort(), ['goalId', 'revision', 'status', 'version', 'waitId']);
  report.goalAtEnd = ctx.goals.get(handle.agent);
  assert.equal(report.goalAtEnd.roundsStarted, 1); assert.equal(requests, 2);
  report.goalOperations = handle.agent.session.snapshotEvents().filter(e => e.type === 'goal/change').map(e => e.data.operation);
  assert.deepEqual(report.goalOperations, ['create', 'resume', 'complete']);
  report.modelRequests = requests;
  report.assertions.push('Actual Apply-Patch replaced only fixture ASAR and actual confirmed relaunch published ready.', 'Exactly one official Goal round resumed from that actual installer receipt.', 'Original app, installer launcher, Explorer worker, relaunched fixture and process observer exited successfully; no fixture processes or locks remain.');
  save(`${directory}/session-events.json`, handle.agent.session.snapshotEvents());
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack ?? error).slice(-6000);
  if (!existsSync(gate)) save(gate, { ownerTokenSha256, cleanup: true });
} finally {
  await handle?.dispose(); await ctx.fiber.dispose();
  for (const child of [original, launcher, monitor]) if (child) await child.exited.catch(() => {});
  report.finishedAt = new Date().toISOString(); save(report.reportPath, report);
}
process.stdout.write(`${JSON.stringify({ status: report.status, reportPath: report.reportPath, directory, goalOperations: report.goalOperations, error: report.error })}\n`);
process.exitCode = report.status === 'passed' ? 0 : 1;
