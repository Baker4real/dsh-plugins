import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkManagedChatPatch } from '../scripts/chat-patch-gate.mjs';

const hash = text => createHash('sha256').update(text).digest('hex').toUpperCase();
const id = 'chat-final-reply-visibility';
const release = '0.0.0-fixture';
const baseSha256 = hash('official archive');
const appliedSha256 = hash('patched archive');

function fixture(t, bytes, overrides = {}) {
  const root = mkdtempSync(fileURLToPath(new URL('../.chat-patch-test-', import.meta.url)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const asarPath = join(root, 'archive.bin');
  const inventoryPath = join(root, 'local-patches.json');
  const definitionPath = join(root, 'current-definition.json');
  writeFileSync(asarPath, bytes);
  writeFileSync(inventoryPath, JSON.stringify({ schemaVersion: 1, patches: [{ id, definition: 'current-definition.json' }] }));
  writeFileSync(definitionPath, JSON.stringify({ id, release, baseSha256, appliedSha256, ...overrides }));
  return { asarPath, inventoryPath, definitionPath, hostVersion: release };
}

test('a registered applied archive passes for the exact Host release', t => {
  const args = fixture(t, 'patched archive');
  assert.deepEqual(checkManagedChatPatch(args), { id, release, appliedSha256 });
});

test('the registered base requires replay; other bytes report drift', t => {
  const args = fixture(t, 'official archive');
  assert.throws(() => checkManagedChatPatch(args), /replay-required: archive matches the registered base/);
  writeFileSync(args.asarPath, 'different archive');
  assert.throws(() => checkManagedChatPatch(args), /unknown-drift: archive [0-9A-F]{12} does not match registered [0-9A-F]{12}/);
});

test('an applied archive for a different registered release is refused', t => {
  const args = fixture(t, 'patched archive', { release: '0.0.0-other' });
  assert.throws(() => checkManagedChatPatch(args), /release mismatch \(Host 0\.0\.0-fixture, registered 0\.0\.0-other\)/);
});

test('missing inventory, definition or archive each names the missing input', t => {
  const args = fixture(t, 'patched archive');
  const readFails = (label, path) => ({ message: new RegExp(`^Cannot read managed Chat ${label} \\(ENOENT\\): `), path });
  for (const [label, path, input] of [
    ['inventory', `${args.inventoryPath}.missing`, { ...args, inventoryPath: `${args.inventoryPath}.missing` }],
    ['archive', `${args.asarPath}.missing`, { ...args, asarPath: `${args.asarPath}.missing` }],
    ['definition', `${args.definitionPath}.missing`, args],
  ]) {
    if (label === 'definition') {
      writeFileSync(args.inventoryPath, JSON.stringify({ schemaVersion: 1, patches: [{ id, definition: 'current-definition.json.missing' }] }));
    }
    const expected = readFails(label, path);
    assert.throws(() => checkManagedChatPatch(input), error =>
      expected.message.test(error.message) && error.message.includes(expected.path));
  }
});

test('a Chat marker regression reports test, file, line and a short message without dumping the bundle', t => {
  const root = mkdtempSync(fileURLToPath(new URL('../.chat-diagnostics-test-', import.meta.url)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src/client/chat'), { recursive: true });
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'src/client/chat/ChatNodeSeat.tsx'), 'data-chat-final-response={processAnswer || undefined}');
  const sentinel = 'CHAT_BUNDLE_BODY_MUST_NOT_BE_REPORTED';
  writeFileSync(join(root, 'lib/client.js'), `"data-chat-final-response":false;${sentinel.repeat(1000)}`);

  const env = { ...process.env, DSH_GOAL_WAIT_CHAT_PACKAGE: root, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [
    '--test', `--test-reporter=${new URL('../scripts/test-diagnostics.mjs', import.meta.url).href}`,
    '--test-reporter-destination=stdout', fileURLToPath(new URL('./chat-final-response-marker.test.js', import.meta.url)),
  ], { env, cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (child.error) throw child.error;
  assert.equal(child.status, 1);
  assert.ok(child.stdout.length < 700 && !child.stdout.includes(sentinel));
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.failed, 1);
  assert.equal(result.failures.length, 1);
  const [failure] = result.failures;
  assert.deepEqual(Object.keys(failure).sort(), ['file', 'line', 'message', 'test']);
  assert.equal(failure.file, 'tests/chat-final-response-marker.test.js');
  assert.ok(failure.test.includes('final-response inspection marker') && Number.isInteger(failure.line));
  assert.match(failure.message, /data-chat-final-response/);
  assert.ok(failure.message.length <= 190);
});
