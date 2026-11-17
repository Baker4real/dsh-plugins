import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

function preExecuteHandler(cwd = 'D:/agents/projects/misc') {
  let handler;
  const ctx = {
    workingDirectory: { get: () => cwd },
    on(event, callback) {
      assert.equal(event, 'tools/pre-execute');
      handler = callback;
    },
  };
  apply(ctx);
  return handler;
}

test('denies native grep below app.asar and names the supported source readers', async () => {
  const handler = preExecuteHandler();
  const decision = await handler({
    name: 'grep',
    arguments: {
      path: 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh',
      pattern: 'data-row-key',
    },
  }, async () => ({ kind: 'allow' }));

  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /SourceNav/);
  assert.match(decision.reason, /Source\.searchFile/);
});

test('denies relative glob paths when the session cwd is inside app.asar', async () => {
  const handler = preExecuteHandler('D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh');
  const decision = await handler({
    name: 'glob',
    agent: { session: 'session-test' },
    arguments: { path: '.', pattern: 'packages/*.js' },
  }, async () => ({ kind: 'allow' }));

  assert.equal(decision.kind, 'deny');
});

test('denies an omitted search path when the session cwd is inside app.asar', async () => {
  const handler = preExecuteHandler('D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh');
  const decision = await handler({
    name: 'grep',
    agent: { session: 'session-test' },
    arguments: { pattern: 'SourceNav' },
  }, async () => ({ kind: 'allow' }));

  assert.equal(decision.kind, 'deny');
});

test('allows native search in ordinary source directories', async () => {
  const handler = preExecuteHandler();
  const decision = await handler({
    name: 'grep',
    arguments: { path: 'D:/agents/projects/dsh-plugins', pattern: 'SourceNav' },
  }, async () => ({ kind: 'allow' }));

  assert.equal(decision.kind, 'allow');
});

test('keeps the existing skills-root write guard active', async () => {
  const handler = preExecuteHandler();
  const decision = await handler({
    name: 'write',
    arguments: {
      file_path: 'D:/agents/skills-manager/skills/example/SKILL.md',
      content: 'candidate',
    },
  }, async () => ({ kind: 'allow' }));

  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /install-skill-guarded\.cmd/);
});

test('does not replace a downstream denial', async () => {
  const handler = preExecuteHandler();
  const downstream = { kind: 'deny', reason: 'existing policy' };
  const decision = await handler({
    name: 'grep',
    arguments: { path: 'D:/tmp/app.asar/dsh', pattern: 'token' },
  }, async () => downstream);

  assert.equal(decision, downstream);
});
