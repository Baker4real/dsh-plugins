export const inject = ["cordisInspect", "agentPresets"];

const inputSchema = {
  type: "object",
  properties: {
    preset: { type: "string", description: "Exact Agent preset id; omit to include every preset." },
    entry: { type: "string", description: "Exact nested plugin entry id." },
    name: { type: "string", description: "Exact nested plugin package name." },
    includeConfig: { type: "boolean", description: "Include each matched row's effective declared config; defaults to false." },
    offset: { type: "number", description: "Zero-based result offset; defaults to 0." },
    limit: { type: "number", description: "Result page size, from 1 to 100; defaults to 25." },
  },
  additionalProperties: false,
};

function flattenDefinition(rows, found = []) {
  for (const row of rows) {
    if (row.group === true) flattenDefinition(row.config, found);
    else found.push(row);
  }
  return found;
}

function page(input) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 25;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("offset must be a non-negative integer and limit must be an integer from 1 to 100");
  }
  return { offset, limit };
}

async function query(ctx, input) {
  const { offset, limit } = page(input);
  const includeConfig = input.includeConfig ?? false;
  const compositions = await ctx.agentPresets.compositionInventory();
  const selected = compositions.filter((item) => input.preset === undefined || item.id === input.preset);
  const documents = new Map();
  if (includeConfig) {
    for (const item of selected) {
      const record = ctx.agentPresets.definitions.get(item.id);
      if (record === undefined) throw new Error(`preset ${item.id}: declaration disappeared during inspection`);
      const byKey = new Map();
      for (const definition of flattenDefinition(record.config.plugins)) {
        const key = `${definition.id ?? ""}\0${definition.name}`;
        const queue = byKey.get(key) ?? [];
        queue.push(definition);
        byKey.set(key, queue);
      }
      documents.set(item.id, byKey);
    }
  }

  const diagnostics = [];
  const rows = [];
  for (const item of selected) {
    if (item.broken !== undefined) diagnostics.push({ preset: item.id, error: item.broken });
    const definitions = documents.get(item.id) ?? new Map();
    item.rows.forEach((row) => {
      const key = `${row.entryId ?? ""}\0${row.moduleName}`;
      const definition = definitions.get(key)?.shift();
      if (includeConfig && definition === undefined) {
        throw new Error(`preset ${item.id}: no declaration matches ${row.entryId} (${row.moduleName})`);
      }
      rows.push({
        preset: item.id,
        ...row,
        ...includeConfig && definition?.config !== undefined ? { config: definition.config } : {},
      });
    });
  }

  const filtered = rows.filter((row) =>
    (input.entry === undefined || row.entryId === input.entry) &&
    (input.name === undefined || row.moduleName === input.name));
  const entries = filtered.slice(offset, offset + limit);
  return {
    entries,
    total: filtered.length,
    nextOffset: offset + entries.length < filtered.length ? offset + entries.length : null,
    diagnostics,
  };
}

export function apply(ctx) {
  const provider = {
    manifest: {
      id: "Preset",
      description: "Read-only Agent preset discovery: nested plugin rows, activation diagnostics, and effective declared configs.",
      methods: [{
        name: "listEntries",
        description: "List nested Agent preset plugin rows with activation state and optional declared config.",
        inputSchema,
        outputSchema: { description: "A bounded page of nested preset rows, activation diagnostics, total, and nextOffset." },
      }],
    },
    async query(method, input = {}) {
      if (method !== "listEntries") throw new Error(`unknown Preset inspect method "${method}"`);
      return await query(ctx, input);
    },
  };
  ctx.effect(() => ctx.cordisInspect.register(provider), "preset-inspect: Preset");
}
