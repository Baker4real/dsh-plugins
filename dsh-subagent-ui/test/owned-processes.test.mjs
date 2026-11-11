import test from 'node:test'
import assert from 'node:assert/strict'
import { OwnedTree } from './owned-processes.mjs'

const root = { pid: 1, parentPid: 0, created: 'root-a', commandLine: 'node server.js' }
const child = { pid: 2, parentPid: 1, created: 'child-a', commandLine: 'node dsh.js' }

test('Windows cleanup kills descendants even after the owned root has exited', async () => {
  let processes = [root, child]
  const killed = []
  const tree = new OwnedTree({ pid: 1 }, {
    home: 'D:/unique-smoke-home', platform: 'win32',
    snapshot: async () => processes,
    kill: async pid => { killed.push(pid); processes = processes.filter(process => process.pid !== pid) },
    delay: async () => {},
  })
  await tree.capture()
  processes = [child]
  await tree.stop()
  assert.ok(killed.includes(2))
})

test('Windows cleanup failure overrides success instead of trusting taskkill or root exit', async () => {
  const tree = new OwnedTree({ pid: 1 }, {
    home: 'D:/unique-smoke-home', platform: 'win32',
    snapshot: async () => [child],
    kill: async () => {},
    delay: async () => {},
  })
  await assert.rejects(tree.stop(), /OWNED_PROCESS_CLEANUP/)
})

test('an initially empty scan must be rechecked after settling because owned descendants can appear late', async () => {
  let processes = [root]
  let emptyObserved = false
  let lateSpawned = false
  const killed = []
  const tree = new OwnedTree({ pid: 1 }, {
    home: 'D:/unique-smoke-home', platform: 'win32',
    snapshot: async () => processes,
    kill: async pid => { killed.push(pid); processes = processes.filter(process => process.pid !== pid) },
    delay: async () => { if (emptyObserved && !lateSpawned && processes.length === 0) { lateSpawned = true; processes = [child] } },
  })
  const originalSnapshot = tree.snapshot
  tree.snapshot = async () => {
    const result = await originalSnapshot()
    if (result.length === 0) emptyObserved = true
    return result
  }
  await tree.stop()
  assert.ok(killed.includes(2))
})

test('PID reuse is not treated as ownership and an orphan carrying the unique home is recovered', async () => {
  const reused = { pid: 1, parentPid: 0, created: 'root-b', commandLine: 'unrelated.exe' }
  const orphan = { pid: 3, parentPid: 999, created: 'orphan-a', commandLine: 'bash /d/unique-smoke-home/runtime-bin/pnpm' }
  let processes = [root]
  const killed = []
  const tree = new OwnedTree({ pid: 1 }, {
    home: 'D:/unique-smoke-home', platform: 'win32',
    snapshot: async () => processes,
    kill: async pid => { killed.push(pid); processes = processes.filter(process => process.pid !== pid) },
    delay: async () => {},
  })
  await tree.capture()
  processes = [reused, orphan]
  await tree.stop()
  assert.deepEqual(killed, [3])
})
