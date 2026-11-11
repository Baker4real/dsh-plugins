import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { PageBridge, registerPageRoutes } from '../page-bridge.js';

const script = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const url = 'http://127.0.0.1:9999/';
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function channel(bridge) {
  const routes = new Map();
  const dispose = registerPageRoutes({ fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } }, bridge);
  return { routes, dispose };
}
function boot({ routes, sessionStorage, ready = true, reload = () => {}, afterAck, onPoll }) {
  const state = { ready, sessionId: 'session-task', x: 5, clicks: 0 };
  const providers = new Map(), cleanups = [];
  let declaration;
  const effect = action => { const cleanup = action(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup; };
  const ctx = {
    get(key) {
      return ({
        modules: { manifest: { modules: [{ id: '@fixture/ui', rev: 'rev-a' }] }, entries: { state: { getSnapshot: () => ({ syncing: false, failures: [] }) } } },
        sessions: { list: { getSnapshot: () => ({ byId: { [state.sessionId]: { id: state.sessionId, retainedBy: { mainView: 1 } } } }) } },
        layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
      })[key];
    },
    slots: { onEntryError: () => () => {}, entriesOfSlot: () => [] },
    effect,
    inject: (_keys, action) => action({ effect, cordisInspect: { register(provider) { providers.set(provider.manifest.id, provider); return () => {}; } } }),
  };
  const element = { getBoundingClientRect: () => ({ left: state.x, top: 5, width: 20, height: 20 }), getAttribute: () => null, click: () => { state.clicks++; }, contains: () => false };
  const document = { get readyState() { return state.ready ? 'complete' : 'loading'; }, querySelectorAll: selector => selector === '.trigger' ? [element] : [], elementFromPoint: () => element };
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { declaration = value; } }, sessionStorage, location: { origin: 'http://127.0.0.1:9999', pathname: '/', href: url, reload } },
    document, URL, AbortController, setTimeout, clearTimeout, getComputedStyle: () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto' }),
    async fetch(path, options) {
      const input = JSON.parse(options.body);
      if (path.endsWith('/poll')) onPoll?.(input);
      const requestUrl = new URL(path, url);
      const route = routes.get(requestUrl.pathname);
      if (!route) return new Response(null, { status: 404 });
      const response = await route.fetch(new Request(requestUrl, options));
      if (!path.endsWith('/ack')) return response;
      return { ok: response.ok, async json() { const data = await response.json(); afterAck?.(); return data; } };
    },
  };
  vm.runInNewContext(script, sandbox);
  declaration.factory().apply(ctx);
  return { state, inspect: (selector) => providers.get('Page').query('inspect', { url, sessionId: state.sessionId, ...(selector ? { selector } : {}) }), dispose: () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); } };
}

test('the real Client loop confirms a new document after its first receipt is not ready', async t => {
  const bridge = new PageBridge({ timeoutMs: 500, pollMs: 800 });
  const transport = channel(bridge), shared = storage();
  let first, fresh, reloads = 0, sawUnreadyReceipt = false;
  t.after(async () => { first?.dispose(); fresh?.dispose(); await transport.dispose(); bridge.dispose(); });
  first = boot({ ...transport, sessionStorage: shared, reload() {
    reloads++;
    first.dispose();
    fresh = boot({ ...transport, sessionStorage: shared, ready: false, onPoll(input) {
      if (input.receipt && !input.ready) { sawUnreadyReceipt = true; fresh.state.ready = true; }
    } });
  } });
  const before = await first.inspect();
  const result = await bridge.reload(before.page);
  assert.equal(reloads, 1);
  assert.equal(sawUnreadyReceipt, true);
  assert.equal(result.status, 'reloaded');
  assert.notEqual(result.page.documentId, before.page.documentId);
});

test('disposing after acknowledgement JSON resolves prevents the final Client side effect', async t => {
  const bridge = new PageBridge({ timeoutMs: 80, pollMs: 100 });
  const transport = channel(bridge);
  let client, reloads = 0;
  t.after(async () => { client?.dispose(); await transport.dispose(); bridge.dispose(); });
  client = boot({ ...transport, sessionStorage: storage(), reload: () => { reloads++; }, afterAck: () => client.dispose() });
  const current = await client.inspect();
  const result = await bridge.reload(current.page);
  assert.equal(result.status, 'unverified');
  assert.equal(reloads, 0);
});

test('the authenticated Client activates the inspected element exactly once', async t => {
  const bridge = new PageBridge({ timeoutMs: 200, pollMs: 10 });
  const transport = channel(bridge);
  const client = boot({ ...transport, sessionStorage: storage() });
  t.after(async () => { client.dispose(); await transport.dispose(); bridge.dispose(); });
  const before = await client.inspect('.trigger');
  assert.equal(typeof before.element.token, 'string');
  const result = await bridge.click(before.page, { selector: '.trigger', elementToken: before.element.token });
  assert.equal(result.status, 'clicked');
  assert.equal(client.state.clicks, 1);
});

test('layout or session changes after acknowledgement prevent the Client click', async t => {
  for (const change of ['layout', 'session']) {
    const bridge = new PageBridge({ timeoutMs: 80, pollMs: 10 });
    const transport = channel(bridge);
    let client;
    client = boot({ ...transport, sessionStorage: storage(), afterAck() { if (change === 'layout') client.state.x += 20; else client.state.sessionId = 'different'; } });
    t.after(async () => { client.dispose(); await transport.dispose(); bridge.dispose(); });
    const before = await client.inspect('.trigger');
    const result = await bridge.click(before.page, { selector: '.trigger', elementToken: before.element.token });
    assert.notEqual(result.status, 'clicked');
    assert.equal(client.state.clicks, 0);
    client.dispose(); await transport.dispose(); bridge.dispose();
  }
});

test('connection route re-registration restores the channel without reviving cancelled operations', async () => {
  const bridge = new PageBridge({ timeoutMs: 100, pollMs: 5 });
  const first = channel(bridge);
  await first.dispose();
  const target = { pageId: 'page-a', documentId: 'document-a', url, sessionId: 'session-task', graphRevision: 'graph-a', ready: true };
  assert.equal((await bridge.reload(target)).code, 'PAGE_CHANNEL_UNAVAILABLE');
  const second = channel(bridge);
  const waiting = bridge.reload(target);
  assert.equal((await bridge.poll(target)).action, 'reload');
  await second.dispose();
  assert.equal((await waiting).code, 'CHANNEL_DISCONNECTED');
  bridge.dispose();
});
