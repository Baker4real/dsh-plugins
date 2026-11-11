import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionId } from '@deepseek-ai/dsh-session';
import { fixture, tick, waitArgs } from './fixture.js';
import * as WaitPlugin from '../index.js';

async function enter(f) {
  f.openTurn();
  const goal = f.ctx.goals.create(f.agent, { objective: '仅差人工确认', maxGoalRounds: 10 });
  const result = await f.call('wait_goal', waitArgs(goal));
  return { goal, result };
}

test('goal revision drift invalidates the old wait and a human cannot rearm it', async () => {
  const f = await fixture();
  try {
    const { goal } = await enter(f);
    const edited = f.ctx.goals.edit(f.agent, goal, { objective: '新的目标定义' });
    f.agent.followup(f.human());
    await tick();
    const value = await f.call('get_goal_wait');
    assert.equal(value.wait.status, 'invalidated');
    assert.equal(value.goal.revision, edited.revision);
    assert.equal(value.goal.activation, 'disarmed');
    assert.equal(value.goal.objective, '新的目标定义');
  } finally { await f.close(); }
});

test('repeated wait calls are idempotent and invalid authority or stale refs do not alter the goal', async () => {
  const f = await fixture();
  try {
    f.openTurn({ kind: 'tool', callId: 'tool-only' });
    const goal = f.ctx.goals.create(f.agent, { objective: '需要人工确认', maxGoalRounds: 10 });
    await assert.rejects(f.call('wait_goal', waitArgs(goal)), { code: 'GOAL_WAIT_AUTHORITY_REQUIRED' });
    assert.equal(f.ctx.goals.get(f.agent).activation, 'armed');
    f.session.append('user/message', f.human(), { surfaceOp: 'append' });
    await assert.rejects(f.call('wait_goal', waitArgs({ ...goal, revision: 2 })), { code: 'GOAL_WAIT_STALE_REF' });
    const one = await f.call('wait_goal', waitArgs(goal));
    const before = f.session.seq;
    const two = await f.call('wait_goal', waitArgs(goal));
    assert.equal(two.wait.waitId, one.wait.waitId);
    assert.equal(f.session.seq, before);
  } finally { await f.close(); }
});

test('a child agent human-looking message cannot enter a human wait', async () => {
  const f = await fixture();
  let detach;
  try {
    const session = f.ctx.sessions.create(SessionId('goal-wait-child'));
    const child = { ...f.agent, id: session.id, session, status: 'running' };
    detach = f.ctx.agents.enter(child, f.agent);
    await f.ctx.agents.announce(child, 'startup');
    session.append('turn/start', { turn: 1 });
    session.append('user/message', f.human(), { surfaceOp: 'append' });
    const goal = f.ctx.goals.create(child, { objective: 'child' });
    const tool = f.ctx.tools.get('wait_goal', child);
    await assert.rejects(f.ctx.agents.withInitiator(child, () => tool.execute(waitArgs(goal), { agent: child, concludeTurn() {} })), { code: 'GOAL_WAIT_AUTHORITY_REQUIRED' });
    assert.equal(f.ctx.goals.get(child).activation, 'armed');
  } finally { detach?.(); await f.close(); }
});

test('plugin reload preserves the wait, does not rearm it, and removes unloaded listeners', async () => {
  const f = await fixture();
  try {
    const { goal, result } = await enter(f);
    await f.waitFiber.dispose();
    f.agent.followup(f.human());
    await tick();
    assert.equal(f.ctx.goals.get(f.agent).activation, 'disarmed');
    assert.equal(f.ctx.tools.get('wait_goal', f.agent), undefined);
    const reloaded = f.ctx.plugin(WaitPlugin, {});
    await reloaded;
    assert.equal((await f.call('get_goal_wait')).wait.waitId, result.wait.waitId);
    assert.equal(f.ctx.goals.get(f.agent).revision, goal.revision);
    await tick();
    assert.equal(f.ctx.goals.get(f.agent).activation, 'disarmed');
    f.agent.followup(f.human());
    await tick();
    assert.equal((await f.call('get_goal_wait')).goal.revision, goal.revision + 1);
  } finally { await f.close(); }
});

test('a new Session/Goal lifecycle replays the persisted wait but never arms from replay', async () => {
  const original = await fixture();
  const { goal, result } = await enter(original);
  const seed = JSON.parse(JSON.stringify(original.session.snapshotEvents()));
  const id = original.agent.id;
  await original.close();
  const resumed = await fixture({ seed, id });
  try {
    const value = await resumed.call('get_goal_wait');
    assert.equal(value.wait.waitId, result.wait.waitId);
    assert.equal(value.wait.status, 'waiting');
    assert.equal(value.goal.revision, goal.revision);
    assert.equal(value.goal.activation, 'disarmed');
    resumed.idle();
    await tick();
    assert.equal(resumed.agent.inbox.nextTurn.length, 0);
    resumed.agent.followup(resumed.human());
    await tick();
    assert.equal((await resumed.call('get_goal_wait')).goal.revision, goal.revision + 1);
  } finally { await resumed.close(); }
});
