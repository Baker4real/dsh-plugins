import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectValidationGate, deliveryOwner } from '../validation.js';

test('a nested contributor attributes delivery to its live root, while a reviewer incurs no separate gate', () => {
  const root = { id: 'root' }, child = { id: 'child' }, nested = { id: 'nested' };
  const registry = { list: () => [root, child, nested], roots: () => [root], isOwnedBy: (id, parent) => (id === 'child' && parent === root) || (id === 'nested' && parent === child) };
  assert.equal(deliveryOwner(registry, nested), root);
  assert.equal(deliveryOwner(registry, root), root);
});

test('unchanged sources reuse a passed CLI result but still recheck the live Client', async () => {
  let source = 'a', runs = 0, clients = 0;
  const gate = new ProjectValidationGate({ fingerprint: async () => source, run: async () => { runs++; return { status: 'passed', checks: [{ name: 'host-tests', status: 'passed' }] }; }, client: async () => { clients++; return { status: 'passed' }; } });
  const agent = {};
  assert.equal((await gate.verify({ agent, reason: 'turn-stopping' })).status, 'passed');
  await gate.verify({ agent, reason: 'turn-stopping' });
  assert.equal(runs, 1);
  assert.equal(clients, 2);
  source = 'b';
  await gate.verify({ agent, reason: 'install' });
  assert.equal(runs, 2);
});

test('failed checks and sources changed during a check cannot be cached as delivery success', async () => {
  let source = 'a';
  const failed = new ProjectValidationGate({ fingerprint: async () => source, run: async () => ({ status: 'failed', checks: [] }), client: async () => ({ status: 'passed' }) });
  assert.equal((await failed.verify({ agent: {}, reason: 'install' })).status, 'failed');
  const raced = new ProjectValidationGate({ fingerprint: async () => source, run: async () => { source = 'b'; return { status: 'passed', checks: [] }; }, client: async () => ({ status: 'passed' }) });
  assert.equal((await raced.verify({ agent: {}, reason: 'install' })).failure, 'SOURCE_CHANGED');
});

test('a broken Client blocks a new delivery even when the CLI result is cached', async () => {
  let broken = false;
  const gate = new ProjectValidationGate({ fingerprint: async () => 'a', run: async () => ({ status: 'passed', checks: [] }), client: async () => ({ status: broken ? 'failed' : 'passed', code: 'CLIENT_NOT_ACTIVE' }) });
  await gate.verify({ agent: {}, reason: 'install' });
  broken = true;
  assert.equal((await gate.verify({ agent: {}, reason: 'turn-stopping' })).failure, 'CLIENT_NOT_ACTIVE');
});
