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
import * as WaitPlugin from '../index.js';
import { tick } from './fixture.js';

// Only the remote model boundary is deterministic. Session, driver, tool
// execution pipeline, compiler, Goal service, and lifecycle are shipped code.
test('real official AgentLoop executes wait_goal via native tool pipeline and becomes idle without another goal round', async () => {
  const ctx = new Context();
  let handle;
  let requests = 0;
  let goal;
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(ProjectionRegistry);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(ToolsService, {});
    await ctx.plugin(NativeExecutor);
    await ctx.plugin(GoalService);
    await ctx.plugin(RoundDriver);
    await ctx.plugin(WaitPlugin, {});
    await ctx.plugin(AgentLoop, {});
    class LocalModel extends LlmAdapter {
      async *stream() {
        requests++;
        goal = ctx.goals.create(handle.agent, { objective: '等用户在第三方后台点确认后验证', maxGoalRounds: 10 });
        const args = { goal_id: goal.id, revision: goal.revision, reason: '剩余操作只能由人工完成', action: '请在后台完成确认后回复继续' };
        const block = { type: 'tool-call', id: 'local-wait-call', name: 'wait_goal', arguments: JSON.stringify(args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
    ctx.llm.registerAdapter(['goal-wait-local-model'], new LocalModel());
    handle = await ctx.agents.create({ sessionId: SessionId('goal-wait-real-loop'), agentOptions: { provider: 'goal-wait-local-model', model: 'local' } });
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '完成任务，只有人工操作剩余时等待。' }] }));
    await handle.agent.whenIdle();
    await tick();
    await tick();
    const current = ctx.goals.get(handle.agent);
    assert.equal(current.phase, 'active');
    assert.equal(current.activation, 'disarmed');
    assert.equal(current.revision, goal.revision);
    assert.equal(current.roundsStarted, 0);
    assert.equal(requests, 1);
    assert.equal(handle.agent.status, 'idle');
    assert.equal(handle.agent.inbox.nextStep.length, 0);
    assert.equal(handle.agent.inbox.nextTurn.length, 0);
    const results = handle.agent.session.snapshotEvents().filter(e => e.type === 'tool/result');
    assert.equal(results.length, 1, JSON.stringify(handle.agent.session.snapshotEvents().filter(e => ['turn/end', 'assistant/message', 'tool/call'].includes(e.type))));
    assert.equal(results[0].data.message.isError, false);
    assert.match(results[0].data.message.content[0].text, /"status":"waiting"/);
  } finally { await handle?.dispose(); await ctx.fiber.dispose(); }
});
