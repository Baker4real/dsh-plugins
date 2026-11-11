import { z } from "zod";

const DEFAULT_THRESHOLD_TOKENS = 256 * 1024;
const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_HEADROOM_TOKENS = 65_536;
const ENGINE_PACKAGE = "@local/dsh-compaction-256k";

const policySchema = z.object({
  provider: z.string(),
  model: z.string(),
  thresholdRatio: z.number().optional(),
  headroomTokens: z.number().int().min(0).optional(),
});

const stateSchema = z.object({
  available: z.boolean(),
  auto: z.boolean().optional(),
  thresholdTokens: z.number().int().min(1).optional(),
  thresholdRatio: z.number().optional(),
  headroomTokens: z.number().int().min(0).optional(),
  modelPolicies: z.array(policySchema).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});

const viewSchema = z.object({
  auto: z.boolean(),
  thresholdTokens: z.number().int().min(1).optional(),
  thresholdRatio: z.number().optional(),
  headroomTokens: z.number().int().min(0).optional(),
});

function flattenRows(rows, found = []) {
  for (const row of rows) {
    if (row.group === true) flattenRows(row.config, found);
    else found.push(row);
  }
  return found;
}

function engineConfig(ctx, preset = "standard") {
  const record = ctx.agentPresets.definitions.get(preset)
    ?? ctx.agentPresets.definitions.get("standard");
  if (record === undefined) return undefined;
  const row = flattenRows(record.config.plugins)
    .find((item) => item.name === ENGINE_PACKAGE);
  return row === undefined ? undefined : row.config ?? {};
}

export function createCompactionSettingsProjection(ctx) {
  return {
    key: "compactionSettings",
    stateVersion: 1,
    stateSchema,
    init(header) {
      const config = engineConfig(ctx, header.agentPreset);
      if (config === undefined) return { available: false };
      return {
        available: true,
        auto: config.auto ?? true,
        thresholdTokens: config.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS,
        thresholdRatio: config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO,
        headroomTokens: config.headroomTokens ?? DEFAULT_HEADROOM_TOKENS,
        modelPolicies: config.modelPolicies ?? [],
      };
    },
    apply(state, event) {
      if (!state.available || event.type !== "request/header") return state;
      const { provider, model } = event.data.header.config;
      if (provider === state.provider && model === state.model) return state;
      return { ...state, provider, model };
    },
    wire: {
      viewSchema,
      view(state) {
        if (!state.available) return { auto: false };
        const policy = state.modelPolicies.find(
          (item) => item.provider === state.provider && item.model === state.model,
        );
        return {
          auto: state.auto,
          thresholdTokens: state.thresholdTokens,
          thresholdRatio: policy?.thresholdRatio ?? state.thresholdRatio,
          headroomTokens: policy?.headroomTokens ?? state.headroomTokens,
        };
      },
      summary: false,
    },
  };
}

export const inject = ["agentPresets", "sessionProjections"];

export async function apply(ctx) {
  await ctx.sessionProjections.register(createCompactionSettingsProjection(ctx));
}
