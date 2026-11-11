import test from "node:test";
import assert from "node:assert/strict";
import { createPwshGuardTool, hasUnsafeCheckedPowerShellCommand, UnsafeCheckedPowerShellError } from "../pwsh-guard.js";
import { registerDailyUpdateGuards } from "../index.js";
import { FakeToolRegistry, pwshOriginal } from "./fixtures.js";

const exec = { signal: new AbortController().signal, marker: "pwsh exec" };

function fixture(result) {
  const calls = [];
  const original = pwshOriginal(calls, result);
  const tools = new FakeToolRegistry([original]);
  const ctx = { tools };
  const agent = { ctx };
  registerDailyUpdateGuards(ctx, agent);
  return { calls, original, wrapped: tools.get("pwsh", agent), tools, agent };
}

function args(command, extra = {}) {
  return { description: "Run checked PowerShell fixture", command, ...extra };
}

test("double-quoted CommandText with an unescaped variable is rejected before original execution", async () => {
  const { calls, wrapped } = fixture();
  const command = "& 'D:/Codex/.codex/scripts/Invoke-CheckedPowerShell.ps1' -CommandText \"Write-Output $value\"";
  await assert.rejects(wrapped.execute(args(command), exec), (error) => {
    assert.ok(error instanceof UnsafeCheckedPowerShellError);
    assert.equal(error.code, "UNSAFE_CHECKED_POWERSHELL_COMMANDTEXT");
    assert.match(error.message, /-ScriptPath/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("double-quoted CommandText with an unescaped subexpression is rejected case-insensitively", async () => {
  const { calls, wrapped } = fixture();
  const command = "invoke-checkedpowershell -CommandText \"Write-Output $(Get-Date)\"";
  await assert.rejects(wrapped.execute(args(command), exec), UnsafeCheckedPowerShellError);
  assert.equal(calls.length, 0);
});

test("backtick-escaped variables and subexpressions in CommandText remain allowed", async () => {
  const { calls, wrapped } = fixture();
  const command = "Invoke-CheckedPowerShell -CommandText \"Write-Output `$value; `$(Get-Date)\"";
  assert.equal(await wrapped.execute(args(command), exec), await wrapped.execute(args(command), exec));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.command, command);
  assert.equal(calls[0].exec, exec);
});

test("single-quoted CommandText is not misclassified even with variables and subexpressions", async () => {
  const { calls, wrapped } = fixture();
  const command = "Invoke-CheckedPowerShell.ps1 -CommandText 'Write-Output $value; $(Get-Date)'";
  const result = await wrapped.execute(args(command), exec);
  assert.deepEqual(result, { kind: "foreground", stdout: "ok" });
  assert.equal(calls.length, 1);
});

test("ScriptPath and static double-quoted CommandText are allowed", async () => {
  const { calls, wrapped } = fixture();
  await wrapped.execute(args("Invoke-CheckedPowerShell -ScriptPath 'D:/work/inspect.ps1' -CheckOnly"), exec);
  await wrapped.execute(args("Invoke-CheckedPowerShell -CommandText \"Write-Output 'static text'\""), exec);
  assert.equal(calls.length, 2);
});

test("ordinary double-quoted PowerShell variables outside the checked entry remain untouched", async () => {
  const { calls, wrapped } = fixture();
  const command = "Write-Output \"$env:USERPROFILE; $(Get-Date)\"";
  await wrapped.execute(args(command), exec);
  assert.equal(calls[0].args.command, command);
});

test("pwsh preserves original background, sandbox, timeout, workdir, execute, and presentation behavior", async () => {
  const background = { kind: "background", jobId: "job-fixture", cwd: "D:/fixture" };
  const { calls, original, wrapped } = fixture(background);
  const call = args("Invoke-CheckedPowerShell -ScriptPath 'D:/work/inspect.ps1'", {
    run_in_background: true,
    sandbox_permissions: "workspace-write",
    justification: "Fixture verifies original sandbox forwarding.",
    timeoutMs: 4567,
    workdir: "D:/fixture",
  });
  assert.equal(await wrapped.execute(call, exec), background);
  assert.equal(calls[0].args, call);
  assert.equal(calls[0].exec, exec);
  assert.equal(wrapped.output, original.output);
  assert.equal(wrapped.presentCall, original.presentCall);
  assert.equal(wrapped.presentResult, original.presentResult);
  assert.equal(wrapped.isConcurrencySafe, original.isConcurrencySafe);
  assert.equal(wrapped.timeoutMs, original.timeoutMs);
  assert.deepEqual(wrapped.presentCall(call), { card: "terminal", title: call.command });
});

test("guard negative and positive controls expose the exact source shape", () => {
  assert.equal(hasUnsafeCheckedPowerShellCommand("Invoke-CheckedPowerShell -CommandText \"$global:value\""), true);
  assert.equal(hasUnsafeCheckedPowerShellCommand("Invoke-CheckedPowerShell -CommandText:\"$(Get-Date)\""), true);
  assert.equal(hasUnsafeCheckedPowerShellCommand("Invoke-CheckedPowerShell -CommandText '${value}'"), false);
  assert.equal(hasUnsafeCheckedPowerShellCommand("Invoke-CheckedPowerShell -ScriptPath 'D:/safe.ps1'"), false);
  assert.equal(hasUnsafeCheckedPowerShellCommand("Write-Output '$value'"), false);
});
