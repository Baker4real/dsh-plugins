import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fixture, tick, waitArgs } from './fixture.js';
import * as WaitPlugin from '../index.js';

const root = 'D:/Codex/evidence/dsh-goal-wait-20261110';
mkdirSync(root, { recursive: true });
const config = { receiptRoots: [root], receiptPollMs: 250, maxReceiptSeconds: 30 };
const settle = async () => { for (let n = 0; n < 10; n++) await tick(); };
async function waiting(f, seconds = 2) {
  f.openTurn();
  const goal = f.ctx.goals.create(f.agent, { objective: '等用户在后台点击', maxGoalRounds: 10 });
  const path = `${root}/${randomUUID()}.goal-wait.json`;
  const result = await f.call('wait_goal', waitArgs(goal, { receipt_path: path, receipt_timeout_seconds: seconds }));
  const ready = () => writeFileSync(path, JSON.stringify({ version: 1, waitId: result.wait.waitId, goalId: goal.id, revision: goal.revision, status: 'ready' }));
  return { goal, path, result, ready };
}

test('receipt timeout stops observing once without automatic rounds or repeated notices', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = await fixture({ config });
  try {
    const { goal, ready } = await waiting(f, 1);
    t.mock.timers.tick(1000);
    await settle();
    const value = await f.call('get_goal_wait');
    assert.equal(value.wait.status, 'waiting');
    assert.equal(value.observation, 'expired');
    const seq = f.session.seq;
    ready();
    t.mock.timers.tick(10000);
    await settle();
    assert.equal(f.session.seq, seq);
    assert.equal(f.ctx.goals.get(f.agent).revision, goal.revision);
    assert.equal(f.ctx.goals.get(f.agent).activation, 'disarmed');
    f.agent.followup(f.human());
    await settle();
    assert.equal((await f.call('get_goal_wait')).wait.resolution, 'human');
  } finally { await f.close(); t.mock.timers.reset(); }
});

test('human input has priority over a simultaneous receipt and consumes the wait once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = await fixture({ config });
  try {
    const { goal, ready } = await waiting(f);
    ready();
    f.agent.followup(f.human());
    t.mock.timers.tick(250);
    await settle();
    const value = await f.call('get_goal_wait');
    assert.equal(value.wait.resolution, 'human');
    assert.equal(value.goal.revision, goal.revision + 1);
    t.mock.timers.tick(5000);
    await settle();
    assert.equal((await f.call('get_goal_wait')).goal.revision, goal.revision + 1);
  } finally { await f.close(); t.mock.timers.reset(); }
});

test('a matching receipt after unload and reload cannot rearm the suspended wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = await fixture({ config });
  try {
    const { goal, result, ready } = await waiting(f);
    await f.waitFiber.dispose();
    ready();
    await f.ctx.plugin(WaitPlugin, config);
    t.mock.timers.tick(5000);
    await settle();
    const value = await f.call('get_goal_wait');
    assert.equal(value.wait.waitId, result.wait.waitId);
    assert.equal(value.observation, 'suspended');
    assert.equal(value.goal.activation, 'disarmed');
    assert.equal(value.goal.revision, goal.revision);
  } finally { await f.close(); t.mock.timers.reset(); }
});

test('revision changes invalidate receipt grants, and a changed matching file cannot wake them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = await fixture({ config });
  try {
    const { goal, ready } = await waiting(f);
    const next = f.ctx.goals.edit(f.agent, goal, { objective: '不同的目标' });
    ready();
    t.mock.timers.tick(5000);
    await settle();
    assert.equal((await f.call('get_goal_wait')).wait.status, 'invalidated');
    assert.equal(f.ctx.goals.get(f.agent).revision, next.revision);
    assert.equal(f.ctx.goals.get(f.agent).activation, 'disarmed');
  } finally { await f.close(); t.mock.timers.reset(); }
});

test('receipt paths, formats, size, and timeout bounds fail closed before granting authority', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = await fixture({ config });
  try {
    f.openTurn();
    const goal = f.ctx.goals.create(f.agent, { objective: '测试边界', maxGoalRounds: 10 });
    for (const path of ['C:/not-allowed.goal-wait.json', 'D:relative.goal-wait.json', 'D:/outside.goal-wait.json', `${root}/secret.txt`, `${root}/../outside.goal-wait.json`, `${root}/file.goal-wait.json:stream`]) await assert.rejects(f.call('wait_goal', waitArgs(goal, { receipt_path: path })));
    await assert.rejects(f.call('wait_goal', waitArgs(goal, { receipt_path: `${root}/bound.goal-wait.json`, receipt_timeout_seconds: 31 })), { code: 'GOAL_WAIT_INVALID_RECEIPT' });
    assert.equal(f.ctx.goals.get(f.agent).activation, 'armed');
    const path = `${root}/${randomUUID()}.goal-wait.json`;
    const value = await f.call('wait_goal', waitArgs(goal, { receipt_path: path, receipt_timeout_seconds: 2 }));
    for (const body of ['{', JSON.stringify({ version: 1, waitId: value.wait.waitId, goalId: goal.id, revision: goal.revision + 1, status: 'ready' }), 'x'.repeat(4097)]) {
      writeFileSync(path, body);
      t.mock.timers.tick(250);
      await settle();
      assert.equal((await f.call('get_goal_wait')).wait.status, 'waiting');
    }
    assert.equal(f.ctx.goals.get(f.agent).activation, 'disarmed');
  } finally { await f.close(); t.mock.timers.reset(); }
});
