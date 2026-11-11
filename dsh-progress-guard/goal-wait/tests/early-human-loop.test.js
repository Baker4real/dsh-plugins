import test from 'node:test';
import assert from 'node:assert/strict';
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
import * as WaitPlugin from '../index-v2.js';

const human = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
test('real AgentLoop resumes an early pending human once without requiring a second reply', async () => {
  const ctx = new Context();
  let handle;
  let goal;
  let requests = 0;
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(ProjectionRegistry); await ctx.plugin(AgentRegistry);
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolsService, {}); await ctx.plugin(NativeExecutor);
    await ctx.plugin(GoalService); await ctx.plugin(RoundDriver); await ctx.plugin(WaitPlugin, {}); await ctx.plugin(AgentLoop, {});
    class LocalModel extends LlmAdapter {
      async *stream() {
        requests++;
        if (requests === 1) {
          goal = ctx.goals.create(handle.agent, { objective: '人工动作完成后继续', maxGoalRounds: 10 });
          // The original task is claimed already; this new reply arrives before
          // wait_goal executes, so there is no waiting state at insertion time.
          assert.equal(handle.agent.inbox.nextTurn.length, 0);
          handle.agent.followup(human('已经完成，请继续'));
          const block = { type: 'tool-call', id: 'early-wait', name: 'wait_goal', arguments: JSON.stringify({ goal_id: goal.id, revision: goal.revision, reason: '只剩人工确认', action: '完成后回复继续' }) };
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
          yield { type: 'block-end', index: 0, block };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          assert.equal(requests, 2);
          const resumed = ctx.goals.get(handle.agent);
          assert.equal(resumed.activation, 'armed');
          assert.equal(resumed.revision, goal.revision + 1);
          ctx.goals.complete(handle.agent, resumed);
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: '已继续并完成。' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '已继续并完成。' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }
    ctx.llm.registerAdapter(['early-human-local'], new LocalModel());
    handle = await ctx.agents.create({ sessionId: SessionId('goal-wait-early-human-fixed'), agentOptions: { provider: 'early-human-local', model: 'local' } });
    handle.agent.followup(human('执行任务，人工动作完成后继续。'));
    await handle.agent.whenIdle();
    const current = ctx.goals.get(handle.agent);
    assert.equal(current.phase, 'complete');
    assert.equal(requests, 2);
    assert.equal(handle.agent.inbox.nextTurn.length, 0);
    const changes = handle.agent.session.snapshotEvents().filter(e => e.type === 'goal/change');
    assert.deepEqual(changes.map(e => e.data.operation), ['create', 'resume', 'complete']);
  } finally { await handle?.dispose(); await ctx.fiber.dispose(); }
});
