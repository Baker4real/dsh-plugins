import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, compactInspection } from '../compact-inspect.js';

const bytes = value => Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');

test('Service discovery keeps names and explicitly omits wide contracts even for an exact service', () => {
  for (const mode of ['catalog', 'service']) {
    const service = { key: 'llm', access: { secret: 'WIDE_ACCESS' }, methods: [{ signature: 'async call(): Promise<void>', description: 'WIDE_DESCRIPTION' }] };
    const output = compactInspection('Service', 'listService', { mode, services: [service], service, referencedTypes: [{ name: 'Large', declaration: 'x'.repeat(20000) }] });
    assert.deepEqual(output.services, [{ key: 'llm', methods: ['call'] }]);
    assert.ok(!JSON.stringify(output).includes('WIDE_'));
    assert.equal(output.nextOffset, null);
    assert.equal(output.truncated, false);
    assert.match(output.compact.detail, /Inspect.method/);
  }
});

test('initial compact Slot discovery is bounded, flat and continues without returning schemas or the full tree', () => {
  const trees = Array.from({ length: 80 }, (_, index) => ({ type: 'slot', name: `slot-${index}`, registrant: 'WC', catalog: { props: 'SECRET_WIDE_CONTRACT' }, children: [] }));
  const first = compactInspection('Slots', 'listSubTree', { trees }, { maxBytes: 800, limit: 100 });
  assert.ok(bytes(first) <= 800);
  assert.ok(first.nodes.length > 0 && first.nodes.length < 80);
  assert.equal(first.trees, undefined);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, first.nodes.length);
  assert.equal(JSON.stringify(first).includes('SECRET_WIDE_CONTRACT'), false);
  const next = compactInspection('Slots', 'listSubTree', { trees }, { maxBytes: 800, offset: first.nextOffset });
  assert.equal(next.nodes[0].name, `slot-${first.nextOffset}`);
  const narrow = compactInspection('Service', 'listService', { mode: 'catalog', services: [{ key: 'huge', methods: [{ signature: 'x'.repeat(10000) }] }] }, { maxBytes: 800 });
  assert.equal(narrow.error.code, 'BUDGET_TOO_SMALL');
  assert.ok(narrow.narrow);
  assert.ok(bytes(narrow) <= 800);
  assert.throws(() => compactInspection('Slots', 'listSubTree', { trees }, { maxBytes: 799 }), /maxBytes/);
});

test('Slot pages preserve parent links and counts while selected props remain an explicit omission', () => {
  const output = compactInspection('Slots', 'listSubTree', {
    trees: [{ type: 'slot', name: 'root', children: [{ type: 'factory', name: 'content', children: [], occupants: [{ id: 'fixture' }] }] }],
    selected: { catalog: { props: 'WIDE_CONTRACT' } },
  }, { limit: 1 });
  assert.equal(output.nodes[0].name, 'root');
  assert.equal(output.nodes[0].childrenCount, 1);
  assert.equal(output.nextOffset, 1);
  assert.equal(output.truncated, true);
  assert.equal(output.selected, undefined);
});

test('an exact Slot root filters an upstream response that still includes unrelated trees', () => {
  const output = compactInspection('Slots', 'listSubTree', {
    trees: [
      { type: 'slot', name: 'unrelated', children: [] },
      { type: 'slot', name: 'parent', children: [{ type: 'slot', name: 'wanted', children: [{ type: 'slot', name: 'wanted.child', children: [] }] }] },
    ],
  }, { input: { root: 'wanted' } });
  assert.deepEqual(output.nodes.map(row => row.name), ['wanted', 'wanted.child']);
});

test('the compact tool preserves read-only dispatch and enforces its budget on the complete rendered result', async () => {
  let definition;
  let invocation;
  const ctx = { tools: { register: value => { definition = value; } }, cordisInspect: { query: async (...args) => {
    invocation = args;
    return { mode: 'catalog', services: Array.from({ length: 50 }, (_, index) => ({ key: `service-${index}`, methods: [{ signature: 'read()' }] })) };
  } } };
  apply(ctx);
  const agent = {}, signal = new AbortController().signal;
  const input = { service: 'llm' };
  const result = await definition.execute({ platform: 'host', provider: 'Service', method: 'listService', input, maxBytes: 800, limit: 1 }, { agent, signal });
  assert.deepEqual(invocation, ['host', 'Service', 'listService', input, agent, signal]);
  assert.ok(bytes(result) <= 800);
  assert.equal(result.data.services.length, 1);
  assert.equal(result.data.nextOffset, 1);
  assert.equal(result.data.truncated, true);
  ctx.cordisInspect.query = async () => ({ trees: Array.from({ length: 100 }, (_unused, index) => ({ type: 'slot', name: `slot-${index}`, kind: 'list', scope: 'root', children: [] })) });
  const defaultPage = await definition.execute({ platform: 'client', provider: 'Slots', method: 'listSubTree', maxBytes: 6000, limit: 100 }, { agent, signal });
  assert.ok(bytes(defaultPage) <= 6000, `Complete pretty JSON output used ${bytes(defaultPage)} bytes`);
  assert.equal(defaultPage.data.nextOffset, defaultPage.data.nodes.length);
  await assert.rejects(definition.execute({ platform: 'host', provider: 'Config', method: 'listConfigs' }, { agent, signal }), /only supports Service.listService and Slots.listSubTree/);
});
