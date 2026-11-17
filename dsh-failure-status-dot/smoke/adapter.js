import { setTimeout as delay } from 'node:timers/promises';

export function createAdapter() {
  const model = (provider, id) => ({
    provider, id, name: 'Local indicator acceptance fixture',
    inputModalities: ['text'], context: { contextWindow: 32768 },
  });
  async function* stream(options) {
    await delay(300, undefined, { signal: options.signal });
    if (options.model === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code: 'INDICATOR_SMOKE_FAILURE', status: 400, message: '受控验收失败，无外部请求',
      } } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '受控验收成功，无外部请求' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '受控验收成功，无外部请求' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  return {
    providerInfo: provider => ({ id: provider, name: 'Failure indicator local smoke' }),
    providerRetryPolicy: () => undefined,
    listModels: async provider => ['error', 'success'].map(id => model(provider, id)),
    resolveModel: async (provider, id) => model(provider, id),
    prepareCall: async (provider, id) => ({ model: model(provider, id), stream }),
    stream,
  };
}
