import test from 'node:test';
import assert from 'node:assert/strict';
import { PageBridge, canonicalPageUrl } from '../page-bridge.js';

const page = (changes = {}) => ({ pageId: 'page-a', documentId: 'document-a', url: 'http://127.0.0.1:7692/', sessionId: 'session-task', graphRevision: 'graph-a', ready: true, ...changes });
const cancelled = () => new AbortController();

test('page URLs exclude credentials, query strings and fragments', () => {
  assert.equal(canonicalPageUrl('http://127.0.0.1:7692'), page().url);
  for (const url of ['https://user:secret@example.test/', 'http://localhost/?token=secret', 'file:///tmp/test', 'http://localhost/#secret']) assert.throws(() => canonicalPageUrl(url));
});

test('a different session on the requested page rejects reload without dispatch', async () => {
  const bridge = new PageBridge({ timeoutMs: 100, pollMs: 10 });
  const result = bridge.reload(page());
  assert.equal((await bridge.poll(page({ sessionId: 'session-other' }))).action, null);
  assert.equal((await result).code, 'PAGE_IDENTITY_CHANGED');
  bridge.dispose();
});

test('acknowledgement is not reload completion; a new matching document confirms it', async () => {
  const bridge = new PageBridge({ timeoutMs: 300, pollMs: 5 });
  let settled = false;
  const result = bridge.reload(page()).then(value => { settled = true; return value; });
  const action = await bridge.poll(page());
  assert.equal(action.action, 'reload');
  assert.equal(bridge.acknowledge({ requestId: action.requestId, page: page() }).accepted, true);
  await Promise.resolve();
  assert.equal(settled, false);
  const fresh = page({ pageId: 'page-b', documentId: 'document-b', graphRevision: 'graph-b' });
  await bridge.poll({ ...fresh, receipt: { requestId: action.requestId, previousPageId: 'page-a', previousDocumentId: 'document-a' } });
  assert.deepEqual(await result, { status: 'reloaded', requestId: action.requestId, page: fresh });
  bridge.dispose();
});

test('plugin remount in the same document cannot masquerade as a page refresh', async () => {
  const bridge = new PageBridge({ timeoutMs: 60, pollMs: 5 });
  const result = bridge.reload(page());
  const action = await bridge.poll(page());
  bridge.acknowledge({ requestId: action.requestId, page: page() });
  await bridge.poll({ ...page({ pageId: 'page-b' }), receipt: { requestId: action.requestId, previousPageId: 'page-a', previousDocumentId: 'document-a' } });
  assert.equal((await result).code, 'RELOAD_NOT_CONFIRMED');
  bridge.dispose();
});

test('a session or graph change before acknowledgement prevents refresh', async () => {
  const bridge = new PageBridge({ timeoutMs: 100, pollMs: 5 });
  const result = bridge.reload(page());
  const action = await bridge.poll(page());
  assert.equal(bridge.acknowledge({ requestId: action.requestId, page: page({ graphRevision: 'changed' }) }).accepted, false);
  assert.equal((await result).code, 'PAGE_IDENTITY_CHANGED');
  bridge.dispose();
});

test('a click is identity-bound, needs completion after acknowledgement and rejects replay', async () => {
  const bridge = new PageBridge({ timeoutMs: 100, pollMs: 5 });
  let settled = false;
  const pending = bridge.click(page(), { selector: '.trigger', elementToken: 'token-a' }).then(value => { settled = true; return value; });
  const command = await bridge.poll(page());
  assert.equal(command.action, 'click');
  assert.equal(command.element.elementToken, 'token-a');
  assert.equal(bridge.acknowledge({ requestId: command.requestId, page: page() }).accepted, true);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(bridge.acknowledge({ requestId: command.requestId, page: page(), completed: true }).accepted, true);
  assert.equal((await pending).status, 'clicked');
  assert.equal(bridge.acknowledge({ requestId: command.requestId, page: page(), completed: true }).accepted, false);
  bridge.dispose();
});

test('a cancelled click distinguishes a queued request from an in-flight execution grant', async () => {
  const bridge = new PageBridge({ timeoutMs: 100 });
  const early = new AbortController();
  const queued = bridge.click(page(), { selector: '.trigger', elementToken: 'token-a' }, { signal: early.signal });
  early.abort();
  assert.equal((await queued).mayHaveExecuted, false);
  const late = new AbortController();
  const executing = bridge.click(page(), { selector: '.trigger', elementToken: 'token-a' }, { signal: late.signal });
  const command = await bridge.poll(page());
  const grant = bridge.acknowledge({ requestId: command.requestId, page: page() });
  assert.ok(grant.expiresAt >= Date.now());
  late.abort();
  assert.equal((await executing).mayHaveExecuted, true);
  bridge.dispose();
});

test('cancellation and disposal release pending requests without a reload command', async () => {
  const bridge = new PageBridge({ timeoutMs: 100, pollMs: 5 });
  const controller = cancelled();
  const result = bridge.reload(page(), { signal: controller.signal });
  controller.abort();
  assert.equal((await result).code, 'CANCELLED');
  assert.equal((await bridge.poll(page())).action, null);
  const waiting = bridge.reload(page());
  bridge.dispose();
  assert.equal((await waiting).code, 'DISPOSED');
});
