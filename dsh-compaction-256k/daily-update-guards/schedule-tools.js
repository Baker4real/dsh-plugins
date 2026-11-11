import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ToolArgsError, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

export const DAILY_UPDATE_SCHEDULE_ID = "schedule-2a8292b0-5876-4d7c-a20a-080f98e18eab";
export const CANONICAL_PROMPT_FILE = "D:/agents/projects/统一环境/docs/automation/daily-update-prompt.md";
export const PROMPT_PREVIEW_CHARS = 80;

const FULL_DESCRIPTION = "Return the original complete result without prompt projection; defaults to false.";
const PROMPT_FILE_DESCRIPTION = `For update of ${DAILY_UPDATE_SCHEDULE_ID} only: read the new prompt from exactly ${CANONICAL_PROMPT_FILE}. Cannot be combined with prompt or used for another id, path, or action.`;

export class DailyUpdatePromptFileError extends Error {
  code = "INVALID_DAILY_UPDATE_PROMPT_FILE";

  constructor(message) {
    super(message);
    this.name = "DailyUpdatePromptFileError";
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function argsWithout(args, fields) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const forwarded = { ...args };
  for (const field of fields) delete forwarded[field];
  return forwarded;
}

function argumentViolations(definition, args) {
  return validateJsonSchemaValue(definition.parameters, args, "");
}

function assertArguments(definition, args) {
  const violations = argumentViolations(definition, args);
  if (violations.length > 0) throw new ToolArgsError(violations);
}

function extendedParameters(original, includePromptFile) {
  const parameters = structuredClone(original.parameters);
  if (parameters.type !== "object" || typeof parameters.properties !== "object" || parameters.properties === null) {
    throw new TypeError(`${original.name} must declare an object parameter schema`);
  }
  if (Object.hasOwn(parameters.properties, "full") || (includePromptFile && Object.hasOwn(parameters.properties, "promptFile"))) {
    throw new TypeError(`${original.name} already declares a reserved wrapper parameter`);
  }
  parameters.properties.full = { type: "boolean", description: FULL_DESCRIPTION };
  if (includePromptFile) parameters.properties.promptFile = { type: "string", description: PROMPT_FILE_DESCRIPTION };
  return parameters;
}

function compactSchemaNode(node) {
  if (Array.isArray(node.oneOf)) return { ...node, oneOf: node.oneOf.map(compactSchemaNode) };
  if (node.type === "array" && typeof node.items === "object" && node.items !== null) {
    return { ...node, items: compactSchemaNode(node.items) };
  }
  if (node.type !== "object" || typeof node.properties !== "object" || node.properties === null) return node;
  const properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, compactSchemaNode(value)]));
  if (node.properties.prompt?.type !== "string" || !node.required?.includes("prompt")) return { ...node, properties };
  const compactProperties = { ...properties };
  delete compactProperties.prompt;
  Object.assign(compactProperties, {
    promptSha256: { type: "string", description: "SHA-256 of the UTF-8 prompt." },
    promptBytes: { type: "integer", description: "Prompt length in UTF-8 bytes." },
    preview: { type: "string", description: "Single-line bounded prompt preview." },
    canonicalPromptSha256: { type: "string", description: "SHA-256 of the canonical daily-update prompt file; target task only." },
    promptMatchesCanonical: { type: "boolean", description: "Whether promptSha256 equals canonicalPromptSha256; target task only." },
  });
  const compact = {
    ...node,
    properties: compactProperties,
    required: [
      ...node.required.filter((field) => field !== "prompt"),
      "promptSha256",
      "promptBytes",
      "preview",
    ],
  };
  return { oneOf: [node, compact] };
}

function compactOutputSchema(schema) {
  return compactSchemaNode(structuredClone(schema));
}

export function promptPreview(prompt) {
  const characters = [...prompt.replace(/\s+/gu, " ").trim()];
  if (characters.length <= PROMPT_PREVIEW_CHARS) return characters.join("");
  return `${characters.slice(0, PROMPT_PREVIEW_CHARS - 3).join("")}...`;
}

async function readCanonical(readPromptFile) {
  const value = await readPromptFile(CANONICAL_PROMPT_FILE);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const text = bytes.toString("utf8");
  return { text, sha256: sha256(text.trim()) };
}

function validatePromptFile(args) {
  if (args.id !== DAILY_UPDATE_SCHEDULE_ID) {
    throw new DailyUpdatePromptFileError(`promptFile is allowed only for schedule id ${DAILY_UPDATE_SCHEDULE_ID}.`);
  }
  if (args.action !== "update") {
    throw new DailyUpdatePromptFileError("promptFile is allowed only for schedule_edit action update.");
  }
  if (args.prompt !== undefined) {
    throw new DailyUpdatePromptFileError("promptFile cannot be combined with prompt; use exactly one prompt source.");
  }
  if (args.promptFile !== CANONICAL_PROMPT_FILE) {
    throw new DailyUpdatePromptFileError(`promptFile must be exactly ${CANONICAL_PROMPT_FILE}; arbitrary paths are refused.`);
  }
}

async function projectResult(result, full, loadCanonical) {
  if (full || typeof result !== "object" || result === null || Array.isArray(result) || typeof result.prompt !== "string") return result;
  const { prompt, ...rest } = result;
  const promptSha256 = sha256(prompt);
  const projected = {
    ...rest,
    promptSha256,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    preview: promptPreview(prompt),
  };
  if (result.id === DAILY_UPDATE_SCHEDULE_ID) {
    const canonical = await loadCanonical();
    projected.canonicalPromptSha256 = canonical.sha256;
    projected.promptMatchesCanonical = promptSha256 === canonical.sha256;
  }
  return projected;
}

function createScheduleTool(original, { edit = false, readPromptFile = readFile } = {}) {
  const forwardedFields = edit ? ["full", "promptFile"] : ["full"];
  const extension = edit
    ? " promptFile can load the designated daily-update prompt from its canonical file."
    : "";
  const definition = {
    ...original,
    description: `${original.description} By default, a returned task prompt is replaced by promptSha256, promptBytes, and a short preview; the daily-update task also includes canonicalPromptSha256 and promptMatchesCanonical. Set full: true for the original complete result.${extension}`,
    parameters: extendedParameters(original, edit),
    output: {
      ...original.output,
      schema: compactOutputSchema(original.output.schema),
      render: (args, value) => original.output.render(argsWithout(args, forwardedFields), value),
      ...original.output.presentationMeta === undefined ? {} : {
        presentationMeta: (args, value) => original.output.presentationMeta(argsWithout(args, forwardedFields), value),
      },
    },
    async execute(args, exec) {
      assertArguments(definition, args);
      let canonical;
      const loadCanonical = async () => {
        canonical ??= await readCanonical(readPromptFile);
        return canonical;
      };
      const forwarded = argsWithout(args, forwardedFields);
      if (edit && args.promptFile !== undefined) {
        validatePromptFile(args);
        forwarded.prompt = (await loadCanonical()).text;
      }
      if (edit && args.full !== true && args.id === DAILY_UPDATE_SCHEDULE_ID && args.action === "update") {
        await loadCanonical();
      }
      const result = await original.execute(forwarded, exec);
      return projectResult(result, args.full === true, loadCanonical);
    },
  };
  if (original.presentCall !== undefined) definition.presentCall = (args) => {
    if (argumentViolations(definition, args).length > 0) return undefined;
    return original.presentCall(argsWithout(args, forwardedFields));
  };
  if (original.presentResult !== undefined) definition.presentResult = (args, result) => {
    if (argumentViolations(definition, args).length > 0) return undefined;
    return original.presentResult(argsWithout(args, forwardedFields), result);
  };
  if (original.isConcurrencySafe !== undefined) definition.isConcurrencySafe = (args) => {
    if (argumentViolations(definition, args).length > 0) return false;
    return original.isConcurrencySafe(argsWithout(args, forwardedFields));
  };
  return definition;
}

export function createScheduleViewTool(original, options) {
  return createScheduleTool(original, options);
}

export function createScheduleEditTool(original, options = {}) {
  return createScheduleTool(original, { ...options, edit: true });
}
