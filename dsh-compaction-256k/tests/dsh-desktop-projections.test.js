import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = join(projectRoot, "scripts/dsh-desktop.mjs");

const record = (rows, identity = {}) => JSON.stringify({
  version: 1,
  record: {
    identity: { cwd: "D:/SECRET-cwd", ...identity },
    rows: Object.fromEntries(Object.entries(rows).map(([key, val]) => [key, { ver: 1, seq: 1, val }])),
  },
});

const settings = {
  available: true, auto: true, thresholdTokens: 466944, thresholdRatio: 0.8, headroomTokens: 65536,
  modelPolicies: [], provider: "provider-a", model: "model-a",
};
const pressure = { surfaceTokens: 1000, contextWindow: 1048576, pressureTokens: 1200, sampledSurfaceTokens: 900 };

async function dshHome(t) {
  const root = await mkdtemp(join(projectRoot, "tests/.dsh-projections-"));
  t.after(async () => {
    const local = relative(join(projectRoot, "tests"), resolve(root));
    assert.ok(local.startsWith(".dsh-projections-") && !local.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const cache = join(root, "storages/session_projcache/sessions");
  await mkdir(cache, { recursive: true });
  const write = async (name, text, at) => {
    const file = join(cache, `${name}.json`);
    await writeFile(file, text);
    await utimes(file, new Date(at), new Date(at));
  };
  await write("session-old", record({ agentPreset: "standard", contextTimeline: { totals: { compactions: 0 } } }), "2026-11-01T00:00:00Z");
  await write("session-new", record({
    agentPreset: "cordis", title: "SECRET title", todos: [{ content: "SECRET todo", status: "pending" }],
    workingDirectory: "D:/SECRET-dir", compactionSettings: { ...settings, extra: "SECRET field" }, contextPressure: pressure,
    contextTimeline: { surface: [{ text: "SECRET surface" }], totals: { compactions: 2 } },
  }, { createdAt: Date.parse("2026-11-13T08:00:00Z") }), "2026-11-14T00:00:00Z");
  await write("session-torn", '{"version":1,"record":{"rows":{"title":{"val":"SECRET', "2026-11-10T00:00:00Z");
  await writeFile(join(cache, "notes.txt"), "not a projection");
  return root;
}

const cli = (root, ...args) => run(process.execPath, [command, "projections", "--home", root, ...args], { encoding: "utf8", timeout: 10_000 });

test("projections lists the newest sessions' threshold and pressure fields without other session content", async (t) => {
  const root = await dshHome(t);
  const { stdout, stderr } = await cli(root, "--limit", "2");
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /SECRET/);
  const output = JSON.parse(stdout);
  assert.equal(output.matched, 3);
  assert.deepEqual(output.sessions, [
    {
      session: "session-new", cacheUpdatedAt: "2026-11-14T00:00:00.000Z", createdAt: "2026-11-13T08:00:00.000Z", agentPreset: "cordis",
      compactionSettings: settings, contextPressure: pressure, compactions: 2,
    },
    { session: "session-torn", cacheUpdatedAt: "2026-11-10T00:00:00.000Z", error: "invalid JSON" },
  ]);
});

test("projections reports missing rows as null and filters by --since", async (t) => {
  const root = await dshHome(t);
  const all = JSON.parse((await cli(root)).stdout);
  assert.deepEqual(all.sessions.at(-1), {
    session: "session-old", cacheUpdatedAt: "2026-11-01T00:00:00.000Z", createdAt: null, agentPreset: "standard",
    compactionSettings: null, contextPressure: null, compactions: 0,
  });
  const recent = JSON.parse((await cli(root, "--since", "2026-11-09")).stdout);
  assert.equal(recent.matched, 2);
  assert.deepEqual(recent.sessions.map((session) => session.session), ["session-new", "session-torn"]);
});

test("projections rejects unbounded or malformed options", async (t) => {
  const root = await dshHome(t);
  const failsWith = (pattern) => (error) => error.code === 1 && pattern.test(error.stderr) && error.stdout === "";
  for (const limit of ["0", "51", "2.5", "many"]) {
    await assert.rejects(cli(root, "--limit", limit), failsWith(/--limit must be an integer from 1 to 50/));
  }
  await assert.rejects(cli(root, "--since", "last week"), failsWith(/--since must be an ISO date or time/));
  await assert.rejects(cli(root, "--resources", root), failsWith(/Unknown option '--resources'/));
});
