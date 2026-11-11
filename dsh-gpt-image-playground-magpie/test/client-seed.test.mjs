import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const APP_SRC = '/plugins/dsh-gpt-image-playground/app/index.html'
const SEED_KEY = 'dsh-gpt-image-playground-magpie:seeded'
const STORE_KEY = 'gpt-image-playground'

function browser({ stored = {}, frames = [] } = {}) {
  const storage = new Map(Object.entries(stored))
  const observers = []
  const animations = new Map()
  let animationId = 0
  let definition

  class MutationObserver {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      observers.push(this)
    }

    observe(target, options) {
      this.observed = { target, options }
    }

    disconnect() {
      this.disconnected = true
    }
  }

  const document = {
    body: {},
    querySelectorAll(selector) {
      return selector === 'iframe' ? frames : []
    },
  }
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null
      },
      setItem(key, value) {
        storage.set(key, value)
      },
    },
    location: { origin: 'dsh-app://app' },
    requestAnimationFrame(callback) {
      animationId += 1
      animations.set(animationId, callback)
      return animationId
    },
    cancelAnimationFrame(id) {
      animations.delete(id)
    },
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window,
    document,
    MutationObserver,
    URLSearchParams,
  })
  const plugin = definition.factory()
  const cleanups = []
  const ctx = {
    effect(fn) {
      cleanups.push(fn())
    },
  }

  return {
    frames,
    observers,
    storage,
    apply: () => plugin.apply(ctx),
    flushAnimations() {
      const pending = [...animations.values()]
      animations.clear()
      for (const callback of pending) callback()
    },
    cleanup() {
      for (const dispose of cleanups) dispose()
    },
  }
}

function frame(src = APP_SRC) {
  const attributes = new Map([['src', src]])
  return {
    writes: 0,
    getAttribute(name) {
      return attributes.get(name) ?? null
    },
    setAttribute(name, value) {
      this.writes += 1
      attributes.set(name, value)
    },
  }
}

test('an already-seeded version never rewrites the workbench frame', () => {
  const existing = frame()
  const env = browser({ stored: { [SEED_KEY]: '1' }, frames: [existing] })
  env.apply()
  assert.equal(existing.writes, 0)
  assert.equal(env.observers.length, 0)
  env.cleanup()
})

test('an existing magpie profile is marked seeded without an import', () => {
  const existing = frame()
  const env = browser({
    stored: {
      [STORE_KEY]: JSON.stringify({ state: { settings: { profiles: [{ id: 'magpie-huanling' }] } } }),
    },
    frames: [existing],
  })
  env.apply()
  assert.equal(existing.writes, 0)
  assert.equal(env.observers.length, 0)
  assert.equal(env.storage.get(SEED_KEY), '1')
  env.cleanup()
})

test('a late workbench frame is imported exactly once with both models', () => {
  const env = browser()
  env.apply()
  assert.equal(env.observers.length, 1)
  const observer = env.observers[0]
  assert.equal(observer.observed.options.childList, true)
  assert.equal(observer.observed.options.subtree, true)

  const added = frame()
  env.frames.push(added)
  observer.callback()
  observer.callback()
  assert.equal(added.writes, 0)
  env.flushAnimations()
  assert.equal(added.writes, 1)
  assert.equal(observer.disconnected, true)
  assert.equal(env.storage.get(SEED_KEY), '1')

  const imported = new URLSearchParams(added.getAttribute('src').split('?')[1])
  assert.equal(imported.get('profileId'), 'magpie-huanling')
  assert.equal(imported.get('profileName'), '幻灵AI · magpie')
  assert.equal(imported.get('apiUrl'), 'dsh-app://app/plugins/dsh-gpt-image-playground-magpie/v1')
  assert.equal(imported.get('model'), 'ai/gpt-image-2.6-sunburst,ai/gpt-image-2.6-flare')
  assert.equal(imported.get('apiMode'), 'images')
  assert.equal(imported.get('apiKey'), 'magpie-local')

  // Even a queued observer callback cannot import a second frame after completion.
  const other = frame()
  env.frames.push(other)
  observer.callback()
  env.flushAnimations()
  assert.equal(other.writes, 0)

  // A later activation sees the seed marker and does not observe or rewrite.
  env.apply()
  assert.equal(env.observers.length, 1)
  assert.equal(added.writes, 1)
  env.cleanup()
})
