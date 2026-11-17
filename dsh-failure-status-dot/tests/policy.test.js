import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, foldOutcome, failedCompletion, rowStyles } from '../policy.js';

const end = kind => ({ type: 'turn/end', data: { turn: 1, reason: { kind } } });
const list = failed => ({
  byId: { demo: { id: 'demo', running: false } },
  projectionsBySession: { demo: { values: { failureStatusDot: failed } } },
});
const unread = new Map([['demo', { running: false, completionUnread: true }]]);

test('a failed turn replaces the green completion color with the error color', () => {
  const failed = foldOutcome(initialState(), end('error'));
  assert.equal(failedCompletion(list(failed), unread, 'demo'), true);
  assert.match(rowStyles('demo'), /--dsw-alias-state-success-primary:\s*var\(--dsw-alias-state-error-primary\)/u);
});

test('healthy completion and cancellation retain the shipped status behavior', () => {
  for (const kind of ['completed', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked']) {
    assert.equal(foldOutcome(true, end(kind)), false);
    assert.equal(failedCompletion(list(false), unread, 'demo'), false);
  }
});

test('starting another turn clears stale failure and unrelated events preserve it', () => {
  assert.equal(foldOutcome(true, { type: 'turn/start', data: { turn: 2 } }), false);
  assert.equal(foldOutcome(true, { type: 'tool/result', data: { error: true } }), true);
  assert.equal(foldOutcome(false, { type: 'tool/result', data: { error: true } }), false);
});

test('read acknowledgement, live activity and pending questions take precedence', () => {
  for (const status of [
    { running: false, completionUnread: false },
    { running: true, completionUnread: true },
    { running: false, completionUnread: true, pendingInteraction: { kind: 'question' } },
  ]) assert.equal(failedCompletion(list(true), new Map([['demo', status]]), 'demo'), false);
  const running = list(true);
  running.byId.demo.running = true;
  assert.equal(failedCompletion(running, unread, 'demo'), false);
});

test('missing projections and unknown identities do not turn healthy sessions red', () => {
  assert.equal(failedCompletion(list(undefined), unread, 'demo'), false);
  assert.equal(failedCompletion(list(true), unread, 'missing'), false);
});

test('selectors quote session identifiers and only retheme the leading cell', () => {
  const css = rowStyles('a"b\\c');
  assert.match(css, /data-row-key="session:a\\"b\\\\c"/u);
  assert.match(css, /> span:first-child/u);
  assert.doesNotMatch(css, /!important|document|body|background:/u);
});
