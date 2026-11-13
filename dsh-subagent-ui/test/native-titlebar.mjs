import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { platform } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { pnpmEntry, smokeRoot } from './smoke-runtime.mjs'
import { OwnedTree } from './owned-processes.mjs'

const execFileAsync = promisify(execFile)
const scriptPath = fileURLToPath(import.meta.url)
const here = dirname(scriptPath)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const ELECTRON_VERSION = '42.4.0'
const progressPath = join(smokeRoot({ projectRoot: resolve(here, '..') }), 'native-titlebar-progress.log')
const note = stage => {
  if (!process.env.DSH_NATIVE_PROGRESS) return
  mkdirSync(dirname(progressPath), { recursive: true })
  appendFileSync(progressPath, `${new Date().toISOString()} pid=${process.pid} ${stage}\n`)
}

async function launchElectron() {
  note('launch-enter')
  const entry = pnpmEntry()
  if (!entry) throw new Error('PNPM_NOT_FOUND: set DSH_PNPM to run the native Electron titlebar test')
  const command = process.execPath
  const runId = randomUUID()
  const marker = `--dsh-native-run=${runId}`
  const args = process.versions.electron
    ? [scriptPath, marker]
    : [entry, 'dlx', '--allow-build=electron', `electron@${ELECTRON_VERSION}`, scriptPath, marker]
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  note('launch-spawn')
  const child = spawn(command, args, { stdio: 'inherit', env, windowsHide: true })
  const tree = new OwnedTree(child, { home: runId })
  let timer
  let outcome
  try {
    await tree.capture()
    outcome = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve({ code, signal }))
      }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 60000) }),
    ])
    if (outcome.timeout) throw new Error('NATIVE_ELECTRON_TIMEOUT')
  } finally {
    clearTimeout(timer)
    await tree.stop()
  }
  if (outcome.signal) throw new Error(`native Electron test terminated by ${outcome.signal}`)
  process.exitCode = outcome.code ?? 1
}

async function runElectron() {
  const { app, BrowserWindow } = await import('electron')
  let win
  let cdp
  let timeout
  try {
    note('electron-enter')
    const clientSource = readFileSync(join(here, '../lib/client.js'), 'utf8')
    const closeRule = /\.dsh-sam-close\{([^}]*)\}/.exec(clientSource)
    assert.ok(closeRule, 'built close-button rule exists')
    const declarations = closeRule[1]
    note('app-ready-wait')
    await Promise.race([
      app.whenReady(),
      sleep(10000).then(() => { throw new Error('Electron app readiness timed out; use an interactive Windows desktop') }),
    ])
    note('window-create')
    win = new BrowserWindow({
      width: 971, height: 900, minWidth: 520, minHeight: 600, x: 100, y: 100,
      show: false, alwaysOnTop: true,
      titleBarStyle: 'hidden', titleBarOverlay: { height: 40, color: '#f9fafb', symbolColor: '#0f1115' },
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: true },
    })
    timeout = setTimeout(() => { console.error('DSH_NATIVE_TITLEBAR_TIMEOUT'); app.exit(2) }, 45000)
    note('window-load')
    await win.loadFile(join(here, 'fixtures/native-titlebar/index.html'))
    note('window-loaded')
    win.show()
    win.focus()
    await sleep(250)
    cdp = win.webContents.debugger
    cdp.attach('1.3')
    const send = (method, params = {}) => cdp.sendCommand(method, params)
    const evaluate = async expression => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (response.exceptionDetails) throw new Error('Native fixture evaluation failed')
      return response.result.value
    }
    await send('Runtime.enable')
    await evaluate(`document.getElementById('close').style.cssText = ${JSON.stringify(declarations)}; true`)
    await sleep(100)
    const rect = await evaluate(`(() => { const r = document.getElementById('close').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, appRegion: getComputedStyle(document.getElementById('close')).webkitAppRegion || null, popoverOpen: document.getElementById('backdrop').matches(':popover-open') } })()`)
    const x = Math.round(rect.left + rect.width / 2)
    const points = { upper: { x, y: Math.round(rect.top + 4) }, center: { x, y: Math.round(rect.top + rect.height / 2) }, lower: { x, y: Math.round(rect.bottom - 4) } }
    const nativeHandle = win.getNativeWindowHandle().readBigUInt64LE(0).toString()
    const nativeHit = async point => {
      const content = win.getContentBounds()
      const screenX = Math.round(content.x + point.x)
      const screenY = Math.round(content.y + point.y)
      const { stdout } = await execFileAsync('pwsh.exe', ['-NoProfile', '-File', join(here, 'fixtures/native-titlebar/native-hit.ps1'), '-Handle', nativeHandle, '-X', String(screenX), '-Y', String(screenY)], { encoding: 'utf8', timeout: 5000 })
      return JSON.parse(stdout.trim())
    }
    const measure = async (name, point, expected) => {
      note(`measure-${name}`)
      const native = await nativeHit(point)
      if (String(native.rootWindow) !== nativeHandle) throw new Error(`NATIVE_WINDOW_MISMATCH: ${name}`)
      return { name, point, screenPoint: { x: native.x, y: native.y }, hitWindow: native.hitWindow, expected, actual: native.hitTest, pass: native.hitTest === expected }
    }
    const results = []
    results.push(await measure('patched-upper', points.upper, 1))
    results.push(await measure('patched-center', points.center, 1))
    results.push(await measure('patched-lower', points.lower, 1))
    await evaluate(`document.getElementById('close').style.removeProperty('-webkit-app-region'); true`)
    await sleep(100)
    results.push(await measure('negative-control-without-no-drag-upper', points.upper, 2))
    await evaluate(`document.getElementById('close').style.setProperty('-webkit-app-region', 'no-drag'); true`)
    await sleep(100)
    results.push(await measure('restored-no-drag-upper', points.upper, 1))
    await evaluate(`document.getElementById('backdrop').hidePopover(); document.getElementById('drag-control').style.display = 'block'; true`)
    await sleep(100)
    const control = await evaluate(`(() => { const r = document.getElementById('drag-control').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 4 } })()`)
    results.push(await measure('negative-control-native-drag', control, 2))
    assert.ok(results.every(result => result.pass), JSON.stringify(results))
    note('complete')
    console.log('DSH_NATIVE_TITLEBAR=' + JSON.stringify({ verdict: 'PASS', declarations, rect, results }))
    clearTimeout(timeout)
    cdp.detach()
    win.destroy()
    app.exit(0)
  } catch (error) {
    note('error')
    if (timeout) clearTimeout(timeout)
    console.error('DSH_NATIVE_TITLEBAR_ERROR=' + String(error?.stack || error))
    try { if (cdp) cdp.detach() } catch {}
    try { if (win && !win.isDestroyed()) win.destroy() } catch {}
    app.exit(1)
  }
}

if (platform() !== 'win32') console.log('SKIP native-titlebar: Windows only')
else if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== '1') void runElectron()
else await launchElectron()
