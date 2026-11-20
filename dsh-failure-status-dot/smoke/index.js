import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdapter } from './adapter.js';

export const inject = ['llm', 'agents', 'sessionController', 'workspaceController', 'workspaceRegistry', 'cordisInspect'];

export function apply(ctx) {
  const runId = randomUUID();
  const provider = `failure-dot-smoke-${runId}`;
  const directory = `D:/agents/run-evidence/dsh-retro-20261116/ui-smoke/${runId}`;
  const cases = ['error', 'success'].map(expected => ({
    sessionId: `session-failure-dot-${expected}-${runId}`, expected, observed: null,
  }));
  const startFile = `${directory}/start`;
  const stop = new AbortController();
  const createdSessions = [];
  let workspaceId;
  let task;
  let phase = 'scheduled';
  // Let the Desktop observe a running state before each synthetic finish.
  ctx.llm.registerAdapter([provider], createAdapter(10000));
  ctx.effect(() => ctx.cordisInspect.register({
    manifest: {
      id: 'FailureDotSmoke',
      description: 'Read-only status of owned, local-model real-session acceptance fixtures.',
      methods: [{ name: 'status', description: 'Read fixture identities and durable outcomes; never starts work.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { description: 'Fixture run identity, phase, workspace identity and bounded case results.' },
      }],
    },
    query(method) {
      if (method !== 'status') throw new Error('Unknown smoke query');
      return { runId, phase, workspaceId, startFile, cases: cases.map(value => ({ ...value })) };
    },
  }), 'failure-dot: read-only smoke status');

  async function run() {
    await mkdir(directory, { recursive: true });
    const { workspace } = await ctx.workspaceController.create({ path: directory });
    workspaceId = workspace.workspaceId;
    for (const item of cases) {
      stop.signal.throwIfAborted();
      const created = await ctx.sessionController.create({ workspaceId, sessionId: item.sessionId, agentPreset: 'minimal' });
      if (created.sessionId !== item.sessionId) throw new Error('Smoke session identity was not accepted');
      createdSessions.push(item.sessionId);
      const agent = ctx.agents.get(item.sessionId);
      if (agent === undefined) throw new Error('Smoke agent was not published');
      agent.model.select({ provider, model: item.expected });
      await ctx.sessionController.rename({ sessionId: item.sessionId, title: item.expected === 'error' ? '红点验收：受控失败' : '红点验收：受控成功' });
    }
    // The operator opens the sidebar rows before starting the local transitions.
    phase = 'prepared';
    const deadline = Date.now() + 240000;
    while (true) {
      stop.signal.throwIfAborted();
      try {
        if ((await stat(startFile)).isFile()) break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (Date.now() >= deadline) { phase = 'expired'; return; }
      await delay(1000, undefined, { signal: stop.signal });
    }
    phase = 'running';
    for (const item of cases) {
      const agent = ctx.agents.get(item.sessionId);
      await ctx.sessionController.prompt({
        sessionId: item.sessionId, requestId: `indicator-${runId}-${item.expected}`, mode: 'queue',
        content: [{ type: 'text', text: '运行本地状态圆点验收。' }],
      }, stop.signal);
      await agent.whenIdle();
      const events = agent.session.snapshotEvents();
      const ending = events.findLast(event => event.type === 'turn/end');
      item.observed = ending?.data.reason.kind ?? null;
      if (item.observed !== (item.expected === 'error' ? 'error' : 'completed')) throw new Error('Unexpected durable smoke outcome');
    }
    phase = 'ready';
  }

  ctx.effect(() => {
    const timer = setTimeout(() => {
      task = run().catch(() => { phase = 'failed'; });
    }, 1000);
    return async () => {
      stop.abort();
      clearTimeout(timer);
      for (const sessionId of createdSessions) ctx.agents.get(sessionId)?.cancel({ kind: 'user' });
      await task;
      for (const sessionId of createdSessions) {
        await ctx.agents.get(sessionId)?.whenIdle();
        await ctx.workspaceRegistry.archiveSession(sessionId);
      }
      if (workspaceId !== undefined) await ctx.workspaceRegistry.delete(workspaceId);
    };
  }, 'failure-dot: owned real-session smoke lifecycle');
}
