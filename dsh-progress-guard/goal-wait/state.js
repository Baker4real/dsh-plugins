import { z } from 'zod';

export const SOURCE = 'local-goal-wait';
export const REF = z.object({ id: z.string().min(1).max(200), revision: z.number().int().positive().safe() }).strict();
export const WaitId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const ReplyText = z.string().min(1).max(1000).refine(text => text.trim().length > 0);
export const WaitRecord = z.object({
  version: z.literal(1), sessionId: z.string().min(1).max(200), waitId: WaitId, goalRef: REF,
  reason: z.string().min(1).max(1000), action: z.string().min(1).max(1000), replyText: ReplyText.optional(), enteredAt: z.number().int().nonnegative().safe(),
  status: z.enum(['waiting', 'released', 'invalidated']), resolution: z.enum(['none', 'human', 'receipt', 'goal-changed', 'resume-failed']),
  receipt: z.object({ path: z.string().max(1000), expiresAt: z.number().int().nonnegative().safe(), status: z.enum(['observing', 'expired']) }).strict().nullable(),
}).strict();
const Notice = z.object({ turn: z.number().int().positive().safe(), action: z.string().min(1).max(1000) }).strict();
const State = z.object({
  sessionId: z.string(), goalRef: REF.nullable(), wait: WaitRecord.nullable(), usedWaitIds: z.array(WaitId),
  openTurn: Notice.shape.turn.nullable(), notice: Notice.nullable(),
}).strict();
export const sameRef = (a, b) => a != null && b != null && a.id === b.id && a.revision === b.revision;

export const waitProjection = {
  key: 'localGoalWait', stateVersion: 4, stateSchema: State,
  init: header => ({ sessionId: header.id, goalRef: null, wait: null, usedWaitIds: [], openTurn: null, notice: null }),
  wire: {
    viewSchema: Notice.nullable(),
    summary: false,
    view: state => state.notice?.turn === state.openTurn ? null : state.notice,
  },
  apply(state, event) {
    if (event.type === 'turn/start') return { ...state, openTurn: event.data.turn };
    if (event.type === 'turn/end') return state.openTurn === event.data.turn ? { ...state, openTurn: null } : state;
    if (event.type === 'goal/change') {
      const change = event.data;
      const goalRef = change.operation === 'clear' ? null : { id: change.goal.id, revision: change.goal.revision };
      const stale = state.wait?.status === 'waiting' && !sameRef(state.wait.goalRef, goalRef);
      return stale
        ? { ...state, goalRef, wait: { ...state.wait, status: 'invalidated', resolution: 'goal-changed' }, notice: null }
        : { ...state, goalRef };
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
      let notice = null;
      if (parsed.status === 'waiting') {
        if (parsed.waitId === next.wait?.waitId) notice = next.notice;
        else if (next.openTurn !== null) notice = { turn: next.openTurn, action: parsed.action };
      }
      next = { ...next, wait: parsed, notice };
    }
    return next;
  },
};
