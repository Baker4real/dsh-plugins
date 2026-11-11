import test from 'node:test';
import assert from 'node:assert/strict';
import { markAgentLoopRequest, BlockAssembler } from '@deepseek-ai/dsh-llm';
import { apply } from '../index.js';
import { initialSources, foldSources } from '../citations.js';

function fixture() {
  const hooks = new Map(), scoped = new Map(), effects = [], injections = [], batches = [];
  let state = initialSources(), provider;
  const basic = name => ({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: (_, value) => [{ type: 'text', text: value.content ?? 'page' }] }, execute: async () => ({ content: '## Core\ntext' }) });
  const originals = new Map(['web_fetch', 'web_search', 'skill', 'mcp__magpie__call_tool'].map(name => [name, basic(name)]));
  const tools = {
    get: name => scoped.get(name) ?? originals.get(name),
    register: tool => { assert.ok(!scoped.has(tool.name)); scoped.set(tool.name, tool); return () => scoped.delete(tool.name); },
    execute: async input => { batches.push(input); return { results: [{ callId: input.calls[0].id, result: { isError: false, value: {}, content: [{ type: 'text', text: 'Title: Example\nURL: https://example.org\nHighlights: observed' }] } }], additionalContexts: [], concluded: false }; },
  };
  const effect = callback => { const cleanup = callback(); const dispose = () => cleanup?.(); effects.push(dispose); return dispose; };
  const agent = { id: 'fixture-agent', session: { id: 'fixture-agent' }, ctx: { tools, effect }, steer: message => { injections.push(message); state = foldSources(state, { type: 'user/message', data: message }); } };
  const ctx = { tools, effect, on: (name, callback) => { hooks.set(name, callback); effects.push(() => hooks.delete(name)); }, agents: { list: () => [agent], get: id => id === agent.id ? agent : undefined }, sessionProjections: { register: async definition => { definition.stateSchema.parse(state); return { stateOf: () => state }; } }, cordisInspect: { register: value => { provider = value; return () => { provider = undefined; }; } } };
  return { ctx, agent, hooks, tools, originals, injections, batches, dispose: () => effects.reverse().forEach(dispose => dispose()), status: () => provider.query('status', { sessionId: agent.id }) };
}
async function* response(text, kind = 'stop') { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind } }; }

test('host hooks intercept actual loop-request identity and request one logged repair per turn', async () => {
  const f = fixture(); await apply(f.ctx);
  const text = 'Claim\uE200cite\uE202turnInvented\uE201';
  const request = markAgentLoopRequest({ provider: 'fixture', model: 'fixture', messages: [], sessionId: f.agent.id, signal: new AbortController().signal });
  const assembler = new BlockAssembler();
  for await (const chunk of f.hooks.get('llm/stream')(request, () => response(text))) assembler.push(chunk);
  assert.ok(JSON.stringify(assembler.blocks()).includes('引用未验证'));
  assert.ok(!JSON.stringify(assembler.blocks()).includes('turnInvented'));
  assert.equal(f.injections.length, 1);
  assert.equal(f.injections[0].source.kind, 'citation-source-guard');
  for await (const _chunk of f.hooks.get('llm/stream')(request, () => response(text))) { /* drain */ }
  assert.equal(f.injections.length, 1);
  const status = await f.status();
  assert.equal(status.metrics.checkedStreams, 2);
  assert.deepEqual(new Set(status.wrappers), new Set(['web_fetch', 'genui_reference', 'web_search']));
  f.dispose();
  assert.equal(f.tools.get('skill'), f.originals.get('skill'));
});

test('native skill identity and catalog gate survive progressive content projection', async () => {
  const f = fixture(); await apply(f.ctx);
  assert.equal(f.tools.get('skill'), f.originals.get('skill'));
  const raw = { name: 'genui', provider: 'fixture', content: 'original full document' };
  const projected = await f.hooks.get('tools/post-execute')({ name: 'skill', arguments: { name: 'genui' } }, { isError: false, value: raw }, async () => ({ kind: 'accept' }));
  assert.ok(projected.value.content.includes('genui_reference'));
  assert.equal(projected.value.provider, raw.provider);
  const other = { name: 'tdd', provider: 'fixture', content: 'untouched' };
  const decision = { kind: 'accept' };
  assert.equal(await f.hooks.get('tools/post-execute')({ name: 'skill', arguments: { name: 'tdd' } }, { isError: false, value: other }, async () => decision), decision);
  assert.equal(f.tools.get('genui_reference').parameters.properties.section.type, 'string');
  f.dispose();
});

test('failed attempts do not request repairs or consume a successful retry repair', async () => {
  const f = fixture(); await apply(f.ctx);
  const bad = 'Claim\uE200cite\uE202turnInvented\uE201';
  const request = markAgentLoopRequest({ provider: 'fixture', model: 'fixture', messages: [], sessionId: f.agent.id, signal: new AbortController().signal });
  for (const kind of ['error', 'aborted']) {
    for await (const _chunk of f.hooks.get('llm/stream')(request, () => response(bad, kind))) { /* drain failed attempt */ }
    assert.equal(f.injections.length, 0);
  }
  for await (const _chunk of f.hooks.get('llm/stream')(request, () => response('clean retry'))) { /* drain */ }
  assert.equal(f.injections.length, 0);
  for await (const _chunk of f.hooks.get('llm/stream')(request, () => response(bad))) { /* drain */ }
  assert.equal(f.injections.length, 1);
  f.dispose();
});

test('auxiliary LLM calls pass through and Exa uses the authorized tool executor with cancellation', async () => {
  const f = fixture(); await apply(f.ctx);
  const text = 'literal\uE200cite\uE202turnOutsideLoop\uE201';
  const chunks = [];
  for await (const chunk of f.hooks.get('llm/stream')({ sessionId: f.agent.id }, () => response(text))) chunks.push(chunk);
  assert.equal(chunks.find(c => c.type === 'block-end').block.text, text);
  assert.equal(f.injections.length, 0);
  const signal = new AbortController().signal;
  const result = await f.tools.get('web_search').execute({ queries: ['example'] }, { agent: f.agent, signal, deferContext: () => {} });
  assert.equal(result.backend, 'existing-magpie-exa');
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0].signal, signal);
  assert.equal(f.batches[0].calls[0].name, 'mcp__magpie__call_tool');
  assert.equal(JSON.parse(f.batches[0].calls[0].arguments).name, 'exa__web_search_exa');
  assert.equal((await f.status()).search.state, 'ready');
  f.dispose();
});
