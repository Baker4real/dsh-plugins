/**
 * Reclassifies truncated OpenAI SDK SSE/NDJSON framing syntax errors that
 * pi-ai flattens to non-retryable PI_AI_ERROR into retryable TRANSPORT errors,
 * letting @deepseek-ai/dsh-llm-retry handle bounded recovery under the
 * provider's own retryPolicy.
 */

const TRUNCATED_SSE_JSON_PATTERN = /^Error reading response: malformed (?:server-sent event|newline-delimited) JSON\.?$/i;

export function isTruncatedSseJsonFailure(failure) {
  if (!failure || typeof failure !== 'object') return false;
  if (failure.code !== 'PI_AI_ERROR') return false;
  if (typeof failure.status === 'number' && failure.status >= 400 && failure.status < 500) return false;
  if (typeof failure.message !== 'string') return false;
  return TRUNCATED_SSE_JSON_PATTERN.test(failure.message.trim());
}

export function reclassifyTruncatedSseFailure(chunk, signal) {
  if (signal?.aborted) return chunk;
  if (chunk?.type !== 'finish' || chunk.reason?.kind !== 'error') return chunk;
  const failure = chunk.reason.failure;
  if (!isTruncatedSseJsonFailure(failure)) return chunk;
  return {
    ...chunk,
    reason: {
      ...chunk.reason,
      failure: {
        ...failure,
        code: 'TRANSPORT',
      },
    },
  };
}

export async function* recoverTruncatedSseStream(stream, signal, onReclassified) {
  for await (const chunk of stream) {
    const nextChunk = reclassifyTruncatedSseFailure(chunk, signal);
    if (nextChunk !== chunk) onReclassified?.(nextChunk.reason.failure);
    yield nextChunk;
  }
}
