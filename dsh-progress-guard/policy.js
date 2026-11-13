import { createHash } from 'node:crypto';

export const REMINDER = 'The previous progress update was already delivered and has been repeated. Continue the task using tools. Send another progress update only for a new finding, failure, blocker, or phase change; do not repeat the plan. Keep the final answer complete and follow any explicit user request to repeat or quote text.';

export function initialState(duplicates = {}) {
  return { turn: 0, lastHash: '', lastText: '', originalId: '', originalSeq: -1, repeated: false, reminded: false, allowRepeat: false, duplicates };
}

function explicitlyRequestsRepetition(message) {
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  return /(?:请|再|原样)(?:重复|复述)|(?:重复|复述)(?:一遍|以下|这段|原文)|(?:每次|每步|每一步).{0,24}(?:说|输出|汇报)|\b(?:please repeat|repeat (?:the following|this|exactly|verbatim)|restate (?:this|the)|quote verbatim|(?:each|every) (?:step|time|tool call).{0,32}(?:say|repeat))\b/i.test(text);
}

export function foldProgress(state, event) {
  if (event.type === 'turn/start') return { ...initialState(state.duplicates), turn: event.data.turn };
  if (event.type === 'user/message') {
    if (event.data.source?.kind === 'progress-guard') return state.reminded ? state : { ...state, reminded: true };
    if (event.data.source?.kind !== 'user') return state;
    return { ...state, lastHash: '', lastText: '', originalId: '', originalSeq: -1, repeated: false, allowRepeat: explicitlyRequestsRepetition(event.data) };
  }
  if (event.type !== 'assistant/message' || event.data.turn !== state.turn || event.data.interrupted) return state;
  const message = event.data.message;
  const content = message.content;
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
  const intermediate = content.some(block => block.type === 'tool-call');
  // Short acknowledgements and structured output are not progress reports.
  if (!intermediate || content.some(block => !['text', 'reasoning', 'tool-call'].includes(block.type))) {
    return { ...state, lastHash: '', lastText: '', originalId: '', originalSeq: -1, repeated: false };
  }
  if (text === '') return state;
  if (state.allowRepeat || text.length < 40 || text.length > 2000 || text.includes('```')) {
    return { ...state, lastHash: '', lastText: '', originalId: '', originalSeq: -1, repeated: false };
  }
  const hash = createHash('sha256').update(text).digest('hex');
  if (hash !== state.lastHash) return { ...state, lastHash: hash, lastText: text, originalId: message.id, originalSeq: event.seq, repeated: false };
  return {
    ...state,
    repeated: true,
    duplicates: { ...state.duplicates, [message.id]: { originalId: state.originalId, originalSeq: state.originalSeq } },
  };
}

/** Buffer only a possible repeat; divergent, final and interrupted replies pass through unchanged. */
export async function* filterRepeatedProgressStream(stream, previousText, onDrop) {
  if (!previousText || previousText.length < 40 || previousText.length > 2000) { yield* stream; return; }
  const buffered = [];
  let candidate = true, text = '', textBlocks = 0, hasTool = false;
  const flush = async function* () { while (buffered.length) yield buffered.shift(); };
  for await (const chunk of stream) {
    if (!candidate) { yield chunk; continue; }
    buffered.push(chunk);
    if (chunk.type === 'block-start') {
      if (chunk.blockType === 'text') textBlocks++;
      else if (chunk.blockType === 'tool-call') hasTool = true;
      else if (chunk.blockType !== 'reasoning') candidate = false;
    } else if (chunk.type === 'text-delta') {
      text += chunk.text;
      if (!previousText.startsWith(text.trimEnd())) candidate = false;
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      if (textBlocks === 0) textBlocks = 1;
      text = chunk.block.text;
      if (!previousText.startsWith(text.trimEnd())) candidate = false;
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') hasTool = true;
    else if (chunk.type === 'block-end' && !['text', 'reasoning'].includes(chunk.block?.type)) candidate = false;
    else if (chunk.type === 'tool-call-delta') hasTool = true;
    if (textBlocks > 1) candidate = false;
    if (chunk.type === 'finish') {
      if (candidate && hasTool && chunk.reason?.kind === 'tool-calls' && textBlocks === 1 && text.trim() === previousText) {
        for (const pending of buffered) {
          if (pending.type === 'text-delta') continue;
          if (pending.type === 'block-start' && pending.blockType === 'text') continue;
          if (pending.type === 'block-end' && pending.block?.type === 'text') continue;
          yield pending;
        }
        onDrop?.();
      } else yield* flush();
      candidate = false;
      continue;
    }
    if (!candidate) yield* flush();
  }
  if (candidate) yield* flush();
}
