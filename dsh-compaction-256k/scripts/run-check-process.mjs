import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

function failure(message, code, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

/** Windows-only check runner: terminate the captured process tree before settling cancellation. */
export async function runCheckProcess(file, args, { cwd, env, signal, timeout = 0, maxBuffer = 1024 * 1024 } = {}) {
  if (process.platform !== "win32") throw failure("check process tree cleanup requires Windows", "ERR_CHECK_PLATFORM");
  if (!Number.isFinite(timeout) || timeout < 0) throw new TypeError("timeout must be a non-negative finite number");
  if (!Number.isInteger(maxBuffer) || maxBuffer < 1) throw new TypeError("maxBuffer must be a positive integer");
  if (signal?.aborted) throw Object.assign(failure("check aborted before launch", "ABORT_ERR", signal.reason), { stdout: "", stderr: "" });
  const taskkill = join(process.env.SystemRoot, "System32/taskkill.exe");
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const capture = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0 };
    let closed = false;
    let settled = false;
    let exitCode;
    let exitSignal;
    let spawnError;
    let stopReason;
    let stopping = false;
    let timer;
    let closeTimer;

    const output = () => ({
      stdout: Buffer.concat(capture.stdout).toString("utf8"),
      stderr: Buffer.concat(capture.stderr).toString("utf8"),
    });
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(Object.assign(error, output()));
      else resolve(output());
    };
    const finish = () => {
      if (!closed || stopping) return;
      settle(stopReason ?? spawnError ?? (exitCode === 0 ? undefined : failure(
        `check process exited with ${exitCode === null ? `signal ${exitSignal}` : `code ${exitCode}`}`,
        exitCode ?? "ERR_CHECK_SIGNAL",
      )));
    };
    const stop = (reason) => {
      if (settled || stopReason || closed) return;
      stopReason = reason;
      stopping = true;
      clearTimeout(timer);
      void (async () => {
        try {
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
            throw new Error("root exited before process-tree cleanup could be verified");
          }
          process.kill(child.pid, 0);
          await execute(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024,
          });
        } catch (error) {
          stopReason = failure(`check process cleanup failed for pid ${child.pid ?? "unknown"}; process tree not verified stopped: ${error.message}`, "ERR_CHECK_CLEANUP", error);
        } finally {
          stopping = false;
          if (closed) finish();
          else {
            closeTimer = setTimeout(() => {
              stopReason = failure(`check process pid ${child.pid ?? "unknown"} did not close after cleanup; process tree not verified stopped`, "ERR_CHECK_CLEANUP", stopReason);
              child.stdout.destroy();
              child.stderr.destroy();
              child.unref();
              settle(stopReason);
            }, 2000);
          }
        }
      })();
    };
    const abort = () => stop(failure("check process aborted", "ABORT_ERR", signal.reason));
    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        const remaining = maxBuffer - capture[`${name}Bytes`];
        const part = chunk.subarray(0, Math.max(0, remaining));
        if (part.length) capture[name].push(part);
        capture[`${name}Bytes`] += part.length;
        if (chunk.length > remaining) stop(failure(`check ${name} exceeded maxBuffer`, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"));
      });
    }
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, stoppedBy) => { closed = true; exitCode = code; exitSignal = stoppedBy; finish(); });
    if (timeout > 0) timer = setTimeout(() => stop(failure(`check process timed out after ${timeout}ms`, "ETIMEDOUT")), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
