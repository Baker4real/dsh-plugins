import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initialState, foldProgress } from '../policy.js';

test('the sanitized original incident flags every repeated progress and preserves replay metadata', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/incident-replay.json', import.meta.url), 'utf8'));
  const before = JSON.stringify(fixture);
  let state = foldProgress(initialState(), { type: 'turn/start', data: { turn: 1 } });
  let seq = 500;
  for (const message of fixture.messages) {
    state = foldProgress(state, message.role === 'assistant' ? { type: 'assistant/message', seq: seq++, surfaceOp: 'append', data: { turn: 1, step: seq, message } } : { type: 'tool/result', seq: seq++, data: message });
  }
  const repeated = fixture.messages.filter(message => message.role === 'assistant' && message.content.some(block => block.type === 'text'));
  assert.equal(Object.keys(state.duplicates).length, repeated.length - 1);
  assert.ok(repeated.slice(1).every(message => state.duplicates[message.id].originalId === repeated[0].id));
  assert.equal(JSON.stringify(fixture), before, 'provider replay metadata, tools and text must stay byte-for-byte intact');
});
