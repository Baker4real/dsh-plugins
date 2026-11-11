import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  const child = spawnSync('D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe', [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  process.stdout.write(child.stdout || '');
  if (child.status !== 0) process.stderr.write(String(child.error || child.stderr));
  process.exitCode = child.status === 0 ? 0 : 1;
} else {
  const source = resolve(dirname(script), '..');
  const manifest = JSON.parse(readFileSync(`${source}/package.json`, 'utf8'));
  const root = `D:/Codex/evidence/dsh-goal-wait-20261110/native-cold-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  const result = { status: 'running', version: manifest.version, sourceEntry: manifest.exports['.'], noRegisterHooks: true, scope: 'Native ESM public export and exact cold-entry source closure; Host SDK bare-import aliases still require actual activation.', resolved: {} };
  try {
    assert.equal(manifest.version, '1.0.1');
    assert.equal(manifest.exports['.'], './index-v2.js');
    const profile = createRequire('C:/Users/WINDOWS/.dsh/profiles/desktop/package.json');
    const host = createRequire('D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/package.json');
    function target(exported) {
      if (typeof exported === 'string') return exported;
      for (const condition of ['import', 'node', 'default']) if (exported?.[condition]) { const found = target(exported[condition]); if (found) return found; }
    }
    function nativeUrl(specifier) {
      if (specifier.startsWith('node:') || specifier.startsWith('.')) return specifier;
      if (result.resolved[specifier]) return result.resolved[specifier].url;
      let packageFile;
      let origin = 'profile';
      try { packageFile = profile.resolve(`${specifier}/package.json`); }
      catch { origin = 'provided-host-sdk'; packageFile = host.resolve(`${specifier}/package.json`); }
      const metadata = JSON.parse(readFileSync(packageFile, 'utf8'));
      const entry = target(metadata.exports?.['.'] ?? metadata.exports) ?? metadata.module ?? metadata.main;
      assert.ok(entry, `No public import export for ${specifier}`);
      const url = pathToFileURL(resolve(dirname(packageFile), entry)).href;
      result.resolved[specifier] = { origin, version: metadata.version, publicEntry: entry, url };
      return url;
    }
    // Resolve each public package export explicitly for this isolated source
    // copy. No global loader or Node resolution hook is registered, and no SDK
    // implementation or package namespace is replaced with a mock/proxy.
    for (const file of ['index-v2.js', 'index.js', 'state.js', 'receipt.js']) {
      const text = readFileSync(`${source}/${file}`, 'utf8');
      const native = text.replace(/(\bfrom\s*['"])([^'"]+)(['"])/g, (_match, before, specifier, after) => `${before}${nativeUrl(specifier)}${after}`);
      writeFileSync(`${root}/${file}`, native);
    }
    writeFileSync(`${root}/package.json`, JSON.stringify({ type: 'module' }));
    const plugin = await import(`${pathToFileURL(resolve(root, manifest.exports['.'])).href}?cold=${randomUUID()}`);
    assert.equal(typeof plugin.apply, 'function');
    const standard = plugin.Config['~standard'];
    assert.equal(typeof standard.validate, 'function');
    const defaults = standard.validate({});
    assert.deepEqual(defaults.value, { receiptRoots: [], receiptPollMs: 1000, maxReceiptSeconds: 3600 });
    for (const input of [{ receiptPollMs: 0 }, { receiptPollMs: 250.5 }, { maxReceiptSeconds: 3601 }]) assert.ok(standard.validate(input).issues?.length);
    const { Context } = await import(nativeUrl('@deepseek-ai/cordis'));
    const ctx = new Context();
    let observed;
    try { await ctx.plugin({ Config: plugin.Config, apply(_ctx, config) { observed = config; } }, {}); assert.deepEqual(observed, defaults.value); }
    finally { await ctx.fiber.dispose(); }
    result.status = 'passed'; result.defaults = defaults.value; result.coldEntryExports = Object.keys(plugin).sort(); result.invalidConfigRejected = 3;
  } catch (error) { result.status = 'failed'; result.error = String(error?.stack ?? error).slice(-6000); }
  result.reportPath = `${root}/native-import.json`;
  writeFileSync(result.reportPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
}
