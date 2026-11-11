import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { apply } from '../index.js';

// Canonical renderer shape verified in installed dsh-skill 0.2.2-rc.1 via SourceNav.
function renderSkill(_args, value) {
  return [{ type: 'text', text: `<skill_content name="${value.name}">\n<skill_resources>\nBase directory for this skill: ${value.resourceBase.path}\nResolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.\n</skill_resources>\n\n<skill_instructions>\n${value.content}\n</skill_instructions>\n</skill_content>` }];
}
const skill = (name = 'tdd', content = 'Run the red test, then implement.\r\nKeep the full instructions.\n') => ({ name, provider: 'fixture', resourceBase: { kind: 'directory', path: '/skills/' + name }, content });
const text = result => result.content.map(block => block.text ?? '').join('\n');

async function fixture(t, { seed, inheritedEventCount, projectResults } = {}) {
  const host = new Context();
  await host.plugin(SessionStore);
  if (projectResults) host.sessions.registerMessageProjection({ type: 'tool/result', project: projectResults });
  const hooks = new Map(), effects = [], scoped = new Map();
  const session = host.sessions.create('skill-session', { seed, inheritedEventCount, ...(inheritedEventCount > 0 ? { meta: { isSeeded: true, parentSession: 'fixture-parent' } } : {}) });
  const agent = { id: session.id, session };
  let value = skill(), body = async () => value, downstream = async () => ({ kind: 'accept' });
  let callNumber = 0;
  const nativeSkill = {
    name: 'skill', description: 'Load skill instructions.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { name: { type: 'string' }, provider: { type: 'string' }, resourceBase: { type: 'object' }, content: { type: 'string' } }, required: ['name', 'provider', 'content'] }, render: renderSkill },
    execute: (...args) => body(...args), isConcurrencySafe: () => true,
  };
  const tools = {
    get: name => scoped.get(name) ?? (name === 'skill' ? nativeSkill : undefined),
    executable: name => tools.get(name), checkGuards: () => undefined,
    register: tool => { assert.ok(!scoped.has(tool.name)); scoped.set(tool.name, tool); return () => scoped.delete(tool.name); },
  };
  const effect = callback => { const dispose = callback(); effects.push(dispose); return dispose; };
  agent.ctx = { tools, effect };
  const ctx = {
    tools, effect, on: (name, callback) => { hooks.set(name, callback); },
    agents: { list: () => [agent], get: id => id === agent.id ? agent : undefined },
    sessionProjections: { register: async definition => ({ stateOf: target => target.snapshotEvents().reduce(definition.apply, definition.init(target.header, target.inheritedEventCount)) }) },
    cordisInspect: { register: () => () => {} },
    waterfall: async (_target, name, ...args) => {
      const next = args.pop();
      const tail = name === 'tools/post-execute' ? () => downstream(...args) : next;
      return hooks.has(name) ? hooks.get(name)(...args, tail) : tail();
    },
    events: { dispatch: () => [] }, logger: { warn: message => assert.fail(message) },
  };
  await apply(ctx);
  const pipeline = new ToolExecutionPipeline(ctx);
  function startStep() {
    session.append('turn/start', { turn: ++callNumber });
    session.append('step/start', { turn: callNumber, step: 1 });
  }
  async function batch(names = ['skill'], { signal = new AbortController().signal, args } = {}) {
    startStep();
    const outcome = await executeToolBatch({ calls: names.map((name, index) => ({ type: 'tool-call', id: `call-${callNumber}-${index}`, name, arguments: JSON.stringify(args ?? { name: value.name }) })), signal, agent, log: { turn: callNumber, step: 1 }, maxParallelToolCalls: 2 }, pipeline, () => 2);
    session.append('step/end', { turn: callNumber, step: 1 });
    session.append('turn/end', { turn: callNumber, reason: { kind: 'completed' } });
    return outcome.results.map(item => item.result);
  }
  t.after(async () => { effects.reverse().forEach(dispose => dispose?.()); await host.fiber.dispose(); });
  return { host, ctx, agent, session, nativeSkill, tools, hooks, batch, call: async (name = 'skill', options) => (await batch([name], options))[0], setValue: next => { value = next; }, setBody: next => { body = next; }, setDecision: next => { downstream = next; }, inject: (content, source = { kind: 'user' }) => session.append('user/message', createUserMessage({ content, source }), { surfaceOp: 'append' }) };
}

test('first complete skill load is unchanged; a committed duplicate returns a brief fingerprint receipt', async t => {
  const f = await fixture(t);
  const first = await f.call();
  assert.equal(first.isError, false);
  assert.deepEqual(first.content, renderSkill({}, skill()));
  const repeated = await f.call();
  assert.equal(repeated.isError, false);
  assert.ok(text(repeated).length < text(first).length);
  assert.match(text(repeated), /already loaded.*current.*context/i);
  assert.match(text(repeated), /sha-?256.*[a-f0-9]{64}/i);
  assert.match(text(repeated), /skill_reload/);
  assert.equal(f.tools.get('skill'), f.nativeSkill);
});

test('explicit reload returns every original byte, including GenUI, and leaves native identity intact', async t => {
  const f = await fixture(t);
  await f.call();
  const reloaded = await f.call('skill_reload');
  assert.equal(reloaded.isError, false);
  assert.deepEqual(reloaded.content, renderSkill({}, skill()));
  f.setValue(skill('genui', '# Full GenUI\r\n## Advanced\r\nOriginal full instructions.\r\n'));
  const genui = await f.call('skill_reload');
  assert.equal(genui.isError, false);
  assert.deepEqual(genui.content, renderSkill({}, skill('genui', '# Full GenUI\r\n## Advanced\r\nOriginal full instructions.\r\n')));
  assert.equal(f.tools.get('skill'), f.nativeSkill);
  assert.deepEqual(f.tools.get('skill_reload').parameters, f.nativeSkill.parameters);
});

test('user and Harness skill_content injections deduplicate only the identical complete current body', async t => {
  const f = await fixture(t);
  f.inject(renderSkill({}, skill()), { kind: 'skill-invocation', name: 'tdd', form: 'instructions' });
  assert.match(text(await f.call()), /already loaded/);
  const next = skill('tdd', 'Updated instructions.\r\nWhitespace stays significant.\n');
  f.setValue(next);
  assert.deepEqual((await f.call()).content, renderSkill({}, next));
  assert.match(text(await f.call()), /already loaded/);
  f.setValue({ ...next, resourceBase: { kind: 'directory', path: '/another/workspace/tdd' } });
  assert.doesNotMatch(text(await f.call()), /already loaded/);
  f.setValue(skill('tdd', 'Exact user-pasted instructions.\n'));
  f.inject(renderSkill({}, skill('tdd', 'Exact user-pasted instructions.\n')));
  assert.match(text(await f.call()), /already loaded/);
});

test('failed, aborted and unknown outcomes cannot create a complete-load receipt', async t => {
  const f = await fixture(t);
  f.setBody(async () => { throw new Error('load failed'); });
  assert.equal((await f.call()).isError, true);
  f.setBody(async () => skill());
  const controller = new AbortController();
  f.setDecision(async () => { controller.abort(); return { kind: 'accept' }; });
  assert.equal((await f.call('skill', { signal: controller.signal })).isError, true);
  f.setDecision(async () => ({ kind: 'accept' }));
  f.setBody(async () => ({ content: skill().content }));
  assert.equal((await f.call()).isError, true);
  f.setBody(async () => skill());
  assert.deepEqual((await f.call()).content, renderSkill({}, skill()));
});

test('GenUI core and partial projections are never evidence of the complete upstream body', async t => {
  const f = await fixture(t);
  const full = skill('genui', '# GenUI\n## Charts\nFull chart guidance.\n## Advanced\nFull advanced guidance.\n');
  f.setValue(full);
  const first = await f.call();
  assert.match(text(first), /genui_reference/);
  assert.deepEqual((await f.call()).content, first.content);
  f.nativeSkill.projectContent = () => [{ type: 'text', text: '<skill_content name="genui">partial only</skill_content>' }];
  assert.match(text(await f.call()), /partial only/);
  delete f.nativeSkill.projectContent;
  const reload = await f.call('skill_reload');
  assert.deepEqual(reload.content, renderSkill({}, full));
  assert.match(text(await f.call()), /already loaded/);
});

test('waterfall content, value, block and additional-context decisions remain authoritative', async t => {
  const f = await fixture(t);
  await f.call();
  const context = createUserMessage({ content: [{ type: 'text', text: 'plugin context' }], source: { kind: 'fixture' } });
  f.setDecision(async () => ({ kind: 'accept', content: [{ type: 'text', text: 'other plugin content' }], additionalContexts: [context] }));
  const content = await f.call();
  assert.equal(text(content), 'other plugin content');
  assert.deepEqual(content.additionalContexts, [context]);
  f.setDecision(async () => ({ kind: 'accept', value: skill('tdd', 'Other plugin selected this version.'), additionalContexts: [context] }));
  const value = await f.call();
  assert.match(text(value), /Other plugin selected this version/);
  assert.deepEqual(value.additionalContexts, [context]);
  f.setDecision(async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'blocked by another plugin' }] }));
  const blocked = await f.call();
  assert.equal(blocked.isError, true);
  assert.equal(text(blocked), 'blocked by another plugin');
  f.setDecision(async () => ({ kind: 'accept', additionalContexts: [context] }));
  const receipt = await f.call();
  assert.match(text(receipt), /already loaded/);
  assert.deepEqual(receipt.additionalContexts, [context]);
});

test('overlapping native bodies deduplicate only after a preceding full result commits', async t => {
  const f = await fixture(t);
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  let started = 0;
  f.setBody(async () => { if (++started === 2) release(); await bothStarted; return skill(); });
  const results = await f.batch(['skill', 'skill']);
  assert.deepEqual(results[0].content, renderSkill({}, skill()));
  assert.match(text(results[1]), /already loaded/);
});

test('independent sessions stay isolated; resume and fork reconstruct receipts from their exact seed', async t => {
  const original = await fixture(t);
  await original.call();
  const independent = await fixture(t);
  assert.deepEqual((await independent.call()).content, renderSkill({}, skill()));
  const resumed = await fixture(t, { seed: original.session.snapshotEvents() });
  assert.match(text(await resumed.call()), /already loaded/);
  const fork = original.host.sessions.fork(original.session);
  const child = await fixture(t, { seed: fork.snapshotEvents(), inheritedEventCount: fork.inheritedEventCount });
  assert.match(text(await child.call()), /already loaded/);
  const beforeResult = original.session.snapshotEvents().find(event => event.type === 'tool/call').seq;
  const earlyFork = original.host.sessions.fork(original.session, beforeResult);
  const earlyChild = await fixture(t, { seed: earlyFork.snapshotEvents(), inheritedEventCount: earlyFork.inheritedEventCount });
  assert.deepEqual((await earlyChild.call()).content, renderSkill({}, skill()));
});

test('compaction replacement drops full-load evidence even when a short receipt remains in context', async t => {
  const f = await fixture(t);
  await f.call();
  await f.call();
  const first = f.session.snapshotEvents().find(event => event.type === 'tool/result');
  const retained = f.session.surface.nodes.filter(seq => seq !== first.seq);
  assert.ok(retained.length > 0);
  f.session.append('user/message', createUserMessage({ source: { kind: 'compaction' }, content: [{ type: 'text', text: 'Summary: tdd was used, but its body is no longer present.' }] }), { surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq }, sourceEventSeqs: [first.seq] });
  const compactedSeed = f.session.snapshotEvents();
  assert.deepEqual((await f.call()).content, renderSkill({}, skill()));
  const replayed = await fixture(t, { seed: compactedSeed });
  assert.deepEqual((await replayed.call()).content, renderSkill({}, skill()));
});

test('official Session message projections, rather than raw log content, determine complete-load evidence', async t => {
  const f = await fixture(t, { projectResults: event => new Map([[event.seq, { ...event.data.message, content: [{ type: 'text', text: 'Pruned: full skill content omitted.' }] }]]) });
  assert.deepEqual((await f.call()).content, renderSkill({}, skill()));
  assert.deepEqual((await f.call()).content, renderSkill({}, skill()));
  assert.ok(f.session.snapshotEvents().some(event => event.type === 'tool/result' && text(event.data.message).includes('<skill_instructions>')));
  assert.ok(f.session.deriveMessages().filter(message => message.role === 'tool').every(message => text(message).startsWith('Pruned:')));
});

test('quoted, incomplete and non-skill tool output cannot stand in for a native complete load', async t => {
  const f = await fixture(t);
  const full = renderSkill({}, skill())[0].text;
  for (const content of ['```text\n' + full + '\n```', full.slice(0, -16), '<skill_content name="tdd">partial</skill_content>', full.replace(skill().content, 'Only the first sentence.')]) f.inject([{ type: 'text', text: content }]);
  f.tools.register({ ...f.nativeSkill, name: 'read', execute: async () => skill() });
  assert.deepEqual((await f.call('read')).content, renderSkill({}, skill()));
  assert.deepEqual((await f.call()).content, renderSkill({}, skill()));
});

test('GenUI all remains complete evidence, while a same-version body newline change reloads', async t => {
  const f = await fixture(t);
  const full = skill('genui', '# GenUI\r\n## Charts\r\nAll chart instructions.\r\n');
  f.setValue(full);
  const all = await f.call('genui_reference', { args: { section: ' ALL ' } });
  assert.equal(all.isError, false);
  assert.deepEqual(all.content, renderSkill({}, full));
  assert.match(text(await f.call()), /already loaded/);
  f.setValue(skill());
  f.inject(renderSkill({}, skill()));
  const unix = skill('tdd', 'Run the red test, then implement.\nKeep the full instructions.\n');
  f.setValue(unix);
  assert.deepEqual((await f.call()).content, renderSkill({}, unix));
});
