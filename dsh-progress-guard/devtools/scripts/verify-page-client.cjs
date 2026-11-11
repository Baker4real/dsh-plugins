// Real Chromium DOM coverage for the authenticated page protocol; no user profile is read.
const { app, BrowserWindow, protocol } = require('electron');
const desktop = process.argv.includes('--desktop');
if (desktop) protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const { createServer } = require('node:http');
const { readFile, mkdir, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const evidence = process.argv[2];
if (!evidence || !/^[D-d]:[\\/]/.test(evidence)) throw new Error('Absolute D: evidence directory required');
app.setPath('userData', join(evidence, 'isolated-browser-data'));
let window, server, bridge, dispose, shuttingDown = false;
const checks = [];
const timer = setTimeout(() => { console.error('PAGE_FIXTURE_TIMEOUT'); app.exit(1); }, 20000);
async function run() {
  await mkdir(evidence, { recursive: true });
  const { PageBridge, registerPageRoutes } = await import(pathToFileURL(resolve(__dirname, '../page-bridge.js')).href);
  bridge = new PageBridge({ timeoutMs: 2000, pollMs: 100 });
  const routes = new Map();
  dispose = registerPageRoutes({ fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path); } } }, bridge, { desktopForwarding: desktop });
  server = createServer(async (req, res) => {
    try {
      const route = routes.get(req.url);
      if (!route) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><body><button class="trigger" aria-expanded="false">Open fixture</button><div class="panel" hidden>Fixture panel</div></body></html>'); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      const response = await route.fetch(new Request(`http://dsh.internal${req.url}`, { method: req.method, body, headers: req.headers }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const hostUrl = `http://127.0.0.1:${server.address().port}/`;
  const url = desktop ? 'dsh-app://app/' : hostUrl;
  await app.whenReady();
  if (desktop) protocol.handle('dsh-app', async request => {
    const source = new URL(request.url);
    const target = new URL(hostUrl); target.pathname = source.pathname;
    const headers = new Headers(request.headers); headers.delete('origin'); headers.delete('host');
    try {
      const response = await fetch(target, { method: request.method, headers, body: request.body, duplex: 'half' });
      return new Response(response.body, { status: response.status, headers: response.headers });
    } catch (error) {
      if (!shuttingDown) throw error;
      return new Response(null, { status: 503 });
    }
  });
  window = new BrowserWindow({ width: 640, height: 480, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(url);
  await window.webContents.executeJavaScript(`window.__fixture = { registrations: new Map(), cleanups: [], state: { sessionId: 'fixture-session' } };
    window.__ModuleLoader__ = { load(declaration) {
      const fixture = window.__fixture;
      const effect = fn => { const clean = fn(); if (typeof clean === 'function') fixture.cleanups.push(clean); return clean; };
      const modules = { manifest: { modules: [{id:'fixture-ui',rev:'a'}] }, entries: {state:{getSnapshot:()=>({syncing:false,failures:[]})}} };
      const sessions = {list:{getSnapshot:()=>({byId:{[fixture.state.sessionId]:{id:fixture.state.sessionId,retainedBy:{mainView:1}}}})}};
      const ctx = {get:key=>({modules,sessions,layout:{panelInfo:{getSnapshot:()=>({activePanelId:null})}}})[key],effect,slots:{onEntryError:()=>()=>{},entriesOfSlot:()=>[]},inject:(_keys,fn)=>fn({effect,cordisInspect:{register:p=>{fixture.registrations.set(p.manifest.id,p);return ()=>{};}}})};
      declaration.factory().apply(ctx);
      fixture.inspect = input => fixture.registrations.get('Page').query('inspect', input);
    }};
    document.querySelector('.trigger').addEventListener('click', event => { const panel=document.querySelector('.panel');panel.hidden=!panel.hidden;event.currentTarget.setAttribute('aria-expanded',String(!panel.hidden)); });`);
  await window.webContents.executeJavaScript(await readFile(join(__dirname, '../client.js'), 'utf8'));
  const inspect = selector => window.webContents.executeJavaScript(`window.__fixture.inspect(${JSON.stringify({ url, sessionId: 'fixture-session', selector })})`);
  let before = await inspect('.trigger');
  assert.equal(before.element.visible, true);
  const clicked = await bridge.click(before.page, { selector: '.trigger', elementToken: before.element.token });
  assert.equal(clicked.status, 'clicked');
  assert.equal((await inspect('.panel')).element.visible, true);
  checks.push('bound-click-changes-real-DOM');
  const stale = await bridge.click(before.page, { selector: '.trigger', elementToken: before.element.token });
  assert.notEqual(stale.status, 'clicked');
  assert.equal((await inspect('.panel')).element.visible, true);
  checks.push('old-state-token-rejected');
  before = await inspect('.trigger');
  await window.webContents.executeJavaScript(`document.querySelector('.trigger').style.marginLeft='40px'`);
  assert.notEqual((await bridge.click(before.page, { selector: '.trigger', elementToken: before.element.token })).status, 'clicked');
  checks.push('old-layout-token-rejected');
  await window.webContents.executeJavaScript(`document.querySelector('.trigger').style.marginLeft='10000px'`);
  assert.equal((await inspect('.trigger')).element.visible, false);
  checks.push('offscreen-is-not-visible');
  await window.webContents.executeJavaScript(`document.querySelector('.trigger').style.marginLeft='40px'; document.querySelector('.trigger').style.opacity='0'`);
  assert.equal((await inspect('.trigger')).element.visible, false);
  checks.push('transparent-is-not-visible');
  await window.webContents.executeJavaScript(`document.querySelector('.trigger').style.opacity='1'`);
  before = await inspect('.trigger');
  await window.webContents.executeJavaScript(`const old=document.querySelector('.trigger');old.replaceWith(old.cloneNode(true))`);
  assert.notEqual((await bridge.click(before.page, { selector: '.trigger', elementToken: before.element.token })).status, 'clicked');
  checks.push('replaced-element-token-rejected');
  before = await inspect('.trigger');
  await window.webContents.executeJavaScript(`window.__fixture.state.sessionId='different-session'`);
  assert.notEqual((await bridge.click(before.page, { selector: '.trigger', elementToken: before.element.token })).status, 'clicked');
  checks.push('session-change-rejected');
  const report = { status: 'passed', electron: process.versions.electron, pageOrigin: url, checks, actualGUI: false, authenticationAdmission: 'not-covered-by-fixture', scope: 'isolated real Chromium DOM and page-protocol route callbacks; production connection authentication is separate' };
  await writeFile(join(evidence, 'page-client.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
run().then(async () => { clearTimeout(timer); shuttingDown = true; window?.destroy(); bridge?.dispose(); await dispose?.(); server?.closeAllConnections(); server?.close(); app.exit(0); }, async error => { clearTimeout(timer); console.error(error.stack); window?.destroy(); bridge?.dispose(); await dispose?.(); server?.closeAllConnections(); server?.close(); app.exit(1); });
