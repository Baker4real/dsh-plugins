import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { initialSources, foldSources, guardCitationStream, REPAIR_REQUEST } from './citations.js';
import { createBoundedFetchTool, createProgressiveSkillTool, projectGenuiSkillValue } from './content-tools.js';
import { createExaSearchTool, initialSearchHealth } from './search.js';
import { completeSkillResult, createSkillReloadTool, projectLoadedSkill } from './skill-loading.js';
import { guardAskUserQuestion } from './question-guard.js';

export const inject = ['tools', 'agents', 'sessionProjections', 'cordisInspect'];
const stateSchema = z.object({ calls: z.record(z.string(), z.string()), sources: z.record(z.string(), z.string()), turn: z.number().int(), repairRequested: z.boolean() });

export async function apply(ctx) {
  const registry = await ctx.sessionProjections.register({ key: 'agentReliabilitySources', stateVersion: 1, stateSchema, init: initialSources, apply: foldSources });
  const health = initialSearchHealth();
  const installed = new Map();
  const repairs = new Map();
  const metrics = { checkedStreams: 0, blockedCitations: 0, repairRequests: 0, questionRejections: 0 };
  ctx.effect(() => ctx.tools.guard(exec => {
    const reason = guardAskUserQuestion(exec);
    if (reason) metrics.questionRejections++;
    return reason;
  }), 'agent-reliability: question schema guard');

  async function runConfiguredMcp(args, exec) {
    const name = 'mcp__magpie__call_tool';
    if (!ctx.tools.get(name, exec.agent, exec.toolSet)) throw new Error('Configured Magpie MCP tool is not available to this agent');
    const result = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: `reliability-${randomUUID()}`, name, arguments: JSON.stringify(args) }], signal: exec.signal, agent: exec.agent, toolSet: exec.toolSet, maxParallelToolCalls: 1 });
    for (const message of result.additionalContexts) exec.deferContext(message);
    const outcome = result.results[0]?.result;
    if (!outcome || outcome.isError) throw new Error(outcome?.error?.message ?? 'Configured search backend returned no result');
    return outcome.content;
  }

  function installAgent(agent) {
    if (installed.has(agent.id)) return;
    const wrapped = [];
    let effect;
    effect = agent.ctx.effect(() => {
      const disposers = [];
      try {
        for (const [name, wrap] of [
          ['web_fetch', createBoundedFetchTool],
          ['web_search', original => createExaSearchTool(original, runConfiguredMcp, health)],
        ]) {
          const original = agent.ctx.tools.get(name, agent);
          if (!original) continue;
          disposers.push(agent.ctx.tools.register(wrap(original)));
          wrapped.push(name);
        }
        // Keep the native skill object's identity: the upstream catalog uses it as its visibility gate.
        const nativeSkill = agent.ctx.tools.get('skill', agent);
        if (nativeSkill) {
          disposers.push(agent.ctx.tools.register(createSkillReloadTool(nativeSkill)));
          wrapped.push('skill_reload');
          const sections = createProgressiveSkillTool(nativeSkill);
          disposers.push(agent.ctx.tools.register({
            ...sections,
            name: 'genui_reference',
            description: 'Read GenUI reference sections after loading the genui skill. Choose core, all, charts, interaction, advanced, examples, or an upstream heading.',
            parameters: { type: 'object', properties: { section: { type: 'string', description: 'Reference section or all for the unchanged full upstream document.' } }, required: ['section'], additionalProperties: false },
            execute: (args, exec) => sections.execute({ name: 'genui', section: args.section }, exec),
            presentCall: args => ({ card: 'generic', title: 'GenUI 分段参考', kind: 'read', rawInput: args }),
          }));
          wrapped.push('genui_reference');
        }
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose();
        throw error;
      }
      return () => { for (const dispose of disposers.reverse()) dispose(); installed.delete(agent.id); repairs.delete(agent.id); };
    }, 'agent-reliability: scoped tools');
    installed.set(agent.id, { effect, wrapped });
  }
  ctx.on('agent/created', ({ agent }) => installAgent(agent));
  for (const agent of ctx.agents.list()) installAgent(agent);
  ctx.effect(() => () => { for (const item of [...installed.values()]) item.effect(); installed.clear(); repairs.clear(); }, 'agent-reliability: agent cleanup');

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (exec.name !== 'skill') return decision;
    const nativeSkill = exec.agent?.ctx.tools.get('skill', exec.agent, exec.toolSet);
    const projected = projectLoadedSkill(exec, result, decision, nativeSkill);
    if (projected !== decision) return projected;
    if (exec.name !== 'skill' || exec.arguments?.name !== 'genui' || result.isError || exec.signal?.aborted || decision.kind !== 'accept' || Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision;
    if (nativeSkill && !completeSkillResult(exec, result, nativeSkill)) return decision;
    const raw = result.value;
    if (raw?.name !== 'genui') return decision;
    return { ...decision, value: projectGenuiSkillValue(raw) };
  });

  ctx.on('llm/stream', async function* (options, next) {
    if (!isAgentLoopRequest(options)) { yield* next(); return; }
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : undefined;
    if (!agent) { yield* next(); return; }
    const state = registry.stateOf(agent.session);
    metrics.checkedStreams++;
    let rejected = 0, finish;
    async function* observeFinish() {
      for await (const chunk of next()) {
        if (chunk.type === 'finish') finish = chunk.reason?.kind;
        yield chunk;
      }
    }
    yield* guardCitationStream(observeFinish(), state.sources, () => { rejected++; metrics.blockedCitations++; });
    if (rejected && ['stop', 'tool-calls'].includes(finish) && !state.repairRequested && repairs.get(agent.id) !== state.turn && !options.signal?.aborted) {
      repairs.set(agent.id, state.turn);
      metrics.repairRequests++;
      agent.steer(createUserMessage({ source: { kind: 'citation-source-guard' }, content: [{ type: 'text', text: REPAIR_REQUEST }] }));
    }
  });

  ctx.effect(() => ctx.cordisInspect.register({
    manifest: {
      id: 'AgentReliability',
      description: 'Read-only status of source citation checks, bounded reading and the configured search route.',
      methods: [{ name: 'status', description: 'Report installed wrappers, per-session source counts and last search health without credentials.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, additionalProperties: false }, outputSchema: { description: 'Runtime status and bounded verification counters.' } }],
    },
    async query(method, input = {}) {
      if (method !== 'status') throw new Error('Unknown AgentReliability method');
      const agent = input.sessionId ? ctx.agents.get(input.sessionId) : undefined;
      const state = agent ? registry.stateOf(agent.session) : undefined;
      return {
        version: '1.0.3', citationStreamGuard: true, questionSchemaGuard: true, activeAgents: installed.size,
        wrappers: input.sessionId ? installed.get(input.sessionId)?.wrapped ?? [] : [...new Set([...installed.values()].flatMap(item => item.wrapped))],
        sourceCount: state ? Object.keys(state.sources).length : null,
        search: { ...health }, metrics: { ...metrics },
      };
    },
  }), 'agent-reliability: read-only status');
}
