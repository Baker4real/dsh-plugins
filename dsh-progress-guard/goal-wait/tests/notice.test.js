import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, tick, waitArgs } from './fixture.js';

function notice(f) {
  return f.ctx.sessionProjections.snapshot(f.session, ['localGoalWait']).values.localGoalWait;
}

test('the session wire publishes only the active wait action and its completed turn', async () => {
  const f = await fixture({ driver: false });
  try {
    const turn = f.openTurn();
    const goal = f.ctx.goals.create(f.agent, { objective: '验收完成后的人工操作提示', maxGoalRounds: 10 });
    await f.call('wait_goal', waitArgs(goal));
    assert.equal(notice(f), null);
    f.session.append('turn/end', { turn, reason: { kind: 'completed' } });
    assert.deepEqual(notice(f), { turn, action: '完成确认后回复继续' });
    const registry = f.ctx.sessionProjections;
    assert.equal(Object.hasOwn(registry.snapshot(f.session, registry.summaryKeys()).values, 'localGoalWait'), false);

    const reopened = await fixture({ driver: false, id: f.session.id, seed: f.session.snapshotEvents() });
    try {
      assert.deepEqual(notice(reopened), { turn, action: '完成确认后回复继续' });
    } finally {
      await reopened.close();
    }

    f.agent.followup(f.human());
    await tick();
    assert.equal(notice(f), null);
  } finally {
    await f.close();
  }
});

test('a rejected wait does not publish an action', async () => {
  const f = await fixture({ driver: false });
  try {
    const turn = f.openTurn({ kind: 'schedule', scheduleId: 'fixture' });
    const goal = f.ctx.goals.create(f.agent, { objective: '拒绝非人工等待', maxGoalRounds: 10 });
    await assert.rejects(f.call('wait_goal', waitArgs(goal)), { code: 'GOAL_WAIT_AUTHORITY_REQUIRED' });
    f.session.append('turn/end', { turn, reason: { kind: 'completed' } });
    assert.equal(notice(f), null);
  } finally {
    await f.close();
  }
});
