import test from "node:test";
import assert from "node:assert/strict";
import { defineTool, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { registerDailyUpdateGuards } from "../index.js";
import { FakeToolRegistry } from "./fixtures.js";

function fixture(jobs) {
  const calls = [];
  const original = defineTool({
    name: "job_list",
    description: "List jobs with native metadata.",
    parameters: {},
    isConcurrencySafe: () => true,
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: value.length === 0 ? "(no background jobs)" : JSON.stringify(value) }],
    },
    execute: async (args, exec) => { calls.push({ args, exec }); return jobs; },
    presentCall: () => ({ card: "generic", title: "List background jobs" }),
  });
  const tools = new FakeToolRegistry([original]);
  const ctx = { tools };
  const agent = { ctx };
  const dispose = registerDailyUpdateGuards(ctx, agent);
  return { agent, calls, dispose, original, tools, wrapped: tools.get("job_list", agent) };
}

test("job_list shows running and stopping jobs first and exposes only job IDs and statuses", async () => {
  const f = fixture([
    { id: "shell-done", status: "completed", kind: "pwsh", label: "full task script", detail: "ok" },
    { id: "shell-live", status: "running", kind: "pwsh", label: "long command", startedAt: 1000 },
    { id: "shell-failed", status: "failed", label: "task with full script", finishedAt: 2000 },
    { id: "shell-stopping", status: "stopping", detail: "cancellation requested" },
  ]);
  const exec = { agent: f.agent, signal: new AbortController().signal };
  try {
    const result = await f.wrapped.execute({}, exec);
    assert.deepEqual(result, [
      { id: "shell-live", status: "running" },
      { id: "shell-stopping", status: "stopping" },
      { id: "shell-done", status: "completed" },
      { id: "shell-failed", status: "failed" },
    ]);
    assert.deepEqual(validateJsonSchemaValue(f.wrapped.output.schema, result, ""), []);
    assert.deepEqual(f.wrapped.output.render({}, result), [{
      type: "text", text: "shell-live running\nshell-stopping stopping\nshell-done completed\nshell-failed failed",
    }]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].exec, exec);
    assert.equal(f.tools.get("job_list"), f.original);
    assert.equal(f.wrapped.presentCall({}).title, "List background jobs");
    assert.equal(f.wrapped.isConcurrencySafe({}), true);
  } finally { f.dispose(); }
  assert.equal(f.tools.get("job_list", f.agent), f.original);
});

test("an empty job list retains the native empty message", async () => {
  const f = fixture([]);
  try {
    const result = await f.wrapped.execute({}, { agent: f.agent });
    assert.deepEqual(result, []);
    assert.deepEqual(f.wrapped.output.render({}, result), [{ type: "text", text: "(no background jobs)" }]);
  } finally { f.dispose(); }
});
