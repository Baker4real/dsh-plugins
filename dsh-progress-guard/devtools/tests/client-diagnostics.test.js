import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Serialization seam only: live Cordis activation is verified separately on the actual page.
test('the public Runtime result never echoes text captured from arbitrary module exceptions', async () => {
  let declaration;
  const registrations = [];
  const script = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInNewContext(script, { window: { __ModuleLoader__: { load(value) { declaration = value; } } } });
  const modules = { manifest: { modules: [] }, entries: { state: { getSnapshot: () => ({ syncing: false, failures: [
    { id: '@fixture/bad', message: 'Configuration rejected: {"description":"slot \'SYNTHETIC_CONFIG_VALUE\' is already declared"}' },
    { id: '@fixture/bad', message: 'slot "SYNTHETIC_CONFIG_VALUE" is already declared' },
    { id: '@fixture/bad', message: 'Error: sessions.retain: unknown session SYNTHETIC_CONFIG_VALUE' },
  ] }) } } };
  const ctx = {
    get(key) { return key === 'modules' ? modules : undefined; },
    slots: { onEntryError: () => () => {}, entriesOfSlot: () => [] },
    effect(action) { return action(); },
    inject(_keys, action) { return action({ effect: action => action(), cordisInspect: { register(value) { registrations.push(value); return () => {}; } } }); },
  };
  declaration.factory().apply(ctx);
  const result = registrations.find(value => value.manifest.id === 'Runtime').query('status');
  assert.equal(result.failures.length, 3);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_CONFIG_VALUE'));
  assert.equal(result.slot, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result.registrations)), []);
});

test('status without a slot lists that package and does not borrow another slot winner', async () => {
  let declaration;
  const registrations = [];
  const script = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInNewContext(script, { window: { __ModuleLoader__: { load(value) { declaration = value; } } } });
  const ctx = {
    get: () => undefined,
    slots: {
      onEntryError: () => () => {},
      entriesOfSlot: () => [{ options: { key: 'assistant-step', priority: -1 }, registrant: '@local/dsh-progress-guard' }],
      snapshot: () => [{ type: 'slot', name: 'conversation.chat.node', occupants: [{ registrant: '@local/dsh-progress-guard', key: 'assistant-step', priority: -1, active: true }], children: [] }, { type: 'slot', name: 'conversation.input.left', occupants: [{ registrant: 'tk', id: 'dsh-prompt-entry', order: 10, priority: 0, active: true }], children: [] }],
    },
    effect(action) { return action(); },
    inject(_keys, action) { return action({ effect: action => action(), cordisInspect: { register(value) { registrations.push(value); return () => {}; } } }); },
  };
  declaration.factory().apply(ctx);
  const query = registrations.find(value => value.manifest.id === 'Runtime').query;
  const result = query('status', { packageName: 'dsh-prompt' });
  assert.equal(result.slot, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result.registrations)), [{ slot: 'conversation.input.left', id: 'dsh-prompt-entry', key: null, registrant: 'tk', order: 10, priority: 0, active: true }]);
  assert.ok(!JSON.stringify(result).includes('progress-guard'));
  const named = query('status', { packageName: 'dsh-prompt', slot: 'conversation.input.left' });
  assert.equal(named.slot.winner.registrant, 'tk');
  assert.equal(named.registrations, undefined);
});

test('Runtime exposes bounded RenderBoundary errors and clears them on recovery', async () => {
  let declaration;
  const registrations = [];
  const listeners = new Map();
  const script = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const sandbox = {
    window: {
      __ModuleLoader__: { load(value) { declaration = value; } },
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); },
    },
  };
  vm.runInNewContext(script, sandbox);
  const modules = { manifest: { modules: [] }, entries: { state: { getSnapshot: () => ({ syncing: false, failures: [] }) } } };
  const ctx = {
    get(key) { return key === 'modules' ? modules : undefined; },
    slots: { onEntryError: () => () => {}, entriesOfSlot: () => [] },
    effect(action) { return action(); },
    inject(_keys, action) { return action({ effect: action => action(), cordisInspect: { register(value) { registrations.push(value); return () => {}; } } }); },
  };
  declaration.factory().apply(ctx);
  const runtime = registrations.find(value => value.manifest.id === 'Runtime');
  const report = listeners.get('dsh-better-sidebar/render-error');
  assert.equal(typeof report, 'function');
  const detail = {
    boundaryId: 'boundary-a', scope: 'tab', sessionId: 'session-a',
    tab: { id: 'tab-a', type: 'subagent' },
    message: 'Cannot read properties of undefined', componentStack: '\n at TaskView',
  };
  report({ detail });
  let result = runtime.query('status', { sessionId: 'session-a' });
  assert.equal(result.renderErrors.length, 1);
  assert.equal(result.renderErrors[0].tab.id, 'tab-a');
  assert.equal(result.renderErrors[0].message, detail.message);
  assert.equal(runtime.query('status', { sessionId: 'session-other' }).renderErrors.length, 0);
  assert.equal(runtime.query('status', { packageName: 'unrelated-package' }).renderErrors.length, 0);
  report({ detail: { ...detail, boundaryId: 'boundary-root', scope: 'root', tab: null } });
  assert.equal(runtime.query('status', { sessionId: 'session-a' }).renderErrors.find(row => row.boundaryId === 'boundary-root').scope, 'root');
  listeners.get('dsh-better-sidebar/render-recovered')({ detail: { boundaryId: 'boundary-root' } });
  report({ detail: {
    ...detail, boundaryId: 'boundary-b',
    message: 'request failed token=SYNTHETIC_SECRET',
    componentStack: 'https://example.test/path?token=SYNTHETIC_SECRET',
  } });
  assert.ok(!JSON.stringify(runtime.query('status', { sessionId: 'session-a' }).renderErrors).includes('SYNTHETIC_SECRET'));
  report({ detail: {
    ...detail, boundaryId: 'boundary-c',
    message: 'Configuration rejected: {"password":"SYNTHETIC_SECRET"}',
    componentStack: ' at SecretComponent (D:/private/project/component.tsx:1:1)',
  } });
  const sanitized = runtime.query('status', { sessionId: 'session-a' }).renderErrors;
  assert.equal(sanitized.find(row => row.boundaryId === 'boundary-c').message, 'Render error omitted because it may contain configuration values.');
  assert.ok(!JSON.stringify(sanitized).includes('example.test'));
  assert.ok(!JSON.stringify(sanitized).includes('D:/private/project'));
  listeners.get('dsh-better-sidebar/render-recovered')({ detail: { boundaryId: 'boundary-a' } });
  listeners.get('dsh-better-sidebar/render-recovered')({ detail: { boundaryId: 'boundary-b' } });
  listeners.get('dsh-better-sidebar/render-recovered')({ detail: { boundaryId: 'boundary-c' } });
  result = runtime.query('status', { sessionId: 'session-a' });
  assert.equal(result.renderErrors.length, 0);
});

test('Desktop element inspection returns selector geometry and DPR without DOM text', async () => {
  let declaration;
  const registrations = [];
  const element = {
    getBoundingClientRect: () => ({ left: 16, top: 22, width: 27, height: 26 }),
    closest: () => ({ matches: () => true }),
    contains: () => true,
    namespaceURI: 'http://www.w3.org/2000/svg',
    get textContent() { throw new Error('DOM text must not be read'); },
    click() { throw new Error('Read-only inspection must not click'); },
    setAttribute() { throw new Error('Read-only inspection must not mutate'); },
  };
  let color = 'rgb(239, 68, 68)';
  const script = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { declaration = value; } }, devicePixelRatio: 1.5, innerWidth: 1000, innerHeight: 800 },
    document: {
      querySelectorAll: selector => selector === '.close' ? [element] : [],
      documentElement: { hasAttribute: name => name === 'data-windows-titlebar' },
      elementFromPoint: () => element,
    },
    getComputedStyle: target => {
      assert.equal(target, element);
      return { webkitAppRegion: 'no-drag', display: 'flex', visibility: 'visible', pointerEvents: 'auto', color, backgroundColor: 'rgba(0, 0, 0, 0)', fill: color };
    },
  };
  vm.runInNewContext(script, sandbox);
  const ctx = {
    get: () => undefined,
    slots: { onEntryError: () => () => {}, entriesOfSlot: () => [] },
    effect(action) { return action(); },
    inject(_keys, action) { return action({ effect: action => action(), cordisInspect: { register(value) { registrations.push(value); return () => {}; } } }); },
  };
  declaration.factory().apply(ctx);
  const provider = registrations.find(value => value.manifest.id === 'Desktop');
  const result = provider.query('inspectElement', { selector: '.close' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(JSON.parse(JSON.stringify(result.paint)), { color: 'rgb(239, 68, 68)', backgroundColor: 'rgba(0, 0, 0, 0)', fill: 'rgb(239, 68, 68)' });
  color = 'rgb(34, 197, 94)';
  assert.equal(provider.query('inspectElement', { selector: '.close' }).paint.fill, 'rgb(34, 197, 94)');
  assert.equal(result.devicePixelRatio, 1.5);
  assert.equal(result.appRegion, 'no-drag');
  assert.equal(result.windowsTitlebar, true);
  assert.equal(result.popoverOpen, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.points)), { upper: { x: 29.5, y: 26 }, center: { x: 29.5, y: 35 }, lower: { x: 29.5, y: 44 } });
  assert.deepEqual(JSON.parse(JSON.stringify(result.hitTargets)), { upper: true, center: true, lower: true });
  assert.equal(provider.query('inspectElement', { selector: '.missing' }).error.code, 'ELEMENT_NOT_FOUND');
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_CONFIG_VALUE'));
});
