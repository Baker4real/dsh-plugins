import { createHash } from 'node:crypto';

export const REMINDER = 'The previous progress update was already delivered and has been repeated. Continue the task using tools. Send another progress update only for a new finding, failure, blocker, or phase change; do not repeat the plan. Keep the final answer complete and follow any explicit user request to repeat or quote text.';

export function initialState(duplicates = {}) {
  return { turn: 0, lastHash: '', originalId: '', originalSeq: -1, repeated: false, reminded: false, allowRepeat: false, duplicates };
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
    return { ...state, lastHash: '', originalId: '', originalSeq: -1, repeated: false, allowRepeat: explicitlyRequestsRepetition(event.data) };
  }
  if (event.type !== 'assistant/message' || event.data.turn !== state.turn || event.data.interrupted) return state;
  const message = event.data.message;
  const content = message.content;
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
  const intermediate = content.some(block => block.type === 'tool-call');
  // Short acknowledgements and structured output are not progress reports.
  if (!intermediate || content.some(block => !['text', 'reasoning', 'tool-call'].includes(block.type))) {
    return { ...state, lastHash: '', originalId: '', originalSeq: -1, repeated: false };
  }
  if (text === '') return state;
  if (state.allowRepeat || text.length < 40 || text.length > 2000 || text.includes('```')) {
    return { ...state, lastHash: '', originalId: '', originalSeq: -1, repeated: false };
  }
  const hash = createHash('sha256').update(text).digest('hex');
  if (hash !== state.lastHash) return { ...state, lastHash: hash, originalId: message.id, originalSeq: event.seq, repeated: false };
  return {
    ...state,
    repeated: true,
    duplicates: { ...state.duplicates, [message.id]: { originalId: state.originalId, originalSeq: state.originalSeq } },
  };
}
