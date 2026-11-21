import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { receiptMatches, receiptPath, receiptRoots } from './receipt.js';
import { HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ReplyText, SOURCE, WaitId, WaitRecord, sameRef, waitProjection } from './state.js';

export const name = 'goal-wait';
export const inject = ['agents', 'goals', 'sessions', 'sessionProjections', 'tools'];
const fail = (message, code = 'GOAL_WAIT_AUTHORITY_REQUIRED') => { throw new HarnessError(message, code); };

function matchesHumanReply(message, wait) {
  if (message.source.kind !== 'user') return false;
  if (wait.replyText === undefined) return true;
  const [block] = message.content;
  return message.content.length === 1 && block.type === 'text' && block.text === wait.replyText;
}

function hasPendingReply(agent, wait) {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => matchesHumanReply(message, wait));
}

export const Config = z.object({
  receiptRoots: z.array(z.string()).default([]),
  receiptPollMs: z.number().int().min(250).max(60000).default(1000),
  maxReceiptSeconds: z.number().int().min(1).max(3600).default(3600),
});

export async function apply(ctx, config = {}) {
  const roots = receiptRoots(config.receiptRoots ?? []);
  const pollMs = config.receiptPollMs ?? 1000;
  const maxSeconds = config.maxReceiptSeconds ?? 3600;
  if (!Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60000 || !Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 3600) throw new TypeError('Invalid bounded receipt configuration.');
  const handle = await ctx.sessionProjections.register(waitProjection);
  const observations = new Map();
  const waiting = new Map();
  const releasing = new Map();
  const pending = new Set();
  let stopping = false;
  const live = agent => agent !== undefined && !stopping && ctx.fiber.state === 2 && ctx.agents.get(agent.id) === agent;
  // DSH 0.2.2-rc.2 removed AgentRegistry.roots(); its upgrade guide selects ordinary agents by session origin,
  // which the subagent service already sets on rc.1 too.
  const topLevel = agent => agent.session.header.origin !== 'subagent';
  const stateOf = agent => handle.stateOf(agent.session);
  function value(agent) {
    const wait = stateOf(agent).wait;
    const observation = wait?.receipt === null || wait === null ? 'none' : observations.get(agent)?.waitId === wait.waitId ? 'observing' : wait.receipt.status === 'expired' ? 'expired' : 'suspended';
    return { goal: ctx.goals.get(agent) ?? null, wait, observation };
  }
  function stopObservation(agent) {
    const observation = observations.get(agent);
    if (!observation) return;
    clearTimeout(observation.timer);
    observations.delete(agent);
  }
  function track(promise) { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); return promise; }
  function execution(exec) {
    const agent = exec.agent;
    if (!live(agent) || agent.status !== 'running' || ctx.agents.currentInitiator() !== agent) fail('Goal wait tools require the exact live calling agent in its active driver.');
    return agent;
  }
  function authorized(agent, goal) {
    if (!topLevel(agent)) fail('Only a top-level agent may wait for human action.');
    const start = ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq;
    if (start === null) fail('A goal wait requires an open human turn or the exact current goal round.');
    const events = agent.session.snapshotEvents(start + 1);
    if (events.some(e => e.type === 'user/message' && (e.data.source.kind === 'user' || (e.data.source.kind === 'goal' && e.data.source.round > 0 && e.data.source.goalId === goal.id && e.data.source.revision === goal.revision && e.data.source.round === goal.roundsStarted)))) return;
    fail('A goal wait requires direct human input or the current authorized goal round.');
  }
  function record(agent, wait) {
    const parsed = WaitRecord.parse(wait);
    const message = createUserMessage({ source: { kind: SOURCE, record: parsed }, content: [{ type: 'text', text: 'Goal human-action wait state recorded.' }] });
    agent.inject(message);
    // Standard durable inbox operations retain the record in the log without
    // adding another model step or leaving stale control text in the inbox.
    agent.inbox.remove(message.id);
  }
  function observe(agent, wait) {
    const observation = { waitId: wait.waitId, timer: undefined, checks: 0 };
    observations.set(agent, observation);
    function poll() {
      if (!live(agent) || ctx.fiber.state !== 2 || observations.get(agent) !== observation) return;
      const current = stateOf(agent).wait;
      const goal = ctx.goals.get(agent);
      if (current?.status !== 'waiting' || current.waitId !== wait.waitId || !sameRef(goal, wait.goalRef) || goal.activation !== 'disarmed' || goal.phase !== 'active') { stopObservation(agent); return; }
      if (Date.now() >= wait.receipt.expiresAt || observation.checks >= 3600) {
        stopObservation(agent);
        record(agent, { ...current, receipt: { ...current.receipt, status: 'expired' } });
        track(ctx.sessions.flush(agent.session)).catch(() => ctx.logger.warn('goal-wait: receipt expiry checkpoint failed; the goal stays disarmed.'));
        return;
      }
      observation.checks += 1;
      if (receiptMatches(wait.receipt.path, wait)) {
        // An eligible human reply in either inbox takes precedence.
        track(release(agent, hasPendingReply(agent, current) ? 'human' : 'receipt', wait.waitId));
        return;
      }
      observation.timer = setTimeout(poll, Math.min(pollMs, Math.max(1, wait.receipt.expiresAt - Date.now())));
    }
    ctx.agents.withoutInitiator(() => { observation.timer = setTimeout(poll, Math.min(pollMs, Math.max(1, wait.receipt.expiresAt - Date.now()))); });
  }
  async function release(agent, kind, waitId) {
    if (!live(agent) || !topLevel(agent)) return;
    const wait = stateOf(agent).wait;
    const goal = ctx.goals.get(agent);
    if (wait?.status !== 'waiting' || wait.waitId !== waitId || !sameRef(wait.goalRef, goal) || goal.phase !== 'active' || goal.activation !== 'disarmed') return;
    // Consume the exact token before any await, including competing human edges.
    if (waiting.get(agent) === waitId) waiting.delete(agent);
    stopObservation(agent);
    const claim = { waitId, kind };
    releasing.set(agent, claim);
    record(agent, { ...wait, status: 'released', resolution: kind });
    try {
      await ctx.sessions.flush(agent.session);
      if (!live(agent)) return;
      if (claim.kind !== kind && sameRef(ctx.goals.get(agent), wait.goalRef)) {
        record(agent, { ...wait, status: 'released', resolution: claim.kind });
        await ctx.sessions.flush(agent.session);
      }
      if (!live(agent)) return;
      const current = ctx.goals.get(agent);
      if (!sameRef(current, wait.goalRef) || current.phase !== 'active' || current.activation !== 'disarmed') return;
      ctx.goals.resume(agent, wait.goalRef);
    } catch {
      if (live(agent) && sameRef(ctx.goals.get(agent), wait.goalRef)) {
        ctx.goals.disarm(agent);
        record(agent, { ...wait, status: 'invalidated', resolution: 'resume-failed' });
      }
      ctx.logger.warn('goal-wait: resume failed; the goal remains disarmed.');
    } finally {
      if (releasing.get(agent) === claim) releasing.delete(agent);
    }
  }
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!live(agent) || message.source.kind !== 'user' || !topLevel(agent)) return;
    const wait = stateOf(agent).wait;
    if (!wait || ![...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(m => m.id === message.id && matchesHumanReply(m, wait))) return;
    const claim = releasing.get(agent);
    if (claim?.waitId === wait.waitId) claim.kind = 'human';
    if (wait.status === 'waiting') return track(release(agent, 'human', wait.waitId));
  });
  const output = { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] };
  ctx.tools.register(defineTool({
    name: 'get_goal_wait', description: 'Read this session\'s persisted human-action wait and current goal.', parameters: {}, output,
    execute: (_args, exec) => Promise.resolve(value(execution(exec))),
  }));
  ctx.tools.register(defineTool({
    name: 'wait_goal', description: 'When only a human action remains, tell the user that action, then preserve the goal and stop automatic continuation until a top-level human reply or registered receipt. Ends this turn.',
    parameters: {
      goal_id: { type: 'string', required: true, description: 'Current goal id.' },
      revision: { type: 'integer', required: true, description: 'Exact current goal revision.' },
      reason: { type: 'string', required: true, description: 'Concrete reason that only a human action remains; 1-1000 characters.' },
      action: { type: 'string', required: true, description: 'One self-contained action for the human to take. Name what to do, where to do it and how to tell it is done. 1-1000 characters.' },
      reply_text: { type: 'string', description: 'Optional non-blank reply text (1-1000 characters). Tell the user to send it as the entire plain-text message. Only an exact match or a verified receipt releases this wait.' },
      receipt_path: { type: 'string', description: 'Optional absolute D-drive *.goal-wait.json file in configured receiptRoots; omit for human reply only. Fixed payload is version:1, waitId, goalId, revision, status:"ready".' },
      wait_id: { type: 'string', description: 'With receipt_path only: optional pre-generated UUID nonce already frozen by the receipt producer. Omit to generate one. Never reuse a nonce for another wait.' },
      receipt_timeout_seconds: { type: 'integer', description: 'With receipt_path only: 1 to configured maxReceiptSeconds (default cap 3600). Defaults to the smaller of 900 and that cap. Observation never survives plugin or agent reload.' },
    }, output,
    async execute(args, exec) {
      const agent = execution(exec);
      const goal = ctx.goals.get(agent);
      if (!goal || !sameRef(goal, { id: args.goal_id, revision: args.revision }) || goal.phase !== 'active') fail('Read the current active goal before entering a wait.', 'GOAL_WAIT_STALE_REF');
      authorized(agent, goal);
      if (args.reply_text !== undefined && !ReplyText.safeParse(args.reply_text).success) fail('reply_text must contain 1-1000 characters and cannot be blank.', 'GOAL_WAIT_INVALID_REPLY');
      if (args.wait_id !== undefined && (!args.receipt_path || !WaitId.safeParse(args.wait_id).success)) fail('wait_id requires receipt_path and a strict UUID nonce.', 'GOAL_WAIT_INVALID_RECEIPT');
      const state = stateOf(agent);
      if (state.wait?.status === 'waiting' && sameRef(state.wait.goalRef, goal)) {
        if (args.wait_id !== undefined && args.wait_id.toLowerCase() !== state.wait.waitId.toLowerCase()) fail('An existing wait cannot be replaced by another nonce.', 'GOAL_WAIT_ALREADY_WAITING');
        if (args.reply_text !== undefined && args.reply_text !== state.wait.replyText) fail('An existing wait cannot change its reply text.', 'GOAL_WAIT_ALREADY_WAITING');
        waiting.set(agent, state.wait.waitId);
        exec.concludeTurn();
        return value(agent);
      }
      if (args.wait_id !== undefined && state.usedWaitIds.includes(args.wait_id.toLowerCase())) fail('This wait nonce has already been used in this session history.', 'GOAL_WAIT_NONCE_REUSED');
      if (goal.activation !== 'armed') fail('Waiting cannot grant authority to a disarmed goal.', 'GOAL_WAIT_DISARMED');
      const seconds = args.receipt_timeout_seconds ?? Math.min(900, maxSeconds);
      if (args.receipt_timeout_seconds !== undefined && !args.receipt_path) fail('receipt_timeout_seconds requires receipt_path.', 'GOAL_WAIT_INVALID_RECEIPT');
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maxSeconds) fail('Receipt timeout exceeds the configured bound.', 'GOAL_WAIT_INVALID_RECEIPT');
      const now = Date.now();
      const receipt = args.receipt_path ? { path: receiptPath(args.receipt_path, roots), expiresAt: now + seconds * 1000, status: 'observing' } : null;
      const wait = WaitRecord.parse({
        version: 1, sessionId: agent.id, waitId: args.wait_id ?? randomUUID(), goalRef: { id: goal.id, revision: goal.revision },
        reason: args.reason.trim(), action: args.action.trim(), enteredAt: now, status: 'waiting', resolution: 'none', receipt,
        ...(args.reply_text === undefined ? {} : { replyText: args.reply_text }),
      });
      waiting.set(agent, wait.waitId);
      ctx.goals.disarm(agent);
      record(agent, wait);
      await ctx.sessions.flush(agent.session);
      if (live(agent) && stateOf(agent).wait?.status === 'waiting' && sameRef(ctx.goals.get(agent), wait.goalRef)) {
        // The human may reply before the wait exists. Only unclaimed input
        // can match; the original task message has already left the inbox.
        if (hasPendingReply(agent, wait)) await track(release(agent, 'human', wait.waitId));
        else if (receipt) observe(agent, wait);
      }
      exec.concludeTurn();
      return value(agent);
    },
  }));
  ctx.on('goal/changed', ({ agent }) => {
    const wait = stateOf(agent).wait;
    if (observations.has(agent) && wait?.status !== 'waiting') stopObservation(agent);
    const waitId = waiting.get(agent);
    if (!waitId || wait?.waitId !== waitId || wait.status !== 'invalidated' || wait.resolution !== 'goal-changed') return;
    // A host/UI resume or edit invalidates the old wait. Do not let that same
    // edge immediately arm automatic work or retain a round already queued.
    // Removing this one active-wait marker still permits a later explicit
    // resume of the new revision; the wait is not a permanent goal lock.
    waiting.delete(agent);
    const goal = ctx.goals.get(agent);
    if (goal?.id === wait.goalRef.id && goal.phase === 'active' && goal.activation === 'armed') ctx.goals.disarm(agent);
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (message.source.kind === 'goal' && message.source.goalId === wait.goalRef.id) agent.inbox.remove(message.id);
    }
  });
  ctx.on('agent/disposed', ({ agent }) => { waiting.delete(agent); stopObservation(agent); });
  ctx.effect(() => () => {
    stopping = true;
    for (const agent of observations.keys()) stopObservation(agent);
    return Promise.allSettled([...pending]);
  });
}
