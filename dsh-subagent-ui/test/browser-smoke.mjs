// End-to-end acceptance in a real DSH Web server and Chromium. One command owns
// the isolated server, browser, temporary DSH_HOME and cleanup. The one-time
// authentication URL is parsed from stdout in memory and is never persisted.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { materializeSmokeRuntime, planSmokeRuntime, smokeRoot } from './smoke-runtime.mjs'
import { OwnedTree } from './owned-processes.mjs'

const root = resolve(process.cwd())
const scratch = smokeRoot({ projectRoot: root })
const PARENT_A = 'session-ui-smoke-parent-a'
const PARENT_B = 'session-ui-smoke-parent-b'
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
const sanitize = text => String(text).replace(/https?:\/\/[^\s"'<>]+/g, '<url>')

async function waitFor(read, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(`Timed out: ${description}${lastError ? ` (${lastError.message})` : ''}`)
}

function browserExecutable() {
  if (process.env.DSH_BROWSER) return process.env.DSH_BROWSER
  const candidates = platform() === 'win32'
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      ]
    : platform() === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  const executable = candidates.find(existsSync)
  if (!executable) throw new Error('No Chromium browser found; set DSH_BROWSER to its executable')
  return executable
}

function bashExecutable() {
  if (process.env.DSH_BASH) return process.env.DSH_BASH
  if (platform() === 'win32') {
    const executable = 'C:/Program Files/Git/bin/bash.exe'
    if (!existsSync(executable)) throw new Error('Git Bash is required on Windows; set DSH_BASH to bash.exe')
    return executable
  }
  return 'bash'
}

function serverUrlFrom(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '')
  const candidates = clean.match(/https?:\/\/[^\s"'<>]+/g) || []
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const url = new URL(candidates[i])
      if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') && (url.search || url.hash)) return url
    } catch {
      // Ignore log text that merely resembles a URL.
    }
  }
  return null
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 0
    this.pending = new Map()
    this.exceptions = []
    this.ready = new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error('CDP WebSocket open timed out')), 10000)
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolveOpen() }, { once: true })
      this.ws.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('CDP WebSocket failed')) }, { once: true })
    })
    this.ws.addEventListener('message', async event => {
      const raw = typeof event.data === 'string' ? event.data : await event.data.text()
      const message = JSON.parse(raw)
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params.exceptionDetails)
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`${message.error.message}: ${message.error.data || ''}`))
      else pending.resolve(message.result)
    })
    this.ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('CDP connection closed'))
      }
      this.pending.clear()
    })
  }

  async send(method, params = {}) {
    await this.ready
    const id = ++this.nextId
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectResult(new Error(`CDP timeout: ${method}`))
      }, 20_000)
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed')
    return result.result.value
  }

  close() {
    this.ws.close()
  }
}

let server
let serverTree
let browser
let browserTree
let cdp
let home
let authenticatedUrl
let serverExit = null
const serverLines = []
const note = stage => {
  if (process.env.DSH_SMOKE_PROGRESS && home) appendFileSync(join(home, 'progress.log'), `${new Date().toISOString()} ${stage}\n`)
}

try {
  if (!existsSync(join(root, 'package.json')) || !existsSync(join(root, 'test.sh'))) throw new Error('Run from the dsh-subagent-ui repository root')
  const bash = bashExecutable()
  const browserBinary = browserExecutable()
  const hasCommand = command => spawnSync(bash, ['-lc', `command -v ${command}`], { stdio: 'ignore', timeout: 2000, windowsHide: true }).status === 0
  const runtimePlan = planSmokeRuntime({ hasCommand })
  await mkdir(scratch, { recursive: true })
  home = await mkdtemp(join(scratch, 'run-'))
  const runtime = await materializeSmokeRuntime(runtimePlan, join(home, 'runtime-bin'))
  const artifacts = join(scratch, 'artifacts', basename(home))
  await mkdir(artifacts, { recursive: true })

  note('runtime-ready')
  server = spawn(bash, ['./test.sh', '0'], {
    cwd: root,
    env: { ...runtime.env, DSH_BROWSER_FIXTURE: '1', DSH_SMOKE_HOME: home, DSH_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: platform() !== 'win32',
    windowsHide: true,
  })
  serverTree = new OwnedTree(server, { home })
  server.once('exit', (code, signal) => { serverExit = { code, signal } })
  let input = ''
  const readServer = chunk => {
    input += chunk.toString()
    const lines = input.split(/\r?\n/)
    input = lines.pop() || ''
    for (const line of lines) {
      const found = serverUrlFrom(line)
      if (found && !authenticatedUrl) { authenticatedUrl = found; note('server-ready') }
      else if (line.trim()) serverLines.push(sanitize(line))
    }
    if (serverLines.length > 100) serverLines.splice(0, serverLines.length - 100)
  }
  server.stdout.on('data', readServer)
  server.stderr.on('data', readServer)
  await serverTree.capture()
  authenticatedUrl = await waitFor(() => {
    if (serverExit) throw new Error(`DSH server exited before readiness: ${JSON.stringify(serverExit)}`)
    return authenticatedUrl
  }, 'authenticated DSH Web URL', 120_000)
  await serverTree.capture()

  note('browser-launch')
  browser = spawn(browserBinary, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${join(home, 'browser-profile')}`,
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  browserTree = new OwnedTree(browser, { home })
  await browserTree.capture()

  const portFile = join(home, 'browser-profile', 'DevToolsActivePort')
  await waitFor(() => existsSync(portFile), 'Chromium DevToolsActivePort')
  const port = (await readFile(portFile, 'utf8')).split(/\r?\n/)[0].trim()
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    const list = await response.json()
    return list.find(target => target.type === 'page' && target.webSocketDebuggerUrl)
  }, 'Chromium page target')
  note('cdp-connect')
  cdp = new Cdp(targets.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  note('cdp-ready')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

  const bootstrap = async () => {
    await cdp.send('Page.navigate', { url: authenticatedUrl.toString() })
    await waitFor(async () => cdp.evaluate("document.readyState === 'complete'"), 'DSH Web document')
    const continueDeadline = Date.now() + 10_000
    while (Date.now() < continueDeadline) {
      const hasContinue = await cdp.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '继续')
        if (!button) return false
        button.setAttribute('data-smoke-continue', '')
        return true
      })()`)
      if (!hasContinue) break
      await cdp.evaluate("document.querySelector('button[data-smoke-continue]')?.click()")
      await sleep(400)
    }
    await waitFor(async () => cdp.evaluate(`!!document.querySelector('[data-row-key="session:${PARENT_A}"]') && !!document.querySelector('[data-row-key="session:${PARENT_B}"]')`), 'fixture rows in the workspace sidebar')
  }
  const floatCount = () => cdp.evaluate("document.querySelectorAll('.dsh-sam-active-float').length")
  const itemCount = () => cdp.evaluate("document.querySelectorAll('.dsh-sam-active-item').length")
  const screenshot = async name => {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const path = join(artifacts, name)
    await writeFile(path, Buffer.from(image.data, 'base64'))
    return path
  }
  const click = async selector => {
    const point = await cdp.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return null
      node.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    assert.ok(point, `visible click target: ${selector}`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  const openSession = async sessionId => {
    const selector = `[data-row-key="session:${sessionId}"]`
    await waitFor(async () => cdp.evaluate(`(() => {
      const row = document.querySelector(${JSON.stringify(selector)})
      if (!row) return false
      const rect = row.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })()`), `sidebar row ${sessionId}`)
    await click(selector)
    await waitFor(async () => cdp.evaluate("!!document.querySelector('.dsh-sam-trigger')"), `manager after opening ${sessionId}`)
  }

  note('bootstrap')
  await bootstrap()
  note('bootstrap-ready')
  await openSession(PARENT_A)
  note('parent-a-open')
  await waitFor(async () => await floatCount() === 1, 'active float on owning main session')
  const collapseSelector = 'button.dsh-sam-active-collapse'
  const expandedState = () => cdp.evaluate(`document.querySelector(${JSON.stringify(collapseSelector)})?.getAttribute('aria-expanded')`)
  assert.strictEqual(await itemCount(), 0, 'the first mount starts without visible child rows')
  assert.strictEqual(await expandedState(), 'false', 'the first mount starts collapsed')
  assert.ok(await cdp.evaluate("document.querySelector('.dsh-sam-active-float')?.textContent.includes('活跃子代理')"), 'collapsed title remains visible')
  const collapsedShot = await screenshot('parent-a-collapsed.png')

  await click(collapseSelector)
  await waitFor(async () => await itemCount() === 1, 'expanded float rows')
  assert.strictEqual(await expandedState(), 'true')
  assert.ok(await cdp.evaluate("document.querySelector('.dsh-sam-active-float')?.textContent.includes('UI smoke child')"), 'fixture child label is visible after expansion')
  const expandedShot = await screenshot('parent-a-expanded.png')
  note('expanded-screenshot')

  await click(collapseSelector)
  await waitFor(async () => await itemCount() === 0, 'collapsed float rows')
  assert.strictEqual(await expandedState(), 'false')
  await click(collapseSelector)
  await waitFor(async () => await itemCount() === 1, 'expanded float rows before opening child')

  await click('.dsh-sam-active-item')
  await waitFor(async () => await floatCount() === 0, 'no main-session float in child view')
  assert.strictEqual(await floatCount(), 0, 'subagent view does not show the main session float')

  await openSession(PARENT_A)
  await waitFor(async () => await floatCount() === 1, 'float returns when the owning main session is selected again')
  await openSession(PARENT_B)
  note('parent-b-open')
  await sleep(1_000)
  assert.strictEqual(await floatCount(), 0, 'another main session in the same workspace does not show the float')
  const otherMainShot = await screenshot('parent-b.png')
  assert.deepStrictEqual(cdp.exceptions, [], 'no browser runtime exceptions')

  console.log(JSON.stringify({
    ownerMain: { float: 1, expandedRows: 1, collapsedRows: 0 },
    otherMain: { float: 0 },
    subagentView: { float: 0 },
    runtimeExceptions: 0,
    testHome: home,
    screenshots: [expandedShot, collapsedShot, otherMainShot],
  }, null, 2))
} catch (error) {
  note('error')
  const safe = sanitize(authenticatedUrl ? (error?.stack || String(error)).split(authenticatedUrl.toString()).join('<DSH_TEST_URL>') : error?.stack || String(error))
  console.error(safe)
  if (serverLines.length) console.error('Server diagnostics (URLs redacted):\n' + serverLines.slice(-30).join('\n'))
  if (cdp) {
    try {
      const diagnostic = await cdp.evaluate(`({
        path: location.pathname,
        manager: !!document.querySelector('.dsh-sam-trigger'),
        inputs: [...document.querySelectorAll('input')].map(item => ({ placeholder: item.placeholder, value: item.value })),
        rowKeys: [...document.querySelectorAll('[data-row-key]')].map(item => item.getAttribute('data-row-key')),
        globals: Object.keys(window).filter(key => /dsh|module|cordis/i.test(key)),
        bootKeys: Object.keys(window.__DSH_BOOT__ || {}),
        text: document.body?.innerText?.slice(0, 4000) || '',
      })`)
      console.error(JSON.stringify({ page: diagnostic }, null, 2))
      const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      await writeFile(join(scratch, 'artifacts', basename(home), 'failure.png'), Buffer.from(image.data, 'base64'))
    } catch {
      // Preserve the original failure when diagnostics are unavailable.
    }
  }
  process.exitCode = 1
} finally {
  note('cleanup')
  if (cdp) {
    try { await cdp.send('Browser.close') } catch { cdp.close() }
  }
  let cleanupFailed = false
  if (browserTree) {
    try { await browserTree.stop(); note('browser-stopped') }
    catch { cleanupFailed = true; note('browser-cleanup-failed'); console.error('BROWSER_SMOKE_CLEANUP_ERROR=OWNED_PROCESS_CLEANUP') }
  }
  if (serverTree) {
    try { await serverTree.stop(); note('server-stopped') }
    catch { cleanupFailed = true; note('server-cleanup-failed'); console.error('DSH_SMOKE_CLEANUP_ERROR=OWNED_PROCESS_CLEANUP') }
  }
  if (cleanupFailed) process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
