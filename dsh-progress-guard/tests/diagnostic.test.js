import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:net';

const moduleUrl = new URL('../scripts/dsh-diagnostic.mjs', import.meta.url);

test('diagnostic logs redact credentials at both live streams and file reads', async () => {
  const { createDiagnosticLog, readDiagnosticLog, redactDiagnosticText } = await import(moduleUrl);
  const root = await mkdtemp(join(tmpdir(), 'dsh-log-'));
  try {
    const chunks = [];
    const log = createDiagnosticLog({ directory: root, write: text => chunks.push(text) });
    const secret = 'token=synthetic-secret&x=1';
    log.write(secret);
    const stdout = log.stream('stdout');
    stdout(Buffer.from('Authorization: Bearer synthetic-bearer\nCookie: session=synthetic-cookie\napi_key=sk-synthetic-key\n'));
    log.flush();
    assert.equal(chunks.join('').includes('synthetic'), false);
    assert.equal((await readFile(log.path, 'utf8')).includes('synthetic'), false);
    assert.equal(readDiagnosticLog(log.path).includes('synthetic'), false);
    assert.equal(redactDiagnosticText(secret).includes('synthetic'), false);
    assert.equal(redactDiagnosticText('api_key=sk-synthetic-key').includes('synthetic'), false);
    assert.equal(redactDiagnosticText('eyJhbGciOiJIUzI1NiJ9.synthetic.payload'), '[REDACTED_JWT]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('owned process teardown waits for close and its debug port to be released', async () => {
  const { stopOwnedDesktop } = await import(moduleUrl);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const child = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  child.kill = () => { server.close(); };
  const events = [];
  const result = await stopOwnedDesktop(child, {
    port,
    isOwned: async () => true,
    killTree: async () => { child.kill(); },
    isAlive: () => child.exitCode === null,
    waitForExit: async () => { child.exitCode = 0; child.emit('close', 0); events.push('closed'); },
    isPortOpen: async () => new Promise(resolve => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    }),
    timeoutMs: 500,
  });
  assert.equal(result.closed, true);
  assert.equal(result.portReleased, true);
  assert.deepEqual(events, ['closed']);
});

test('foreign or stale debug endpoints are rejected instead of inspected', async () => {
  const { assertOwnedDebugTarget } = await import(moduleUrl);
  const owned = { target: { type: 'page', url: 'dsh-app://index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/page/owned' }, ownedPageIds: new Set(['owned']), port: 1234 };
  assert.throws(() => assertOwnedDebugTarget({ ...owned, ownedPageIds: new Set(['other']) }), /not owned by this diagnostic launch/);
  assert.doesNotThrow(() => assertOwnedDebugTarget(owned));
  assert.throws(() => assertOwnedDebugTarget({ ...owned, target: { ...owned.target, url: 'https://invalid.example/' } }), /expected page URL/);
});

test('isolated home copies the profile without credentials or dependencies', async () => {
  const { prepareIsolatedHome } = await import(moduleUrl);
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-'));
  try {
    const source = join(root, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify({ dependencies: { secret: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-progress-guard'] } } }));
    await writeFile(join(source, 'cordis.patch.yml'), '[]\n');
    await writeFile(join(source, 'credentials.yaml'), 'do-not-copy: true\n');
    const home = await prepareIsolatedHome({ sourceProfile: source, directory: join(root, 'home') });
    const manifest = JSON.parse(await readFile(join(home, 'profiles/desktop/package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies, {});
    assert.equal(manifest.dsh.profile.bundles.length, 3);
    assert.equal(await readFile(join(home, 'profiles/desktop/cordis.patch.yml'), 'utf8'), '[]\n');
    await assert.rejects(() => readFile(join(home, 'profiles/desktop/credentials.yaml')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('teardown refuses to kill a foreign or reused process', async () => {
  const { stopOwnedDesktop } = await import(moduleUrl);
  const child = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  let killed = false;
  await assert.rejects(() => stopOwnedDesktop(child, { port: 1234, isOwned: async () => false, isAlive: () => true, killTree: async () => { killed = true; } }), /not owned/);
  assert.equal(killed, false);
});

test('diagnostic startup failure still tears down the owned desktop and reports closed', async () => {
  const { diagnoseDesktop, redactDiagnosticText } = await import(moduleUrl);
  const root = await mkdtemp(join(tmpdir(), 'dsh-startup-'));
  try {
    const source = join(root, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
    const child = new EventEmitter();
    Object.assign(child, { pid: 4321, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
    let killed = false;
    child.kill = () => {
      killed = true;
      child.exitCode = 0;
      child.signalCode = 'SIGTERM';
      child.emit('close', 0);
    };
    const result = await diagnoseDesktop({
      runtime: process.execPath,
      sourceProfile: source,
      workRoot: join(root, 'run'),
      spawnProcess: () => child,
      readIdentity: async pid => { throw new Error(`synthetic-identity-failure-${pid}`); },
      stopOptions: { isOwned: async () => true, killTree: async () => child.kill(), isPortOpen: async () => false },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /identity-failure/);
    assert.equal(killed, true);
    assert.deepEqual(result.teardown, { closed: true, portReleased: true });
    assert.equal(redactDiagnosticText(JSON.stringify(result)).includes('synthetic-failure-4321'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
