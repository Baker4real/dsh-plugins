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

test('real AgentLoop admits ordinary human turns but resumes only for the whole configured reply', async () => {
  const ctx = new Context();
  let handle;
  let goal;
  const requests = [];
  const reply = '现场验证已完成';
  const initial = '请等待人工验证';
  const early = `稍后会发${reply}`;
  const question = `${reply}，接下来会做什么？`;
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(ProjectionRegistry); await ctx.plugin(AgentRegistry);
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(LlmRuntime); await ctx.plugin(ToolsService, {}); await ctx.plugin(NativeExecutor);
    await ctx.plugin(GoalService); await ctx.plugin(RoundDriver); await ctx.plugin(WaitPlugin, {}); await ctx.plugin(AgentLoop, {});
    class LocalModel extends LlmAdapter {
      async *stream() {
        const { agent } = handle;
        const incoming = agent.session.snapshotEvents().filter(e => e.type === 'user/message').at(-1);
        const current = ctx.goals.get(agent);
        requests.push([incoming?.data.content[0].text, current?.activation, current?.revision]);
        if (requests.length === 1) {
          goal = ctx.goals.create(agent, { objective: '人工动作完成后继续', maxGoalRounds: 10 });
          agent.followup(human(early));
          const args = { goal_id: goal.id, revision: goal.revision, reason: '只剩人工确认', action: `完成后回复${reply}`, reply_text: reply };
          const block = { type: 'tool-call', id: 'exact-reply-wait', name: 'wait_goal', arguments: JSON.stringify(args) };
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
          yield { type: 'block-end', index: 0, block };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (incoming?.data.content[0].text === reply && current?.activation === 'armed') ctx.goals.complete(agent, current);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '收到。' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '收到。' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['exact-reply-local'], new LocalModel());
    handle = await ctx.agents.create({ sessionId: SessionId('goal-wait-reply-text'), agentOptions: { provider: 'exact-reply-local', model: 'local' } });
    handle.agent.followup(human(initial));
    await handle.agent.whenIdle();
    const results = handle.agent.session.snapshotEvents().filter(e => e.type === 'tool/result');
    assert.equal(results.length, 1);
    assert.equal(results[0].data.message.isError, false, results[0].data.message.content[0].text);
    assert.equal(ctx.goals.get(handle.agent).activation, 'disarmed');

    handle.agent.followup(human(question));
    await handle.agent.whenIdle();
    assert.equal(ctx.goals.get(handle.agent).activation, 'disarmed');

    handle.agent.followup(human(reply));
    await handle.agent.whenIdle();
    assert.equal(ctx.goals.get(handle.agent).phase, 'complete');
    assert.deepEqual(requests, [
      [initial, undefined, undefined],
      [early, 'disarmed', goal.revision],
      [question, 'disarmed', goal.revision],
      [reply, 'armed', goal.revision + 1],
    ]);
    const changes = handle.agent.session.snapshotEvents().filter(e => e.type === 'goal/change');
    assert.deepEqual(changes.map(e => e.data.operation), ['create', 'resume', 'complete']);
  } finally { await handle?.dispose(); await ctx.fiber.dispose(); }
});
