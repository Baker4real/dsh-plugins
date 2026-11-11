import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped ModuleLoader registration boundary. Nothing renders here;
// actual Client mount and DOM behavior are verified on the connected Harness page.
async function harness() {
  let declaration;
  const pending = [];
  const script = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInNewContext(script, { window: { __ModuleLoader__: { load(value) { declaration = value; } } }, queueMicrotask: callback => pending.push(callback) });
  const entries = [];
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  let slotEffect;
  const cleanups = [];
  const localeDisposers = [];
  const ctx = {
    locale: { register: () => () => localeDisposers.push('disposed'), bind: () => key => key },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') cleanups.push(dispose); return dispose; },
    inject() {},
    slots: {
      onEntryError: () => () => {},
      inject(_name, callback) { slotEffect = callback(); },
      subscribe(_name, callback) { listeners.add(callback); return () => listeners.delete(callback); },
      entriesOfSlot() { return entries.length ? [entries.toSorted((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]] : []; },
      register(options, component) {
        const entry = { options, component, registrant: options.registrant };
        entries.push(entry); notify();
        return () => { entries.splice(entries.indexOf(entry), 1); notify(); };
      },
    },
  };
  const flush = () => {
    let count = 0;
    while (pending.length) {
      assert.ok(count++ < 10, 'slot changes must not form an endless microtask loop');
      pending.shift()();
    }
  };
  declaration.factory(() => ({})).apply(ctx);
  return { entries, listeners, notify, flush, ctx, slotEffect: () => slotEffect(), cleanups, pending, localeDisposers };
}

function officialEntry() {
  return { component() {}, registrant: 'official', options: { key: 'assistant-step', priority: 0 }, children: {} };
}

test('Client waits for the official keyed occupant and stops observing its own winning entry', async () => {
  const { entries, listeners, notify, flush, ctx, slotEffect, cleanups } = await harness();
  flush();
  assert.equal(entries.length, 0);
  const official = officialEntry();
  entries.push(official); notify(); flush();
  assert.equal(entries.length, 2, 'one official entry and one wrapper');
  assert.equal(ctx.slots.entriesOfSlot()[0].registrant, '@local/dsh-progress-guard');
  notify(); flush();
  assert.equal(entries.length, 2, 'the wrapper does not remove itself when the winner list hides the original');
  slotEffect(); flush();
  for (const dispose of cleanups.reverse()) dispose();
  assert.equal(entries.length, 1);
  assert.equal(entries[0], official);
  assert.equal(listeners.size, 0);
});

test('Client handles declaration reentry without piling up subscriptions or microtasks', async () => {
  const { entries, listeners, notify, flush, slotEffect, pending } = await harness();
  const official = officialEntry();
  entries.push(official); notify(); flush();
  const first = entries.find(entry => entry.registrant === '@local/dsh-progress-guard');
  notify(); flush();
  assert.equal(entries.at(-1), first);
  assert.equal(pending.length, 0);
  slotEffect(); flush();
  assert.equal(listeners.size, 0);
  assert.deepEqual(entries, [official]);
});

test('Client waits without an original entry and unregisters its locale on teardown', async () => {
  const { entries, listeners, notify, flush, slotEffect, cleanups, localeDisposers } = await harness();
  flush();
  assert.equal(entries.length, 0);
  notify(); flush();
  assert.equal(listeners.size, 1);
  const official = officialEntry();
  entries.push(official); notify(); flush();
  assert.equal(entries.length, 2);
  slotEffect();
  for (const dispose of cleanups.reverse()) dispose();
  assert.deepEqual(localeDisposers, ['disposed']);
  assert.deepEqual(entries, [official]);
  assert.equal(listeners.size, 0);
});
