import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

export const inject = ["agentLoop", "agentPresets", "sessionProjections", "tools"];

// Must match thresholdTokens in ../cordis.patch.yml.
const EXPECTED_THRESHOLD_TOKENS = 456 * 1024;

async function verifyCompactInspect(ctx, agent) {
  const fullTool = ctx.tools.get("cordis_inspect_query", agent);
  const compactTool = ctx.tools.get("cordis_inspect_compact", agent);
  if (fullTool === undefined || compactTool === undefined) {
    return { status: "fail", error: "full or compact Inspect tool is unavailable" };
  }
  const exec = { agent, signal: AbortSignal.timeout(20_000) };
  const comparisons = [];
  for (const query of [
    { platform: "host", provider: "Service", method: "listService", input: {} },
    { platform: "client", provider: "Slots", method: "listSubTree", input: {} },
  ]) {
    const full = await fullTool.execute(query, exec);
    const compact = await compactTool.execute(query, exec);
    const fullChars = JSON.stringify(full).length;
    const compactChars = JSON.stringify(compact).length;
    comparisons.push({
      provider: query.provider,
      fullChars,
      compactChars,
      reductionPercent: Math.round((1 - compactChars / fullChars) * 100),
      compact: compact.data.compact !== undefined,
      hasReferencedTypes: Object.hasOwn(compact.data, "referencedTypes"),
    });
  }
  return {
    status: comparisons.every((item) => item.compact && !item.hasReferencedTypes && item.compactChars < item.fullChars)
      ? "pass"
      : "fail",
    comparisons,
  };
}

export async function apply(ctx) {
  const sessionId = randomUUID();
  const resultPath = "D:/agents/run-evidence/dsh-compaction-256k/smoke-result.json";
  let result;
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId,
    meta: { cwd: "D:/agents/projects/misc", agentPreset: "cordis" },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, "cordis");
    },
  });
  try {
    const engine = ctx.agentPresets.serviceFor(handle.agent, "compaction");
    const engineClass = engine?.constructor.name ?? null;
    const preset = ctx.agentPresets.composedPreset(handle.agent.ctx) ?? null;
    const tool = ctx.tools.schemas(handle.agent).find((item) => item.name === "plugin_manager");
    const parameters = tool?.parameters?.properties ?? tool?.parameters ?? {};
    const pluginManagerFiltered = Object.hasOwn(parameters, "name") && Object.hasOwn(parameters, "summary");
    const compactionSettings = ctx.sessionProjections.snapshot(handle.agent.session).values.compactionSettings ?? null;
    const compactInspect = await verifyCompactInspect(ctx, handle.agent);
    result = {
      status: engineClass === "ConfigurableThresholdCompactionEngine"
        && preset === "cordis"
        && engine?.thresholdTokens === EXPECTED_THRESHOLD_TOKENS
        && engine?.config.headroomTokens === 65536
        && engine?.config.retainRatio === 0.16
        && engine?.config.compactionRetries === 1
        && compactionSettings?.thresholdTokens === EXPECTED_THRESHOLD_TOKENS
        && compactionSettings?.auto === true
        && compactInspect.status === "pass"
        && pluginManagerFiltered ? "pass" : "fail",
      sessionId,
      preset,
      engineClass,
      automaticCompaction: engine?.config.auto ?? null,
      thresholdTokens: engine?.thresholdTokens ?? null,
      compactionSettings,
      compactInspect,
      officialPolicy: {
        headroomTokens: engine?.config.headroomTokens ?? null,
        retainRatio: engine?.config.retainRatio ?? null,
        compactionRetries: engine?.config.compactionRetries ?? null,
      },
      pluginManagerFiltered,
      scope: "host+projection+tools",
      uiVerified: false,
      modelRequestMade: false,
    };
  } catch (error) {
    result = { status: "fail", sessionId, error: error instanceof Error ? error.message : String(error), modelRequestMade: false };
  } finally {
    await handle.dispose();
  }
  await mkdir("D:/agents/run-evidence/dsh-compaction-256k", { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (result.status !== "pass") throw new Error(`compaction smoke test failed: ${JSON.stringify(result)}`);
}
