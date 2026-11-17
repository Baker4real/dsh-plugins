import { z } from 'zod';
import { initialState, foldOutcome } from './policy.js';

export const inject = ['sessionProjections'];

export async function apply(ctx) {
  await ctx.sessionProjections.register({
    key: 'failureStatusDot',
    stateVersion: 1,
    stateSchema: z.boolean(),
    init: initialState,
    apply: foldOutcome,
    wire: {
      viewSchema: z.boolean(),
      view: state => state,
      summary: true,
    },
  });
}
