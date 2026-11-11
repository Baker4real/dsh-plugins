import test from "node:test";
import assert from "node:assert/strict";
import { apply, createPluginManagerTool } from "../plugin-manager-tools.js";
import { fileURLToPath } from "node:url";

function fixture() {
  let definition;
  const bundles = [
    { name: "alpha", enabled: true, installed: true, availability: "profile", removable: true, rows: [{}] },
    { name: "beta", enabled: false, installed: true, availability: "profile", removable: true, rows: [{}, {}] },
  ];
  const plugins = [
    { entryId: "include:alpha", moduleName: "alpha", enabled: true },
    { entryId: "include:beta", moduleName: "beta", enabled: false },
  ];
  const ctx = {
    tools: { register: (value) => { definition = value; } },
    sandboxPolicy: { resolve: () => ({ mode: "danger-full-access" }) },
    pluginManager: {
      listBundles: async () => bundles,
      listPlugins: async () => plugins,
    },
    get: () => undefined,
  };
  apply(ctx);
  const exec = { signal: new AbortController().signal };
  return { definition, exec };
}

test("list_bundles filters by exact name before returning a row-free summary", async () => {
  const { definition, exec } = fixture();
  const output = JSON.parse(await definition.execute({ action: "list_bundles", name: "beta", summary: true }, exec));
  assert.equal(output.total, 1);
  assert.equal(output.entries.length, 1);
  assert.equal(output.entries[0].name, "beta");
  assert.equal(output.entries[0].rowCount, 2);
  assert.equal("rows" in output.entries[0], false);
});

test("list_plugins filters by moduleName", async () => {
  const { definition, exec } = fixture();
  const output = JSON.parse(await definition.execute({ action: "list_plugins", name: "beta" }, exec));
  assert.equal(output.total, 1);
  assert.equal(output.entries[0].entryId, "include:beta");
});

test("list pagination rejects a limit above 100", async () => {
  const { definition, exec } = fixture();
  await assert.rejects(definition.execute({ action: "list_plugins", limit: 101 }, exec), /from 1 to 100/);
});

test("a failed local bundle check blocks installation before the manager changes the profile", async () => {
  const mutations = [];
  const ctx = {
    sandboxPolicy: { resolve: () => ({ mode: "danger-full-access" }) },
    pluginManager: { installBundle: async (...args) => { mutations.push(args); return { application: "applied" }; } },
    get: () => undefined,
  };
  const tool = createPluginManagerTool(ctx, async () => { throw new Error("local bundle check failed: incompatible projection"); });
  await assert.rejects(tool.execute({
    action: "install_bundle",
    target: fileURLToPath(new URL("../daily-update-guards", import.meta.url)),
  }, { signal: new AbortController().signal }), /local bundle check failed/);
  assert.deepEqual(mutations, []);
});

test("official file/link specs and surrounding whitespace cannot bypass local validation", async () => {
  let calls = 0;
  const ctx = {
    sandboxPolicy: { resolve: () => ({ mode: "danger-full-access" }) },
    pluginManager: { installBundle: async () => { calls += 1; return { application: "applied" }; } },
    get: () => undefined,
  };
  const tool = createPluginManagerTool(ctx, async () => { throw new Error("check refused"); });
  const directory = fileURLToPath(new URL("../context-meter", import.meta.url));
  for (const target of [`file:${directory}`, `link:${directory}`, `  ${directory}  `]) {
    await assert.rejects(tool.execute({ action: "install_bundle", target }, { signal: new AbortController().signal }), /check refused/);
  }
  assert.equal(calls, 0);
});

test("local bundle and plugin re-enables validate first; recovery disables and unrelated bundles remain available", async () => {
  const operations = [];
  const manager = {
    listPlugins: async () => [{ entryId: "meter-row", moduleName: "@local/dsh-compaction-context-meter" }],
    setPluginEnabled: async (...args) => { operations.push(["plugin", ...args]); return { application: "applied" }; },
    setBundleEnabled: async (...args) => { operations.push(["bundle", ...args]); return { application: "applied" }; },
    removeBundle: async (...args) => { operations.push(["remove", ...args]); return { application: "applied" }; },
    installBundle: async (...args) => { operations.push(["install", ...args]); return { application: "applied" }; },
  };
  const ctx = { pluginManager: manager, sandboxPolicy: { resolve: () => ({ mode: "danger-full-access" }) }, get: () => undefined };
  const exec = { signal: new AbortController().signal };
  const blocked = createPluginManagerTool(ctx, async () => { throw new Error("regression failed"); });
  for (const args of [
    { action: "set_bundle", target: "@local/dsh-compaction-context-meter", enabled: true },
    { action: "set_plugin", target: "meter-row", enabled: true },
  ]) await assert.rejects(blocked.execute(args, exec), /regression failed/);
  assert.deepEqual(operations, []);
  for (const args of [
    { action: "set_bundle", target: "@local/dsh-compaction-context-meter", enabled: false },
    { action: "set_plugin", target: "meter-row", enabled: false },
    { action: "remove_bundle", target: "@local/dsh-compaction-context-meter" },
    { action: "install_bundle", target: "unrelated-package@1.0.0" },
  ]) assert.equal(JSON.parse(await blocked.execute(args, exec)).application, "applied");
  assert.equal(operations.length, 4);

  const report = { status: "passed", hostVersion: "0.2.2-rc.1" };
  const passed = createPluginManagerTool(ctx, async () => { operations.push(["check"]); return report; });
  const output = JSON.parse(await passed.execute({ action: "set_bundle", target: "@local/dsh-compaction-context-meter", enabled: true }, exec));
  assert.deepEqual(operations.slice(-2), [["check"], ["bundle", "@local/dsh-compaction-context-meter", true]]);
  assert.deepEqual(output.localValidation, report);
});
