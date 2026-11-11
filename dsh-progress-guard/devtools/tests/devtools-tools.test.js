import test from 'node:test';
import assert from 'node:assert/strict';
import { InspectionLens } from '../inspect.js';
import { createInspectTool } from '../inspect-tool.js';
import { createPageTool } from '../page-tool.js';
import { registerPageRoutes, PageBridge } from '../page-bridge.js';

const agent = { id: 'session-task' };
const exec = () => ({ agent, signal: new AbortController().signal });
const page = { pageId: 'page-a', documentId: 'document-a', graphRevision: 'graph-a', sessionId: agent.id, url: 'http://127.0.0.1:7292/', ready: true };
const result = () => ({ status: 'ready', page, modules: [{ id: '@fixture/ui', rev: 'rev-a' }], element: { status: 'found', matches: 1, visible: true, ariaExpanded: false } });

function pageTool(query, bridge = { reload: () => { throw new Error('unexpected mutation'); } }) {
  return createPageTool({ cordisInspect: { query }, clientModules: { graph: () => ({ entries: [{ id: '@fixture/ui', rev: 'rev-a' }] }) } }, bridge);
}

test('inspect defaults to requesting session and reports the actual disclosure and advertised generation', async () => {
  let observed;
  const tool = pageTool(async (...args) => { observed = args; return result(); });
  const output = await tool.execute({ action: 'inspect', url: page.url, packageName: '@fixture/ui', selector: '.collapse', expectedExpanded: false }, exec());
  assert.equal(observed[3].sessionId, agent.id);
  assert.equal(output.verification.passed, true);
  assert.equal(output.verification.sourceBuildVerified, false);
  assert.equal(tool.isConcurrencySafe({ action: 'reload' }), false);
});

test('reload needs the full identity and never dispatches after an unmatched page query', async () => {
  const tool = pageTool(async () => { throw new Error('no matching page'); });
  assert.equal((await tool.execute({ action: 'reload', url: page.url }, exec())).code, 'TARGET_IDENTITY_REQUIRED');
  assert.equal((await tool.execute({ action: 'reload', ...page }, exec())).code, 'MATCHING_PAGE_UNAVAILABLE');
  let reloaded = false;
  const mismatched = pageTool(async () => ({ status: 'mismatch', page: { url: 'http://127.0.0.1:7292/session' }, mismatch: ['url'] }), { reload: () => { reloaded = true; throw new Error('reload must not run'); } });
  const inspect = await mismatched.execute({ action: 'inspect', url: 'http://127.0.0.1:7292/' }, exec());
  assert.equal(inspect.code, 'MATCHING_PAGE_UNAVAILABLE');
  assert.deepEqual(inspect.pages, ['http://127.0.0.1:7292/session']);
  assert.equal(reloaded, false);
  const reload = await mismatched.execute({ action: 'reload', ...page }, exec());
  assert.equal(reload.code, 'MATCHING_PAGE_UNAVAILABLE');
  assert.equal(reloaded, false);
});

test('a reload receipt is followed by a query against the new document and must pass the requested state', async () => {
  const fresh = { ...page, pageId: 'page-b', documentId: 'document-b', graphRevision: 'graph-b' };
  let calls = 0;
  const tool = pageTool(async (_platform, _provider, _method, target) => {
    calls++;
    if (calls === 1) return result();
    assert.equal(target.documentId, fresh.documentId);
    return { ...result(), page: fresh, element: { status: 'found', visible: true, ariaExpanded: true } };
  }, { reload: async target => { assert.deepEqual(target, page); return { status: 'reloaded', requestId: 'request-a', page: fresh }; } });
  const output = await tool.execute({ action: 'reload', ...page, selector: '.collapse', expectedExpanded: false }, exec());
  assert.equal(output.reloaded, true);
  assert.equal(output.status, 'unverified');
  assert.equal(output.verification.element, 'failed');
});

test('click requires the inspected element and page identity, then verifies the requested resulting state', async () => {
  const clicked = [];
  const bridge = { click: async (target, action) => { clicked.push({ target, action }); return { status: 'clicked', requestId: 'click-a', page }; } };
  let queries = 0;
  const tool = pageTool(async () => {
    queries++;
    return { ...result(), element: queries === 1 ? { status: 'found', visible: true, token: 'element-a' } : { status: 'found', visible: true, ariaExpanded: true } };
  }, bridge);
  assert.equal((await tool.execute({ action: 'click', url: page.url, selector: '.trigger' }, exec())).code, 'TARGET_IDENTITY_REQUIRED');
  assert.equal(clicked.length, 0);
  const output = await tool.execute({ action: 'click', ...page, selector: '.trigger', elementToken: 'element-a', verifySelector: '.panel', expectedVisible: true }, exec());
  assert.equal(clicked.length, 1);
  assert.equal(clicked[0].action.elementToken, 'element-a');
  assert.equal(output.status, 'verified');
  assert.equal(output.verification.element, 'passed');
});

test('compact discovery omits schemas, and only the explicitly selected method contract is returned', async () => {
  const manifests = [{ platform: 'host', id: 'Fixture', description: 'A small read-only fixture.', methods: [{ name: 'read', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }, { name: 'other', inputSchema: { description: 'UNSELECTED_SCHEMA' }, outputSchema: {} }] }];
  let queries = 0;
  const ctx = { cordisInspect: { list: () => manifests, query: async () => { queries++; return { value: 'x'.repeat(2000) }; } } };
  const lens = new InspectionLens({ query: ctx.cordisInspect.query });
  const tool = createInspectTool(ctx, lens);
  const directory = await tool.execute({}, exec());
  assert.equal(directory.providers[0].purpose, manifests[0].description);
  assert.ok(!JSON.stringify(directory).includes('inputSchema'));
  const contract = await tool.execute({ action: 'contract', provider: 'Fixture', method: 'read' }, exec());
  assert.equal(contract.method.name, 'read');
  assert.ok(!JSON.stringify(contract).includes('UNSELECTED_SCHEMA'));
  const unknown = await tool.execute({ action: 'query', provider: 'Fixture', method: 'missing' }, exec());
  assert.equal(unknown.error.code, 'UNKNOWN_PROVIDER_METHOD');
  assert.equal(queries, 0);
  const large = await tool.execute({ action: 'query', provider: 'Fixture', method: 'read', maxBytes: 800 }, exec());
  assert.equal(large.error.code, 'QUERY_RESULT_TOO_LARGE');
  assert.equal(queries, 1);
});

test('an undeclared property names that method\'s allowed fields and does not query', async () => {
  const manifests = [{ platform: 'client', id: 'Runtime', description: 'Client runtime.', methods: [{ name: 'status', inputSchema: { type: 'object', properties: { packageName: { type: 'string' }, slot: { type: 'string' } }, additionalProperties: false }, outputSchema: {} }] }];
  let queries = 0;
  const ctx = { cordisInspect: { list: () => manifests, query: async () => { queries++; return {}; } } };
  const output = await createInspectTool(ctx, new InspectionLens({ query: ctx.cordisInspect.query })).execute({ action: 'query', platform: 'client', provider: 'Runtime', method: 'status', input: { packageName: 'pkg', limit: 20 } }, exec());
  assert.equal(output.error.code, 'UNDECLARED_INPUT');
  assert.match(output.error.message, /Allowed properties: packageName, slot/);
  assert.equal(queries, 0);
});

test('Config.listConfigs pages include packageDir and omit the plugin schema unless requested', async () => {
  const manifests = [{ platform: 'host', id: 'Config', description: 'Plugin config.', methods: [{ name: 'listConfigs', inputSchema: { type: 'object', properties: { name: { type: 'string' }, entry: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false }, outputSchema: {} }] }];
  const calls = [];
  const ctx = { cordisInspect: { list: () => manifests, query: async (_platform, _provider, _method, input) => {
    calls.push(input);
    if (input.entry === 'include:pkg') return { id: 'include:pkg', packageDir: 'C:/pkg', schema: { huge: true } };
    if (input.limit === 25) return { entries: Array.from({ length: 6 }, (_unused, index) => ({ id: `row-${index}`, name: 'wide', status: 'schema' })), total: 6, nextOffset: null };
    return { entries: [{ id: 'include:pkg', name: 'pkg', status: 'schema' }], total: 1, nextOffset: null };
  } } };
  const tool = createInspectTool(ctx, new InspectionLens({ query: ctx.cordisInspect.query }));
  const directory = await tool.execute({ action: 'query', platform: 'host', provider: 'Config', method: 'listConfigs', input: { name: 'pkg' } }, exec());
  assert.equal(directory.data.entries[0].packageDir, 'C:/pkg');
  assert.equal(JSON.stringify(directory).includes('huge'), false);
  const wide = await tool.execute({ action: 'query', platform: 'host', provider: 'Config', method: 'listConfigs', input: { limit: 25 } }, exec());
  assert.equal(wide.data.entries[0].packageDir, undefined);
  assert.equal(calls.filter(input => input.entry).length, 1);
  const entry = await tool.execute({ action: 'query', platform: 'host', provider: 'Config', method: 'listConfigs', input: { entry: 'include:pkg' } }, exec());
  assert.equal(entry.data.packageDir, 'C:/pkg');
  assert.equal(entry.data.schemaOmitted, true);
  assert.equal('schema' in entry.data, false);
  const full = await tool.execute({ action: 'query', platform: 'host', provider: 'Config', method: 'listConfigs', input: { entry: 'include:pkg', includeSchema: true } }, exec());
  assert.equal(full.data.schema.huge, true);
  assert.equal(calls.some(input => Object.hasOwn(input, 'includeSchema')), false);
});

test('Desktop forwarding accepts only its exact app origin on an explicitly enabled authenticated loopback route', async () => {
  const bridge = new PageBridge({ pollMs: 1 });
  const routes = [];
  const dispose = registerPageRoutes({ fetch: { register(route) { routes.push(route); return async () => {}; } } }, bridge, { desktopForwarding: true });
  const call = (identityUrl, host = 'http://127.0.0.1:7292', origin) => routes[0].fetch(new Request(host + '/api/dsh-devtools/page/poll', { method: 'POST', headers: origin ? { origin } : {}, body: JSON.stringify({ ...page, url: identityUrl }) }));
  const internal = await routes[0].fetch(new Request('http://dsh.internal/api/dsh-devtools/page/poll', { method: 'POST', headers: { host: '127.0.0.1:7292' }, body: JSON.stringify({ ...page, url: 'dsh-app://app/' }) }));
  assert.equal(internal.status, 200);
  assert.equal((await call('dsh-app://app/')).status, 200);
  assert.equal((await call('dsh-app://other/')).status, 400);
  assert.equal((await call('dsh-app://app/', 'https://unrelated.test')).status, 400);
  assert.equal((await call('dsh-app://app/', undefined, 'null')).status, 400);
  await dispose(); bridge.dispose();
});

test('the admitted HTTPS carrier normalizes Host default ports using the Origin scheme', async () => {
  const bridge = new PageBridge({ pollMs: 1 });
  const routes = [];
  const dispose = registerPageRoutes({ fetch: { register(route) { routes.push(route); return async () => {}; } } }, bridge);
  const call = (host, origin, identityUrl) => routes[0].fetch(new Request('http://dsh.internal/api/dsh-devtools/page/poll', { method: 'POST', headers: { host, origin }, body: JSON.stringify({ ...page, url: identityUrl }) }));
  assert.equal((await call('example.test:443', 'https://example.test', 'https://example.test/')).status, 200);
  assert.equal((await call('example.test:80', 'https://example.test:80', 'https://example.test:80/')).status, 200);
  assert.equal((await call('example.test:444', 'https://example.test', 'https://example.test/')).status, 400);
  await dispose(); bridge.dispose();
});

test('page commands are exposed only on the authenticated Fetch face and reject cross-origin claims', async () => {
  const bridge = new PageBridge({ pollMs: 1 });
  assert.throws(() => registerPageRoutes({}, bridge), /AUTHENTICATED_FETCH_UNAVAILABLE/u);
  const routes = [];
  const dispose = registerPageRoutes({ fetch: { register(route) { routes.push(route); return async () => {}; } } }, bridge);
  assert.equal(routes.length, 2);
  assert.ok(routes.every(route => route.path.startsWith('/api/') && route.methods.join() === 'POST'));
  const response = await routes[0].fetch(new Request('http://127.0.0.1:7292/api/dsh-devtools/page/poll', { method: 'POST', body: JSON.stringify({ ...page, url: 'http://unrelated.test/' }) }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'PAGE_ORIGIN_MISMATCH');
  await dispose();
});
