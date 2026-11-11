import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { DAILY_UPDATE_SCHEDULE_ID } from "../schedule-tools.js";

export const CANONICAL_PROMPT = "Update the daily briefing.\nKeep the source list short.\n";
export const TARGET_ID = DAILY_UPDATE_SCHEDULE_ID;

export function task(prompt = CANONICAL_PROMPT, id = TARGET_ID) {
  // The real Schedule service persists prompt.trim().
  return { id, prompt: prompt.trim(), kind: "rrule", title: "Update daily briefing" };
}

const TASK_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        prompt: { type: "string" },
        kind: { type: "string" },
        title: { type: "string" },
      },
      required: ["id", "prompt"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        code: { type: "string" },
        message: { type: "string" },
      },
      required: ["id", "code", "message"],
    },
  ],
};

const VIEW_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "string" } },
  required: ["id"],
};

const EDIT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    action: { type: "string", enum: ["update", "delete"] },
    title: { type: "string" },
    prompt: { type: "string" },
    active: { type: "boolean" },
    expectedUpdatedAt: { type: "string" },
  },
  required: ["id", "action"],
};

export function scheduleOriginal(name, execute, calls) {
  return {
    name,
    description: `Original ${name} behavior.`,
    parameters: name === "schedule_view" ? structuredClone(VIEW_PARAMETERS) : structuredClone(EDIT_PARAMETERS),
    output: {
      schema: structuredClone(TASK_OUTPUT_SCHEMA),
      render: (args, value) => [{ type: "text", text: JSON.stringify({ args, value }) }],
      presentationMeta: (args, value) => ({ id: args.id, resultId: value.id }),
    },
    execute: async (args, exec) => {
      calls.push({ name, args, exec });
      return execute(args, exec);
    },
    presentCall: (args) => ({ card: "generic", title: `${name}:${args.id}`, rawInput: args }),
    presentResult: (args, result) => ({ card: "generic", title: `${name}:${args.id}:${result.isError}` }),
    isConcurrencySafe: (args) => args.action !== "delete",
  };
}

export const PWSH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string" },
    command: { type: "string" },
    timeoutMs: { type: "number" },
    workdir: { type: "string" },
    run_in_background: { type: "boolean" },
    sandbox_permissions: { type: "string", enum: ["workspace-write", "danger-full-access"] },
    justification: { type: "string" },
  },
  required: ["description", "command"],
};

export function pwshOriginal(calls, result = { kind: "foreground", stdout: "ok" }) {
  return {
    name: "pwsh",
    description: "Original pwsh execution, presentation, background, and sandbox behavior.",
    parameters: structuredClone(PWSH_PARAMETERS),
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    timeoutMs: 12345,
    execute: async (args, exec) => {
      calls.push({ args, exec });
      return result;
    },
    presentCall: (args) => ({ card: "terminal", title: args.command }),
    presentResult: (_args, result) => ({ card: "terminal", output: result.isError ? "failed" : "ok" }),
    isConcurrencySafe: () => false,
  };
}

export class FakeToolRegistry {
  globals = new Map();
  scoped = new Map();
  registrations = [];

  constructor(originals) {
    for (const original of originals) this.globals.set(original.name, original);
  }

  get(name, agent) {
    if (agent === undefined) return this.globals.get(name);
    return this.scoped.get(name) ?? this.globals.get(name);
  }

  register(definition) {
    assertSupportedJsonSchema(definition.output.schema);
    if (this.scoped.has(definition.name)) throw new Error(`duplicate scoped tool ${definition.name}`);
    this.scoped.set(definition.name, definition);
    this.registrations.push(definition);
    return () => {
      if (this.scoped.get(definition.name) === definition) this.scoped.delete(definition.name);
    };
  }
}

export function scheduleFixture({ viewResult = task(), editResult = task() } = {}) {
  const calls = [];
  const originals = [
    scheduleOriginal("schedule_view", () => viewResult, calls),
    scheduleOriginal("schedule_edit", () => editResult, calls),
  ];
  const tools = new FakeToolRegistry(originals);
  const ctx = { tools };
  const agent = { ctx };
  return { calls, originals, tools, ctx, agent };
}
