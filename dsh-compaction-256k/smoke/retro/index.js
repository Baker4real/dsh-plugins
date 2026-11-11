import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

export const inject = ['tools', 'agents', 'agentLoop', 'agentPresets', 'sessionSkillCatalog', 'tokenMeter'];
const DIRECTORY = 'D:/agents/run-evidence/retro-improvements/20261111';
const MAIN = 'session-21b91010-0f59-4226-b882-441caf031515';
const body = result => (result?.content ?? []).map(block => block.type === 'text' ? block.text : '').join('\n');

export async function apply(ctx) {
  const report = { checkedAt: new Date().toISOString(), modelRequestMade: false, activeMain: false, checks: {} };
  const hmr = ctx.get('hmr');
  // Read-only version-specific diagnostic; never evict or mutate the loader cache.
  report.loadedEntryUrls = typeof hmr?.loadedUrls === 'function' ? [...hmr.loadedUrls()].filter(url => /(?:daily-update-guards|agent-reliability)\/(?:index|pwsh-guard|skill-loading)\.js/.test(url)).slice(0, 12) : [];
  const main = ctx.agents.get(MAIN);
  report.activeMain = !!main;
  if (main) report.mainTools = ctx.tools.schemas(main).filter(tool => ['pwsh', 'skill', 'skill_reload'].includes(tool.name)).map(tool => ({ name: tool.name, description: tool.description }));
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: randomUUID(),
    meta: { cwd: 'D:/agents/projects/dsh-plugins/dsh-compaction-256k', agentPreset: 'cordis' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'cordis'); },
  });
  const agent = handle.agent;
  const signal = AbortSignal.timeout(30000);
  let step = 0;
  try {
    agent.session.append('turn/start', { turn: 1 });
    async function run(name, args) {
      const number = ++step;
      agent.session.append('step/start', { turn: 1, step: number });
      const result = await ctx.tools.execute({
        agent, signal, log: { turn: 1, step: number }, maxParallelToolCalls: 1,
        calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }],
      });
      agent.session.append('step/end', { turn: 1, step: number });
      return result.results[0]?.result;
    }
    const native = ctx.tools.get('skill', agent);
    const schemas = ctx.tools.schemas(agent);
    report.skillReloadAvailable = schemas.some(tool => tool.name === 'skill_reload');
    report.skillCatalog = await ctx.sessionSkillCatalog.list({ sessionId: agent.id }, signal).then(value => ({ available: !!value, serializedCharacters: JSON.stringify(value).length }));
    if (report.skillReloadAvailable) {
      const first = await run('skill', { name: 'tdd' });
      const repeated = await run('skill', { name: 'tdd' });
      const reloaded = await run('skill_reload', { name: 'tdd' });
      report.checks.firstComplete = !first?.isError && body(first).includes('<skill_instructions>');
      report.checks.duplicateReceipt = !repeated?.isError && body(repeated).includes('already loaded');
      report.checks.reloadExact = !reloaded?.isError && body(reloaded) === body(first);
      report.checks.nativeIdentity = native === ctx.tools.get('skill', agent);
      report.characters = { first: body(first).length, duplicate: body(repeated).length, reloaded: body(reloaded).length };
      const quoteMessage = text => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
      report.heuristicTokens = {
        firstBody: ctx.tokenMeter.estimateMessage(quoteMessage(body(first))),
        duplicateBody: ctx.tokenMeter.estimateMessage(quoteMessage(body(repeated))),
        reloadSchema: ctx.tokenMeter.estimateMessage(quoteMessage(JSON.stringify(schemas.find(tool => tool.name === 'skill_reload')))),
        note: 'Service heuristic, not provider-reported billing tokens. No model request was sent.',
      };
    }
    const pwsh = ctx.tools.get('pwsh', agent);
    report.nativePreflightAdvertised = pwsh?.description?.includes('Direct gh calls with a separate --json') === true;
    if (report.nativePreflightAdvertised) {
      const rejected = await run('pwsh', { description: 'Check bad native arguments without executing gh', command: 'gh issue list --json number,title' });
      report.checks.nativeArgumentsRejected = !!rejected?.isError && /PWSH_PREFLIGHT_REJECTED|bare-comma-array/.test(body(rejected) + JSON.stringify(rejected?.error ?? {}));
      const accepted = await run('pwsh', { description: 'Verify the original command executor', command: "Write-Output 'RETRO-PREFLIGHT-OK'" });
      report.checks.originalExecutorPreserved = !accepted?.isError && body(accepted).includes('RETRO-PREFLIGHT-OK');
    }
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    report.status = report.skillReloadAvailable && report.nativePreflightAdvertised && Object.values(report.checks).every(Boolean) ? 'pass' : 'pending-runtime-reload';
  } catch (error) {
    report.status = 'fail';
    report.error = { name: error.name, message: String(error.message).slice(0, 500) };
  } finally {
    await handle.dispose();
    await mkdir(DIRECTORY, { recursive: true });
    await writeFile(`${DIRECTORY}/host-smoke.json`, JSON.stringify(report, null, 2) + '\n');
  }
}
