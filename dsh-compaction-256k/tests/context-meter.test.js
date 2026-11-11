import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session";
import ProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import { createCompactionSettingsProjection } from "../context-meter/index.js";

function fixture(config = { thresholdTokens: 262_144 }) {
  const ctx = {
    agentPresets: {
      definitions: new Map([
        ["standard", {
          config: {
            plugins: [{
              id: "compaction-basic",
              name: "@local/dsh-compaction-256k",
              config,
            }],
          },
        }],
      ]),
    },
  };
  return createCompactionSettingsProjection(ctx);
}

function requestHeader(provider = "deepseek", model = "k3") {
  return {
    type: "request/header",
    data: { header: { config: { provider, model } } },
  };
}

test("the projection exposes the active preset's current absolute threshold and official defaults", () => {
  const definition = fixture();
  const state = definition.init({ agentPreset: "standard" });
  const view = definition.wire.view(state);
  assert.deepEqual(view, {
    auto: true,
    thresholdTokens: 262_144,
    thresholdRatio: 0.8,
    headroomTokens: 65_536,
  });
  assert.deepEqual(definition.wire.viewSchema.parse(view), view);
});

test("a request header selects only its exact model policy", () => {
  const definition = fixture({
    thresholdTokens: 131_072,
    thresholdRatio: 0.75,
    headroomTokens: 4096,
    modelPolicies: [
      { provider: "deepseek", model: "other", thresholdRatio: 0.5, headroomTokens: 2048 },
      { provider: "deepseek", model: "k3", thresholdRatio: 0.7, headroomTokens: 1024 },
    ],
  });
  let state = definition.init({ agentPreset: "standard" });
  state = definition.apply(state, requestHeader());
  assert.deepEqual(definition.wire.view(state), {
    auto: true,
    thresholdTokens: 131_072,
    thresholdRatio: 0.7,
    headroomTokens: 1024,
  });
});

test("unrelated events and repeated routes preserve projection state identity", () => {
  const definition = fixture();
  const initial = definition.init({ agentPreset: "standard" });
  assert.equal(definition.apply(initial, { type: "user/message", data: {} }), initial);
  const routed = definition.apply(initial, requestHeader());
  assert.equal(definition.apply(routed, requestHeader()), routed);
});

test("sessions without the local engine hide the meter", async (t) => {
  await t.test("preset is absent", () => {
    const definition = createCompactionSettingsProjection({ agentPresets: { definitions: new Map() } });
    const state = definition.init({ agentPreset: "standard" });
    const view = definition.wire.view(state);
    assert.deepEqual(view, { auto: false });
    assert.deepEqual(definition.wire.viewSchema.parse(view), view);
  });

  await t.test("preset uses another compaction engine", () => {
    const definition = createCompactionSettingsProjection({
      agentPresets: {
        definitions: new Map([["standard", {
          config: { plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }] },
        }]]),
      },
    });
    const state = definition.init({ agentPreset: "standard" });
    assert.deepEqual(definition.wire.view(state), { auto: false });
  });
});

test("the host registry can load history and restore saved compaction state", async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(ProjectionRegistry);
    const session = new Session(SessionId("context-meter-history"));
    assert.deepEqual(ctx.sessionProjections.snapshot(session).values, {});
    const definition = fixture({
      thresholdTokens: 131_072,
      modelPolicies: [{ provider: "deepseek", model: "k3", thresholdRatio: 0.7 }],
    });
    await ctx.sessionProjections.register(definition);
    const initial = ctx.sessionProjections.snapshot(session);
    assert.equal(initial.values.compactionSettings.thresholdTokens, 131_072);
    const replayed = ctx.sessionProjections.restore({}, [{ ...requestHeader(), seq: 0 }], 0, session.header, 0);
    assert.equal(replayed.snapshot.values.compactionSettings.thresholdRatio, 0.7);
    const resumed = ctx.sessionProjections.restore(replayed.checkpoint, [], 1, session.header, 0);
    assert.deepEqual(resumed.snapshot.values, replayed.snapshot.values);
    assert.deepEqual(ctx.sessionProjections.viewCheckpoint(replayed.checkpoint), replayed.snapshot.values);
  } finally {
    await ctx.fiber.dispose();
  }
});
