import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tick, waitArgs } from './fixture.js';

async function waiting(f) {
  f.openTurn();
  const goal = f.ctx.goals.create(f.agent, { objective: '仅差人工操作', maxGoalRounds: 10 });
  await f.call('wait_goal', waitArgs(goal));
  return goal;
}

test('a resume that invalidates an active wait cannot immediately launch an automatic round', async () => {
  const f = await fixture();
  try {
    const goal = await waiting(f);
    f.idle();
    await tick();
    f.ctx.goals.resume(f.agent, goal);
    assert.equal(f.ctx.goals.get(f.agent).activation, 'disarmed');
    assert.equal((await f.call('get_goal_wait')).wait.resolution, 'goal-changed');
    f.idle();
    await tick();
    await tick();
    const value = await f.call('get_goal_wait');
    assert.equal(value.goal.activation, 'disarmed');
    assert.equal(value.goal.roundsStarted, 0);
    assert.equal(f.agent.inbox.nextTurn.filter(m => m.source.kind === 'goal').length, 0);

    // The suppression is only the invalidation edge, not a permanent lock on
    // a later explicit resume of the new goal revision.
    f.ctx.goals.resume(f.agent, value.goal);
    f.idle();
    await tick();
    await tick();
    assert.equal(f.agent.inbox.nextTurn.filter(m => m.source.kind === 'goal').length, 1);
  } finally { await f.close(); }
});

test('unload while a human release awaits durability cannot arm afterward', async () => {
  const f = await fixture();
  try {
    const goal = await waiting(f);
    let finish;
    const barrier = new Promise(resolve => { finish = resolve; });
    const disposeFlush = f.ctx.on('session/flush', () => barrier);
    f.agent.followup(f.human());
    const unloaded = f.waitFiber.dispose();
    finish();
    await unloaded;
    disposeFlush();
    await tick();
    assert.equal(f.ctx.goals.get(f.agent).activation, 'disarmed');
    assert.equal(f.ctx.goals.get(f.agent).revision, goal.revision);
  } finally { await f.close(); }
});

test('a revision change during the release checkpoint cannot arm the new revision', async () => {
  const f = await fixture();
  try {
    const goal = await waiting(f);
    let finish;
    const barrier = new Promise(resolve => { finish = resolve; });
    const disposeFlush = f.ctx.on('session/flush', () => barrier);
    f.agent.followup(f.human());
    const edited = f.ctx.goals.edit(f.agent, goal, { objective: '检查期间的新目标' });
    finish();
    await tick();
    disposeFlush();
    assert.equal(f.ctx.goals.get(f.agent).activation, 'disarmed');
    assert.equal(f.ctx.goals.get(f.agent).revision, edited.revision);
  } finally { await f.close(); }
});

test('a failed durability checkpoint consumes no resumption authority and keeps the goal stopped', async () => {
  const f = await fixture();
  try {
    const goal = await waiting(f);
    const disposeFlush = f.ctx.on('session/flush', async () => { throw new Error('synthetic durability failure'); });
    f.agent.followup(f.human());
    await tick();
    disposeFlush();
    const value = await f.call('get_goal_wait');
    assert.equal(value.goal.activation, 'disarmed');
    assert.equal(value.goal.revision, goal.revision);
    assert.equal(value.wait.status, 'invalidated');
    assert.equal(value.wait.resolution, 'resume-failed');
    f.agent.followup(f.human());
    await tick();
    assert.equal(f.ctx.goals.get(f.agent).revision, goal.revision);
  } finally { await f.close(); }
});

test('forked history does not transfer the original session wait authority', async () => {
  const f = await fixture();
  let forked;
  try {
    await waiting(f);
    forked = await fixture({ seed: f.session.snapshotEvents(), id: 'goal-wait-forked' });
    const value = await forked.call('get_goal_wait');
    assert.equal(value.wait, null);
    assert.equal(value.goal.activation, 'disarmed');
    forked.agent.followup(forked.human());
    await tick();
    assert.equal(forked.ctx.goals.get(forked.agent).activation, 'disarmed');
  } finally { await forked?.close(); await f.close(); }
});
