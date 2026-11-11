import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { planSmokeRuntime } from './smoke-runtime.mjs'

const managedPnpm = execPath => resolve(dirname(execPath), '../../pnpm/bin/pnpm.cjs')

test('managed Node supplies pnpm and an internal shim even when dsh and pnpm are absent from PATH', () => {
  const execPath = 'C:/runtime/dependencies/node/bin/node.exe'
  const pnpm = managedPnpm(execPath)
  const plan = planSmokeRuntime({
    env: {},
    execPath,
    platform: 'win32',
    hasCommand: () => false,
    exists: path => path === pnpm,
  })
  assert.equal(plan.env.DSH_VERSION, 'latest')
  assert.equal(plan.env.DSH_PNPX, 'pnpm dlx')
  assert.equal(plan.pnpmEntry, pnpm)
  assert.deepEqual(plan.shims.map(shim => shim.name).sort(), ['pnpm', 'pnpm.cmd'])
  assert.match(plan.shims.find(shim => shim.name === 'pnpm.cmd').content, /pnpm\.cjs/)
})

test('existing dsh and pnpm stay on the unmodified path when no pnpm entry is needed', () => {
  const plan = planSmokeRuntime({ env: { PATH: '/usr/bin' }, execPath: '/usr/bin/node', platform: 'linux', hasCommand: () => true, exists: () => false })
  assert.equal(plan.env.DSH_VERSION, undefined)
  assert.equal(plan.env.DSH_PNPX, undefined)
  assert.equal(plan.shims.length, 0)
  assert.equal(plan.env.PATH, '/usr/bin')
})

test('explicit DSH version and launcher are preserved while internal pnpm is still guaranteed', () => {
  const execPath = 'C:/runtime/dependencies/node/bin/node.exe'
  const pnpm = managedPnpm(execPath)
  const plan = planSmokeRuntime({
    env: { DSH_VERSION: '1.2.3', DSH_PNPX: 'custom-pnpx' },
    execPath,
    platform: 'win32',
    hasCommand: command => command === 'dsh',
    exists: path => path === pnpm,
  })
  assert.equal(plan.env.DSH_VERSION, '1.2.3')
  assert.equal(plan.env.DSH_PNPX, 'custom-pnpx')
  assert.equal(plan.pnpmEntry, pnpm)
  assert.ok(plan.shims.length > 0)
})

test('missing pnpm fails during preflight with an actionable error', () => {
  assert.throws(() => planSmokeRuntime({ env: {}, execPath: '/missing/node', hasCommand: () => false, exists: () => false }), /PNPM_NOT_FOUND.*DSH_PNPM/)
})
