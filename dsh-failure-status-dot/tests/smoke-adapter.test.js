import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../smoke/adapter.js';

test('the local fixture emits an actual terminal failure for the error model', async () => {
  const chunks = [];
  for await (const chunk of createAdapter().stream({ model: 'error', signal: new AbortController().signal })) chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'INDICATOR_SMOKE_FAILURE');
});

test('the local success model emits an answer and a successful finish', async () => {
  const chunks = [];
  for await (const chunk of createAdapter().stream({ model: 'success', signal: new AbortController().signal })) chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'text'), true);
});
