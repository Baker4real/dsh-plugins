import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../preset-inspect.js";

test("Preset Inspect matches configs by nested row identity across Loader reordering", async () => {
  let provider;
  const moduleName = "@deepseek-ai/dsh-compaction-tool-result-pruner";
  const config = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };
  const ctx = {
    cordisInspect: { register: (value) => { provider = value; return () => {}; } },
    agentPresets: {
      definitions: new Map([["standard", { config: { plugins: [
        { id: "planning", name: "cordis:group", group: true, config: [] },
        { id: "compaction", name: "cordis:group", group: true, config: [
          { id: "tool-result-pruner", name: moduleName, config },
        ] },
      ] } }]]),
      compositionInventory: async () => [{
        id: "standard",
        rows: [{ entryId: "tool-result-pruner", moduleName, enabled: true, fiberState: 2 }],
      }],
    },
    effect: (callback) => callback(),
  };
  apply(ctx);
  const output = await provider.query("listEntries", { name: moduleName, includeConfig: true });
  assert.equal(output.total, 1);
  assert.deepEqual(output.entries[0].config, config);
  assert.deepEqual(output.diagnostics, []);
});
