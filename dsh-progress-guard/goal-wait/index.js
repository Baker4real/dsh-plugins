import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { receiptMatches, receiptPath, receiptRoots } from './receipt.js';
import { HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SOURCE, WaitId, WaitRecord, sameRef, waitProjection } from './state.js';

export const name = 'goal-wait';
export const inject = ['agents', 'goals', 'sessions', 'sessionProjections', 'tools'];
const fail = (message, code = 'GOAL_WAIT_AUTHORITY_REQUIRED') => { throw new HarnessError(message, code); };

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
  const releasing = new Map();
  const pending = new Set();
  let stopping = false;
  const live = agent => agent !== undefined && !stopping && ctx.fiber.state === 2 && ctx.agents.get(agent.id) === agent;
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
    if (!ctx.agents.roots().includes(agent)) fail('Only a top-level agent may wait for human action.');
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
        // Human inputs already in either inbox own the next resumption edge.
        const human = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(m => m.source.kind === 'user');
        track(release(agent, human ? 'human' : 'receipt', wait.waitId));
        return;
      }
      observation.timer = setTimeout(poll, Math.min(pollMs, Math.max(1, wait.receipt.expiresAt - Date.now())));
    }
    ctx.agents.withoutInitiator(() => { observation.timer = setTimeout(poll, Math.min(pollMs, Math.max(1, wait.receipt.expiresAt - Date.now()))); });
  }
  async function release(agent, kind, waitId) {
    if (!live(agent) || !ctx.agents.roots().includes(agent)) return;
    const wait = stateOf(agent).wait;
    const goal = ctx.goals.get(agent);
    if (wait?.status !== 'waiting' || wait.waitId !== waitId || !sameRef(wait.goalRef, goal) || goal.phase !== 'active' || goal.activation !== 'disarmed') return;
    // Consume the exact token before any await, including competing human edges.
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
    if (!live(agent) || message.source.kind !== 'user' || !ctx.agents.roots().includes(agent)) return;
    if (![...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(m => m.id === message.id && m.source.kind === 'user')) return;
    const wait = stateOf(agent).wait;
    const claim = releasing.get(agent);
    if (claim && claim.waitId === wait?.waitId) claim.kind = 'human';
    if (wait?.status === 'waiting') return track(release(agent, 'human', wait.waitId));
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
      action: { type: 'string', required: true, description: 'The single action the human must perform; 1-1000 characters.' },
      receipt_path: { type: 'string', description: 'Optional absolute D-drive *.goal-wait.json file in configured receiptRoots; omit for human reply only. Fixed payload is version:1, waitId, goalId, revision, status:"ready".' },
      wait_id: { type: 'string', description: 'With receipt_path only: optional pre-generated UUID nonce already frozen by the receipt producer. Omit to generate one. Never reuse a nonce for another wait.' },
      receipt_timeout_seconds: { type: 'integer', description: 'With receipt_path only: 1 to configured maxReceiptSeconds (default cap 3600). Defaults to the smaller of 900 and that cap. Observation never survives plugin or agent reload.' },
    }, output,
    async execute(args, exec) {
      const agent = execution(exec);
      const goal = ctx.goals.get(agent);
      if (!goal || !sameRef(goal, { id: args.goal_id, revision: args.revision }) || goal.phase !== 'active') fail('Read the current active goal before entering a wait.', 'GOAL_WAIT_STALE_REF');
      authorized(agent, goal);
      if (args.wait_id !== undefined && (!args.receipt_path || !WaitId.safeParse(args.wait_id).success)) fail('wait_id requires receipt_path and a strict UUID nonce.', 'GOAL_WAIT_INVALID_RECEIPT');
      const state = stateOf(agent);
      if (state.wait?.status === 'waiting' && sameRef(state.wait.goalRef, goal)) {
        if (args.wait_id !== undefined && args.wait_id.toLowerCase() !== state.wait.waitId.toLowerCase()) fail('An existing wait cannot be replaced by another nonce.', 'GOAL_WAIT_ALREADY_WAITING');
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
      const wait = WaitRecord.parse({ version: 1, sessionId: agent.id, waitId: args.wait_id ?? randomUUID(), goalRef: { id: goal.id, revision: goal.revision }, reason: args.reason.trim(), action: args.action.trim(), enteredAt: now, status: 'waiting', resolution: 'none', receipt });
      ctx.goals.disarm(agent);
      record(agent, wait);
      await ctx.sessions.flush(agent.session);
      if (live(agent) && stateOf(agent).wait?.status === 'waiting' && sameRef(ctx.goals.get(agent), wait.goalRef)) {
        // A human may arrive after the model asks for action but before this
        // wait exists. Only unclaimed, currently pending input is considered;
        // the original task message has already left the inbox.
        const pendingHuman = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.source.kind === 'user');
        if (pendingHuman) await track(release(agent, 'human', wait.waitId));
        else if (receipt) observe(agent, wait);
      }
      exec.concludeTurn();
      return value(agent);
    },
  }));
  ctx.on('goal/changed', ({ agent }) => { if (observations.has(agent) && stateOf(agent).wait?.status !== 'waiting') stopObservation(agent); });
  ctx.on('agent/disposed', ({ agent }) => { stopObservation(agent); });
  ctx.effect(() => () => {
    stopping = true;
    for (const agent of observations.keys()) stopObservation(agent);
    return Promise.allSettled([...pending]);
  });
}
