import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { filterRepeatedProgressStream } from '../policy.js';

const PROGRESS = '三笔 skills 提交已在隔离快照中全部预演通过，接下来只执行已经核验的写入步骤。';

function chunks(text = PROGRESS, tool = true) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: text.slice(0, 12) },
    { type: 'text-delta', index: 0, text: text.slice(12) },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(tool ? [
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } },
    ] : []),
    { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' }, replayState: { id: 'preserved' } },
  ];
}

async function collect(input) {
  const output = [];
  for await (const chunk of input) output.push(chunk);
  return output;
}

test('an exact repeated intermediate progress loses its text before assembly but keeps tools and replay state', async () => {
  let dropped = 0;
  const output = await collect(filterRepeatedProgressStream(chunks(), PROGRESS, () => { dropped++; }));
  assert.equal(dropped, 1);
  assert.ok(output.every(chunk => chunk.type !== 'text-delta'));
  assert.equal(output.at(-1).replayState.id, 'preserved');
  const assembler = new BlockAssembler();
  for (const chunk of output) assembler.push(chunk);
  const blocks = assembler.blocks();
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'tool-call');
  assert.equal(blocks[0].id, 'call-1');
});

test('different text and a final answer are never truncated', async () => {
  for (const input of [chunks('这是一条新的进度更新，内容与上一版不同，并且需要完整保留。'), chunks(PROGRESS, false)]) {
    const output = await collect(filterRepeatedProgressStream(input, PROGRESS));
    assert.deepEqual(output, input);
  }
});

test('an interrupted stream without finish fails open with every original chunk', async () => {
  const input = chunks().slice(0, -1);
  const output = await collect(filterRepeatedProgressStream(input, PROGRESS));
  assert.deepEqual(output, input);
});

test('an aborted finish also preserves the interrupted text and tool call', async () => {
  const input = chunks();
  input[input.length - 1] = { type: 'finish', reason: { kind: 'aborted', failure: { message: 'fixture abort', code: 'aborted' } } };
  const output = await collect(filterRepeatedProgressStream(input, PROGRESS));
  assert.deepEqual(output, input);
});
