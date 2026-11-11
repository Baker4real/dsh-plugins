import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate';
import { fixture } from './fixture.js';

const root = 'D:/Codex/evidence/dsh-goal-wait-20261110';

test('current Host compiler exposes two tools and rejects malformed arguments before goal authority changes', async () => {
  const f = await fixture({ driver: false });
  try {
    const schemas = f.ctx.tools.schemas(f.agent);
    assert.deepEqual(schemas.map(s => s.name).sort(), ['get_goal_wait', 'wait_goal']);
    const wait = schemas.find(s => s.name === 'wait_goal');
    assert.deepEqual(wait.parameters.required, ['goal_id', 'revision', 'reason', 'action']);
    await assert.rejects(f.call('wait_goal', { goal_id: 'g', revision: '1', reason: '需要人工', action: '确认' }), { code: 'INVALID_ARGS' });
    assert.equal(f.ctx.goals.get(f.agent), undefined);
    const added = estimateToolsTokens({ tools: schemas });
    await f.waitFiber.dispose();
    const baseline = estimateToolsTokens({ tools: f.ctx.tools.schemas(f.agent) });
    mkdirSync(root, { recursive: true });
    writeFileSync(`${root}/tool-schema-cost.json`, JSON.stringify({ method: 'Official dsh-token-meter/estimate fixed-density tool-schema heuristic; not provider-exact tokenization', before: baseline, after: added, delta: added - baseline, schemas }, null, 2));
  } finally { await f.close(); }
});
