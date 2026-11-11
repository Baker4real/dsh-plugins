import test from 'node:test';
import assert from 'node:assert/strict';
import { createExaSearchTool, initialSearchHealth, classifySearchError } from '../search.js';
const original = { name: 'web_search', description: 'search', parameters: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'] }, output: { schema: { type: 'object' } } };
const exec = { signal: new AbortController().signal };
test('configured Exa search is executed once, bounded, and reports real readiness', async () => {
  const health = initialSearchHealth();
  const calls = [];
  const tool = createExaSearchTool(original, async (args) => { calls.push(args); return [{ type: 'text', text: 'Title: Example\nURL: https://example.org/\nHighlights:\n' + '字'.repeat(9000) }]; }, health);
  assert.equal(health.state, 'untested');
  const result = await tool.execute({ queries: ['example', 'example'] }, exec);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'exa__web_search_exa');
  assert.ok(result.searches[0].content.length <= 6000);
  assert.equal(result.searches[0].truncated, true);
  assert.equal(health.state, 'ready');
  assert.ok(tool.output.render({}, result)[0].text.includes('external'));
});
test('protocol/auth failure is explicit and never calls another backend', async () => {
  const health = initialSearchHealth();
  let calls = 0;
  const tool = createExaSearchTool(original, async () => { calls++; throw new Error('HTTP 403: This group does not allow /v1/messages dispatch'); }, health);
  await assert.rejects(tool.execute({ queries: ['test'] }, exec), /SEARCH_PROTOCOL_NOT_ALLOWED/);
  assert.equal(calls, 1);
  assert.equal(health.state, 'unavailable');
  assert.equal(health.code, 'SEARCH_PROTOCOL_NOT_ALLOWED');
  assert.ok(!JSON.stringify(health).includes('/v1/messages'));
});
test('invalid query batches fail before network and abort is preserved', async () => {
  let calls = 0;
  const tool = createExaSearchTool(original, async () => { calls++; return []; }, initialSearchHealth());
  for (const queries of [[], [''], ['x', 'x', 'x', 'x', 'x'], ['x', 1]]) await assert.rejects(tool.execute({ queries }, exec));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tool.execute({ queries: ['x'] }, { signal: controller.signal }));
  assert.equal(calls, 0);
  assert.equal(classifySearchError(new Error('HTTP 401')), 'SEARCH_AUTH_FAILED');
});
