import { createPwshGuardTool } from "./pwsh-guard.js";
import { createScheduleEditTool, createScheduleViewTool } from "./schedule-tools.js";

export const inject = ["tools", "agents"];

/** Capture the originals before scoped same-name registration; wrappers never resolve themselves at execution time. */
export function registerDailyUpdateGuards(ctx, agent, options = {}) {
  const disposers = [];
  try {
    for (const [name, wrap] of [
      ["schedule_view", createScheduleViewTool],
      ["schedule_edit", createScheduleEditTool],
      ["pwsh", createPwshGuardTool],
    ]) {
      const original = ctx.tools.get(name, agent);
      if (original === undefined) continue;
      disposers.push(ctx.tools.register(wrap(original, options)));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const dispose of disposers.reverse()) dispose();
  };
}

export function apply(ctx) {
  const agentDisposers = new Set();
  const installAgent = (agent) => {
    let effectDisposer;
    effectDisposer = agent.ctx.effect(() => {
      const disposeGuards = registerDailyUpdateGuards(agent.ctx, agent);
      return () => {
        disposeGuards();
        agentDisposers.delete(effectDisposer);
      };
    }, "daily-update-guards: agent tools");
    agentDisposers.add(effectDisposer);
  };
  ctx.on("agent/created", ({ agent }) => installAgent(agent));
  for (const agent of ctx.agents.list()) installAgent(agent);
  ctx.effect(() => () => {
    for (const dispose of [...agentDisposers]) dispose();
    agentDisposers.clear();
  }, "daily-update-guards: remaining agent tools");
}

export { createPwshGuardTool, hasUnsafeCheckedPowerShellCommand, UnsafeCheckedPowerShellError } from "./pwsh-guard.js";
export {
  CANONICAL_PROMPT_FILE,
  DAILY_UPDATE_SCHEDULE_ID,
  DailyUpdatePromptFileError,
  createScheduleEditTool,
  createScheduleViewTool,
  promptPreview,
} from "./schedule-tools.js";
