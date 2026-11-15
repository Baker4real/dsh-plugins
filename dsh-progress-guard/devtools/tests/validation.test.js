import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectValidationGate, deliveryOwner } from '../validation.js';

// Registries expose only list(): DSH 0.2.2-rc.2 has no roots() or isOwnedBy(), so calling either would throw here.
const liveAgent = (id, header = {}) => ({ id, session: { id, header } });

test('a nested subagent attributes delivery to its live top-level creator, while a reviewer incurs no separate gate', () => {
  const root = liveAgent('root');
  const child = liveAgent('child', { origin: 'subagent', parentSession: 'root' });
  const nested = liveAgent('nested', { origin: 'subagent', parentSession: 'child' });
  const registry = { list: () => [root, child, nested] };
  assert.equal(deliveryOwner(registry, nested), root);
  assert.equal(deliveryOwner(registry, root), root);
});

test('an ordinary fork owns its delivery, and a subagent whose creator is gone keeps it', () => {
  const root = liveAgent('root');
  const fork = liveAgent('fork', { parentSession: 'root' });
  const orphan = liveAgent('orphan', { origin: 'subagent', parentSession: 'gone' });
  const registry = { list: () => [root, fork, orphan] };
  assert.equal(deliveryOwner(registry, fork), fork);
  assert.equal(deliveryOwner(registry, orphan), orphan);
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
