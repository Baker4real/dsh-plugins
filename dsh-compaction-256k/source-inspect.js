import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import z from "@deepseek-ai/schemastery";

export const inject = ["cordisInspect"];
export const Config = z.object({ sourceRoot: z.string() });

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 500;

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute path of one file inside the configured DSH source root." },
    pattern: { type: "string", description: "Unicode regular expression, up to 256 characters; matched one line at a time." },
    maxMatches: { type: "number", description: "Maximum returned matches, from 1 to 100; defaults to 50." },
  },
  additionalProperties: false,
};

function defaultSourceRoot() {
  if (typeof process.resourcesPath !== "string" || process.resourcesPath.length === 0) {
    throw new Error("Source.searchFile: no desktop resources path; configure sourceRoot explicitly");
  }
  return join(process.resourcesPath, "app.asar", "dsh");
}

function validateInput(input) {
  if (typeof input.path !== "string" || input.path.length === 0 || !isAbsolute(input.path)) {
    throw new Error("Source.searchFile: path must be a non-empty absolute file path");
  }
  if (typeof input.pattern !== "string" || input.pattern.length === 0 || input.pattern.length > 256) {
    throw new Error("Source.searchFile: pattern length must be from 1 to 256 characters");
  }
  const maxMatches = input.maxMatches ?? 50;
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 100) {
    throw new Error("Source.searchFile: maxMatches must be an integer from 1 to 100");
  }
  let regex;
  try {
    regex = new RegExp(input.pattern, "u");
  } catch (error) {
    throw new Error(`Source.searchFile: invalid regular expression: ${error.message}`);
  }
  return { path: input.path, regex, maxMatches };
}

async function searchFile(sourceRoot, input) {
  const { regex, maxMatches } = validateInput(input);
  const [root, target] = await Promise.all([
    realpath(resolve(sourceRoot)),
    realpath(resolve(input.path)),
  ]);
  const relativePath = relative(root, target);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Source.searchFile: path is outside the configured source root; expected one contained file");
  }
  const metadata = await stat(target);
  if (!metadata.isFile()) throw new Error("Source.searchFile: target is not a regular file");
  if (metadata.size > MAX_FILE_BYTES) throw new Error("Source.searchFile: file exceeds the 2 MiB limit");

  const text = await readFile(target, "utf8");
  const matches = [];
  let total = 0;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!regex.test(lines[index])) continue;
    total += 1;
    if (matches.length < maxMatches) {
      const line = lines[index].length > MAX_LINE_CHARS
        ? `${lines[index].slice(0, MAX_LINE_CHARS)}…`
        : lines[index];
      matches.push({ line: index + 1, text: line });
    }
  }
  return { matches, total, truncated: total > matches.length };
}

export function apply(ctx, config = {}) {
  const sourceRoot = config.sourceRoot ?? defaultSourceRoot();
  const provider = {
    manifest: {
      id: "Source",
      description: "Read-only Host source search inside the configured DSH source root, including app.asar files.",
      methods: [{
        name: "searchFile",
        description: "Search one bounded source file by regular expression and return 1-based line matches.",
        inputSchema,
        outputSchema: { description: "Bounded line matches, total match count, and whether returned rows were truncated." },
      }],
    },
    async query(method, input = {}) {
      if (method !== "searchFile") throw new Error(`unknown Source inspect method "${method}"`);
      return await searchFile(sourceRoot, input);
    },
  };
  ctx.effect(() => ctx.cordisInspect.register(provider), "source-inspect: Source");
}
