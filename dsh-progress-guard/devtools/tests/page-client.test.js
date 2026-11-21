import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPageTool } from '../page-tool.js';

function inspectPage(provider, options) {
  const tool = createPageTool({
    cordisInspect: { query: (_platform, _provider, method, input) => provider.query(method, input) },
    clientModules: { graph: () => ({ entries: [{ id: '@fixture/ui', rev: 'revision-a' }] }) },
  }, {});
  return tool.execute({ action: 'inspect', url: 'http://127.0.0.1:7692/', packageName: '@fixture/ui', ...options }, { agent: { id: 'session-task' } });
}

async function boot(location = { origin: 'http://127.0.0.1:7692', pathname: '/', href: 'http://127.0.0.1:7692/?token=SYNTHETIC_SECRET' }) {
  let declaration;
  const registrations = [];
  const listeners = new Map();
  const state = { sessionId: 'session-task', activePanelId: null, revision: 'revision-a', expanded: 'false', left: 0, opacity: '1', ambiguous: false, covered: false };
  const element = { getBoundingClientRect: () => ({ left: state.left, top: 0, width: 20, height: 20 }), getAttribute: name => name === 'aria-expanded' ? state.expanded : null };
  const sandbox = {
    window: {
      __ModuleLoader__: { load(value) { declaration = value; } },
      location, innerWidth: 640, innerHeight: 480,
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); },
    },
    document: {
      readyState: 'complete',
      querySelectorAll: selector => selector === '.collapse' ? (state.ambiguous ? [element, {}] : [element]) : [],
      elementFromPoint: x => x >= 0 && x < 640 ? (state.covered ? {} : element) : null,
    },
    TextEncoder, Uint8Array, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: state.opacity }),
  };
  const loadCache = new Map([['@fixture/ui', { id: '@fixture/ui' }]]);
  const modules = {
    manifest: { get modules() { return [{ id: '@fixture/ui', rev: state.revision }]; } },
    entries: { state: { getSnapshot: () => ({ syncing: false, failures: [] }) } },
    loadCache,
  };
  const sessions = { list: { getSnapshot: () => ({ byId: { [state.sessionId]: { id: state.sessionId, retainedBy: { mainView: 1 } } } }) } };
  const ctx = {
    get(key) { return ({ modules, sessions, layout: { panelInfo: { getSnapshot: () => ({ activePanelId: state.activePanelId }) } } })[key]; },
    slots: { onEntryError: () => () => {}, entriesOfSlot: () => [] },
    effect: action => action(),
    inject: (_keys, action) => action({ effect: action => action(), cordisInspect: { register(provider) { registrations.push(provider); return () => {}; } } }),
  };
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
  declaration.factory().apply(ctx);
  return { provider: registrations.find(item => item.manifest.id === 'Page'), state, listeners, loadCache };
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

test('dsh_page reports a loaded module and a mounted offscreen element without passing the assertion', async () => {
  const { provider, state } = await boot();
  state.left = 10000;
  const output = await inspectPage(provider, { selector: '.collapse' });
  assert.equal(output.status, 'ready');
  assert.equal(output.element.status, 'found');
  assert.equal(output.element.matches, 1);
  assert.equal(output.element.visible, false);
  assert.equal(output.element.hitTarget, false);
  assert.equal(output.verification.matchesAdvertisedModule, 'passed');
  assert.equal(output.verification.element, 'failed');
  assert.equal(output.verification.passed, false);
  assert.equal(output.verification.elementMounted, true);
  assert.equal(output.verification.elementVisibleInViewport, false);
  assert.equal(output.verification.moduleLoaded, true);
});

test('dsh_page passes the assertion for a unique visible and unobstructed match', async () => {
  const { provider } = await boot();
  const output = await inspectPage(provider, { selector: '.collapse' });
  assert.equal(output.element.matches, 1);
  assert.equal(output.element.hitTarget, true);
  assert.equal(output.verification.moduleLoaded, true);
  assert.equal(output.verification.matchesAdvertisedModule, 'passed');
  assert.equal(output.verification.elementMounted, true);
  assert.equal(output.verification.elementVisibleInViewport, true);
  assert.equal(output.verification.element, 'passed');
  assert.equal(output.verification.passed, true);
});

test('dsh_page leaves selector assertions unrequested when inspecting only a module', async () => {
  const { provider } = await boot();
  const output = await inspectPage(provider);
  assert.equal(output.element, undefined);
  assert.equal(output.verification.moduleLoaded, true);
  assert.equal(output.verification.matchesAdvertisedModule, 'passed');
  assert.equal(output.verification.elementMounted, null);
  assert.equal(output.verification.elementVisibleInViewport, null);
  assert.equal(output.verification.element, 'not-requested');
  assert.equal(output.verification.passed, true);
});

test('dsh_page distinguishes a matching Client manifest revision from module materialization', async () => {
  const { provider, loadCache } = await boot();
  loadCache.clear();
  const output = await inspectPage(provider);
  assert.equal(output.verification.moduleLoaded, false);
  assert.equal(output.verification.matchesAdvertisedModule, 'passed');
  assert.equal(output.verification.passed, true);
});

test('dsh_page reports multiple mounted matches without treating any as the asserted element', async () => {
  const { provider, state } = await boot();
  state.ambiguous = true;
  const output = await inspectPage(provider, { selector: '.collapse' });
  assert.equal(output.element.status, 'ambiguous');
  assert.equal(output.element.matches, 2);
  assert.equal(output.verification.elementMounted, true);
  assert.equal(output.verification.elementVisibleInViewport, null);
  assert.equal(output.verification.element, 'failed');
  assert.equal(output.verification.passed, false);
});

test('dsh_page preserves a failed assertion for a viewport-visible match whose hit target is covered', async () => {
  const { provider, state } = await boot();
  state.covered = true;
  const output = await inspectPage(provider, { selector: '.collapse' });
  assert.equal(output.element.hitTarget, false);
  assert.equal(output.verification.elementMounted, true);
  assert.equal(output.verification.elementVisibleInViewport, true);
  assert.equal(output.verification.element, 'failed');
  assert.equal(output.verification.passed, false);
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

test('active inspection atomically returns the current session without a caller session id', async () => {
  const { provider, state } = await boot();
  const first = await provider.query('inspect', { url: 'http://127.0.0.1:7692/', active: true });
  assert.equal(first.status, 'ready');
  assert.equal(first.page.sessionId, 'session-task');
  state.sessionId = 'session-next';
  const second = await provider.query('inspect', { url: 'http://127.0.0.1:7692/', active: true });
  assert.equal(second.page.sessionId, 'session-next');
  assert.notEqual(second.page.sessionId, first.page.sessionId);
});

test('active inspection reports not-ready when no main session is active', async () => {
  const { provider, state } = await boot();
  state.activePanelId = 'settings';
  const result = await provider.query('inspect', { url: 'http://127.0.0.1:7692/', active: true });
  assert.equal(result.status, 'not-ready');
  assert.equal(result.page.sessionId, null);
});

test('active inspection rejects an explicit session instead of silently choosing one', async () => {
  const { provider } = await boot();
  await assert.rejects(
    provider.query('inspect', { url: 'http://127.0.0.1:7692/', active: true, sessionId: 'session-task' }),
    /INVALID_PAGE_TARGET/u,
  );
});

test('active inspection includes only the current session RenderBoundary errors', async () => {
  const { provider, listeners } = await boot();
  listeners.get('dsh-better-sidebar/render-error')({ detail: {
    boundaryId: 'boundary-a', scope: 'tab', sessionId: 'session-task',
    tab: { id: 'tab-a', type: 'subagent' }, message: 'render failed', componentStack: '',
  } });
  const result = await provider.query('inspect', { url: 'http://127.0.0.1:7692/', active: true });
  assert.equal(result.renderErrors.length, 1);
  assert.equal(result.renderErrors[0].sessionId, 'session-task');
});

test('a non-http page returns its origin and pathname without the query secret', async () => {
  const { provider } = await boot({ origin: 'app://.', pathname: '/index.html', href: 'app://./index.html?token=SYNTHETIC_SECRET' });
  const result = await provider.query('inspect', { url: 'http://127.0.0.1:2462/', sessionId: 'session-task' });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.page.url, 'app://./index.html');
  assert.equal(result.page.pageId, undefined);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
});
