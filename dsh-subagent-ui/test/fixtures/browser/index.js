export const inject = ['agents', 'llm', 'sessionController', 'subagents', 'workspaceController']

const PARENT_A = 'session-ui-smoke-parent-a'
const PARENT_B = 'session-ui-smoke-parent-b'
const CHILD_A = 'session-ui-smoke-child-a'
const PROVIDER = 'ui-smoke'
const MODEL = 'ui-smoke-never'

async function* pendingStream(options) {
  const signal = options?.signal
  if (!signal) return new Promise(() => {})
  await new Promise(resolve => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', resolve, { once: true })
  })
}

const adapter = {
  providerInfo: provider => ({ id: provider, name: 'UI smoke' }),
  providerRetryPolicy: () => undefined,
  listModels: async provider => [{ provider, id: MODEL, name: 'UI smoke (no external requests)', inputModalities: ['text'] }],
  resolveModel: async (provider, model) => ({ provider, id: model, name: 'UI smoke (no external requests)', inputModalities: ['text'], context: { contextWindow: 128000 } }),
  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: pendingStream }
  },
  stream: pendingStream,
}

export async function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const { workspace } = await ctx.workspaceController.create({ path: process.cwd() })
  await ctx.sessionController.create({ workspaceId: workspace.workspaceId, sessionId: PARENT_A })
  await ctx.sessionController.create({ workspaceId: workspace.workspaceId, sessionId: PARENT_B })
  const parent = ctx.agents.get(PARENT_A)
  const parentB = ctx.agents.get(PARENT_B)
  if (!parent || !parentB) throw new Error('browser fixture parents are not live')
  await ctx.sessionController.prompt({
    sessionId: PARENT_A,
    requestId: 'ui-smoke-parent-a-prompt',
    content: [{ type: 'text', text: 'UI smoke parent A' }],
  }, new AbortController().signal)
  await ctx.sessionController.prompt({
    sessionId: PARENT_B,
    requestId: 'ui-smoke-parent-b-prompt',
    content: [{ type: 'text', text: 'UI smoke parent B' }],
  }, new AbortController().signal)
  await ctx.sessionController.rename({ sessionId: PARENT_A, title: 'UI smoke parent A' })
  await ctx.sessionController.rename({ sessionId: PARENT_B, title: 'UI smoke parent B' })
  await ctx.subagents.startActivation({
    provider: 'spawn',
    childId: CHILD_A,
    label: 'UI smoke child',
    request: {
      parent,
      prompt: [{ type: 'text', text: 'Hold the browser smoke child open.' }],
      agentOptions: { provider: PROVIDER, model: MODEL },
    },
    signal: new AbortController().signal,
  })
  await ctx.get('sessionPersistence')?.flush()
  console.log('subagent-ui browser fixture ready', { PARENT_A, PARENT_B, CHILD_A })
}
