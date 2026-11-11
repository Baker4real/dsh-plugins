import test from "node:test";
import assert from "node:assert/strict";
import { apply, compactInspection } from "../compact-inspect.js";

test("Service catalog keeps keys and method names without contracts or referenced types", () => {
  const output = compactInspection("Service", "listService", {
    mode: "catalog",
    services: [{
      key: "llm",
      description: "large description",
      methods: [{ signature: "async call(): Promise<void>", description: "large method description" }],
    }],
    referencedTypes: [{ name: "Large", declaration: "x".repeat(1000) }],
  });
  assert.deepEqual(output, {
    mode: "catalog",
    services: [{ key: "llm", methods: ["call"] }],
    compact: { omitted: ["service descriptions", "method signatures", "method descriptions", "referencedTypes"] },
  });
});

test("exact Service contracts keep methods but omit access prose and referenced types", () => {
  const output = compactInspection("Service", "listService", {
    mode: "service",
    service: {
      key: "llm",
      description: "large description",
      access: { hardDependency: {} },
      methods: [{ signature: "call()", parameters: [], returns: "void" }],
    },
    referencedTypes: [{ name: "Large", declaration: "x".repeat(1000) }],
  });
  assert.deepEqual(output, {
    mode: "service",
    service: { key: "llm", methods: [{ signature: "call()", parameters: [], returns: "void" }] },
    compact: { omitted: ["service description", "access", "referencedTypes"] },
  });
});

test("Slots topology keeps only navigation fields while exact selections retain props and occupants", () => {
  const selected = {
    type: "slot",
    name: "conversation.composer.dock",
    occupants: [{ id: "usage", active: true }],
    catalog: { standardProps: ["useProjection"] },
  };
  const output = compactInspection("Slots", "listSubTree", {
    requestedRoot: { name: "conversation.composer.dock", available: true },
    trees: [{
      type: "slot",
      name: "root",
      kind: "single",
      scope: "root",
      purpose: "large purpose",
      registration: [{ name: "key", description: "large schema" }],
      children: [{ type: "factory", name: "conversation.content", scope: "session", children: [] }],
    }],
    selected,
    referencedTypes: [{ name: "Large", declaration: "x".repeat(1000) }],
  });
  assert.deepEqual(output, {
    requestedRoot: { name: "conversation.composer.dock", available: true },
    trees: [{
      type: "slot",
      name: "root",
      kind: "single",
      scope: "root",
      children: [{ type: "factory", name: "conversation.content", scope: "session", children: [] }],
    }],
    selected,
    compact: { omitted: ["purpose", "registration schemas", "replaceRisk", "keyDomain", "referencedTypes"] },
  });
});

test("the compact tool delegates through the existing read-only Inspect dispatcher", async () => {
  let definition;
  let invocation;
  const ctx = {
    tools: { register: (value) => { definition = value; } },
    cordisInspect: {
      query: async (...args) => {
        invocation = args;
        return { mode: "catalog", services: [], referencedTypes: [] };
      },
    },
  };
  apply(ctx);
  const agent = {};
  const signal = new AbortController().signal;
  const input = { service: "llm" };
  const result = await definition.execute({
    platform: "host", provider: "Service", method: "listService", input,
  }, { agent, signal });
  assert.deepEqual(invocation, ["host", "Service", "listService", input, agent, signal]);
  assert.deepEqual(result.data, {
    mode: "catalog",
    services: [],
    compact: { omitted: ["service descriptions", "method signatures", "method descriptions", "referencedTypes"] },
  });
  await assert.rejects(
    definition.execute({ platform: "host", provider: "Config", method: "listConfigs" }, { agent, signal }),
    /only supports Service\.listService and Slots\.listSubTree/,
  );
});
