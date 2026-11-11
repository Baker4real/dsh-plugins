import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

const root = 'D:/Codex/evidence/dsh-goal-wait-20261110';

test('real tool pipeline binds a prestarted producer nonce and its atomic success receipt resumes exactly one official round', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  mkdirSync(root, { recursive: true });
  const ctx = new Context();
  const waitId = randomUUID();
  const path = `${root}/${waitId}.goal-wait.json`;
  const successfulTool = Promise.withResolvers();
  let handle;
  let goal;
  let producer;
  let producerStarted = false;
  let requests = 0;
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
    await ctx.plugin(WaitPlugin, { receiptRoots: [root], receiptPollMs: 250 });
    await ctx.plugin(AgentLoop, {});
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result' && event.data.message.toolCallId === 'prebound-wait-call' && !event.data.message.isError) successfulTool.resolve();
    });
    class LocalModel extends LlmAdapter {
      async *stream() {
        requests++;
        if (requests === 1) {
          goal = ctx.goals.create(handle.agent, { objective: '安装生产者成功退出后继续验证', maxGoalRounds: 10 });
          const frozen = Object.freeze({ version: 1, path, waitId, goalId: goal.id, revision: goal.revision });
          // Starts before wait_goal and uses only the already-frozen identity.
          producer = (async () => {
            producerStarted = true;
            await successfulTool.promise;
            const { path: output, ...identity } = frozen;
            const temporary = `${output}.tmp`;
            writeFileSync(temporary, JSON.stringify({ ...identity, status: 'ready' }));
            renameSync(temporary, output);
          })();
          assert.equal(producerStarted, true);
          const args = { goal_id: goal.id, revision: goal.revision, reason: '只有人工安装动作剩余', action: '请完成安装器中的人工步骤', receipt_path: frozen.path, wait_id: frozen.waitId, receipt_timeout_seconds: 5 };
          const block = { type: 'tool-call', id: 'prebound-wait-call', name: 'wait_goal', arguments: JSON.stringify(args) };
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
          yield { type: 'block-end', index: 0, block };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          ctx.goals.complete(handle.agent, ctx.goals.get(handle.agent));
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: '回执后检查已完成。' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '回执后检查已完成。' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }
    ctx.llm.registerAdapter(['prebound-local-model'], new LocalModel());
    handle = await ctx.agents.create({ sessionId: SessionId(`goal-wait-prebound-${waitId}`), agentOptions: { provider: 'prebound-local-model', model: 'local' } });
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '启动人工步骤，成功后继续原目标。' }] }));
    await handle.agent.whenIdle();
    assert.equal(requests, 1);
    assert.equal(ctx.goals.get(handle.agent).activation, 'disarmed');
    await producer;
    const toolResult = handle.agent.session.snapshotEvents().find(e => e.type === 'tool/result').data.message;
    const waiting = JSON.parse(toolResult.content[0].text);
    assert.equal(waiting.wait.waitId, waitId);
    assert.equal(waiting.wait.goalRef.id, goal.id);
    assert.equal(waiting.wait.goalRef.revision, goal.revision);
    t.mock.timers.tick(250);
    await tick();
    await handle.agent.whenIdle();
    const completed = ctx.goals.get(handle.agent);
    assert.equal(completed.phase, 'complete');
    assert.equal(completed.roundsStarted, 1);
    assert.equal(requests, 2);
    const operations = handle.agent.session.snapshotEvents().filter(e => e.type === 'goal/change').map(e => e.data.operation);
    assert.deepEqual(operations, ['create', 'resume', 'complete']);
    t.mock.timers.tick(10000);
    await tick();
    assert.equal(requests, 2);
  } finally { successfulTool.resolve(); await producer; await handle?.dispose(); await ctx.fiber.dispose(); t.mock.timers.reset(); }
});
