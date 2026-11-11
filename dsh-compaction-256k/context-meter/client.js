window.__ModuleLoader__.load({
  id: "@local/dsh-compaction-context-meter",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const NS = "compaction-context-meter";
    const css = `
      .dsh-compaction-remaining {
        flex: none;
        display: inline-flex;
        align-items: center;
        padding: 1px 8px;
        color: var(--dsw-alias-label-tertiary);
        font-family: inherit;
        font-size: var(--dsh-content-font-size-secondary, 13px);
        font-variant-numeric: tabular-nums;
        line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
        white-space: nowrap;
      }
    `;

    function formatTokens(value) {
      if (value < 1000) return String(value);
      const scaled = value / 1000;
      return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}K`;
    }

    function CompactionRemaining({ useProjection, t }) {
      const pressure = useProjection("contextPressure");
      const settings = useProjection("compactionSettings");
      const timeline = useProjection("contextTimeline");
      if (settings === undefined || settings.auto === false) return null;
      const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
      const contextWindow = pressure?.contextWindow;
      if (usedTokens === undefined || contextWindow === undefined) return null;

      // dsh-context exposes the resolved output reservation. Without it, zero
      // matches the official engine's no-declared-cap fallback.
      const reservedOutputTokens = typeof timeline?.maxOutputTokens === "number"
        ? timeline.maxOutputTokens
        : 0;
      const officialThreshold = Math.floor(Math.min(
        contextWindow * settings.thresholdRatio,
        contextWindow - reservedOutputTokens - settings.headroomTokens,
      ));
      const thresholdTokens = Math.min(settings.thresholdTokens, officialThreshold);
      if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) return null;
      const remainingPercent = Math.max(
        0,
        Math.round((thresholdTokens - usedTokens) / thresholdTokens * 100),
      );
      const label = t("remaining", { percent: remainingPercent });
      const title = t("threshold", { threshold: formatTokens(thresholdTokens) });
      return h("span", {
        className: "dsh-compaction-remaining",
        title,
        "aria-label": `${title}，${label}`,
        "data-compaction-remaining": remainingPercent,
        "data-compaction-threshold": thresholdTokens,
      }, h("style", null, css), label);
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            remaining: "压缩剩余 {percent}%",
            threshold: "自动压缩阈值：{threshold}",
          },
          en: {
            remaining: "Compaction remaining {percent}%",
            threshold: "Automatic compaction threshold: {threshold}",
          },
        }), "compaction-context-meter: locale");
        ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
          name: "conversation.composer.dock",
          id: "compaction-remaining",
          order: 2,
          locale: NS,
        }, CompactionRemaining));
      },
    };
  },
});
