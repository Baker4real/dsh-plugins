import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join, resolve } from 'node:path'

const bashPath = value => String(value).replace(/\\/g, '/')

// Each smoke run keeps a whole isolated DSH_HOME and browser profile. Inside the D:\agents layout runs go under
// run-evidence so globs over the project stay small; DSH_SMOKE_ROOT overrides, other checkouts keep the old default.
export function smokeRoot({ projectRoot, env = process.env, exists = existsSync }) {
  if (env.DSH_SMOKE_ROOT) return resolve(env.DSH_SMOKE_ROOT)
  const evidence = resolve(projectRoot, '../../../run-evidence')
  return exists(evidence) ? join(evidence, 'dsh-subagent-ui', 'plugin-smoke') : join(projectRoot, '.dsh-plugin-smoke')
}

export function pnpmEntry({ env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  const candidates = [env.DSH_PNPM, env.npm_execpath]
  if (env.DSH_PNPX) candidates.push(...(env.DSH_PNPX.match(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+\.(?:cjs|mjs)/g) || []))
  candidates.push(resolve(dirname(execPath), '../../pnpm/bin/pnpm.cjs'), resolve(dirname(execPath), '../../pnpm/bin/pnpm.mjs'))
  return candidates.find(candidate => candidate && basename(String(candidate)).match(/^pnpm\.(?:cjs|mjs)$/) && exists(candidate)) || null
}

export function planSmokeRuntime({ env = process.env, execPath = process.execPath, platform = process.platform, hasCommand, exists = existsSync }) {
  const entry = pnpmEntry({ env, execPath, exists })
  if (!entry && !hasCommand('pnpm')) throw new Error('PNPM_NOT_FOUND: set DSH_PNPM to the managed pnpm.cjs or pnpm.mjs before running browser smoke')
  const next = { ...env }
  const shims = entry ? [
    ...(platform === 'win32' ? [{ name: 'pnpm.cmd', content: `@echo off\r\n"${execPath}" "${entry}" %*\r\n` }] : []),
    { name: 'pnpm', content: `#!/usr/bin/env bash\n"${bashPath(execPath)}" "${bashPath(entry)}" "$@"\n` },
  ] : []
  if (next.DSH_VERSION || !hasCommand('dsh')) {
    if (!next.DSH_VERSION) next.DSH_VERSION = 'latest'
    if (!next.DSH_PNPX) next.DSH_PNPX = 'pnpm dlx'
  }
  return { env: next, pnpmEntry: entry, shims }
}

export async function materializeSmokeRuntime(plan, binDirectory) {
  if (plan.shims.length === 0) return plan
  await mkdir(binDirectory, { recursive: true })
  for (const shim of plan.shims) await writeFile(join(binDirectory, shim.name), shim.content, { mode: 0o755 })
  const env = { ...plan.env }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  env[pathKey] = `${binDirectory}${delimiter}${env[pathKey] || ''}`
  return { ...plan, env }
}
