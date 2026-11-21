import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fixture, tick, waitArgs } from './fixture.js';

const root = 'D:/Codex/evidence/dsh-goal-wait-20261110';
mkdirSync(root, { recursive: true });

for (const exact of [true, false]) {
  test(exact ? 'an exact reply arriving during receipt durability takes priority' : 'unrelated inbox messages do not take priority over a verified receipt', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const f = await fixture({ config: { receiptRoots: [root], receiptPollMs: 250 } });
    let finish;
    let disposeFlush;
    try {
      f.openTurn();
      const goal = f.ctx.goals.create(f.agent, { objective: '等待人工确认后的检查', maxGoalRounds: 10 });
      const path = `${root}/${randomUUID()}.goal-wait.json`;
      const result = await f.call('wait_goal', waitArgs(goal, { reply_text: '继续', receipt_path: path, receipt_timeout_seconds: 2 }));
      if (!exact) f.agent.followup(f.human('稍后继续'));
      assert.equal((await f.call('get_goal_wait')).wait.status, 'waiting');
      const barrier = new Promise(resolve => { finish = resolve; });
      disposeFlush = f.ctx.on('session/flush', () => barrier);
      writeFileSync(path, JSON.stringify({ version: 1, waitId: result.wait.waitId, goalId: goal.id, revision: goal.revision, status: 'ready' }));
      t.mock.timers.tick(250);
      assert.equal(f.ctx.goals.get(f.agent).activation, 'disarmed');
      f.agent.followup(f.human(exact ? '继续' : '继续吗？'));
      finish();
      await tick();
      const current = await f.call('get_goal_wait');
      assert.equal(current.wait.resolution, exact ? 'human' : 'receipt');
      assert.equal(current.goal.revision, goal.revision + 1);
    } finally { finish?.(); disposeFlush?.(); await f.close(); t.mock.timers.reset(); }
  });
}
