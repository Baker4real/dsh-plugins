/** Read-only inspection through Electron's existing asar filesystem support. */
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 50_000;

function contained(root, path) {
  const local = relative(root, path);
  return local !== "" && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

async function sourceRoot(resourcesPath) {
  if (typeof resourcesPath !== "string" || !isAbsolute(resourcesPath)) {
    throw new Error("resources must be an absolute desktop resources path");
  }
  return await realpath(join(resourcesPath, "app.asar", "dsh"));
}

function packageName(value) {
  if (typeof value !== "string" || value.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value)) {
    throw new Error("package must be an exact npm package name");
  }
  return value;
}

async function packageRoot(root, name) {
  const path = await realpath(join(root, "node_modules", packageName(name)));
  if (!contained(root, path)) throw new Error("package resolves outside the DSH source root");
  return path;
}

function relativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || isAbsolute(value)
      || value.includes(":") || value.split(/[\\/]/u).some((part) => part === "..")) {
    throw new Error(`${label} must be a relative path inside the selected package`);
  }
  return value;
}

function integerOption(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

async function readText(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("target must be a regular file");
  if (metadata.size > MAX_FILE_BYTES) throw new Error("file exceeds the 2 MiB limit");
  const data = await readFile(path);
  if (data.length > MAX_FILE_BYTES) throw new Error("file exceeds the 2 MiB limit");
  if (data.includes(0)) throw new Error("target must be a UTF-8 text file");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("target must be a UTF-8 text file");
  }
}

async function manifest(root, name) {
  const directory = await packageRoot(root, name);
  const target = await realpath(join(directory, "package.json"));
  if (!contained(directory, target)) throw new Error("manifest resolves outside its package");
  const value = JSON.parse(await readText(target));
  if (value.name !== name || typeof value.version !== "string" || value.version.length === 0 || value.version.length > 128) {
    throw new Error(`invalid installed package manifest: ${name}`);
  }
  return value;
}

/** Return actual installed versions and selected package entry points, never configuration. */
export async function inspectManifest(resourcesPath, packageNames = []) {
  if (!Array.isArray(packageNames) || packageNames.length > 32) throw new Error("request at most 32 exact package names");
  const root = await sourceRoot(resourcesPath);
  const host = await manifest(root, "@deepseek-ai/dsh");
  const packages = {};
  for (const name of new Set(packageNames)) {
    const value = name === "@deepseek-ai/dsh" ? host : await manifest(root, name);
    const entry = { version: value.version };
    for (const field of ["exports", "types", "main"]) {
      if (value[field] !== undefined) entry[field] = value[field];
    }
    packages[name] = entry;
  }
  const result = { dshVersion: host.version, packages };
  if (JSON.stringify(result).length > MAX_OUTPUT_CHARS) throw new Error("manifest projection exceeds output limit; request fewer packages");
  return result;
}

/** Search one package source file, including bounded neighboring lines. */
export async function searchSource(resourcesPath, input) {
  if (input === null || typeof input !== "object") throw new Error("search input is required");
  const { packageName: name, file, pattern, maxMatches = 20, context = 2 } = input;
  packageName(name);
  relativePath(file, "file");
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 256) {
    throw new Error("pattern length must be from 1 to 256 characters");
  }
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 100) throw new Error("max-matches must be an integer from 1 to 100");
  if (!Number.isInteger(context) || context < 0 || context > 5) throw new Error("context must be an integer from 0 to 5");
  let regex;
  try { regex = new RegExp(pattern, "u"); }
  catch { throw new Error("pattern must be a valid Unicode regular expression"); }
  const root = await sourceRoot(resourcesPath);
  const directory = await packageRoot(root, name);
  const target = await realpath(resolve(directory, file));
  if (!contained(directory, target)) throw new Error("file resolves outside the selected package");
  const source = (await readText(target)).split(/\r?\n/u);
  const hits = [];
  for (let index = 0; index < source.length; index += 1) {
    if (regex.test(source[index])) hits.push(index);
  }
  const selected = new Set(hits.slice(0, maxMatches));
  const wanted = new Set();
  for (const index of selected) {
    for (let nearby = Math.max(0, index - context); nearby <= Math.min(source.length - 1, index + context); nearby += 1) {
      wanted.add(nearby);
    }
  }
  const result = { packageName: name, file, totalMatches: hits.length, lines: [], truncated: hits.length > maxMatches };
  let outputChars = JSON.stringify(result).length;
  for (const index of [...wanted].sort((a, b) => a - b)) {
    const clipped = source[index].length > 500;
    const row = { line: index + 1, text: clipped ? `${source[index].slice(0, 499)}…` : source[index], match: selected.has(index) };
    const rowChars = JSON.stringify(row).length + 1;
    if (result.lines.length === 100 || outputChars + rowChars > MAX_OUTPUT_CHARS) {
      result.truncated = true;
      break;
    }
    outputChars += rowChars;
    result.lines.push(row);
    if (clipped) result.truncated = true;
  }
  return result;
}

/** List one directory inside a package, one sorted page at a time. */
export async function listFiles(resourcesPath, input) {
  if (input === null || typeof input !== "object") throw new Error("files input is required");
  const { packageName: name, directory = ".", offset = 0, limit = 50 } = input;
  packageName(name);
  relativePath(directory, "directory");
  integerOption(offset, "offset", 0, 100_000);
  integerOption(limit, "limit", 1, 100);
  const root = await sourceRoot(resourcesPath);
  const packageDir = await packageRoot(root, name);
  const target = await realpath(resolve(packageDir, directory));
  if (target !== packageDir && !contained(packageDir, target)) throw new Error("directory resolves outside the selected package");
  if (!(await stat(target)).isDirectory()) throw new Error("directory must be a directory");
  const names = (await readdir(target)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files = [];
  for (const entry of names.slice(offset, offset + limit)) {
    const metadata = await lstat(join(target, entry));
    files.push({ name: entry, type: metadata.isSymbolicLink() ? "symlink" : metadata.isDirectory() ? "directory" : "file" });
  }
  const next = offset + files.length;
  return { packageName: name, directory, offset, total: names.length, files, nextOffset: next < names.length ? next : null };
}

/** Read a bounded line range of one package text file. */
export async function readSource(resourcesPath, input) {
  if (input === null || typeof input !== "object") throw new Error("read input is required");
  const { packageName: name, file, startLine = 1, maxLines = 80 } = input;
  packageName(name);
  relativePath(file, "file");
  integerOption(startLine, "start-line", 1, 10_000_000);
  integerOption(maxLines, "max-lines", 1, 200);
  const root = await sourceRoot(resourcesPath);
  const directory = await packageRoot(root, name);
  const target = await realpath(resolve(directory, file));
  if (!contained(directory, target)) throw new Error("file resolves outside the selected package");
  const source = (await readText(target)).split(/\r?\n/u);
  if (startLine > source.length) throw new Error(`start-line is past the end of the file (${source.length} lines)`);
  const result = { packageName: name, file, totalLines: source.length, lines: [], nextLine: null, truncated: false };
  let outputChars = JSON.stringify(result).length;
  for (let index = startLine - 1; index < Math.min(source.length, startLine - 1 + maxLines); index += 1) {
    const clipped = source[index].length > 500;
    const row = { line: index + 1, text: clipped ? `${source[index].slice(0, 499)}…` : source[index] };
    const rowChars = JSON.stringify(row).length + 1;
    if (outputChars + rowChars > MAX_OUTPUT_CHARS) {
      result.truncated = true;
      break;
    }
    outputChars += rowChars;
    result.lines.push(row);
    if (clipped) result.truncated = true;
  }
  const last = result.lines.length > 0 ? result.lines.at(-1).line : startLine - 1;
  result.nextLine = last < source.length ? last + 1 : null;
  return result;
}

const HELP = `DSH bounded source inspector (read only)
  manifest --resources <absolute path> [--package <exact name> ...]
  search --resources <absolute path> --package <exact name> --file <relative path>
         --pattern <regexp> [--max-matches 1..100] [--context 0..5]
  files --resources <absolute path> --package <exact name> [--directory <relative path>]
        [--offset 0..100000] [--limit 1..100]
  read --resources <absolute path> --package <exact name> --file <relative path>
       [--start-line 1..] [--max-lines 1..200]
Installed app.asar: run this script with the desktop Electron executable,
ELECTRON_RUN_AS_NODE=1 and --expose-internals. Plain Node supports directory fixtures.
`;

const COMMAND_OPTIONS = {
  manifest: [],
  search: ["file", "pattern", "max-matches", "context"],
  files: ["directory", "offset", "limit"],
  read: ["file", "start-line", "max-lines"],
};

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      resources: { type: "string" }, package: { type: "string", multiple: true },
      file: { type: "string" }, pattern: { type: "string" },
      "max-matches": { type: "string" }, context: { type: "string" }, help: { type: "boolean" },
      directory: { type: "string" }, offset: { type: "string" }, limit: { type: "string" },
      "start-line": { type: "string" }, "max-lines": { type: "string" },
    },
    allowPositionals: true,
  });
  if (values.help) { process.stdout.write(HELP); return; }
  const command = positionals.length === 1 ? positionals[0] : undefined;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw new Error("choose manifest, search, files or read; see --help");
  const extra = Object.keys(values).find((key) => !["resources", "package", ...COMMAND_OPTIONS[command]].includes(key));
  if (extra !== undefined) throw new Error(`${command} does not accept --${extra}`);
  if (command !== "manifest" && values.package?.length !== 1) throw new Error(`${command} requires exactly one package`);
  const number = (key, field) => (values[key] === undefined ? {} : { [field]: Number(values[key]) });
  let result;
  if (command === "manifest") {
    result = await inspectManifest(values.resources, values.package ?? []);
  } else if (command === "search") {
    result = await searchSource(values.resources, {
      packageName: values.package[0], file: values.file, pattern: values.pattern,
      ...number("max-matches", "maxMatches"), ...number("context", "context"),
    });
  } else if (command === "files") {
    result = await listFiles(values.resources, {
      packageName: values.package[0], ...(values.directory === undefined ? {} : { directory: values.directory }),
      ...number("offset", "offset"), ...number("limit", "limit"),
    });
  } else {
    result = await readSource(values.resources, {
      packageName: values.package[0], file: values.file,
      ...number("start-line", "startLine"), ...number("max-lines", "maxLines"),
    });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`dsh-inspect: ${error.message}\n`);
    process.exitCode = 1;
  });
}
