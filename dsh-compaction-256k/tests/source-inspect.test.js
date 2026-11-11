import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { apply } from "../source-inspect.js";

function providerFor(sourceRoot) {
  let provider;
  const ctx = {
    cordisInspect: { register: (value) => { provider = value; return () => {}; } },
    effect: (callback) => callback(),
  };
  apply(ctx, { sourceRoot });
  return provider;
}

test("Source.searchFile returns bounded line matches inside the configured DSH source root", async () => {
  const sourceRoot = resolve("tests/fixtures");
  const provider = providerFor(sourceRoot);
  const output = await provider.query("searchFile", {
    path: resolve("tests/fixtures/source-sample.js"),
    pattern: "compactPressure",
    maxMatches: 1,
  });
  assert.equal(output.total, 2);
  assert.equal(output.truncated, true);
  assert.deepEqual(output.matches, [
    { line: 2, text: "function compactPressure() {}" },
  ]);
});

test("Source.searchFile rejects paths outside the source root and invalid patterns", async () => {
  const provider = providerFor(resolve("tests/fixtures"));
  await assert.rejects(
    provider.query("searchFile", { path: resolve("README.md"), pattern: "DSH" }),
    /outside the configured source root/,
  );
  await assert.rejects(
    provider.query("searchFile", { path: resolve("tests/fixtures/source-sample.js"), pattern: "[" }),
    /invalid regular expression/i,
  );
  await assert.rejects(
    provider.query("searchFile", { path: "tests/fixtures/source-sample.js", pattern: "compactPressure" }),
    /absolute file path/,
  );
});
