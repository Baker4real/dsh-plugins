import test from 'node:test';
import assert from 'node:assert/strict';
import { InspectionLens, signatureName } from '../inspect.js';

function fixture() {
  const calls = [];
  let generation = 'release-a';
  const query = async (_platform, _provider, _method, input) => {
    calls.push(input);
    if (!input?.service) return { mode: 'catalog', services: [{ key: 'tools', methods: [{ signature: 'register<T>(definition: ToolDefinition): void' }, { signature: 'get(name: string): ToolDefinition' }] }] };
    return { mode: 'service', service: { key: 'tools', access: { optional: { expression: 'ctx.get("tools")' } }, methods: [{ signature: 'register<T>(definition: ToolDefinition): void', description: 'Register a definition.' }, { signature: 'get(name: string): ToolDefinition' }] }, referencedTypes: [{ name: 'ToolDefinition', declaration: 'interface ToolDefinition { value: Child }' }, { name: 'Child', declaration: 'type Child = string' }, { name: 'Unrelated', declaration: 'x'.repeat(50000) }] };
  };
  return { calls, agent: { id: 'fixture' }, lens: new InspectionLens({ query, generation: () => generation }), change: () => { generation = 'release-b'; } };
}

test('method discovery strips Remote decorators and modifiers before generic or property names', () => {
  assert.equal(signatureName("@Remote('catalog') async catalog<T>(args: T): Promise<T>"), 'catalog');
  assert.equal(signatureName('declare readonly register: SlotCore[\'register\']'), 'register');
  assert.equal(signatureName('*follow(session: Session, signal: AbortSignal): AsyncIterable<State>'), 'follow');
});

test('method lookup selects one contract, omits types by default and caches by runtime generation', async () => {
  const f = fixture();
  const request = { platform: 'client', service: 'tools', method: 'get', maxBytes: 1600 };
  const first = await f.lens.method(request, { agent: f.agent });
  assert.equal(first.contracts.length, 1);
  assert.match(first.contracts[0].signature, /^get\(/);
  assert.equal(first.referencedTypes, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(first, null, 2)) <= 1600);
  await f.lens.method(request, { agent: f.agent });
  assert.equal(f.calls.length, 2, 'one catalog and one exact service query are enough');
  f.change();
  await f.lens.method(request, { agent: f.agent });
  assert.equal(f.calls.length, 4, 'a runtime generation change invalidates both cached contracts');
});

test('unknown service is rejected before dispatching a slow Client exact-service query', async () => {
  const f = fixture();
  const output = await f.lens.method({ platform: 'client', service: 'nonexistent', method: 'get' }, { agent: f.agent });
  assert.equal(output.error.code, 'UNKNOWN_SERVICE');
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.lens.method({ service: '\u0001'.repeat(128), method: 'get', maxBytes: 800 }, { agent: f.agent }), /identifier/);
});

test('requested type closure includes only the chosen method dependencies and respects total byte budget', async () => {
  const f = fixture();
  const output = await f.lens.method({ service: 'tools', method: 'register', includeTypes: true, maxBytes: 1600 }, { agent: f.agent });
  assert.deepEqual(output.referencedTypes.map(item => item.name), ['ToolDefinition', 'Child']);
  assert.ok(!JSON.stringify(output).includes('Unrelated'));
  assert.ok(Buffer.byteLength(JSON.stringify(output, null, 2)) <= 1600);
});
