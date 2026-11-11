import test from 'node:test';
import assert from 'node:assert/strict';
import { createPwshGuardTool } from '../pwsh-guard.js';
import { pwshOriginal } from './fixtures.js';

const windows = { skip: process.platform !== 'win32' };
const args = (command, extra = {}) => ({ description: 'Check native arguments', command, ...extra });
const execution = () => ({ signal: new AbortController().signal });

for (const [name, command, reason] of [
  ['label fields', "Write-Output 'PRIVATE-COMMAND-SENTINEL'; gh label list --json name,description", 'bare-comma-array'],
  ['issue fields', 'gh issue list --json number,title,labels,url', 'bare-comma-array'],
  ['comments mode', "gh issue view 186 --comments --json 'body,comments'", 'comments-json-mutually-exclusive'],
]) {
  test(`native PowerShell preflight rejects invalid ${name} before the original tool`, windows, async () => {
    const calls = [];
    const guarded = createPwshGuardTool(pwshOriginal(calls));
    await assert.rejects(guarded.execute(args(command), execution()), error => {
      assert.equal(error.code, 'PWSH_PREFLIGHT_REJECTED');
      assert.match(error.message, new RegExp(reason));
      assert.doesNotMatch(error.message, /PRIVATE-COMMAND-SENTINEL/);
      return true;
    });
    assert.equal(calls.length, 0);
  });
}

test('native preflight accepts quoted fields and preserves the original argument object and result', windows, async () => {
  const calls = [];
  const result = { kind: 'background', jobId: 'original-job' };
  const guarded = createPwshGuardTool(pwshOriginal(calls, result));
  const input = args("gh issue view 186 --json 'body,comments'", {
    workdir: 'D:/fixture', timeoutMs: 4500, run_in_background: true,
    sandbox_permissions: 'workspace-write', justification: 'Preserve the original sandbox choice.',
  });
  const exec = execution();
  assert.equal(await guarded.execute(input, exec), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args, input);
  assert.equal(calls[0].exec, exec);
});

test('a cancelled preflight never invokes the original command', windows, async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const guarded = createPwshGuardTool(pwshOriginal(calls));
  await assert.rejects(guarded.execute(args("gh issue list --json 'number,title'"), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});
