import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = join(projectRoot, "scripts/dsh-inspect.mjs");

async function fixture(t) {
  const resources = await mkdtemp(join(projectRoot, "tests/.dsh-inspect-"));
  t.after(async () => {
    const local = relative(join(projectRoot, "tests"), resolve(resources));
    assert.ok(local.startsWith(".dsh-inspect-") && !local.includes(sep));
    await rm(resources, { recursive: true, force: true });
  });
  const packageRoot = join(resources, "app.asar/dsh/node_modules");
  for (const [name, manifest] of Object.entries({
    "@deepseek-ai/dsh": { name: "@deepseek-ai/dsh", version: "0.2.2-rc.1" },
    "@deepseek-ai/dsh-session-projection": {
      name: "@deepseek-ai/dsh-session-projection", version: "0.2.2-rc.1",
      exports: { ".": { types: "./lib/types/index.d.ts", import: "./lib/index.js" } },
      license: "UNRELATED-MANIFEST-FIELD",
    },
    zod: { name: "zod", version: "4.4.3", main: "./index.cjs", types: "./index.d.cts" },
  })) {
    await mkdir(join(packageRoot, name), { recursive: true });
    await writeFile(join(packageRoot, name, "package.json"), JSON.stringify(manifest));
  }
  await writeFile(join(resources, "app.asar/dsh/package.json"), JSON.stringify({
    dependencies: { "@deepseek-ai/dsh": "0.1.0" },
  }));
  return { resources, packageRoot };
}

async function cli(resources, ...args) {
  const result = await run(process.execPath, [command, ...args, "--resources", resources], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 80_000,
  });
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("manifest reports actual installed versions and only requested package entry points", async (t) => {
  const { resources } = await fixture(t);
  const output = await cli(resources, "manifest", "--package", "@deepseek-ai/dsh-session-projection", "--package", "zod");
  assert.equal(output.dshVersion, "0.2.2-rc.1");
  assert.deepEqual(output.packages, {
    "@deepseek-ai/dsh-session-projection": {
      version: "0.2.2-rc.1", exports: { ".": { types: "./lib/types/index.d.ts", import: "./lib/index.js" } },
    },
    zod: { version: "4.4.3", types: "./index.d.cts", main: "./index.cjs" },
  });
});

test("search returns exact line numbers with bounded context and reports omitted matches", async (t) => {
  const { resources, packageRoot } = await fixture(t);
  const sourcePath = join(packageRoot, "@deepseek-ai/dsh-session-projection/index.js");
  const original = "start\nbefore\nwire.viewSchema.parse(value)\nafter\nwire.viewSchema.parse(next)\nend\n";
  await writeFile(sourcePath, original);
  const output = await cli(resources, "search", "--package", "@deepseek-ai/dsh-session-projection",
    "--file", "index.js", "--pattern", "viewSchema", "--max-matches", "1", "--context", "1");
  assert.equal(output.totalMatches, 2);
  assert.equal(output.truncated, true);
  assert.deepEqual(output.lines, [
    { line: 2, text: "before", match: false },
    { line: 3, text: "wire.viewSchema.parse(value)", match: true },
    { line: 4, text: "after", match: false },
  ]);
  assert.equal(await readFile(sourcePath, "utf8"), original);
});

test("search caps context rows, serialized output, and long line text", async (t) => {
  const { resources, packageRoot } = await fixture(t);
  await writeFile(join(packageRoot, "zod/long.js"), Array.from({ length: 150 }, () => `needle ${'"'.repeat(600)}`).join("\n"));
  const output = await cli(resources, "search", "--package", "zod", "--file", "long.js",
    "--pattern", "needle", "--max-matches", "100", "--context", "5");
  assert.equal(output.totalMatches, 150);
  assert.equal(output.truncated, true);
  assert.ok(output.lines.length > 0 && output.lines.length <= 100);
  assert.ok(output.lines.every((line) => line.text.length <= 500));
  assert.ok(JSON.stringify(output).length <= 50_000);
});

test("search rejects path traversal and a link escaping its package", async (t) => {
  const { resources, packageRoot } = await fixture(t);
  const other = join(resources, "outside");
  await mkdir(other);
  await writeFile(join(other, "external.js"), "must not read this file");
  await symlink(other, join(packageRoot, "zod/linked"), "junction");
  const request = ["search", "--package", "zod", "--pattern", "."];
  for (const file of ["../package.json", "../../../../outside/external.js", "C:/outside.js"]) {
    await assert.rejects(cli(resources, ...request, "--file", file), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /relative path inside the selected package/);
      assert.equal(error.stdout, "");
      return true;
    });
  }
  await assert.rejects(cli(resources, ...request, "--file", "linked/external.js"), /resolves outside the selected package/);
});

test("missing, oversized and non-text files fail while a real no-match search succeeds", async (t) => {
  const { resources, packageRoot } = await fixture(t);
  const request = ["search", "--package", "zod", "--pattern", "no-such-term"];
  const noMatches = await cli(resources, ...request, "--file", "package.json");
  assert.deepEqual(noMatches.lines, []);
  assert.equal(noMatches.totalMatches, 0);
  assert.equal(noMatches.truncated, false);
  await assert.rejects(cli(resources, ...request, "--file", "missing.js"), /ENOENT/);
  await writeFile(join(packageRoot, "zod/large.js"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  await assert.rejects(cli(resources, ...request, "--file", "large.js"), /2 MiB limit/);
  await writeFile(join(packageRoot, "zod/binary.bin"), Buffer.from([65, 0, 66]));
  await assert.rejects(cli(resources, ...request, "--file", "binary.bin"), /UTF-8 text file/);
});

test("invalid package names, regular expressions and output limits fail explicitly", async (t) => {
  const { resources } = await fixture(t);
  await assert.rejects(cli(resources, "manifest", "--package", "../zod"), /exact npm package name/);
  const request = ["search", "--package", "zod", "--file", "package.json"];
  await assert.rejects(cli(resources, ...request, "--pattern", "["), /valid Unicode regular expression/);
  await assert.rejects(cli(resources, ...request, "--pattern", ".", "--max-matches", "101"), /integer from 1 to 100/);
  await assert.rejects(cli(resources, ...request, "--pattern", ".", "--context", "6"), /integer from 0 to 5/);
});
