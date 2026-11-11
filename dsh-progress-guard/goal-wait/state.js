import { z } from 'zod';

export const SOURCE = 'local-goal-wait';
export const REF = z.object({ id: z.string().min(1).max(200), revision: z.number().int().positive().safe() }).strict();
export const WaitId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const WaitRecord = z.object({
  version: z.literal(1), sessionId: z.string().min(1).max(200), waitId: WaitId, goalRef: REF,
  reason: z.string().min(1).max(1000), action: z.string().min(1).max(1000), enteredAt: z.number().int().nonnegative().safe(),
  status: z.enum(['waiting', 'released', 'invalidated']), resolution: z.enum(['none', 'human', 'receipt', 'goal-changed', 'resume-failed']),
  receipt: z.object({ path: z.string().max(1000), expiresAt: z.number().int().nonnegative().safe(), status: z.enum(['observing', 'expired']) }).strict().nullable(),
}).strict();
const State = z.object({ sessionId: z.string(), goalRef: REF.nullable(), wait: WaitRecord.nullable(), usedWaitIds: z.array(WaitId) }).strict();
export const sameRef = (a, b) => a != null && b != null && a.id === b.id && a.revision === b.revision;

export const waitProjection = {
  key: 'localGoalWait', stateVersion: 2, stateSchema: State,
  init: header => ({ sessionId: header.id, goalRef: null, wait: null, usedWaitIds: [] }),
  apply(state, event) {
    if (event.type === 'goal/change') {
      const change = event.data;
      const goalRef = change.operation === 'clear' ? null : { id: change.goal.id, revision: change.goal.revision };
      const stale = state.wait?.status === 'waiting' && !sameRef(state.wait.goalRef, goalRef);
      return { ...state, goalRef, wait: stale ? { ...state.wait, status: 'invalidated', resolution: 'goal-changed' } : state.wait };
    }
    if (event.type !== 'agent/inbox/spliced') return state;
    let next = state;
    for (const message of event.data.inserted) {
      if (message.source.kind !== SOURCE) continue;
      const parsed = WaitRecord.parse(message.source.record);
      const key = parsed.waitId.toLowerCase();
      // Remember inherited and obsolete identities as spent, without importing
      // a fork's wait authority or allowing case variants to replay a nonce.
      if (!next.usedWaitIds.includes(key)) next = { ...next, usedWaitIds: [...next.usedWaitIds, key] };
      if (parsed.sessionId !== state.sessionId || !sameRef(parsed.goalRef, state.goalRef)) continue;
      next = { ...next, wait: parsed };
    }
    return next;
  },
};
