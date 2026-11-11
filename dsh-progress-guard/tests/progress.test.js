import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { apply } from '../index.js';

const PROGRESS = '官方把这张上下文卡片直接写在输入框组件里，没有可往卡片内部追加内容的插槽。我会用现有 dock 插槽放置同一风格的压缩余量入口。';

async function fixture() {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(ProjectionRegistry);
  await apply(ctx);
  const session = new Session(SessionId('progress-fixture'));
  const agent = { id: session.id, session };
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续排查并修复界面。' }] }), { surfaceOp: 'append' });
  function reply(text, step, tool = true) {
    const message = createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [
      { type: 'text', text },
      ...(tool ? [{ type: 'tool-call', id: `call-${step}`, name: 'fixture-read', arguments: '{}' }] : []),
    ] });
    session.append('assistant/message', { turn: 1, step, message, stream: [] }, { surfaceOp: 'append' });
    return message;
  }
  async function prepare(step, messages = []) {
    return ctx.waterfall('agent/pre-step', { agent, turn: 1, step, messages, signal: new AbortController().signal, modelSelection: { provider: 'fixture', model: 'fixture' } }, () => Promise.resolve({ kind: 'enter', messages, startsRequestSeries: true }));
  }
  return { ctx, session, agent, reply, prepare, close: () => ctx.fiber.dispose() };
}

test('the screenshot repetition is folded and adds one durable corrective reminder without changing tools', async () => {
  const f = await fixture();
  try {
    const first = f.reply(PROGRESS, 43);
    const second = f.reply(PROGRESS, 44);
    const third = f.reply(PROGRESS, 46);
    const view = f.ctx.sessionProjections.snapshot(f.session, ['progressGuard']).values.progressGuard;
    assert.ok(view, 'the progress guard must publish duplicate decisions');
    assert.equal(view.duplicates[second.id].originalId, first.id);
    assert.equal(view.duplicates[third.id].originalId, first.id);
    const decision = await f.prepare(47);
    assert.equal(decision.startsRequestSeries, true);
    assert.equal(decision.messages.length, 1);
    assert.equal(decision.messages[0].source.kind, 'progress-guard');
    assert.match(decision.messages[0].content[0].text, /already delivered/);
    f.session.append('user/message', decision.messages[0], { surfaceOp: 'append' });
    f.reply(PROGRESS, 47);
    assert.equal((await f.prepare(48)).messages.length, 0, 'reminders must not grow every step');
    const history = f.session.deriveMessages().filter(message => message.role === 'assistant');
    assert.equal(history.length, 4);
    assert.deepEqual(history.map(message => message.content[1].id), ['call-43', 'call-44', 'call-46', 'call-47']);
    assert.ok(history.every(message => message.content[0].text === PROGRESS));
  } finally { await f.close(); }
});
