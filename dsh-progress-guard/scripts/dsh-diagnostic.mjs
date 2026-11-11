import { spawn, execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const installedDesktop = 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe';
const installedProfile = 'C:/Users/WINDOWS/.dsh/profiles/desktop';
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const boundedError = error => redactDiagnosticText(String(error?.message ?? error)).slice(0, 600);

export function redactDiagnosticText(value) {
  return String(value)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gi, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:cookie|set-cookie|authorization|proxy-authorization)\s*:).*$/gim, '$1 [REDACTED]')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|apikey|auth)=)[^&#\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/(["']?\b(?:token|access_token|refresh_token|api[_-]?key|apikey|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, (_match, prefix) => `${prefix}[REDACTED]`)
    .replace(/\bsk-[A-Za-z0-9_-]+\b/gi, '[REDACTED_API_KEY]');
}

export function readDiagnosticLog(path) {
  return redactDiagnosticText(readFileSync(path, 'utf8'));
}

export function createDiagnosticLog({ directory, write } = {}) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'desktop.log');
  writeFileSync(path, '', { flag: 'wx', encoding: 'utf8' });
  const pending = new Map();
  const sink = {
    path,
    write(value) {
      const safe = redactDiagnosticText(value);
      appendFileSync(path, safe, 'utf8');
      write?.(safe);
    },
    stream(label) {
      pending.set(label, '');
      return chunk => {
        const next = pending.get(label) + chunk.toString('utf8');
        const lines = next.split(/(?<=\n)/);
        const tail = lines.at(-1).endsWith('\n') ? '' : lines.pop();
        pending.set(label, tail);
        if (tail.length > 65536) {
          pending.set(label, '');
          sink.write(`[${label}] [oversized unterminated log line discarded]\n`);
        }
        if (lines.length) sink.write(lines.map(line => `[${label}] ${line}`).join(''));
      };
    },
    flush() {
      for (const [label, tail] of pending) {
        if (tail) sink.write(`[${label}] ${tail}\n`);
        pending.set(label, '');
      }
    },
  };
  return sink;
}

export async function prepareIsolatedHome({ sourceProfile = installedProfile, directory, plugins } = {}) {
  if (!isAbsolute(directory)) throw new Error('Isolated home requires an absolute directory.');
  const source = JSON.parse(readFileSync(join(sourceProfile, 'package.json'), 'utf8'));
  const installed = source.dsh?.profile?.bundles;
  if (!Array.isArray(installed) || installed.some(value => typeof value !== 'string')) throw new Error('The source profile has no valid bundle list.');
  if (plugins !== undefined) {
    if (!Array.isArray(plugins) || plugins.some(value => typeof value !== 'string') || new Set(plugins).size !== plugins.length) throw new Error('Plugins must be unique package names.');
    for (const plugin of plugins) if (!installed.includes(plugin)) throw new Error('A requested plugin is not installed in the source profile.');
  }
  const selected = plugins === undefined ? installed : [...new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...plugins])];
  const manifest = { ...source, dependencies: {}, dsh: { ...source.dsh, profile: { ...source.dsh.profile, bundles: selected } } };
  mkdirSync(directory, { recursive: false });
  const profile = join(directory, 'profiles', 'desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const name of ['cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']) {
    if (existsSync(join(sourceProfile, name))) copyFileSync(join(sourceProfile, name), join(profile, name));
  }
  return directory;
}

export async function reserveDebugPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

export async function isPortOpen(port, { timeoutMs = 400 } = {}) {
  return new Promise(resolveResult => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = result => {
      socket.destroy();
      resolveResult(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('A valid spawned process PID is required.');
  const script = `$item=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($null -eq $item) { throw 'Process not found' }; [pscustomobject]@{ processId=[int]$item.ProcessId; startedAt=$item.CreationDate.ToUniversalTime().ToString('o'); executable=$item.ExecutablePath; commandLine=$item.CommandLine } | ConvertTo-Json -Compress`;
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', 'D:/Codex/.codex/scripts/Invoke-CheckedPowerShell.ps1', '-CommandText', script], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  return JSON.parse(stdout);
}

export async function assertOwnedDesktopProcess({ pid, runtime, port, userData, launchedAfter, readIdentity = readProcessIdentity }) {
  const identity = await readIdentity(pid);
  const samePath = String(identity.executable).replaceAll('/', '\\').toLowerCase() === realpathSync(runtime).replaceAll('/', '\\').toLowerCase();
  const startedAt = Date.parse(identity.startedAt);
  const commandLine = String(identity.commandLine).toLowerCase();
  const userDataArgument = `--user-data-dir=${userData}`.replaceAll('/', '\\').toLowerCase();
  if (identity.processId !== pid || !samePath || !Number.isFinite(startedAt) || startedAt < launchedAfter - 2000 || startedAt > Date.now() + 5000 || !commandLine.includes(userDataArgument) || !commandLine.includes(`--remote-debugging-port=${port}`)) {
    throw new Error('The desktop process identity or isolated launch arguments do not match this diagnostic launch.');
  }
  return { pid, startedAt: identity.startedAt, executable: identity.executable, userData };
}

export function assertOwnedDebugTarget({ target, ownedPageIds, port }) {
  if (!target || target.type !== 'page' || !String(target.url).startsWith('dsh-app:')) throw new Error('The debug endpoint did not expose the expected page URL.');
  const id = target.id ?? String(target.webSocketDebuggerUrl).split('/').at(-1);
  if (!ownedPageIds.has(id)) throw new Error('The debug page is not owned by this diagnostic launch; foreign debug pages are not inspected.');
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port || !url.pathname.startsWith('/devtools/page/')) throw new Error('Unexpected renderer debugger address.');
  return target;
}

export async function stopOwnedDesktop(child, {
  port, isOwned, killTree, isAlive, waitForExit, isPortOpen: probePort = isPortOpen, timeoutMs = 8000,
} = {}) {
  const alive = isAlive ?? (() => child.exitCode === null && child.signalCode === null);
  if (!alive()) return { closed: true, portReleased: !await probePort(port) };
  if (alive()) {
    if (typeof isOwned !== 'function') throw new Error('Process ownership must be verified before teardown.');
    if (!await isOwned()) throw new Error('Refusing to stop a process that is not owned by this launch.');
    const kill = killTree ?? (async () => {
      await execute(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000, maxBuffer: 65536 });
    });
    await kill();
  }
  const wait = waitForExit ?? (() => new Promise((resolveExit, reject) => {
    if (!alive()) return resolveExit();
    const timer = setTimeout(() => reject(new Error('The owned desktop did not close after teardown.')), timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolveExit(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  }));
  await wait();
  if (alive()) throw new Error('The owned desktop is still running after teardown.');
  const deadline = Date.now() + timeoutMs;
  while (await probePort(port)) {
    if (Date.now() >= deadline) throw new Error('The owned desktop debug port remains open after teardown.');
    await delay(50);
  }
  return { closed: true, portReleased: true };
}

async function fetchJson(url, timeoutMs = 1000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('The local debug endpoint returned a non-success response.');
  return response.json();
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out.')), 2000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed.')); }, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error('The renderer rejected a diagnostic command.'));
      else request.resolve(message.result);
      return;
    }
    if (exceptions.length < 20 && ['Runtime.exceptionThrown', 'Log.entryAdded', 'Inspector.targetCrashed'].includes(message.method)) {
      const detail = message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? message.params?.entry?.text ?? message.method;
      exceptions.push({ event: message.method, detail: redactDiagnosticText(detail).slice(0, 400), platform: 'renderer' });
    }
  });
  return {
    exceptions,
    events: socket,
    call(method, params = {}, timeoutMs = 2500) {
      return new Promise((resolveCall, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Renderer did not answer the diagnostic command.')); }, timeoutMs);
        pending.set(id, { resolve: resolveCall, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP connection closed.')); }
      pending.clear();
      socket.close();
    },
  };
}

async function rendererState(cdp) {
  const expression = `(() => ({
    readyState: document.readyState,
    loading: document.body?.innerText.includes('Loading plugins') ?? true,
    documentHasContent: (document.body?.innerText.length ?? 0) > 0,
    hasModuleLoader: Boolean(window.__ModuleLoader__),
    moduleLoaderMode: typeof window.__ModuleLoader__?.mode === 'string' ? window.__ModuleLoader__.mode : null,
    pendingQueueLength: Number.isFinite(window.__ModuleLoader__?.pendingQueue?.length) ? window.__ModuleLoader__.pendingQueue.length : null,
    bodyElementCount: document.body?.children.length ?? 0
  }))()`;
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error('The renderer state probe raised an exception.');
  const state = result.result?.value;
  if (!state || typeof state.loading !== 'boolean') throw new Error('The renderer state probe returned no usable state.');
  return state;
}

export async function diagnoseDesktop({
  runtime = process.env.DSH_DESKTOP_EXE ?? installedDesktop,
  sourceProfile = installedProfile,
  workRoot = join('D:/Codex/temp/dsh-gui-diagnostics', `run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`),
  plugins, timeoutMs = 30000,
  spawnProcess = spawn, readIdentity, write, stopOptions = {},
} = {}) {
  if (!isAbsolute(workRoot)) throw new Error('--work-root must be an absolute path.');
  runtime = realpathSync(runtime);
  mkdirSync(workRoot, { recursive: false });
  const home = await prepareIsolatedHome({ sourceProfile, directory: join(workRoot, 'home'), plugins });
  const userData = join(workRoot, 'user-data');
  mkdirSync(userData);
  const log = createDiagnosticLog({ directory: join(workRoot, 'logs'), write });
  const port = await reserveDebugPort();
  if (await isPortOpen(port)) throw new Error('The allocated debug port is already occupied.');
  const launchedAfter = Date.now();
  const child = spawnProcess(runtime, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    cwd: workRoot, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let spawnError;
  let exited = false;
  child.once('error', error => { spawnError = error; });
  child.once('exit', () => { exited = true; });
  child.stdout.on('data', log.stream('stdout'));
  child.stderr.on('data', log.stream('stderr'));
  const owned = () => assertOwnedDesktopProcess({ pid: child.pid, runtime, port, userData, launchedAfter, readIdentity });
  let browser;
  let renderer;
  let outcome;
  try {
    const identity = await owned();
    let attached = false;
    log.write('[diagnostic] main-process identity confirmed; main stdout/stderr are collected in the redacted log\n');
    const deadline = Date.now() + timeoutMs;
    let page;
    while (!page) {
      if (spawnError) throw new Error('The isolated desktop could not be started.');
      if (exited) throw new Error('The isolated desktop exited before exposing its page.');
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the isolated application page.');
      try {
        await owned();
        await fetchJson(`http://127.0.0.1:${port}/json/version`);
        const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
        const candidate = targets.find(target => target.type === 'page' && String(target.url).startsWith('dsh-app:'));
        if (candidate) {
          const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
          browser = await connectCdp(version.webSocketDebuggerUrl);
          attached = true;
          const targetList = await browser.call('Target.getTargets');
          await owned();
          const ownedPageIds = new Set(targetList.targetInfos.filter(target => target.type === 'page').map(target => target.targetId));
          page = assertOwnedDebugTarget({ target: candidate, ownedPageIds, port });
        }
      } catch (error) {
        if (attached) throw error;
        if (Date.now() >= deadline) throw error;
        await delay(150);
      }
    }
    renderer = await connectCdp(page.webSocketDebuggerUrl);
    await renderer.call('Runtime.enable');
    await renderer.call('Log.enable');
    await renderer.call('Page.enable');
    const loaded = Promise.withResolvers();
    renderer.events.addEventListener('message', ({ data }) => {
      if (JSON.parse(data).method === 'Page.loadEventFired') loaded.resolve();
    });
    const initial = await renderer.call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (initial.result?.value !== 'complete') {
      await Promise.race([
        loaded.promise,
        delay(Math.min(5000, Math.max(1, deadline - Date.now()))).then(() => { throw new Error('The renderer load event was not observed before its deadline.'); }),
      ]);
    }
    let state;
    while (Date.now() < deadline) {
      state = await rendererState(renderer);
      if (state.readyState === 'complete' && !state.loading && state.documentHasContent) break;
      await delay(150);
    }
    if (!state || state.readyState !== 'complete' || state.loading || !state.documentHasContent) throw new Error('The renderer is still on the plugin loading page or has no content at the diagnostic deadline.');
    await owned();
    outcome = { schemaVersion: 1, status: 'ready', process: identity, port, page: { owned: true, rendererAlive: true, ...state }, diagnostics: { rendererExceptions: renderer.exceptions, logPath: log.path }, isolation: { home, userData, plugins: plugins ?? 'installed-profile' }, teardown: { closed: false, portReleased: false } };
  } catch (error) {
    outcome = { schemaVersion: 1, status: 'failed', error: boundedError(error), process: { pid: child.pid }, port, diagnostics: { rendererExceptions: renderer?.exceptions ?? [], logPath: log.path }, isolation: { home, userData, plugins: plugins ?? 'installed-profile' }, teardown: { closed: false, portReleased: false } };
  } finally {
    renderer?.close();
    browser?.close();
    try {
      const cleanup = await stopOwnedDesktop(child, { port, isOwned: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        await owned();
        return true;
      }, ...stopOptions });
      log.write(`[diagnostic] teardown=${JSON.stringify(cleanup)}\n`);
      if (outcome) outcome.teardown = cleanup;
    } catch (error) {
      log.write(`[diagnostic] teardown failed: ${boundedError(error)}\n`);
      if (outcome) outcome.cleanupError = boundedError(error);
    } finally {
      log.flush();
    }
  }
  if (outcome.cleanupError) outcome.status = 'cleanup-failed';
  return outcome;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--runtime', '--source-profile', '--work-root', '--plugin', '--timeout-ms'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--plugin') (options.plugins ??= []).push(value);
    else {
      const name = { '--runtime': 'runtime', '--source-profile': 'sourceProfile', '--work-root': 'workRoot', '--timeout-ms': 'timeoutMs' }[key];
      if (Object.hasOwn(options, name)) throw new Error(`Duplicate argument: ${key}`);
      options[name] = key === '--timeout-ms' ? Number(value) : value;
    }
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 120000)) throw new Error('--timeout-ms must be between 1000 and 120000.');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try { result = await diagnoseDesktop(parseArgs(process.argv.slice(2))); }
  catch (error) { result = { schemaVersion: 1, status: 'failed', error: boundedError(error) }; }
  process.stdout.write(`${redactDiagnosticText(JSON.stringify(result))}\n`);
  process.exitCode = result.status === 'ready' ? 0 : 1;
}
