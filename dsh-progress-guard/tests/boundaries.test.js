import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, foldProgress } from '../policy.js';

const A = '已经定位到这个页面的问题，接下来会检查实际数据和接口返回，并在修复后核对界面状态和工具执行结果。';
const B = '已完成数据接口的核对，接下来验证真实页面中的显示和刷新行为，确保修改没有破坏当前会话中的原始消息记录。';
const state = () => foldProgress(initialState(), { type: 'turn/start', data: { turn: 1 } });
function reply(text, id, { tool = true, interrupted = false, turn = 1, extra = [] } = {}) {
  return { seq: Number(id.replace(/\D/g, '')) || 1, type: 'assistant/message', data: { turn, step: 1, interrupted, message: { id, content: [...(text ? [{ type: 'text', text }] : []), ...extra, ...(tool ? [{ type: 'tool-call', id: `call-${id}`, name: 'read' }] : [])] } } };
}
const user = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });

test('only identical adjacent progress folds, with tool-only steps allowed between', () => {
  let s = foldProgress(state(), reply(A, 'm1'));
  s = foldProgress(s, reply('', 'm2'));
  s = foldProgress(s, reply(A, 'm3'));
  assert.equal(s.duplicates.m3.originalId, 'm1');
  s = foldProgress(s, reply(B, 'm4'));
  s = foldProgress(s, reply(A, 'm5'));
  assert.equal(s.duplicates.m5, undefined);
  s = foldProgress(s, reply('已确认，开始验证。', 'm6'));
  s = foldProgress(s, reply(A, 'm7'));
  assert.equal(s.duplicates.m7, undefined, 'a different short progress update ends the previous run');
});

test('final answers, interruptions, structured replies and new user inputs retain their text', () => {
  let s = foldProgress(state(), reply(A, 'm1'));
  s = foldProgress(s, reply(A, 'm2', { tool: false }));
  assert.equal(s.duplicates.m2, undefined);
  s = foldProgress(s, reply(A, 'm3'));
  assert.equal(s.duplicates.m3, undefined);
  s = foldProgress(s, reply(A, 'm4', { interrupted: true }));
  assert.equal(s.duplicates.m4, undefined);
  s = foldProgress(s, user('请重复这段原文，然后调用工具。'));
  s = foldProgress(s, reply(A, 'm5'));
  s = foldProgress(s, reply(A, 'm6'));
  assert.equal(s.duplicates.m6, undefined);
  s = foldProgress(s, { type: 'turn/start', data: { turn: 2 } });
  s = foldProgress(s, reply(A, 'm7', { turn: 2 }));
  assert.equal(s.duplicates.m7, undefined);
  s = foldProgress(s, reply(A, 'm8', { turn: 2, extra: [{ type: 'image' }] }));
  assert.equal(s.duplicates.m8, undefined);
});

test('committed reminders remain one per Turn after replay and duplicate history survives a new Turn', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } }, reply(A, 'm1'), reply(A, 'm2'),
    { type: 'user/message', data: { source: { kind: 'progress-guard' } } }, reply(A, 'm3'),
  ];
  const s = events.reduce(foldProgress, initialState());
  assert.equal(s.reminded, true);
  assert.equal(s.repeated, true);
  const next = foldProgress(s, { type: 'turn/start', data: { turn: 2 } });
  assert.equal(next.reminded, false);
  assert.equal(next.duplicates.m2.originalId, 'm1');
  assert.equal(JSON.parse(JSON.stringify(next)).duplicates.m3.originalId, 'm1');
});
