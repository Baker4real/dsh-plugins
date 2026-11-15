import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runCheckProcess } from "./run-check-process.mjs";

const MAX_PROJECTIONS = 50;
const SETTINGS_FIELDS = ["available", "auto", "thresholdTokens", "thresholdRatio", "headroomTokens", "modelPolicies", "provider", "model"];
const PRESSURE_FIELDS = ["contextWindow", "pressureTokens", "surfaceTokens", "sampledSurfaceTokens"];
const pick = (value, fields) => Object.fromEntries(fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]));

// The running Host rewrites one cache file per session; only threshold and pressure fields leave this function,
// never titles, todos, working directories or message surfaces.
async function projections(args) {
  const { values } = parseArgs({ args, options: { home: { type: "string" }, since: { type: "string" }, limit: { type: "string" } } });
  const since = values.since === undefined ? -Infinity : Date.parse(values.since);
  if (Number.isNaN(since)) throw new Error("--since must be an ISO date or time");
  const limit = Number(values.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROJECTIONS) throw new Error(`--limit must be an integer from 1 to ${MAX_PROJECTIONS}`);
  const cache = join(resolve(values.home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh")), "storages", "session_projcache", "sessions");
  const files = [];
  for (const name of await readdir(cache)) {
    if (!name.endsWith(".json")) continue;
    const { mtimeMs } = await stat(join(cache, name));
    if (mtimeMs >= since) files.push({ name, mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sessions = [];
  for (const { name, mtimeMs } of files.slice(0, limit)) {
    const entry = { session: name.slice(0, -".json".length), cacheUpdatedAt: new Date(mtimeMs).toISOString() };
    try {
      const { identity, rows = {} } = JSON.parse(await readFile(join(cache, name), "utf8")).record ?? {};
      const settings = rows.compactionSettings?.val;
      const pressure = rows.contextPressure?.val;
      sessions.push({
        ...entry,
        createdAt: Number.isFinite(identity?.createdAt) ? new Date(identity.createdAt).toISOString() : null,
        agentPreset: rows.agentPreset?.val ?? null,
        compactionSettings: settings ? pick(settings, SETTINGS_FIELDS) : null,
        contextPressure: pressure ? pick(pressure, PRESSURE_FIELDS) : null,
        compactions: rows.contextTimeline?.val?.totals?.compactions ?? null,
      });
    } catch (error) {
      // V8 quotes the start of the text in JSON syntax errors, so report the kind of failure only.
      sessions.push({ ...entry, error: error instanceof SyntaxError ? "invalid JSON" : error.code ?? "unreadable" });
    }
  }
  return { cache, matched: files.length, sessions };
}

try {
  const [action, ...args] = process.argv.slice(2);
  if (action === "--help") {
    console.log([
      "dsh-desktop.mjs <check|manifest|search|files|read> --resources <desktop resources> [options]",
      "check: run the project's full pre-activation check",
      "manifest/search/files/read: see dsh-inspect.mjs --help",
      "Captures and waits for a hidden Electron Node child; never opens the desktop UI.",
      `dsh-desktop.mjs projections [--home <DSH home>] [--since <ISO time>] [--limit 1..${MAX_PROJECTIONS}]`,
      "projections: plain Node read of the session projection cache, newest first; prints createdAt, agentPreset,",
      "compactionSettings, contextPressure and the compaction count only. --home defaults to $DSH_HOME, then ~/.dsh.",
    ].join("\n"));
  } else if (action === "projections") {
    process.stdout.write(`${JSON.stringify(await projections(args))}\n`);
  } else {
    if (!["check", "manifest", "search", "files", "read"].includes(action)) throw new Error("choose check, manifest, search, files, read or projections; see --help");
    const index = args.indexOf("--resources");
    if (index < 0 || !args[index + 1]) throw new Error("--resources is required");
    const resources = resolve(args[index + 1]);
    const script = join(dirname(fileURLToPath(import.meta.url)), action === "check" ? "check-local-bundle.mjs" : "dsh-inspect.mjs");
    const result = await runCheckProcess(join(dirname(resources), "DeepSeek Harness.exe"), [
      "--expose-internals", script, ...action === "check" ? [] : [action], ...args,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: action === "check" ? 180_000 : 15_000, maxBuffer: 1024 * 1024 });
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
} catch (error) {
  process.stderr.write(`dsh-desktop: ${error.message}\n${String(error.stderr ?? "").slice(-5000)}`);
  process.exitCode = 1;
}
