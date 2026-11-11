import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { fixture, tick, waitArgs } from './fixture.js';

const root = 'D:/Codex/evidence/dsh-goal-wait-20261110/persistence';

test('official JSONL persistence reopens a logged wait with official Session and Goal while keeping it disarmed', async () => {
  const storageCtx = new Context();
  await storageCtx.plugin(JsonlPersistence, { root, compression: 'none' });
  const f = await fixture({ id: `goal-wait-jsonl-${randomUUID()}` });
  let writeHandle;
  let readHandle;
  let reopened;
  try {
    f.openTurn();
    const goal = f.ctx.goals.create(f.agent, { objective: 'JSONL重开后的人工等待', maxGoalRounds: 10 });
    const result = await f.call('wait_goal', waitArgs(goal));
    const events = f.session.snapshotEvents();
    writeHandle = await storageCtx.sessionPersistence.create(f.session.header);
    await writeHandle.append(events);
    await writeHandle.flush();
    await writeHandle.close();
    writeHandle = undefined;
    readHandle = await storageCtx.sessionPersistence.open(f.session.id, 'read');
    const read = await readHandle.read();
    assert.equal(read.events.length, events.length);
    reopened = await fixture({ id: f.agent.id, seed: read.events });
    const recovered = await reopened.call('get_goal_wait');
    assert.equal(recovered.wait.waitId, result.wait.waitId);
    assert.equal(recovered.wait.action, '完成确认后回复继续');
    assert.equal(recovered.goal.phase, 'active');
    assert.equal(recovered.goal.activation, 'disarmed');
    assert.equal(recovered.goal.revision, goal.revision);
    reopened.agent.followup(reopened.human());
    await tick();
    assert.equal((await reopened.call('get_goal_wait')).goal.revision, goal.revision + 1);
  } finally {
    await reopened?.close();
    await readHandle?.close();
    await writeHandle?.close();
    await f.close();
    await storageCtx.fiber.dispose();
  }
});
