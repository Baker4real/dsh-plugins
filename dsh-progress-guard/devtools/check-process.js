import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** Run one owned check process; settle cancellation only after its Windows tree is stopped. */
export async function runCheckProcess(file, args, { cwd, env, signal, timeout = 180000, maxBuffer = 65536 } = {}) {
  if (process.platform !== 'win32') throw new Error('The automatic check runner currently requires Windows process-tree cleanup');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const capture = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0 };
    let closed = false, settled = false, stopping = false, stopReason, spawnError, code, timer, closeTimer;
    const finish = () => {
      if (!closed || stopping || settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(closeTimer);
      signal?.removeEventListener('abort', abort);
      const error = stopReason ?? spawnError ?? (code === 0 ? undefined : new Error(`Check exited with code ${code}`));
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(capture.stdout).toString('utf8'), stderr: Buffer.concat(capture.stderr).toString('utf8') });
    };
    const stop = async reason => {
      if (settled || stopReason || closed) return;
      stopReason = reason; stopping = true; clearTimeout(timer);
      try {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Owned root exited before tree cleanup');
        process.kill(child.pid, 0);
        await execute(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000, maxBuffer: 65536 });
      } catch {
        stopReason = Object.assign(new Error('Owned check process tree cleanup could not be verified'), { code: 'ERR_CHECK_CLEANUP' });
      } finally {
        stopping = false;
        if (closed) finish();
        else closeTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abort);
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
          reject(Object.assign(new Error('Owned check process did not close after tree cleanup'), { code: 'ERR_CHECK_CLEANUP' }));
        }, 2000);
      }
    };
    const abort = () => { void stop(Object.assign(new Error('Check cancelled'), { code: 'ABORT_ERR' })); };
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      const remaining = maxBuffer - capture[`${name}Bytes`];
      const part = chunk.subarray(0, Math.max(0, remaining));
      if (part.length) capture[name].push(part);
      capture[`${name}Bytes`] += part.length;
      if (chunk.length > remaining) void stop(new Error(`Check ${name} exceeds its output budget`));
    });
    child.once('error', error => { spawnError = error; });
    child.once('close', exitCode => { code = exitCode; closed = true; finish(); });
    timer = setTimeout(() => { void stop(Object.assign(new Error('Check timed out'), { code: 'ETIMEDOUT' })); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
