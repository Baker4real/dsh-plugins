import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_PACKAGE = "@local/dsh-compaction-256k";
const PRESETS = ["standard", "ptc", "minimal", "cordis"];

function engineRows(rows, found = []) {
  for (const row of rows ?? []) {
    if (row.group === true) engineRows(row.config, found);
    else if (row.name === ENGINE_PACKAGE) found.push(row);
  }
  return found;
}

// cordis.patch.yml is the only place the threshold is written; the smoke bundle reads it back from the loaded preset.
test("all four Agent presets declare one explicit engine threshold", () => {
  const patches = loadOverlayPatches("dsh", join(projectRoot, "cordis.patch.yml"));
  const thresholds = Object.fromEntries(PRESETS.map((preset) => {
    const declared = patches.filter((patch) => patch.id === `preset-${preset}`);
    assert.equal(declared.length, 1, `preset-${preset} is patched once`);
    const rows = engineRows(declared[0].config.plugins);
    assert.equal(rows.length, 1, `preset-${preset} has one ${ENGINE_PACKAGE} row`);
    return [preset, rows[0].config?.thresholdTokens];
  }));
  const [first] = Object.values(thresholds);
  assert.ok(Number.isInteger(first) && first > 0, JSON.stringify(thresholds));
  assert.deepEqual(thresholds, Object.fromEntries(PRESETS.map((preset) => [preset, first])));
});
