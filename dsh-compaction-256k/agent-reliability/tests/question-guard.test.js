import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import ToolsService from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { guardAskUserQuestion } from '../question-guard.js';

async function fixture() {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolsService, {});
  ctx.effect(() => ctx.tools.guard(guardAskUserQuestion));
  // DSH 0.2.2-rc.2 normalizes a guard denial to { reason, ...info }; rc.1 returned the guard's string.
  const denial = (exec) => { const value = ctx.tools.checkGuards(exec); return typeof value === 'string' ? value : value?.reason; };
  return { ctx, denial, close: () => ctx.fiber.dispose() };
}

const valid = {
  questions: [{
    header: '本地提交授权', id: 'authorize', question: '是否授权本地提交？', multi_select: false,
    options: [{ label: '授权', description: '只提交，不推送。' }, { label: '暂不提交' }],
  }],
};

test('the incident shape is rejected by the real tool guard before dispatch', async () => {
  const f = await fixture();
  try {
    const malformed = {
      questions: [{
        header: '本地提交授权', id: 'authorize', question: '是否授权？', 'multi_select false': false,
        'options [{': false,
      }],
    };
    const reason = f.denial({ name: 'ask_user_question', arguments: malformed });
    assert.match(reason, /unrecognized_keys/);
    assert.equal(f.denial({ name: 'ask_user_question', arguments: valid }), undefined);
    assert.equal(f.denial({ name: 'read', arguments: malformed }), undefined);
  } finally { await f.close(); }
});

test('blank identity, blank question and duplicate ids are rejected without echoing content', async () => {
  const f = await fixture();
  try {
    const cases = [
      { questions: [{ id: '', question: 'valid' }] },
      { questions: [{ id: 'valid', question: ' ' }] },
      { questions: [{ id: 'same', question: 'first' }, { id: 'same', question: 'second' }] },
    ];
    for (const args of cases) {
      const reason = f.denial({ name: 'ask_user_question', arguments: args });
      assert.match(reason, /Invalid ask_user_question input/);
      assert.ok(!reason.includes('first'), 'diagnostics must not echo question text');
    }
    assert.equal(f.denial({ name: 'ask_user_question', arguments: { questions: [{ id: 'freeform', question: '请回复决定。' }] } }), undefined);
  } finally { await f.close(); }
});
