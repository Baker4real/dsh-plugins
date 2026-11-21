import test from 'node:test';
import assert from 'node:assert/strict';
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { apply } from '../index.js';
import { initialSources, foldSources } from '../citations.js';
import { isTruncatedSseJsonFailure, reclassifyTruncatedSseFailure, recoverTruncatedSseStream } from '../stream-recovery.js';

function hostFixture() {
  const hooks = new Map(), scoped = new Map(), effects = [], injections = [];
  let state = initialSources(), provider;
  const basic = name => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (_, value) => [{ type: 'text', text: value.content ?? 'ok' }] },
    execute: async () => ({ content: 'ok' }),
  });
  const originals = new Map(['web_fetch', 'web_search', 'skill', 'mcp__magpie__call_tool'].map(name => [name, basic(name)]));
  const tools = {
    get: name => scoped.get(name) ?? originals.get(name),
    register: tool => { scoped.set(tool.name, tool); return () => scoped.delete(tool.name); },
    guard: () => () => {},
    execute: async () => ({ results: [], additionalContexts: [], concluded: false }),
  };
  const effect = callback => { const cleanup = callback(); const dispose = () => cleanup?.(); effects.push(dispose); return dispose; };
  const agent = {
    id: 'fixture-agent',
    session: { id: 'fixture-agent' },
    ctx: { tools, effect },
    steer: message => { injections.push(message); state = foldSources(state, { type: 'user/message', data: message }); },
  };
  const ctx = {
    tools,
    effect,
    on: (name, callback) => { hooks.set(name, callback); effects.push(() => hooks.delete(name)); },
    agents: { list: () => [agent], get: id => id === agent.id ? agent : undefined },
    sessionProjections: { register: async definition => { definition.stateSchema.parse(state); return { stateOf: () => state }; } },
    cordisInspect: { register: value => { provider = value; return () => { provider = undefined; }; } },
  };
  return {
    ctx,
    agent,
    hooks,
    injections,
    dispose: () => effects.reverse().forEach(dispose => dispose()),
    status: () => provider.query('status', { sessionId: agent.id }),
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test('exact OpenAI SDK truncated SSE JSON PI_AI_ERROR reclassifies to TRANSPORT without mutating input', async () => {
  const failure = Object.freeze({
    message: 'Error reading response: malformed server-sent event JSON.',
    code: 'PI_AI_ERROR',
  });
  assert.equal(isTruncatedSseJsonFailure(failure), true);

  const originalFinish = Object.freeze({
    type: 'finish',
    reason: Object.freeze({ kind: 'error', failure }),
  });
  const usageChunk = Object.freeze({
    type: 'usage',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });

  let hits = 0;
  async function* source() {
    yield usageChunk;
    yield originalFinish;
  }

  const out = await collect(recoverTruncatedSseStream(source(), new AbortController().signal, () => { hits++; }));
  assert.equal(out.length, 2);
  assert.equal(out[0], usageChunk);
  assert.equal(out[1].type, 'finish');
  assert.equal(out[1].reason.kind, 'error');
  assert.equal(out[1].reason.failure.code, 'TRANSPORT');
  assert.equal(out[1].reason.failure.message, failure.message);
  assert.equal(originalFinish.reason.failure.code, 'PI_AI_ERROR');
  assert.equal(hits, 1);

  const ndjson = reclassifyTruncatedSseFailure({
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'Error reading response: malformed newline-delimited JSON.', code: 'PI_AI_ERROR' } },
  });
  assert.equal(ndjson.reason.failure.code, 'TRANSPORT');
});

test('negative controls: unrelated PI_AI_ERROR, non-PI_AI_ERROR codes, 4xx status, quoted text and aborted signals stay unchanged', async () => {
  const unchangedCases = [
    { message: 'pi-ai stream for model "gpt" ended pending', code: 'PI_AI_ERROR' },
    { message: '400 Bad Request: Error reading response: malformed server-sent event JSON.', code: 'PI_AI_ERROR' },
    { message: 'Error reading response: malformed server-sent event JSON.', code: 'PI_AI_ERROR', status: 400 },
    { message: 'Error reading response: malformed server-sent event JSON.', code: 'INVALID_REQUEST' },
    { message: 'Error reading response: malformed server-sent event JSON.', code: 'TRANSPORT' },
    { message: 'Error reading response: malformed server-sent event JSON.', code: 'AUTH' },
    { message: 'Unexpected token < in JSON', code: 'PI_AI_ERROR' },
  ];

  for (const failure of unchangedCases) {
    assert.equal(isTruncatedSseJsonFailure(failure), false, `should not match: ${JSON.stringify(failure)}`);
    const chunk = { type: 'finish', reason: { kind: 'error', failure } };
    assert.equal(reclassifyTruncatedSseFailure(chunk), chunk);
  }

  const aborted = new AbortController();
  aborted.abort(new Error('user canceled'));
  const abortedChunk = {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'Error reading response: malformed server-sent event JSON.', code: 'PI_AI_ERROR' } },
  };
  assert.equal(reclassifyTruncatedSseFailure(abortedChunk, aborted.signal), abortedChunk);

  const normalFinish = { type: 'finish', reason: { kind: 'stop' } };
  assert.equal(reclassifyTruncatedSseFailure(normalFinish), normalFinish);
});

test('host llm/stream reclassifies truncated SSE error on loop and auxiliary streams without triggering citation repair', async () => {
  const f = hostFixture();
  await apply(f.ctx);

  async function* truncatedWithPartial() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Claim\uE200cite\uE202turnInvented\uE201' };
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'Error reading response: malformed server-sent event JSON.',
          code: 'PI_AI_ERROR',
        },
      },
    };
  }

  const loopRequest = markAgentLoopRequest({
    provider: 'magpie-responses',
    model: 'ai/gpt-6.2-sol',
    messages: [],
    sessionId: f.agent.id,
    signal: new AbortController().signal,
  });

  const loopChunks = await collect(f.hooks.get('llm/stream')(loopRequest, () => truncatedWithPartial()));
  const loopFinish = loopChunks.at(-1);
  assert.equal(loopFinish.type, 'finish');
  assert.equal(loopFinish.reason.kind, 'error');
  assert.equal(loopFinish.reason.failure.code, 'TRANSPORT');
  assert.equal(loopFinish.reason.failure.message, 'Error reading response: malformed server-sent event JSON.');
  assert.equal(f.injections.length, 0);

  // Auxiliary stream also reclassifies exact truncated SSE error without running citation rewriting.
  const auxChunks = await collect(f.hooks.get('llm/stream')({ sessionId: f.agent.id, signal: new AbortController().signal }, () => truncatedWithPartial()));
  assert.equal(auxChunks.at(-1).reason.failure.code, 'TRANSPORT');
  assert.equal(auxChunks.find(c => c.type === 'text-delta').text, 'Claim\uE200cite\uE202turnInvented\uE201');

  const status = await f.status();
  assert.equal(status.version, '1.0.5');
  assert.equal(status.truncatedSseRetryGuard, true);
  assert.equal(status.metrics.reclassifiedSseErrors, 2);

  f.dispose();
});
