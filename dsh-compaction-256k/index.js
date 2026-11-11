import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import z from "@deepseek-ai/schemastery";

const DEFAULT_THRESHOLD_TOKENS = 256 * 1024;

export default class ConfigurableThresholdCompactionEngine extends BasicCompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];
  static Config = z.object({
    ...BasicCompactionEngine.Config.dict,
    thresholdTokens: z.number().step(1).min(1),
  });

  constructor(ctx, config = {}) {
    const { thresholdTokens = DEFAULT_THRESHOLD_TOKENS, ...officialConfig } = config;
    super(ctx, officialConfig);
    this.thresholdTokens = thresholdTokens;
  }

  async compactPressure(agent, header, signal, requireBelowThreshold) {
    const target = header.config;
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    const contextWindow = info.context?.contextWindow;
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      return super.compactPressure(agent, header, signal, requireBelowThreshold);
    }

    const override = this.config.modelPolicies.find(
      (policy) => policy.provider === target.provider && policy.model === target.model,
    );
    const officialThresholdRatio = override?.thresholdRatio ?? this.config.thresholdRatio;

    // The official engine applies its output reservation, headroom, retention,
    // pruning, range selection, and retry policy after resolving this ratio.
    const thresholdRatio = Math.min(
      officialThresholdRatio,
      (this.thresholdTokens + 0.5) / contextWindow,
    );
    if (thresholdRatio === officialThresholdRatio) {
      return super.compactPressure(agent, header, signal, requireBelowThreshold);
    }

    const view = Object.create(this);
    Object.defineProperty(view, "config", {
      value: {
        ...this.config,
        thresholdRatio,
        modelPolicies: this.config.modelPolicies.map((policy) => (
          policy.provider === target.provider && policy.model === target.model
            ? { ...policy, thresholdRatio }
            : policy
        )),
      },
    });
    return BasicCompactionEngine.prototype.compactPressure.call(
      view,
      agent,
      header,
      signal,
      requireBelowThreshold,
    );
  }
}
