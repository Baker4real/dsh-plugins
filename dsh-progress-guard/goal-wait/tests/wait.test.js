import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick, waitArgs } from './fixture.js';

test('wait_goal preserves the active goal and stops official automatic rounds without repeated notices', async () => {
  const f = await fixture();
  try {
    f.openTurn();
    const goal = f.ctx.goals.create(f.agent, { objective: '完成后台授权后的本地验证', maxGoalRounds: 10 });
    const result = await f.call('wait_goal', waitArgs(goal));
    assert.equal(result.wait.status, 'waiting');
    assert.equal(result.goal.activation, 'disarmed');
    assert.equal(result.goal.phase, 'active');
    assert.equal(result.goal.revision, goal.revision);
    assert.equal(f.agent.concluded, true);
    f.idle();
    await tick();
    f.idle();
    await tick();
    const reread = await f.call('get_goal_wait');
    assert.equal(reread.wait.waitId, result.wait.waitId);
    assert.equal(f.agent.inbox.nextTurn.length, 0);
    assert.equal(f.agent.inbox.nextStep.length, 0);
    assert.equal(reread.goal.roundsStarted, 0);
  } finally { await f.close(); }
});

test('only direct top-level human inbox input releases a wait once and the official driver may continue', async () => {
  const f = await fixture();
  try {
    f.openTurn();
    const goal = f.ctx.goals.create(f.agent, { objective: '等待人工确认后继续验证', maxGoalRounds: 10 });
    const waiting = await f.call('wait_goal', waitArgs(goal));
    for (const kind of ['tool', 'subagent', 'goal', 'schedule', 'system-prompt', 'local-goal-wait']) {
      const message = { ...f.human(), source: { kind } };
      f.dispatch.emit('agent/inbox/inserted', { message });
    }
    assert.equal((await f.call('get_goal_wait')).wait.status, 'waiting');
    f.agent.followup(f.human());
    await tick();
    const released = await f.call('get_goal_wait');
    assert.equal(released.wait.waitId, waiting.wait.waitId);
    assert.equal(released.wait.status, 'released');
    assert.equal(released.wait.resolution, 'human');
    assert.equal(released.goal.activation, 'armed');
    assert.equal(released.goal.revision, goal.revision + 1);
    f.agent.followup(f.human());
    assert.equal((await f.call('get_goal_wait')).goal.revision, goal.revision + 1);
    for (const m of [...f.agent.inbox.nextTurn]) f.agent.inbox.remove(m.id);
    f.idle();
    await tick();
    await tick();
    assert.equal(f.agent.inbox.nextTurn.filter(m => m.source.kind === 'goal').length, 1);
  } finally { await f.close(); }
});
