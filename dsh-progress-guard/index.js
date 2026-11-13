import { z } from 'zod';
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { initialState, foldProgress, filterRepeatedProgressStream, REMINDER } from './policy.js';

const duplicatesSchema = z.record(z.string(), z.object({ originalId: z.string(), originalSeq: z.number().int() }));
const stateSchema = z.object({
  turn: z.number().int(), lastHash: z.string(), lastText: z.string(), originalId: z.string(), originalSeq: z.number().int(),
  repeated: z.boolean(), reminded: z.boolean(), allowRepeat: z.boolean(), duplicates: duplicatesSchema,
});

export const inject = ['sessionProjections', 'agents'];

export async function apply(ctx) {
  const progress = await ctx.sessionProjections.register({
    key: 'progressGuard',
    stateVersion: 2,
    stateSchema,
    init: () => initialState(),
    apply: foldProgress,
    wire: {
      viewSchema: z.object({ duplicates: duplicatesSchema }),
      view: state => ({ duplicates: state.duplicates }),
      summary: false,
    },
  });
  ctx.on('llm/stream', async function* (options, next) {
    if (!isAgentLoopRequest(options) || !options.sessionId) { yield* next(); return; }
    const agent = ctx.agents.get(options.sessionId);
    if (!agent) { yield* next(); return; }
    const state = progress.stateOf(agent.session);
    if (state.allowRepeat) { yield* next(); return; }
    yield* filterRepeatedProgressStream(next(), state.lastText);
  });
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const state = progress.stateOf(agent.session);
    if (state.turn !== turn || !state.repeated || state.reminded || state.allowRepeat) return decision;
    if (decision.messages.some(message => message.source?.kind === 'user')) return decision;
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        source: { kind: 'progress-guard' },
        content: [{ type: 'text', text: REMINDER }],
      })],
    };
  });
}
