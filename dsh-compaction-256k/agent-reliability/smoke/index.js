import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LlmAdapter, markAgentLoopRequest, BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm';

export const inject = ['agentLoop', 'agentPresets', 'sessionProjections', 'tools', 'llm', 'tokenMeter', 'skills'];
const resultPath = 'D:/agents/run-evidence/retro-improvements/20261110/host-smoke-result.json';
const url = 'https://usemagpie.ai/docs/start';
const sourceId = 'web' + createHash('sha256').update(url).digest('hex').slice(0, 16);
class SmokeAdapter extends LlmAdapter {
  async *stream(options) {
    options.signal?.throwIfAborted();
    const text = options.model === 'bad' ? 'Synthetic negative\uE200cite\uE202turnNotASource\uE201' : options.model === 'good' ? 'Synthetic positive\uE200cite\uE202' + sourceId + '\uE201' : 'Synthetic repair finished.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (let offset = 0; offset < text.length; offset += 3) yield { type: 'text-delta', index: 0, text: text.slice(offset, offset + 3) };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export async function apply(ctx) {
  const provider = 'local-reliability-smoke-' + randomUUID();
  const adapter = ctx.llm.registerAdapter([provider], new SmokeAdapter());
  const sessionId = 'session-reliability-smoke-' + randomUUID();
  let handle, report = { status: 'failed', sessionId, externalModelRequests: 0 };
  try {
    handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId, meta: { cwd: fileURLToPath(new URL('../../', import.meta.url)), agentPreset: 'cordis' },
      agentOptions: { provider, model: 'repair' },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'cordis'); },
    });
    const agent = handle.agent;
    const signal = AbortSignal.timeout(45000);
    const definitions = ctx.tools.schemas(agent);
    if (!definitions.find(tool => tool.name === 'web_fetch')?.parameters?.properties?.section || !definitions.some(tool => tool.name === 'genui_reference')) throw new Error('Fresh agent lacks section tooling');
    const nativeSkill = ctx.tools.get('skill', agent);
    const skillSnapshot = await ctx.skills.snapshot({ cwd: fileURLToPath(new URL('../../', import.meta.url)), scope: agent, signal });
    if (!skillSnapshot.skills.some(skill => skill.name === 'genui')) throw new Error('GenUI missing from native skill catalog');
    const call = async (name, args, log = false) => {
      const result = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }], signal, agent, ...(log ? { log: { turn: 1, step: 1 } } : {}) });
      const outcome = result.results[0]?.result;
      if (!outcome || outcome.isError) throw new Error(name + ': ' + JSON.stringify(outcome?.error));
      return outcome;
    };
    agent.session.append('turn/start', { turn: 1 });
    const fetched = await call('web_fetch', { url, section: 'FAQ', maxCharacters: 1200 }, true);
    async function stream(model) {
      const assembler = new BlockAssembler();
      const request = markAgentLoopRequest({ provider, model, messages: [], sessionId, signal });
      for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk);
      return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
    }
    const valid = await stream('good');
    if (!valid.includes('](https://usemagpie.ai/docs/start)') || valid.includes(sourceId)) throw new Error('Valid source was not resolved by the live waterfall');
    const invalid = await stream('bad');
    if (!invalid.includes('引用未验证') || invalid.includes('turnNotASource')) throw new Error('Invalid source survived the live waterfall');
    const core = await call('skill', { name: 'genui' });
    const full = await call('genui_reference', { section: 'all' });
    const advanced = await call('genui_reference', { section: 'charts' });
    const rawSkill = await ctx.skills.get('genui', { cwd: fileURLToPath(new URL('../../', import.meta.url)), scope: agent, signal });
    if (full.value?.content !== rawSkill.content) throw new Error('Full GenUI content differs from the upstream skill');
    if (!core.value?.content.includes('核心入口') || !advanced.value?.content.includes('echart')) throw new Error('Progressive GenUI sections are unavailable');
    if (ctx.tools.get('skill', agent) !== nativeSkill) throw new Error('Native skill identity changed');
    const estimate = content => ctx.tokenMeter.estimateMessage(createToolResultMessage({ callId: 'measurement', content: [{ type: 'text', text: content }] }));
    report = { ...report, status: 'passed', freshAgentTools: ['web_fetch', 'web_search', 'genui_reference'], skillCatalogEntries: skillSnapshot.skills.length, nativeSkillIdentityPreserved: true, registeredSourceVerifiedByStream: true, validCitationResolved: true, invalidCitationBlocked: true, fetchProjectionCharacters: [...fetched.value.projection].length, genui: { coreCharacters: [...core.value.content].length, fullCharacters: [...full.value.content].length, allMatchesUpstream: true, chartsLoaded: true, estimatedCoreTokens: estimate(core.value.content), estimatedFullTokens: estimate(full.value.content), measurement: 'Host TokenMeter heuristic; no external model request' } };
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  finally { if (handle) await handle.dispose(); adapter(); }
  await mkdir('D:/agents/run-evidence/retro-improvements/20261110', { recursive: true });
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (report.status !== 'passed') throw new Error('Reliability smoke failed: ' + report.error);
}
