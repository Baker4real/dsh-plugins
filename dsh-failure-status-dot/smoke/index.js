import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createAdapter } from './adapter.js';

export const inject = ['llm', 'agents', 'sessionController', 'workspaceController', 'workspaceRegistry', 'cordisInspect'];

export function apply(ctx) {
  const runId = randomUUID();
  const provider = `failure-dot-smoke-${runId}`;
  const directory = `D:/agents/run-evidence/dsh-retro-20261116/ui-smoke/${runId}`;
  const cases = ['error', 'success'].map(expected => ({
    sessionId: `session-failure-dot-${expected}-${runId}`, expected, observed: null,
  }));
  let workspaceId;
  let disposed = false;
  let task;
  let phase = 'scheduled';
  ctx.llm.registerAdapter([provider], createAdapter());
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
      return { runId, phase, workspaceId, cases: cases.map(value => ({ ...value })) };
    },
  }), 'failure-dot: read-only smoke status');

  async function run() {
    phase = 'running';
    await mkdir(directory, { recursive: true });
    const { workspace } = await ctx.workspaceController.create({ path: directory });
    workspaceId = workspace.workspaceId;
    for (const item of cases) {
      if (disposed) return;
      const created = await ctx.sessionController.create({ workspaceId, sessionId: item.sessionId, agentPreset: 'minimal' });
      if (created.sessionId !== item.sessionId) throw new Error('Smoke session identity was not accepted');
      const agent = ctx.agents.get(item.sessionId);
      if (agent === undefined) throw new Error('Smoke agent was not published');
      agent.model.select({ provider, model: item.expected });
      await ctx.sessionController.rename({ sessionId: item.sessionId, title: item.expected === 'error' ? '红点验收：受控失败' : '红点验收：受控成功' });
      await ctx.sessionController.prompt({
        sessionId: item.sessionId, requestId: `indicator-${runId}-${item.expected}`,
        content: [{ type: 'text', text: '运行本地状态圆点验收。' }],
      }, new AbortController().signal);
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
      disposed = true;
      clearTimeout(timer);
      for (const item of cases) ctx.agents.get(item.sessionId)?.cancel({ kind: 'user' });
      await task;
      for (const item of cases) {
        const agent = ctx.agents.get(item.sessionId);
        if (agent !== undefined) {
          await agent.whenIdle();
          await ctx.workspaceRegistry.archiveSession(item.sessionId);
        }
      }
      if (workspaceId !== undefined) await ctx.workspaceRegistry.delete(workspaceId);
    };
  }, 'failure-dot: owned real-session smoke lifecycle');
}
