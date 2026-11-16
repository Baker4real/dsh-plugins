import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
import { applyGlobTool, RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_META_MAX_BYTES, SEARCH_STDERR_MAX_BYTES, SEARCH_TIMEOUT_MS } from '@deepseek-ai/dsh-tool-fs-search';
import { apply } from '../index.js';

const text = result => result.content.map(block => block.text ?? '').join('\n');

async function fixture(t, { maxResults = 100 } = {}) {
  const root = await mkdtemp(join(process.cwd(), '.tool-behavior-'));
  const hooks = new Map(), definitions = new Map(), effects = [], spawns = [];
  const tools = {
    get: name => definitions.get(name), executable: name => definitions.get(name),
    register: definition => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); },
    guard: () => () => {}, checkGuards: () => undefined,
  };
  const agent = { id: 'tools-fixture', session: { header: { id: 'tools-fixture' } } };
  const spills = [];
  const effect = callback => { const dispose = callback(); effects.push(dispose); return dispose; };
  agent.ctx = { tools, effect };
  const ctx = {
    tools, effect, get: name => name === 'spillStore' ? { saveText: async input => { spills.push(input); return { locator: 'fixture/glob-results.txt', retrievalHint: 'Read the complete saved result.' }; } } : undefined,
    on: (name, callback) => { const listeners = hooks.get(name) ?? []; listeners.push(callback); hooks.set(name, listeners); },
    agents: { list: () => [agent], get: () => agent },
    sessionProjections: { register: async () => ({ stateOf: () => ({ sources: {} }) }) },
    cordisInspect: { register: () => () => {} },
    systemPrompt: { section: () => {}, getSectionOrder: () => 1 },
    workingDirectory: { ensure: async () => root },
    subprocess: { spawn: spec => {
      spawns.push(spec);
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, signal: spec.signal, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const done = new Promise((resolveDone, reject) => { child.on('error', reject); child.on('close', (exitCode, signal) => resolveDone({ exitCode, signal })); });
      return { done, collected: {
        stdout: { readFrom: () => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: false }) },
        stderr: { readFrom: () => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }) },
      } };
    } },
    waterfall: async (_scope, name, ...args) => {
      const tail = args.pop();
      const listeners = hooks.get(name) ?? [];
      const run = index => index < listeners.length ? listeners[index](...args, () => run(index + 1)) : tail();
      return run(0);
    },
    events: { dispatch: () => [] }, logger: { warn: message => assert.fail(message) },
  };
  applyGlobTool(ctx, { sampleOverCapGlobResults: false, maxResults, maxMetaBytes: SEARCH_META_MAX_BYTES, rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES, graceMs: SEARCH_GRACE_MS, stderrMaxBytes: SEARCH_STDERR_MAX_BYTES, timeoutMs: SEARCH_TIMEOUT_MS });
  const nativeGlob = tools.get('glob');
  // Native GenUI's public output contract is a string protocol (0.16.0).
  const nativeValidation = {
    name: 'validate_dsh_ui', description: 'Native validation fixture',
    parameters: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => '[genui-validation]\nstatus=valid\nrendered=1\nwarning=policy_truncated path="$.items[0].rows" detail="rows truncated to 50"\nnext=emit_fence\nreply_language=conversation\nnative_fence_json:\n```\n{"items":[{"type":"table","columns":["id"],"rows":[[1]]}],"children":[{"type":"text","text":"projection"}]}\n```',
  };
  tools.register(nativeValidation);
  await apply(ctx);
  const pipeline = new ToolExecutionPipeline(ctx);
  let id = 0;
  async function call(name, args, signal = new AbortController().signal) {
    const outcome = await executeToolBatch({ calls: [{ type: 'tool-call', id: `tools-${++id}`, name, arguments: JSON.stringify(args) }], signal, agent }, pipeline, () => 1);
    return outcome.results[0].result;
  }
  t.after(async () => { effects.reverse().forEach(dispose => dispose?.()); await rm(root, { recursive: true, force: true }); });
  return { root, ctx, tools, agent, nativeGlob, nativeValidation, call, hooks, spills, spawns };
}

test('explicit .git/config glob finds the requested metadata file through the actual tool pipeline', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.git'));
  await writeFile(join(f.root, '.git/config'), '[core]\nrepositoryformatversion=0\n');
  const result = await f.call('glob', { path: f.root, pattern: '.git/config' });
  assert.equal(result.isError, false, text(result));
  assert.match(text(result).replaceAll('\\', '/'), /^\.git\/config$/m);
  assert.equal(f.tools.get('glob'), f.nativeGlob);
  assert.match(result.additionalContexts?.map(message => message.content.map(block => block.text).join('\n')).join('\n') ?? '', /\.git file \(worktree\).*ALL fetch remotes/);
});

test('explicit .git/config is anchored to its search root when the session directory is a different subtree', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.git'));
  await mkdir(join(f.root, 'session-workspace'));
  await writeFile(join(f.root, '.git/config'), 'metadata');
  f.ctx.workingDirectory.ensure = async () => join(f.root, 'session-workspace');
  const result = await f.call('glob', { path: f.root, pattern: '.git/config' });
  assert.equal(result.isError, false, text(result));
  assert.equal(text(result).replaceAll('\\', '/'), join(f.root, '.git/config').replaceAll('\\', '/'));
});

test('truncated validation requires revalidation and retains diagnostics and native JSON verbatim', async t => {
  const f = await fixture(t);
  const args = { spec: { items: [{ type: 'table', columns: ['id'], rows: Array.from({ length: 51 }, (_, i) => [i + 1]) }] } };
  const raw = await f.nativeValidation.execute(args);
  const result = await f.call('validate_dsh_ui', args);
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /^next=fix_and_revalidate$/m);
  assert.match(text(result), /^status=valid$/m);
  assert.match(text(result), /^content_fidelity=not_preserved$/m);
  assert.equal(text(result).split('native_fence_json:')[1], raw.split('native_fence_json:')[1]);
  assert.match(text(result), /^warning=policy_truncated path="\$\.items\[0\]\.rows" detail="rows truncated to 50"$/m);
  assert.equal(f.tools.get('validate_dsh_ui'), f.nativeValidation);
});

test('ordinary glob still excludes VCS metadata; explicit .git leaves other VCS exclusions intact', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.git/.svn'), { recursive: true });
  await writeFile(join(f.root, '.git/config'), 'metadata');
  await writeFile(join(f.root, '.git/.svn/private'), 'metadata');
  await writeFile(join(f.root, 'visible.txt'), 'visible');
  const ordinary = await f.call('glob', { pattern: '**/*' });
  assert.equal(text(ordinary), 'visible.txt');
  assert.equal(ordinary.additionalContexts?.length ?? 0, 0);
  assert.equal(f.spawns.length, 1);
  assert.equal(text(await f.call('glob', { path: join(f.root, '.git'), pattern: '**/*' })).replaceAll('\\', '/'), '.git/config');
  assert.equal(f.tools.get('glob'), f.nativeGlob);
});

test('a worktree .git file is discoverable and an empty config search explains repository and remote scope', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.git'), 'gitdir: ../main/.git/worktrees/example\n');
  assert.equal(text(await f.call('glob', { pattern: '.git' })), '.git');
  const empty = await f.call('glob', { pattern: '.git/config' });
  assert.equal(empty.isError, false);
  assert.match(text(empty), /No files found/);
  assert.match(text(empty), /\.git file \(worktree\)/);
  assert.match(text(empty), /git remote -v.*ALL fetch remotes/);
  assert.match(text(empty), /do not narrow.*account-owned repositories/);
});

test('explicit multi-repository glob retains native capping, metadata and complete-result spill', async t => {
  const f = await fixture(t, { maxResults: 1 });
  for (const name of ['a', 'b']) {
    await mkdir(join(f.root, name, '.git'), { recursive: true });
    await writeFile(join(f.root, name, '.git/config'), 'metadata');
  }
  const result = await f.call('glob', { pattern: '**/.git/config' });
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /Showing 1 of 2 paths/);
  assert.match(text(result), /Full sorted result stored at: fixture\/glob-results.txt/);
  assert.equal(f.spills.length, 1);
  assert.deepEqual(new Set(f.spills[0].content.replaceAll('\\', '/').split('\n')), new Set(['a/.git/config', 'b/.git/config']));
  assert.ok(result.meta);
});

test('invalid or cancelled explicit Git searches fail instead of claiming an empty complete listing', async t => {
  const f = await fixture(t);
  const missing = await f.call('glob', { path: join(f.root, 'absent'), pattern: '.git/config' });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /search failed/i);
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.call('glob', { pattern: '.git/config' }, controller.signal)).isError, true);
});

test('clean and repairable validator results, including payload text mentioning truncation, pass through unchanged', async t => {
  const f = await fixture(t);
  for (const raw of [
    '[genui-validation]\nstatus=valid\nrendered=1\nnext=emit_fence\nreply_language=conversation',
    '[genui-validation]\nstatus=invalid\nerror=invalid_json\nrepair=applied\nnext=emit_repaired_fence\nreply_language=conversation\nrepaired_json:\n```\n{"items":[]}\n```',
    '[genui-validation]\nstatus=valid\nnext=emit_fence\nreply_language=conversation\nnative_fence_json:\n```\nwarning=policy_truncated\n```',
  ]) {
    f.nativeValidation.execute = async () => raw;
    assert.equal(text(await f.call('validate_dsh_ui', { spec: {} })), raw);
  }
});

test('truncated repaired JSON retains every repair byte and other warning fields while requiring correction', async t => {
  const f = await fixture(t);
  const raw = '[genui-validation]\nstatus=invalid\nerror=invalid_json\ndiagnostic="keep"\nwarning=policy_truncated path="items" detail="limit"\nwarning=unknown_field path="items[0].typo"\nrepair=applied\nrepair_count=1\nnext=emit_repaired_fence\nreply_language=conversation\nrepaired_json:\n```\n{"items":[]}\n```';
  f.nativeValidation.execute = async () => raw;
  const result = text(await f.call('validate_dsh_ui', { spec: {} }));
  assert.equal(result.split('repaired_json:')[1], raw.split('repaired_json:')[1]);
  assert.match(result, /^next=fix_and_revalidate$/m);
  for (const line of raw.split('\n').filter(line => /^(status|error|diagnostic|warning|repair)/.test(line))) assert.ok(result.includes(line));
});

test('other post-execute content, value, block and additional contexts retain their authority', async t => {
  const f = await fixture(t);
  let decision = { kind: 'accept' };
  f.ctx.on('tools/post-execute', async () => decision);
  const additionalContexts = [{ role: 'user', content: [{ type: 'text', text: 'downstream context' }], source: { kind: 'fixture' } }];
  decision = { kind: 'accept', additionalContexts };
  const projected = await f.call('validate_dsh_ui', { spec: {} });
  assert.match(text(projected), /^next=fix_and_revalidate$/m);
  assert.deepEqual(projected.additionalContexts, additionalContexts);
  decision = { kind: 'accept', content: [{ type: 'text', text: 'other policy content' }] };
  assert.equal(text(await f.call('validate_dsh_ui', { spec: {} })), 'other policy content');
  decision = { kind: 'accept', value: 'other policy value' };
  assert.equal(text(await f.call('validate_dsh_ui', { spec: {} })), 'other policy value');
  decision = { kind: 'block', feedback: [{ type: 'text', text: 'blocked by another policy' }] };
  assert.equal((await f.call('validate_dsh_ui', { spec: {} })).isError, true);
});

test('a later replacement definition retains its own validator result without native projection', async t => {
  const f = await fixture(t);
  const raw = await f.nativeValidation.execute({ spec: {} });
  f.tools.register({ ...f.nativeValidation, description: 'another plugin owns this definition' });
  assert.equal(text(await f.call('validate_dsh_ui', { spec: {} })), raw);
});

test('the explicit Git scan awaits cancellation and restores its caller signal on failure', async t => {
  const f = await fixture(t);
  f.nativeGlob.timeoutMs = 10;
  let settled = false;
  f.ctx.subprocess.spawn = spec => ({
    done: new Promise(resolveDone => spec.signal.addEventListener('abort', () => { settled = true; resolveDone({ exitCode: null, signal: 'SIGTERM' }); }, { once: true })),
    collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } },
  });
  const callerSignal = new AbortController().signal;
  const exec = { name: 'glob', arguments: { pattern: '.git/config' }, agent: f.agent, signal: callerSignal };
  const hook = f.hooks.get('tools/execute')[0];
  await assert.rejects(hook(exec, async () => ({ isError: false, value: { root: '.', paths: [] }, content: [] })), /aborted/i);
  assert.equal(settled, true);
  assert.equal(exec.signal, callerSignal);
});
