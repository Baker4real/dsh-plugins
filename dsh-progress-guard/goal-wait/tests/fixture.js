import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent';
import GoalService from '@deepseek-ai/dsh-goal';
import ToolsService from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as RoundDriver from '@deepseek-ai/dsh-goal-round-driver';
import * as WaitPlugin from '../index.js';

let serial = 0;
export const tick = () => new Promise(resolve => setImmediate(resolve));
export async function fixture({ seed, id, driver = true, config = {} } = {}) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(ProjectionRegistry);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(GoalService);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolsService, {});
  if (driver) await ctx.plugin(RoundDriver);
  const waitFiber = ctx.plugin(WaitPlugin, config);
  await waitFiber;
  const session = ctx.sessions.create(SessionId(id || `goal-wait-test-${++serial}`), seed ? { seed } : {});
  const lists = { 'next-step': [], 'next-turn': [] };
  const agent = { id: session.id, session, ctx, status: 'running', inject: msg => splice('next-step', lists['next-step'].length, 0, [msg]), followup: msg => splice('next-turn', lists['next-turn'].length, 0, [msg]) };
  const dispatch = agentEvents(ctx, agent);
  function splice(target, start, count, inserted) {
    const removed = lists[target].splice(start, count, ...inserted);
    session.append('agent/inbox/spliced', { target, start, ...(count ? { removedCount: count } : {}), inserted, ...(count ? { outcome: 'canceled' } : {}) });
    for (const message of inserted) dispatch.emit('agent/inbox/inserted', { message });
    return removed;
  }
  agent.inbox = {
    get nextStep() { return lists['next-step']; }, get nextTurn() { return lists['next-turn']; },
    remove(messageId) { for (const target of ['next-step', 'next-turn']) { const i = lists[target].findIndex(m => m.id === messageId); if (i >= 0) { splice(target, i, 1, []); return true; } } return false; },
    prepend: (target, msg) => splice(target, 0, 0, [msg]),
  };
  await ctx.agents.register(agent);
  function human(text = '继续') { return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }); }
  function openTurn(source = { kind: 'user' }) {
    const turn = ctx.agents.turnBoundaryOf(session).lastTurn + 1;
    session.append('turn/start', { turn });
    session.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: '完成目标，遇到仅需人工时等待。' }] }), { surfaceOp: 'append' });
    return turn;
  }
  async function call(name, args = {}) {
    agent.status = 'running';
    const tool = ctx.tools.get(name, agent);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    return ctx.agents.withInitiator(agent, () => tool.execute(args, { agent, signal: new AbortController().signal, concludeTurn() { agent.concluded = true; } }));
  }
  function idle() { agent.status = 'idle'; dispatch.emit('agent/status', { status: 'idle' }); }
  async function close() { await ctx.fiber.dispose(); }
  return { ctx, session, agent, human, openTurn, call, idle, close, waitFiber, dispatch };
}
export function waitArgs(goal, extra = {}) { return { goal_id: goal.id, revision: goal.revision, reason: '只差用户在后台完成一次确认', action: '完成确认后回复继续', ...extra }; }
