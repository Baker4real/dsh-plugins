import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, symlink, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../scripts/check-local-bundle.mjs");
const evidence = resolve(here, "../../../../run-evidence/dsh-compaction-256k/check-fixtures");
const runtimeNode = process.env.npm_node_execpath || process.execPath;
const runtimeNodeVersion = spawnSync(runtimeNode, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const dependencies = resolve(dirname(runtimeNode), "../..");

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function fixture(hostProjectionVersion = "0.2.2-rc.1", checkExit = 0) {
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(join(evidence, "gate-"));
  const resources = join(root, "resources");
  const project = join(root, "project");
  const sdk = "@deepseek-ai/dsh-session-projection";
  await json(join(resources, "app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json"), { name: "@deepseek-ai/dsh", version: "0.2.2-rc.1" });
  await json(join(resources, "app.asar/dsh/node_modules", sdk, "package.json"), { name: sdk, version: hostProjectionVersion });
  await json(join(project, "node_modules", sdk, "package.json"), { name: sdk, version: "0.2.2-rc.1" });
  await json(join(project, "package.json"), { name: "test-local-bundle", version: "1.0.0", scripts: { check: "node check.cjs" }, devDependencies: { [sdk]: "0.2.2-rc.1" } });
  await writeFile(join(project, "check.cjs"), `require('node:fs').writeFileSync('checked.txt', process.version); process.exit(${checkExit});`);
  const dependencyRoot = join(resources, "runtime/primary-runtime/dependencies");
  await mkdir(dependencyRoot, { recursive: true });
  // Directory symlinks also work when the bundled runtime and D: fixture are on different volumes.
  for (const name of ["node", "pnpm"]) await symlink(join(dependencies, name), join(dependencyRoot, name), "dir");
  return { root, resources, project, marker: join(project, "checked.txt") };
}

test("the check CLI rejects a host SDK mismatch before running the project's checks", async () => {
  const f = await fixture("0.2.3");
  const result = spawnSync(process.execPath, [cli, "--resources", f.resources, "--project-root", f.project], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /host\/test version mismatch.*dsh-session-projection/);
  await assert.rejects(access(f.marker));
});

test("the check CLI runs the existing check with bundled Node and reports the exact host/test versions", async () => {
  const f = await fixture();
  const result = spawnSync(process.execPath, [cli, "--resources", f.resources, "--project-root", f.project], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "passed");
  assert.equal(report.hostVersion, "0.2.2-rc.1");
  assert.equal(report.testDependencyVersions["@deepseek-ai/dsh-session-projection"], "0.2.2-rc.1");
  assert.equal(report.nodeVersion, runtimeNodeVersion);
  await access(f.marker);
});

test("the check CLI runs through an alias after its source directory moves", async () => {
  const f = await fixture();
  const entryAlias = join(f.root, "check-entry.mjs");
  await symlink(cli, entryAlias, "file");
  const result = spawnSync(process.execPath, [entryAlias, "--resources", f.resources, "--project-root", f.project], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), "", "The aliased CLI must execute, not silently skip its entry point.");
  assert.equal(JSON.parse(result.stdout).status, "passed");
  await access(f.marker);
});

test("a failed project check exits nonzero and never emits a passed report", async () => {
  const f = await fixture("0.2.2-rc.1", 7);
  const result = spawnSync(process.execPath, [cli, "--resources", f.resources, "--project-root", f.project], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pnpm run check failed/);
  assert.doesNotMatch(result.stdout, /"status":\s*"passed"/);
  await access(f.marker);
});

test("a still-running older host cannot accept validation against a newly installed runtime", async () => {
  const f = await fixture();
  const result = spawnSync(process.execPath, [cli, "--resources", f.resources, "--project-root", f.project, "--expected-host-version", "0.2.1"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /running\/installed host version mismatch/);
  await assert.rejects(access(f.marker));
});
