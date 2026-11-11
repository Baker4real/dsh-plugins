import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LlmAdapter, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const inject = ['agentLoop', 'agentPresets', 'tools', 'llm', 'sessionProjections', 'clientModules'];
const ROOT = 'D:/agents/run-evidence/dsh-repeated-output/repair-20261109';
const PROGRESS = '已经定位到原始会话中的重复进度，接下来继续核对实际消息流与工具执行，并验证修复不会删除原文或重复执行工具。';

export async function apply(ctx) {
  await mkdir(ROOT, { recursive: true });
  const route = `progress-guard-smoke-${randomUUID()}`;
  const calls = [];
  const executions = [];
  class FakeAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 1000000, maxTokens: 4096 }; }
    async *stream(options) {
      if (!isAgentLoopRequest(options)) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Progress guard smoke' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const n = calls.length + 1;
      calls.push({ n, reminderCount: options.messages.filter(message => message.source?.kind === 'progress-guard').length, priorAssistantCount: options.messages.filter(message => message.role === 'assistant').length });
      const text = n <= 4 ? PROGRESS : 'Smoke verification complete.';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      if (n <= 4) {
        yield { type: 'block-start', index: 1, blockType: 'tool-call' };
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: `progress-smoke-call-${n}`, name: 'progress_guard_smoke_read', arguments: JSON.stringify({ n }) } };
      }
      yield { type: 'usage', usage: { inputTokens: 128, outputTokens: 32, totalTokens: 160 } };
      yield { type: 'finish', reason: { kind: n <= 4 ? 'tool-calls' : 'stop' } };
    }
  }
  const unregister = ctx.llm.registerAdapter([route], new FakeAdapter());
  let handle;
  const result = {
    status: 'fail', externalModelRequestMade: false, requests: calls, executions, uiVerified: false,
    clientGraph: ctx.clientModules.graph().entries.find(entry => entry.id === '@local/dsh-progress-guard') ?? null,
  };
  try {
    handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: randomUUID(),
      meta: { cwd: fileURLToPath(new URL('../', import.meta.url)), agentPreset: 'cordis' },
      agentOptions: { provider: route, model: 'fixture', maxTokens: 4096 },
      setup: async agentCtx => {
        await ctx.agentPresets.mount(agentCtx, 'cordis');
        agentCtx.tools.register(defineTool({
          name: 'progress_guard_smoke_read',
          description: 'Read a synthetic verification value; no file or network access.',
          parameters: { n: { type: 'number', required: true } },
          output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
          async execute({ n }) { executions.push(n); return n; },
          isConcurrencySafe: () => true,
        }));
      },
    });
    result.sessionId = handle.agent.id;
    handle.agent.followup({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the synthetic progress verification.' }] });
    let timer;
    try { await Promise.race([handle.agent.whenIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('smoke exceeded 20 seconds')), 20000); })]); }
    finally { clearTimeout(timer); }
    const session = handle.agent.session;
    const history = session.deriveMessages();
    const view = ctx.sessionProjections.snapshot(session, ['progressGuard']).values.progressGuard;
    const assistants = history.filter(message => message.role === 'assistant');
    result.duplicateCount = Object.keys(view?.duplicates ?? {}).length;
    result.reminderCount = history.filter(message => message.source?.kind === 'progress-guard').length;
    result.originalTextsPreserved = assistants.slice(0, 4).every(message => message.content.find(block => block.type === 'text')?.text === PROGRESS);
    result.finalAnswerPreserved = assistants.at(-1)?.content[0]?.text === 'Smoke verification complete.';
    result.status = calls.length === 5 && executions.join(',') === '1,2,3,4' && result.duplicateCount === 3 && result.reminderCount === 1 && result.originalTextsPreserved && result.finalAnswerPreserved && calls[2].reminderCount === 1 ? 'pass' : 'fail';
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await handle?.dispose();
    unregister();
    await writeFile(`${ROOT}/live-smoke.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  if (result.status !== 'pass') throw new Error(`Progress guard smoke failed; see ${ROOT}/live-smoke.json`);
}
