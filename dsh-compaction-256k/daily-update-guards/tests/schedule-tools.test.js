import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
  apply,
  CANONICAL_PROMPT_FILE,
  DailyUpdatePromptFileError,
  registerDailyUpdateGuards,
} from "../index.js";
import { CANONICAL_PROMPT, scheduleFixture, TARGET_ID, task } from "./fixtures.js";

const canonicalSha256 = createHash("sha256").update(CANONICAL_PROMPT.trim()).digest("hex");
const exec = { signal: new AbortController().signal, marker: "original exec" };
const canonicalReader = async (path) => {
  assert.equal(path, CANONICAL_PROMPT_FILE);
  return Buffer.from(CANONICAL_PROMPT, "utf8");
};

function registered(fixture, name, readPromptFile = canonicalReader) {
  registerDailyUpdateGuards(fixture.ctx, fixture.agent, { readPromptFile });
  return fixture.tools.get(name, fixture.agent);
}

test("register shadows schedule tools without replacing globals or recursing through lookup", async () => {
  const fixture = scheduleFixture();
  const wrapped = registered(fixture, "schedule_view");
  assert.notEqual(wrapped, fixture.originals[0]);
  assert.equal(fixture.tools.get("schedule_view"), fixture.originals[0]);
  assert.equal(fixture.tools.get("schedule_view", fixture.agent), wrapped);
  assert.equal(fixture.tools.get("schedule_edit", fixture.agent).name, "schedule_edit");
  const result = await wrapped.execute({ id: TARGET_ID }, exec);
  assert.equal(result.promptMatchesCanonical, true);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].args.id, TARGET_ID);
});

test("schedule_view compact projection hashes UTF-8, bounds preview, removes prompt, and matches canonical", async () => {
  const unicodePrompt = `${"界".repeat(90)}\nsecond line`;
  const fixture = scheduleFixture({ viewResult: task(unicodePrompt) });
  const wrapped = registered(fixture, "schedule_view");
  const result = await wrapped.execute({ id: TARGET_ID, full: false }, exec);
  assert.equal(Object.hasOwn(result, "prompt"), false);
  assert.equal(result.promptSha256, createHash("sha256").update(unicodePrompt).digest("hex"));
  assert.equal(result.promptBytes, Buffer.byteLength(unicodePrompt));
  assert.equal([...result.preview].length, 80);
  assert.equal(result.preview.endsWith("..."), true);
  assert.equal(result.preview.includes("\n"), false);
  assert.equal(result.canonicalPromptSha256, canonicalSha256);
  assert.equal(result.promptMatchesCanonical, false);
  assert.deepEqual(fixture.calls[0].args, { id: TARGET_ID });
  assert.equal(fixture.calls[0].exec, exec);
});

test("canonical hash follows Schedule trim normalization", async () => {
  const fixture = scheduleFixture();
  const wrapped = registered(fixture, "schedule_view", async () => Buffer.from(`${CANONICAL_PROMPT}\n\n`));
  const result = await wrapped.execute({ id: TARGET_ID }, exec);
  assert.equal(result.promptSha256, canonicalSha256);
  assert.equal(result.canonicalPromptSha256, canonicalSha256);
  assert.equal(result.promptMatchesCanonical, true);
});

test("schedule_view compact non-target task omits canonical-only fields and does not read the file", async () => {
  const fixture = scheduleFixture({ viewResult: task("other prompt", "schedule-other") });
  let reads = 0;
  const wrapped = registered(fixture, "schedule_view", async () => { reads += 1; return Buffer.from(CANONICAL_PROMPT); });
  const result = await wrapped.execute({ id: "schedule-other" }, exec);
  assert.equal(result.preview, "other prompt");
  assert.equal(Object.hasOwn(result, "canonicalPromptSha256"), false);
  assert.equal(Object.hasOwn(result, "promptMatchesCanonical"), false);
  assert.equal(reads, 0);
});

test("schedule_view full preserves the exact original result and avoids canonical reads", async () => {
  const originalResult = task();
  const fixture = scheduleFixture({ viewResult: originalResult });
  let reads = 0;
  const wrapped = registered(fixture, "schedule_view", async () => { reads += 1; return Buffer.from("changed"); });
  const result = await wrapped.execute({ id: TARGET_ID, full: true }, exec);
  assert.equal(result, originalResult);
  assert.equal(result.prompt, CANONICAL_PROMPT.trim());
  assert.equal(Object.hasOwn(result, "promptSha256"), false);
  assert.deepEqual(fixture.calls[0].args, { id: TARGET_ID });
  assert.equal(reads, 0);
});

test("schedule errors pass through unchanged in compact mode", async () => {
  const error = { id: TARGET_ID, code: "schedule_not_found", message: "missing" };
  const fixture = scheduleFixture({ viewResult: error });
  let reads = 0;
  const wrapped = registered(fixture, "schedule_view", async () => { reads += 1; return Buffer.from(CANONICAL_PROMPT); });
  assert.equal(await wrapped.execute({ id: TARGET_ID }, exec), error);
  assert.equal(reads, 0);
});

test("schedule_edit promptFile loads only the canonical prompt and forwards every original update field", async () => {
  const fixture = scheduleFixture({ editResult: task() });
  const wrapped = registered(fixture, "schedule_edit");
  const args = {
    id: TARGET_ID,
    action: "update",
    title: "Retitled",
    active: true,
    expectedUpdatedAt: "2026-11-10T00:00:00.000Z",
    promptFile: CANONICAL_PROMPT_FILE,
  };
  const result = await wrapped.execute(args, exec);
  assert.deepEqual(fixture.calls[0].args, {
    id: TARGET_ID,
    action: "update",
    title: "Retitled",
    active: true,
    expectedUpdatedAt: "2026-11-10T00:00:00.000Z",
    prompt: CANONICAL_PROMPT,
  });
  assert.equal(fixture.calls[0].exec, exec);
  assert.equal(result.canonicalPromptSha256, canonicalSha256);
  assert.equal(result.promptMatchesCanonical, true);
  assert.equal(Object.hasOwn(result, "prompt"), false);
});

test("schedule_edit promptFile with full returns the unprojected original result", async () => {
  const originalResult = task();
  const fixture = scheduleFixture({ editResult: originalResult });
  const wrapped = registered(fixture, "schedule_edit");
  const result = await wrapped.execute({ id: TARGET_ID, action: "update", promptFile: CANONICAL_PROMPT_FILE, full: true }, exec);
  assert.equal(result, originalResult);
  assert.equal(result.prompt, CANONICAL_PROMPT.trim());
  assert.deepEqual(fixture.calls[0].args, { id: TARGET_ID, action: "update", prompt: CANONICAL_PROMPT });
});

test("promptFile rejects another schedule id and every non-canonical path before reading or editing", async () => {
  const fixture = scheduleFixture();
  let reads = 0;
  const wrapped = registered(fixture, "schedule_edit", async () => { reads += 1; return Buffer.from(CANONICAL_PROMPT); });
  for (const args of [
    { id: "schedule-other", action: "update", promptFile: CANONICAL_PROMPT_FILE },
    { id: TARGET_ID, action: "update", promptFile: "D:/agents/projects/统一环境/docs/automation/other.md" },
    { id: TARGET_ID, action: "update", promptFile: "D:\\agents\\projects\\统一环境\\docs\\automation\\daily-update-prompt.md" },
    { id: TARGET_ID, action: "update", promptFile: "file:///D:/agents/projects/统一环境/docs/automation/daily-update-prompt.md" },
  ]) {
    await assert.rejects(wrapped.execute(args, exec), DailyUpdatePromptFileError);
  }
  assert.equal(reads, 0);
  assert.equal(fixture.calls.length, 0);
});

test("promptFile rejects delete and an ambiguous second prompt source", async () => {
  const fixture = scheduleFixture();
  let reads = 0;
  const wrapped = registered(fixture, "schedule_edit", async () => { reads += 1; return Buffer.from(CANONICAL_PROMPT); });
  await assert.rejects(
    wrapped.execute({ id: TARGET_ID, action: "delete", promptFile: CANONICAL_PROMPT_FILE }, exec),
    /only for schedule_edit action update/,
  );
  await assert.rejects(
    wrapped.execute({ id: TARGET_ID, action: "update", prompt: "inline", promptFile: CANONICAL_PROMPT_FILE }, exec),
    /exactly one prompt source/,
  );
  assert.equal(reads, 0);
  assert.equal(fixture.calls.length, 0);
});

test("schedule_edit direct prompt compact result reports canonical mismatch without changing forwarded args", async () => {
  const fixture = scheduleFixture({ editResult: task("stale prompt") });
  const wrapped = registered(fixture, "schedule_edit");
  const result = await wrapped.execute({ id: TARGET_ID, action: "update", prompt: "stale prompt" }, exec);
  assert.deepEqual(fixture.calls[0].args, { id: TARGET_ID, action: "update", prompt: "stale prompt" });
  assert.equal(result.canonicalPromptSha256, canonicalSha256);
  assert.equal(result.promptMatchesCanonical, false);
});

test("canonical read failure blocks a target compact update before the original edit mutates state", async () => {
  const fixture = scheduleFixture();
  const wrapped = registered(fixture, "schedule_edit", async () => { throw new Error("canonical fixture unavailable"); });
  await assert.rejects(
    wrapped.execute({ id: TARGET_ID, action: "update", prompt: "new prompt" }, exec),
    /canonical fixture unavailable/,
  );
  assert.equal(fixture.calls.length, 0);
});

test("wrapped output schema accepts full, compact, canonical metadata, and errors without oneOf ambiguity", async () => {
  const fixture = scheduleFixture();
  const wrapped = registered(fixture, "schedule_view");
  const compact = await wrapped.execute({ id: TARGET_ID }, exec);
  for (const value of [task(), compact, { id: TARGET_ID, code: "schedule_not_found", message: "missing" }]) {
    assert.deepEqual(validateJsonSchemaValue(wrapped.output.schema, value, ""), []);
  }
});

test("schedule presentation and rendering callbacks receive compatible original arguments", async () => {
  const fixture = scheduleFixture();
  const wrapped = registered(fixture, "schedule_edit");
  const args = { id: TARGET_ID, action: "update", promptFile: CANONICAL_PROMPT_FILE, full: true };
  assert.deepEqual(wrapped.presentCall(args), {
    card: "generic",
    title: `schedule_edit:${TARGET_ID}`,
    rawInput: { id: TARGET_ID, action: "update" },
  });
  assert.deepEqual(wrapped.presentResult(args, { isError: false }), { card: "generic", title: `schedule_edit:${TARGET_ID}:false` });
  assert.equal(wrapped.isConcurrencySafe(args), true);
  const value = await wrapped.execute(args, exec);
  const rendered = wrapped.output.render(args, value);
  assert.equal(rendered[0].text.includes("promptFile"), false);
  assert.equal(rendered[0].text.includes("full"), false);
  assert.deepEqual(wrapped.output.presentationMeta(args, value), { id: TARGET_ID, resultId: TARGET_ID });
});

test("apply installs wrappers from agent/created and root disposal restores originals", async () => {
  const fixture = scheduleFixture();
  let created;
  let rootCleanup;
  fixture.agent.ctx.effect = (callback) => {
    const cleanup = callback();
    return () => cleanup();
  };
  const rootCtx = {
    on: (event, listener) => {
      assert.equal(event, "agent/created");
      created = listener;
    },
    effect: (callback) => { rootCleanup = callback(); },
    agents: { list: () => [] },
  };
  apply(rootCtx);
  created({ agent: fixture.agent });
  assert.notEqual(fixture.tools.get("schedule_view", fixture.agent), fixture.originals[0]);
  rootCleanup();
  assert.equal(fixture.tools.get("schedule_view", fixture.agent), fixture.originals[0]);
});

test("apply wraps already live agents so the current session does not wait for recreation", () => {
  const fixture = scheduleFixture();
  let rootCleanup;
  fixture.agent.ctx.effect = (callback) => {
    const cleanup = callback();
    return () => cleanup();
  };
  const rootCtx = {
    on: () => {},
    effect: (callback) => { rootCleanup = callback(); },
    agents: { list: () => [fixture.agent] },
  };
  apply(rootCtx);
  assert.notEqual(fixture.tools.get("schedule_view", fixture.agent), fixture.originals[0]);
  rootCleanup();
  assert.equal(fixture.tools.get("schedule_view", fixture.agent), fixture.originals[0]);
});
