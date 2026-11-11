import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, tick, waitArgs } from './fixture.js';

const root = 'D:/Codex/evidence/dsh-goal-wait-20261110';

test('prebound wait_id rejects invalid or receipt-less ids and cannot replace or replay an existing wait', async () => {
  const f = await fixture({ config: { receiptRoots: [root] } });
  try {
    f.openTurn();
    const goal = f.ctx.goals.create(f.agent, { objective: '先登记生产者nonce，再等待', maxGoalRounds: 10 });
    const path = `${root}/prebound.goal-wait.json`;
    await assert.rejects(f.call('wait_goal', waitArgs(goal, { wait_id: randomUUID() })), { code: 'GOAL_WAIT_INVALID_RECEIPT' });
    for (const id of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', `${randomUUID()}suffix`]) {
      await assert.rejects(f.call('wait_goal', waitArgs(goal, { receipt_path: path, wait_id: id })), { code: 'GOAL_WAIT_INVALID_RECEIPT' });
      assert.equal(f.ctx.goals.get(f.agent).activation, 'armed');
    }
    const waitId = randomUUID();
    const one = await f.call('wait_goal', waitArgs(goal, { receipt_path: path, wait_id: waitId }));
    assert.equal(one.wait.waitId, waitId);
    const seq = f.session.seq;
    const again = await f.call('wait_goal', waitArgs(goal, { receipt_path: path, wait_id: waitId }));
    assert.equal(again.wait.waitId, waitId);
    assert.equal(f.session.seq, seq);
    await assert.rejects(f.call('wait_goal', waitArgs(goal, { receipt_path: path, wait_id: randomUUID() })), { code: 'GOAL_WAIT_ALREADY_WAITING' });
    assert.equal((await f.call('get_goal_wait')).wait.waitId, waitId);
    f.agent.followup(f.human());
    await tick();
    const current = f.ctx.goals.get(f.agent);
    await assert.rejects(f.call('wait_goal', waitArgs(current, { receipt_path: path, wait_id: waitId.toUpperCase() })), { code: 'GOAL_WAIT_NONCE_REUSED' });
    assert.equal(f.ctx.goals.get(f.agent).activation, 'armed');
    assert.equal(f.ctx.goals.get(f.agent).revision, goal.revision + 1);
  } finally { await f.close(); }
});
