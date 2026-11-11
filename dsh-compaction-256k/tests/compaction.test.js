import test from "node:test";
import assert from "node:assert/strict";
import ConfigurableThresholdCompactionEngine from "../index.js";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";

function fixture(contextWindow, totalTokens, config = {}, EngineClass = ConfigurableThresholdCompactionEngine) {
  const measurement = {
    totalTokens,
    nodes: [
      { seq: 0, tokens: 100, heuristicTokens: 100 },
      { seq: 1, tokens: 100, heuristicTokens: 100 },
    ],
  };
  const events = [0, 1].map((seq) => ({ seq, type: "user/message", data: {} }));
  const session = {
    surface: { nodes: [0, 1], replaceGeneration: 0 },
    eventAt(seq) { return events[seq]; },
  };
  const ctx = {
    reflect: { provide: () => {} },
    tokenMeter: { measure: () => measurement },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow } }) },
    get: () => undefined,
  };
  const engine = new EngineClass(ctx, { auto: false, retainTokens: 0, ...config });
  const ranges = [];
  engine.compactRegion = async (start, end) => {
    ranges.push([start, end]);
    measurement.totalTokens = 0;
    return { shadowedSeqs: [0] };
  };
  const agent = { session };
  const header = { config: { provider: "test", model: "test", maxTokens: 0 } };
  session.requestHeader = () => header;
  return {
    engine,
    agent,
    header,
    ctx,
    measurement,
    session,
    ranges,
    compactCalls: () => ranges.length,
  };
}

test("262,143 tokens stays below the default trigger on 500K and 1M windows", async (t) => {
  for (const contextWindow of [500_000, 1_048_576]) {
    await t.test(String(contextWindow), async () => {
      const { engine, agent, header, compactCalls } = fixture(contextWindow, 262_143);
      assert.equal(await engine.compactPressure(agent, header, new AbortController().signal, false), null);
      assert.equal(compactCalls(), 0);
    });
  }
});

test("262,144 tokens enters compaction on 500K and 1M windows", async (t) => {
  for (const contextWindow of [500_000, 1_048_576]) {
    await t.test(String(contextWindow), async () => {
      const { engine, agent, header, compactCalls } = fixture(contextWindow, 262_144);
      const result = await engine.compactPressure(agent, header, new AbortController().signal, false);
      assert.deepEqual(result, { shadowedSeqs: [0] });
      assert.equal(compactCalls(), 1);
    });
  }
});

test("thresholdTokens configures an absolute trigger without replacing the official pressure path", async () => {
  const below = fixture(1_048_576, 131_071, { thresholdTokens: 131_072 });
  assert.equal(await below.engine.compactPressure(below.agent, below.header, new AbortController().signal, false), null);
  assert.equal(below.compactCalls(), 0);

  const reached = fixture(1_048_576, 131_072, { thresholdTokens: 131_072 });
  const result = await reached.engine.compactPressure(reached.agent, reached.header, new AbortController().signal, false);
  assert.deepEqual(result, { shadowedSeqs: [0] });
  assert.equal(reached.compactCalls(), 1);
});

test("a route policy cannot overwrite an earlier absolute trigger", async () => {
  const { engine, agent, header, compactCalls } = fixture(1_048_576, 262_144, {
    modelPolicies: [{ provider: "test", model: "test", thresholdRatio: 0.5 }],
  });
  const result = await engine.compactPressure(agent, header, new AbortController().signal, false);
  assert.deepEqual(result, { shadowedSeqs: [0] });
  assert.equal(compactCalls(), 1);
});

test("the official pressure budget still applies when it is earlier than 256K", async () => {
  const below = fixture(262_144, 196_607);
  assert.equal(await below.engine.compactPressure(below.agent, below.header, new AbortController().signal, false), null);
  assert.equal(below.compactCalls(), 0);

  const reached = fixture(262_144, 196_608);
  const result = await reached.engine.compactPressure(reached.agent, reached.header, new AbortController().signal, false);
  assert.deepEqual(result, { shadowedSeqs: [0] });
  assert.equal(reached.compactCalls(), 1);
});

test("a non-binding absolute threshold is behaviorally identical to the official engine", async () => {
  for (const totalTokens of [399_999, 400_000]) {
    const official = fixture(500_000, totalTokens, {}, BasicCompactionEngine);
    const local = fixture(500_000, totalTokens, { thresholdTokens: 900_000 });
    const officialResult = await official.engine.compactPressure(official.agent, official.header, new AbortController().signal, false);
    const localResult = await local.engine.compactPressure(local.agent, local.header, new AbortController().signal, false);
    assert.deepEqual(localResult, officialResult);
    assert.deepEqual(local.ranges, official.ranges);
  }
});

test("official retention selects the same range on the absolute-threshold path", async () => {
  const official = fixture(1_048_576, 131_072, {
    thresholdRatio: 0.125,
    retainTokens: 100,
  }, BasicCompactionEngine);
  const local = fixture(1_048_576, 131_072, {
    thresholdTokens: 131_072,
    retainTokens: 100,
  });
  const officialResult = await official.engine.compactPressure(official.agent, official.header, new AbortController().signal, false);
  const localResult = await local.engine.compactPressure(local.agent, local.header, new AbortController().signal, false);
  assert.deepEqual(localResult, officialResult);
  assert.deepEqual(local.ranges, [[0, 0]]);
  assert.deepEqual(local.ranges, official.ranges);
});

test("official pruning can cancel an absolute-threshold compaction after remeasurement", async () => {
  async function run(EngineClass, config) {
    const value = fixture(1_048_576, 131_072, config, EngineClass);
    let pruneCalls = 0;
    value.ctx.get = (name) => name === "toolResultPruner" ? {
      pruneSession: () => {
        pruneCalls += 1;
        value.measurement.totalTokens = 131_071;
      },
    } : undefined;
    const result = await value.engine.compactPressure(value.agent, value.header, new AbortController().signal, false);
    return { result, pruneCalls, ranges: value.ranges };
  }

  const official = await run(BasicCompactionEngine, { thresholdRatio: 0.125 });
  const local = await run(ConfigurableThresholdCompactionEngine, { thresholdTokens: 131_072 });
  assert.deepEqual(local, official);
  assert.deepEqual(local, { result: null, pruneCalls: 1, ranges: [] });
});

test("overflow recovery and manual no-op behavior stay on the official engine path", async (t) => {
  await t.test("context-overflow", async () => {
    const official = fixture(1_048_576, 1_000, {}, BasicCompactionEngine);
    const local = fixture(1_048_576, 1_000, {});
    const signal = new AbortController().signal;
    const officialResult = await official.engine.compactIfNeeded(official.agent, "context-overflow", signal);
    const localResult = await local.engine.compactIfNeeded(local.agent, "context-overflow", signal);
    assert.deepEqual(localResult, officialResult);
    assert.deepEqual(local.ranges, official.ranges);
    assert.equal(local.compactCalls(), 1);
  });

  await t.test("compactNow with no useful range", async () => {
    async function run(EngineClass) {
      const value = fixture(1_048_576, 1_000, {}, EngineClass);
      value.measurement.nodes = value.measurement.nodes.slice(0, 1);
      value.session.surface.nodes = value.session.surface.nodes.slice(0, 1);
      let maintenanceCalls = 0;
      const agent = {
        ...value.agent,
        runMaintenance: async (callback) => {
          maintenanceCalls += 1;
          return callback(new AbortController().signal);
        },
      };
      const result = await value.engine.compactNow(agent, new AbortController().signal);
      return { result, maintenanceCalls };
    }
    const official = await run(BasicCompactionEngine);
    const local = await run(ConfigurableThresholdCompactionEngine);
    assert.deepEqual(local, official);
    assert.deepEqual(local, { result: null, maintenanceCalls: 1 });
  });
});
