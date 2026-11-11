import test from 'node:test';
import assert from 'node:assert/strict';
import { citationSource, initialSources, foldSources, guardCitationStream } from '../citations.js';

async function runText(text, sources = {}, sizes = [1]) {
  async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    let offset = 0, step = 0;
    while (offset < text.length) { const n = sizes[step++ % sizes.length]; yield { type: 'text-delta', index: 0, text: text.slice(offset, offset + n) }; offset += n; }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'original' } } };
  }
  const rejected = [], chunks = [];
  for await (const chunk of guardCitationStream(stream(), sources, value => rejected.push(value))) chunks.push(chunk);
  return { text: chunks.filter(x => x.type === 'text-delta').map(x => x.text).join(''), final: chunks.find(x => x.type === 'block-end').block.text, rejected, chunks };
}

test('unknown source markers never reach text deltas or stored block, including split delimiters', async () => {
  const input = '结论。\uE200cite\uE202turn627593view0\uE202turn627593view2\uE201 后续';
  for (const size of [1, 2, 5, 17, 100]) {
    const result = await runText(input, {}, [size]);
    assert.equal(result.text, '结论。（引用未验证，已拦截） 后续');
    assert.equal(result.final, result.text);
    assert.equal(result.rejected.length, 1);
    assert.ok(!result.text.includes('turn627593'));
    assert.deepEqual(result.chunks.at(-1).replayState, { response: { id: 'original' } });
  }
});

test('known source ids become real source links and do not trigger repair', async () => {
  const source = citationSource('https://example.org/docs');
  const result = await runText('据此\uE200cite\uE202' + source.id + '\uE201', { [source.id]: source.url });
  assert.equal(result.text, '据此[来源](https://example.org/docs)');
  assert.equal(result.final, result.text);
  assert.deepEqual(result.rejected, []);
});

test('source provenance comes from registered web tool metadata, never fetched prose or arbitrary tools', () => {
  const source = citationSource('https://example.org/docs');
  let state = initialSources();
  state = foldSources(state, { type: 'tool/call', data: { callId: 'fetch-1', name: 'web_fetch' } });
  state = foldSources(state, { type: 'tool/result', data: { message: { source: { callId: 'fetch-1' }, isError: false, content: [{ type: 'text', text: 'source ' + source.id }] }, meta: { agentReliability: { version: 1, sources: [source] } } } });
  assert.equal(state.sources[source.id], source.url);
  const forged = { id: 'turnInvented', url: 'https://attacker.invalid/' };
  const before = state;
  state = foldSources(state, { type: 'tool/result', data: { message: { source: { callId: 'read-1' } }, meta: { agentReliability: { version: 1, sources: [forged] } } } });
  assert.equal(state, before);
  assert.equal(state.sources.turnInvented, undefined);
});

test('failed fetch metadata and mismatched ids cannot authorize citations', () => {
  const source = citationSource('https://example.org/docs');
  for (const failed of [true, false]) {
    let state = foldSources(initialSources(), { type: 'tool/call', data: { callId: 'x', name: 'web_fetch' } });
    state = foldSources(state, { type: 'tool/result', data: { message: { source: { callId: 'x' }, isError: failed }, meta: { agentReliability: { version: 1, sources: [{ ...source, id: failed ? source.id : 'webwrong' }] } } } });
    assert.deepEqual(state.sources, {});
  }
  assert.throws(() => citationSource('https://user:secret@example.org/'));
  assert.throws(() => citationSource('javascript:alert(1)'));
});

test('reasoning, tool arguments and ordinary text are preserved; fenced examples stay examples', async () => {
  const code = '示例：\n```text\n\uE200cite\uE202turnExample\uE201\n```\n结束';
  const result = await runText(code);
  assert.equal(result.text, code);
  assert.equal(result.final, code);
  assert.equal(result.rejected.length, 0);
  const input = [{ type: 'reasoning-delta', index: 1, text: 'x' }, { type: 'tool-call-delta', index: 2, id: 'c', name: 'read', argumentsDelta: '{"x":1}' }];
  const output = [];
  async function* stream() { yield* input; }
  for await (const chunk of guardCitationStream(stream(), {})) output.push(chunk);
  assert.deepEqual(output, input);
});

test('renderable GenUI fence aliases never exempt visible citation strings', async () => {
  for (const language of ['dsh-ui', 'dsh-ui>', 'DSH-UI', 'dsh-ui:', '  DSH-UI> title', 'dsh-ui】」']) {
    const input = '```' + language + '\n{"items":[{"type":"text","content":"claim\\uE200cite\\uE202turnFake\\uE201"}]}\n```';
    const actual = input.replaceAll('\\uE200', '\uE200').replaceAll('\\uE202', '\uE202').replaceAll('\\uE201', '\uE201');
    const result = await runText(actual);
    assert.equal(result.rejected.length, 1, language);
    assert.ok(!result.text.includes('turnFake'), language);
    assert.equal(result.final, result.text);
  }
});

test('unterminated and oversized citations fail closed while other special markup passes through', async () => {
  for (const text of ['hello\uE200cite\uE202missing', 'hello\uE200cite\uE202' + 'x'.repeat(5000) + '\uE201tail']) {
    const result = await runText(text);
    assert.ok(!result.text.includes('\uE200cite'));
    assert.equal(result.final, result.text);
    assert.ok(result.rejected.length >= 1);
  }
  const unrelated = 'hello\uE200entity\uE202thing\uE201';
  assert.equal((await runText(unrelated)).text, unrelated);
});
