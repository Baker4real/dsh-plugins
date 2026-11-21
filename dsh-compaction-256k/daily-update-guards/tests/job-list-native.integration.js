import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import ProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as NativeExecutor from "@deepseek-ai/dsh-tool-executor-native";
import * as NativeJobs from "@deepseek-ai/dsh-tool-jobs";
import ToolsService from "@deepseek-ai/dsh-tools";
import * as DailyUpdateGuards from "../index.js";

test("desktop native job_list stays owner-scoped and uses compact results for existing and new agents", async () => {
  assert.ok(process.versions.electron, "Use the installed Electron runtime and Host resolution loader.");
  const ctx = new Context();
  const handles = [];
  const outcomes = [];
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(ProjectionRegistry);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(ToolsService, {});
    await ctx.plugin(NativeExecutor);
    await ctx.plugin(LocalJobRegistry, {});
    await ctx.plugin(NativeJobs, { completionDelivery: "quiet", inlineOutputBytes: 0 });
    await ctx.plugin(AgentLoop, {});

    async function createAgent(id) {
      const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: "fixture", model: "fixture" } });
      handles.push(handle);
      return handle.agent;
    }
    function startJob(agent, label, done) {
      const pending = Promise.withResolvers();
      outcomes.push(pending.resolve);
      return ctx.jobs.start({
        kind: "bash", label, owner: agent.id,
        run: () => ({ cancel() {}, done: done ?? pending.promise }),
      });
    }
    const results = new Map();
    ctx.on("tools/result", (exec, result) => results.set(exec.callId, result));
    async function execute(agent, id, name, args) {
      await ctx.tools.execute({ calls: [{ type: "tool-call", id, name, arguments: JSON.stringify(args) }], agent, signal: new AbortController().signal });
      const result = results.get(id);
      assert.ok(result, `${name} did not emit a result`);
      assert.equal(result.isError, false, JSON.stringify(result));
      return result;
    }

    const first = await createAgent("job-list-existing-agent");
    const doneId = startJob(first, "NATIVE LABEL " + "long command ".repeat(100), Promise.resolve({ status: "completed", result: "fixture output" }));
    await new Promise(resolve => setImmediate(resolve));
    const runningId = startJob(first, "running test label");
    const native = await execute(first, "jobs-before", "job_list", {});
    assert.deepEqual(native.value.map(job => job.id), [doneId, runningId]);
    assert.match(native.content[0].text, /NATIVE LABEL /);

    const guard = ctx.plugin(DailyUpdateGuards);
    await guard;
    const second = await createAgent("job-list-new-agent");
    const empty = await execute(second, "jobs-empty", "job_list", {});
    assert.deepEqual(empty.value, []);
    assert.deepEqual(empty.content, [{ type: "text", text: "(no background jobs)" }]);
    const otherId = startJob(second, "separate owner's job");
    const firstList = await execute(first, "jobs-first", "job_list", {});
    assert.deepEqual(firstList.value, [{ id: runningId, status: "running" }, { id: doneId, status: "completed" }]);
    assert.deepEqual(firstList.content, [{ type: "text", text: `${runningId} running\n${doneId} completed` }]);
    const secondList = await execute(second, "jobs-second", "job_list", {});
    assert.deepEqual(secondList.value, [{ id: otherId, status: "running" }]);
    const output = await execute(first, "jobs-output", "job_output", { job_id: doneId });
    assert.match(output.content[0].text, /fixture output/);

    await guard.dispose();
    const restored = await execute(first, "jobs-restored", "job_list", {});
    assert.deepEqual(restored.value, native.value);
    assert.deepEqual(restored.content, native.content);
  } finally {
    for (const finish of outcomes) finish({ status: "completed" });
    for (const handle of handles) await handle.dispose();
    await ctx.fiber.dispose();
  }
});
