import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function boot(location = { origin: 'http://127.0.0.1:7692', pathname: '/', href: 'http://127.0.0.1:7692/?token=SYNTHETIC_SECRET' }) {
  let declaration;
  const registrations = [];
  const state = { sessionId: 'session-task', activePanelId: null, revision: 'revision-a', expanded: 'false', left: 0, opacity: '1' };
  const element = { getBoundingClientRect: () => ({ left: state.left, top: 0, width: 20, height: 20 }), getAttribute: name => name === 'aria-expanded' ? state.expanded : null };
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { declaration = value; } }, location, innerWidth: 640, innerHeight: 480 },
    document: { readyState: 'complete', querySelectorAll: selector => selector === '.collapse' ? [element] : [] },
    TextEncoder, Uint8Array, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: state.opacity }),
  };
  const modules = { manifest: { get modules() { return [{ id: '@fixture/ui', rev: state.revision }]; } }, entries: { state: { getSnapshot: () => ({ syncing: false, failures: [] }) } } };
  const sessions = { list: { getSnapshot: () => ({ byId: { [state.sessionId]: { id: state.sessionId, retainedBy: { mainView: 1 } } } }) } };
  const ctx = {
    get(key) { return ({ modules, sessions, layout: { panelInfo: { getSnapshot: () => ({ activePanelId: state.activePanelId }) } } })[key]; },
    slots: { onEntryError: () => () => {}, entriesOfSlot: () => [] },
    effect: action => action(),
    inject: (_keys, action) => action({ effect: action => action(), cordisInspect: { register(provider) { registrations.push(provider); return () => {}; } } }),
  };
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
  declaration.factory().apply(ctx);
  return { provider: registrations.find(item => item.manifest.id === 'Page'), state };
}

test('Page inspection returns matching session, safe URL, document and module generations', async () => {
  const { provider } = await boot();
  assert.ok(provider, 'a read-only Page provider is registered');
  const result = await provider.query('inspect', { url: 'http://127.0.0.1:7692/', sessionId: 'session-task', selector: '.collapse', packageName: '@fixture/ui' });
  assert.equal(result.status, 'ready');
  assert.equal(result.page.sessionId, 'session-task');
  assert.equal(result.element.ariaExpanded, false);
  assert.equal(result.element.visible, true);
  assert.equal(result.modules[0].rev, 'revision-a');
  assert.ok(result.page.graphRevision.startsWith(result.page.pageId + ':graph:'));
  const repeated = await provider.query('inspect', { url: result.page.url, sessionId: result.page.sessionId });
  assert.equal(repeated.page.graphRevision, result.page.graphRevision);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
});

test('offscreen and transparent elements are not reported as visible results', async () => {
  const { provider, state } = await boot();
  const target = { url: 'http://127.0.0.1:7692/', sessionId: 'session-task', selector: '.collapse' };
  assert.equal((await provider.query('inspect', target)).element.visible, true);
  state.left = 10000;
  assert.equal((await provider.query('inspect', target)).element.visible, false);
  state.left = 0; state.opacity = '0';
  assert.equal((await provider.query('inspect', target)).element.visible, false);
});

test('a different session or page URL returns the connected origin and pathname only', async () => {
  const { provider } = await boot();
  const session = await provider.query('inspect', { url: 'http://127.0.0.1:7692/', sessionId: 'another-session' });
  assert.equal(session.status, 'mismatch');
  assert.equal(session.page.url, 'http://127.0.0.1:7692/');
  assert.deepEqual(JSON.parse(JSON.stringify(session.mismatch)), ['sessionId']);
  const url = await provider.query('inspect', { url: 'http://127.0.0.1:11288/', sessionId: 'session-task' });
  assert.equal(url.page.url, 'http://127.0.0.1:7692/');
  assert.deepEqual(JSON.parse(JSON.stringify(url.mismatch)), ['url']);
  assert.ok(!JSON.stringify(url).includes('SYNTHETIC_SECRET'));
  assert.equal(url.page.pageId, undefined);
});

test('strict queries reject the wrong responder so a matching connected page can answer', async () => {
  const { provider } = await boot();
  await assert.rejects(provider.query('inspect', { url: 'http://127.0.0.1:7692/', sessionId: 'another-session', requireMatch: true }), /PAGE_TARGET_MISMATCH/u);
  await assert.rejects(provider.query('inspect', { url: 'http://127.0.0.1:11288/', sessionId: 'session-task', requireMatch: true }), /PAGE_TARGET_MISMATCH/u);
});

test('a stale page identity does not reveal the new graph', async () => {
  const { provider, state } = await boot();
  const target = { url: 'http://127.0.0.1:7692/', sessionId: 'session-task' };
  const before = await provider.query('inspect', target);
  state.revision = 'revision-b';
  const stale = await provider.query('inspect', { ...target, pageId: before.page.pageId, graphRevision: before.page.graphRevision });
  assert.equal(stale.status, 'mismatch');
  assert.deepEqual(JSON.parse(JSON.stringify(stale.mismatch)), ['graphRevision']);
  assert.ok(!JSON.stringify(stale).includes('revision-b'));
  const other = await provider.query('inspect', { ...target, pageId: 'another-page' });
  assert.deepEqual(JSON.parse(JSON.stringify(other.mismatch)), ['pageId']);
  assert.equal(other.page.url, 'http://127.0.0.1:7692/');
});

test('session identity and selector state are sampled together without an await race', async () => {
  const { provider, state } = await boot();
  const pending = provider.query('inspect', { url: 'http://127.0.0.1:7692/', sessionId: 'session-task', selector: '.collapse' });
  state.sessionId = 'session-other';
  state.expanded = 'true';
  const output = await pending;
  assert.equal(output.page.sessionId, 'session-task');
  assert.equal(output.element.ariaExpanded, false);
});

test('a retained conversation hidden behind a global panel is not the active page session', async () => {
  const { provider, state } = await boot();
  state.activePanelId = 'settings';
  const hidden = await provider.query('inspect', { url: 'http://127.0.0.1:7692/', sessionId: 'session-task' });
  assert.equal(hidden.status, 'mismatch');
  assert.deepEqual(JSON.parse(JSON.stringify(hidden.mismatch)), ['sessionId']);
  assert.equal(hidden.page.url, 'http://127.0.0.1:7692/');
});

test('a non-http page returns its origin and pathname without the query secret', async () => {
  const { provider } = await boot({ origin: 'app://.', pathname: '/index.html', href: 'app://./index.html?token=SYNTHETIC_SECRET' });
  const result = await provider.query('inspect', { url: 'http://127.0.0.1:2462/', sessionId: 'session-task' });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.page.url, 'app://./index.html');
  assert.equal(result.page.pageId, undefined);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
});
