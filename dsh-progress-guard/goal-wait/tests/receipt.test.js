import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fixture, tick, waitArgs } from './fixture.js';

const root = 'D:/Codex/evidence/dsh-goal-wait-20261110';
mkdirSync(root, { recursive: true });
const config = { receiptRoots: [root], receiptPollMs: 250, maxReceiptSeconds: 30 };
const settle = async () => { for (let n = 0; n < 30; n++) await tick(); };

test('a registered bounded receipt matches the exact wait and resumes only once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = await fixture({ config });
  try {
    f.openTurn();
    const goal = f.ctx.goals.create(f.agent, { objective: '等人工完成外部确认', maxGoalRounds: 10 });
    const path = `${root}/${randomUUID()}.goal-wait.json`;
    const waiting = await f.call('wait_goal', waitArgs(goal, { receipt_path: path, receipt_timeout_seconds: 2 }));
    assert.equal(waiting.observation, 'observing');
    const receipt = { version: 1, waitId: waiting.wait.waitId, goalId: goal.id, revision: goal.revision, status: 'ready' };
    writeFileSync(path, JSON.stringify({ ...receipt, waitId: randomUUID() }));
    t.mock.timers.tick(250);
    await settle();
    assert.equal((await f.call('get_goal_wait')).wait.status, 'waiting');
    writeFileSync(path, JSON.stringify(receipt));
    t.mock.timers.tick(250);
    await settle();
    const released = await f.call('get_goal_wait');
    assert.equal(released.wait.resolution, 'receipt');
    assert.equal(released.goal.activation, 'armed');
    assert.equal(released.goal.revision, goal.revision + 1);
    t.mock.timers.tick(5000);
    await settle();
    assert.equal((await f.call('get_goal_wait')).goal.revision, goal.revision + 1);
  } finally { await f.close(); t.mock.timers.reset(); }
});
