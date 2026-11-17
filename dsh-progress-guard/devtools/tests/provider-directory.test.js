import test from 'node:test';
import assert from 'node:assert/strict';
import { InspectionLens } from '../inspect.js';
import { projectProviderDirectory } from '../provider-directory.js';

const manifests = Array.from({ length: 80 }, (_unused, index) => ({
  platform: 'host', id: `Provider${index}`, description: 'A read-only provider',
  methods: [{ name: 'read', inputSchema: { huge: 'x'.repeat(5000) }, outputSchema: {} }],
}));
const lens = new InspectionLens({ query: () => { throw new Error('Directory projection must not dispatch queries'); } });

test('the standard provider directory is bounded and retains method names and explicit continuation', () => {
  const raw = { providers: manifests };
  const result = projectProviderDirectory({ name: 'cordis_inspect_list' }, { value: raw }, { kind: 'accept' }, lens);
  assert.equal(result.kind, 'accept');
  assert.ok(Buffer.byteLength(JSON.stringify(result.value, null, 2), 'utf8') <= 6000);
  assert.ok(result.value.providers.length > 0);
  assert.deepEqual(result.value.providers[0].methods, ['read']);
  assert.equal(JSON.stringify(result.value).includes('inputSchema'), false);
  assert.ok(result.value.nextOffset > 0);
  assert.equal(result.value.truncated, true);
  assert.equal(result.value.contractLookup, 'Inspect.provider');
  assert.equal(raw.providers[0].methods[0].inputSchema.huge.length, 5000);
});

test('failed tools, explicit content and unrelated tools preserve the accepted downstream decision', () => {
  const accepted = { kind: 'accept', content: [{ type: 'text', text: 'owned downstream' }] };
  assert.equal(projectProviderDirectory({ name: 'cordis_inspect_list' }, { value: { providers: manifests } }, accepted, lens), accepted);
  const blocked = { kind: 'block', reason: 'not allowed' };
  assert.equal(projectProviderDirectory({ name: 'cordis_inspect_list' }, { value: { providers: manifests } }, blocked, lens), blocked);
  const decision = { kind: 'accept' };
  assert.equal(projectProviderDirectory({ name: 'other' }, { value: { providers: manifests } }, decision, lens), decision);
  assert.equal(projectProviderDirectory({ name: 'cordis_inspect_list' }, { isError: true, value: { providers: manifests } }, decision, lens), decision);
});
