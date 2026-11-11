import { createHash } from 'node:crypto';

export const BLOCKED_CITATION = '（引用未验证，已拦截）';
export const REPAIR_REQUEST = '上一条回复包含没有对应工具来源的引用标记，已被拦截。请只重写受影响的解释或结论，引用本会话实际获取的来源 URL；没有来源就明确说明未验证。不要重做已成功的写操作，也不要编造引用 ID。';
const PREFIX = '\uE200cite';
const END = '\uE201';
const SEPARATOR = '\uE202';
const SOURCE_TOOLS = new Set(['web_fetch', 'web_search']);
// Mirrors GenUI 0.15.0 fence-language.ts; Markdown separates language from info metadata.
function isVisibleUiFence(info) {
  const language = info.trim().split(/\s+/, 1)[0] ?? '';
  return language.replace(/[>`"'.,;:)\]】」』]+$/, '').trim().toLowerCase() === 'dsh-ui';
}

export function citationSource(input) {
  const parsed = new URL(input);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Citation sources require credential-free HTTP(S) URLs');
  const url = parsed.href;
  return { id: 'web' + createHash('sha256').update(url).digest('hex').slice(0, 16), url };
}

export function initialSources() { return { calls: {}, sources: {}, turn: 0, repairRequested: false }; }

/** Pure session projection: webpage prose never creates a source registration. */
export function foldSources(state, event) {
  if (event.type === 'turn/start') return { ...state, turn: event.data.turn, repairRequested: false };
  if (event.type === 'user/message' && event.data.source?.kind === 'citation-source-guard') return { ...state, repairRequested: true };
  if (event.type === 'tool/call') {
    const { callId, name } = event.data;
    if (!SOURCE_TOOLS.has(name) || typeof callId !== 'string') return state;
    return { ...state, calls: { ...state.calls, [callId]: name } };
  }
  if (event.type !== 'tool/result') return state;
  const message = event.data?.message;
  const callId = message?.source?.callId ?? message?.toolCallId ?? event.data?.callId;
  if (!SOURCE_TOOLS.has(state.calls[callId])) return state;
  const calls = { ...state.calls };
  delete calls[callId];
  const sources = { ...state.sources };
  const metadata = event.data?.meta?.agentReliability;
  if (!message?.isError && metadata?.version === 1 && Array.isArray(metadata.sources)) {
    for (const item of metadata.sources.slice(0, 32)) {
      try {
        const source = citationSource(item.url);
        if (source.id === item.id) sources[source.id] = source.url;
      } catch { /* Malformed provenance is not a source. */ }
    }
  }
  return { ...state, calls, sources };
}

/** Keeps only an incomplete marker (at most 4 KiB), not an entire response. */
function textFilter(sources, onInvalid) {
  let pending = '', dropping = false, line = '', fence = null;
  function observe(text) {
    for (const char of text) {
      if (char === '\n') {
        const match = /^ {0,3}(`{3,}|~{3,})([^\r]*)$/.exec(line);
        if (match) {
          if (fence && match[1][0] === fence.char && match[1].length >= fence.size && !match[2].trim()) fence = null;
          else if (!fence) fence = { char: match[1][0], size: match[1].length, exempt: !isVisibleUiFence(match[2]) };
        }
        line = '';
      } else if (line.length < 2048) line += char;
    }
    return text;
  }
  function reject(reason) {
    onInvalid?.({ reason });
    return observe(BLOCKED_CITATION);
  }
  return {
    push(text, final = false) {
      pending += text;
      let output = '';
      while (pending) {
        if (dropping) {
          const end = pending.indexOf(END);
          if (end < 0) { pending = ''; break; }
          pending = pending.slice(end + 1);
          dropping = false;
          continue;
        }
        const start = pending.indexOf('\uE200');
        if (start < 0) { output += observe(pending); pending = ''; break; }
        if (start > 0) { output += observe(pending.slice(0, start)); pending = pending.slice(start); }
        if (pending.length < PREFIX.length && PREFIX.startsWith(pending) && !final) break;
        if (!pending.startsWith(PREFIX)) { output += observe(pending[0]); pending = pending.slice(1); continue; }
        const end = pending.indexOf(END, PREFIX.length);
        if (end < 0) {
          if (pending.length > 4096 || final) {
            output += reject(final ? 'unterminated-citation' : 'oversized-citation');
            dropping = !final;
            pending = '';
          }
          break;
        }
        const marker = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        if (fence?.exempt) { output += observe(marker); continue; }
        const ids = marker.slice(PREFIX.length, -1).split(SEPARATOR);
        const references = ids.shift() === '' && ids.length > 0 && ids.length <= 16 && ids.every(id => typeof sources[id] === 'string') ? ids : null;
        if (!references) { output += reject('unknown-source'); continue; }
        const links = [...new Set(references)].map(id => `[来源](${sources[id].replaceAll('(', '%28').replaceAll(')', '%29')})`).join('');
        output += observe(links);
      }
      return output;
    },
  };
}

/** Native llm/stream seam; opaque replay/usage/reasoning/tool chunks pass through. */
export async function* guardCitationStream(stream, sources, onInvalid) {
  const texts = new Map();
  function stateOf(index) {
    if (!texts.has(index)) texts.set(index, { filter: textFilter(sources, onInvalid), raw: '', rendered: '' });
    return texts.get(index);
  }
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      const state = stateOf(chunk.index);
      state.raw += chunk.text;
      const text = state.filter.push(chunk.text);
      state.rendered += text;
      if (text) yield { ...chunk, text };
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      const state = stateOf(chunk.index);
      if (state.raw && state.raw !== chunk.block.text) throw new Error('Citation guard: final text differs from streamed text');
      const tail = state.filter.push(state.raw ? '' : chunk.block.text, true);
      state.rendered += tail;
      if (tail) yield { type: 'text-delta', index: chunk.index, text: tail };
      yield { ...chunk, block: { ...chunk.block, text: state.rendered } };
      texts.delete(chunk.index);
    } else if (chunk.type === 'finish') {
      // Some adapters finalize via finish without block-end. Do not leave buffered markers unexamined.
      for (const [index, state] of texts) {
        const tail = state.filter.push('', true);
        if (tail) yield { type: 'text-delta', index, text: tail };
      }
      texts.clear();
      yield chunk;
    } else yield chunk;
  }
  for (const [index, state] of texts) {
    const tail = state.filter.push('', true);
    if (tail) yield { type: 'text-delta', index, text: tail };
  }
}
