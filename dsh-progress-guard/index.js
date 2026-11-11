import { z } from 'zod';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { initialState, foldProgress, REMINDER } from './policy.js';

const duplicatesSchema = z.record(z.string(), z.object({ originalId: z.string(), originalSeq: z.number().int() }));
const stateSchema = z.object({
  turn: z.number().int(), lastHash: z.string(), originalId: z.string(), originalSeq: z.number().int(),
  repeated: z.boolean(), reminded: z.boolean(), allowRepeat: z.boolean(), duplicates: duplicatesSchema,
});

export const inject = ['sessionProjections'];

export async function apply(ctx) {
  const progress = await ctx.sessionProjections.register({
    key: 'progressGuard',
    stateVersion: 1,
    stateSchema,
    init: () => initialState(),
    apply: foldProgress,
    wire: {
      viewSchema: z.object({ duplicates: duplicatesSchema }),
      view: state => ({ duplicates: state.duplicates }),
      summary: false,
    },
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
