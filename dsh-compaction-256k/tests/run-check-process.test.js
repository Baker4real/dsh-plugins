import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { runCheckProcess } from "../scripts/run-check-process.mjs";

const execute = promisify(execFile);
const fixtures = "D:/agents/run-evidence/dsh-compaction-256k/check-process-fixtures";

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function processFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const directory = await mkdtemp(join(fixtures, "tree-"));
  const script = join(directory, "parent.cjs");
  const marker = join(directory, "pids.json");
  await writeFile(script, `const {spawn}=require('node:child_process');\nconst child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,grandchild:child.pid}));\nsetInterval(()=>{},1000);\n`);
  let pids;
  const ready = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { pids = JSON.parse(await readFile(marker, "utf8")); return pids; }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await delay(20);
    }
    throw new Error("isolated process fixture did not become ready");
  };
  t.after(async () => {
    if (!pids) { try { pids = JSON.parse(await readFile(marker, "utf8")); } catch { return; } }
    for (const pid of [pids.grandchild, pids.parent]) {
      if (!alive(pid)) continue;
      try {
        await execute(join(process.env.SystemRoot, "System32/taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 2000 });
      } catch (error) { if (alive(pid)) throw error; }
    }
  });
  return { script, ready };
}

test("check runner preserves successful stdout and stderr", async () => {
  const result = await runCheckProcess(process.execPath, ["-e", "process.stdout.write('check-out'); process.stderr.write('check-err');"], { timeout: 2000 });
  assert.deepEqual(result, { stdout: "check-out", stderr: "check-err" });
});

test("abort waits until the isolated command and its grandchild have stopped", async (t) => {
  const fixture = await processFixture(t);
  const controller = new AbortController();
  const operation = runCheckProcess(process.execPath, [fixture.script], { signal: controller.signal, timeout: 3000 });
  operation.catch(() => {});
  const pids = await fixture.ready();
  controller.abort();
  await assert.rejects(operation, (error) => error.code === "ABORT_ERR");
  assert.equal(alive(pids.parent), false, "root process remains alive after cancellation");
  assert.equal(alive(pids.grandchild), false, "grandchild remains alive after cancellation");
});

test("timeout waits until the isolated command and its grandchild have stopped", async (t) => {
  const fixture = await processFixture(t);
  const operation = runCheckProcess(process.execPath, [fixture.script], { timeout: 700 });
  operation.catch(() => {});
  const pids = await fixture.ready();
  await assert.rejects(operation, (error) => error.code === "ETIMEDOUT");
  assert.equal(alive(pids.parent), false);
  assert.equal(alive(pids.grandchild), false);
});

test("a real nonzero exit keeps its code and both output streams", async () => {
  await assert.rejects(runCheckProcess(process.execPath, ["-e", "process.stdout.write('before-failure'); process.stderr.write('diagnostic'); process.exitCode=7;"], { timeout: 2000 }), (error) => {
    assert.equal(error.code, 7);
    assert.equal(error.stdout, "before-failure");
    assert.equal(error.stderr, "diagnostic");
    return true;
  });
});

test("a pre-aborted request never launches the command", async () => {
  const controller = new AbortController();
  controller.abort("already cancelled");
  await assert.rejects(runCheckProcess("does-not-exist.exe", [], { signal: controller.signal }), (error) => {
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "");
    return true;
  });
});

test("output overflow stops the process and bounds the captured bytes", async () => {
  await assert.rejects(runCheckProcess(process.execPath, ["-e", "process.stdout.write('z'.repeat(4096)); setInterval(()=>{},1000);"], { timeout: 2000, maxBuffer: 80 }), (error) => {
    assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    assert.equal(Buffer.byteLength(error.stdout), 80);
    return true;
  });
});

test("failed tree cleanup is reported explicitly instead of claiming cancellation completed", async (t) => {
  const fixture = await processFixture(t);
  const controller = new AbortController();
  const originalSystemRoot = process.env.SystemRoot;
  const childEnvironment = { ...process.env };
  let operation;
  try {
    process.env.SystemRoot = join(fixtures, "missing-system-root");
    operation = runCheckProcess(process.execPath, [fixture.script], { signal: controller.signal, timeout: 3000, env: childEnvironment });
  } finally {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
  }
  operation.catch(() => {});
  const pids = await fixture.ready();
  controller.abort();
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, "ERR_CHECK_CLEANUP");
    assert.match(error.message, /not verified stopped/);
    return true;
  });
  // The fixture owns these captured PIDs and its after hook reaps both.
  assert.equal(alive(pids.parent), true);
  assert.equal(alive(pids.grandchild), true);
});
