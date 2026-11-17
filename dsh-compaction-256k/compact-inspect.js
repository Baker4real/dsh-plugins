import { defineTool } from "@deepseek-ai/dsh-tools";

const SUPPORTED = new Set(["Service/listService", "Slots/listSubTree"]);

function methodName(signature) {
  const plain = signature.trim().replace(/^(?:@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*)+/u, '').replace(/^(?:(?:declare|abstract|public|protected|readonly|async|static)\s+)+/u, '').replace(/^\*\s*/u, '');
  return /^(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)/u.exec(plain)?.[1] ?? plain;
}

// Match dsh_inspect's pretty-JSON budget, paging limits and transport headroom.
function page(base, key, rows, input, envelope = value => value) {
  const maxBytes = input.maxBytes ?? 6000, offset = input.offset ?? 0, limit = input.limit ?? 20;
  if (!Number.isInteger(maxBytes) || maxBytes < 800 || maxBytes > 16000) throw new Error('maxBytes must be an integer from 800 to 16000');
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('offset must be nonnegative and limit must be from 1 to 100');
  const narrow = key === 'nodes' ? 'Select input.root, or use Inspect.slots and SourceNav.slot.' : 'Select input.service; use Inspect.method for one exact contract.';
  const output = { ...base, [key]: [], total: rows.length, offset, nextOffset: null, truncated: false };
  for (const row of rows.slice(offset, offset + limit)) {
    output[key].push(row);
    output.nextOffset = offset + output[key].length < rows.length ? offset + output[key].length : null;
    output.truncated = output.nextOffset !== null;
    if (Buffer.byteLength(JSON.stringify(envelope(output), null, 2), 'utf8') > maxBytes - 256) {
      output[key].pop();
      output.nextOffset = offset + output[key].length;
      output.truncated = true;
      break;
    }
  }
  if ((rows.length > offset && output[key].length === 0) || Buffer.byteLength(JSON.stringify(envelope(output), null, 2), 'utf8') > maxBytes - 256) return { error: { code: 'BUDGET_TOO_SMALL', message: 'Increase maxBytes or narrow the query.' }, maxBytes, narrow };
  return output;
}

export function compactInspection(provider, method, data, input = {}, envelope) {
  if (!SUPPORTED.has(`${provider}/${method}`)) throw new Error('cordis_inspect_compact only supports Service.listService and Slots.listSubTree; use cordis_inspect_query for this provider');
  if (provider === 'Service') {
    if (!['catalog', 'service'].includes(data.mode)) throw new Error('Service.listService returned an unknown data mode; use cordis_inspect_query for the full result');
    const rows = data.mode === 'catalog' ? (data.services ?? []) : [data.service];
    return page({ mode: data.mode, compact: { omitted: ['descriptions', 'method signatures', 'access', 'referencedTypes'], detail: 'Inspect.method returns one exact method contract.' } }, 'services', rows.map(service => ({ key: service.key, methods: [...new Set((service.methods ?? []).map(method => methodName(method.signature)))] })), input, envelope);
  }
  const rows = [];
  let trees = data.trees ?? [];
  const root = input.input?.root;
  if (root !== undefined) {
    const search = [...trees];
    let selected;
    while (search.length) {
      const node = search.pop();
      if ((node.type === 'slot' && node.name === root) || (node.type === 'factory' && `factory:${node.name}` === root)) { selected = node; break; }
      search.push(...(node.children ?? []));
    }
    trees = selected === undefined ? [] : [selected];
  }
  const pending = trees.map(node => ({ node, parent: null })).reverse();
  while (pending.length) {
    const { node, parent } = pending.pop();
    rows.push({ type: node.type, name: node.name, parent, ...(node.kind === undefined ? {} : { kind: node.kind }), ...(node.scope === undefined ? {} : { scope: node.scope }), childrenCount: node.children?.length ?? 0, occupantsCount: node.occupants?.length ?? 0 });
    for (const child of [...(node.children ?? [])].reverse()) pending.push({ node: child, parent: node.name });
  }
  return page({ compact: { omitted: ['trees', 'selected schemas', 'occupants', 'referencedTypes'], detail: 'Select input.root; SourceNav.slot resolves verified package/source evidence.' } }, 'nodes', rows, input, envelope);
}

export const inject = ["tools", "cordisInspect"];

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "cordis_inspect_compact",
    description: "Bounded read-only Service names or flat Slot navigation. Defaults to 6000 bytes and 20 rows; nextOffset explicitly continues. Provider and method come from cordis_inspect_list. Use Inspect.method for one exact Service contract and SourceNav.slot for verified package/source ownership.",
    parameters: {
      platform: {
        type: "string",
        required: true,
        enum: ["host", "client"],
        description: "Runtime platform that owns the Provider.",
      },
      provider: {
        type: "string",
        required: true,
        description: "Service or Slots.",
      },
      method: {
        type: "string",
        required: true,
        description: "listService for Service, or listSubTree for Slots.",
      },
      offset: { type: 'integer', description: 'Zero-based result cursor; default 0.' },
      limit: { type: 'integer', description: 'Page size, 1-100; default 20.' },
      maxBytes: { type: 'integer', description: 'Pretty-printed UTF-8 output budget, 800-16000 bytes; default 6000.' },
      input: {
        type: "json",
        description: "Optional provider input, such as an exact service name or slot root.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error("Cordis inspection requires an Agent-backed session");
      if (!SUPPORTED.has(`${args.provider}/${args.method}`)) {
        throw new Error("cordis_inspect_compact only supports Service.listService and Slots.listSubTree; use cordis_inspect_query for this provider");
      }
      page({}, 'nodes', [], args); // Validate the paging contract before dispatching a Client query.
      const data = await ctx.cordisInspect.query(
        args.platform,
        args.provider,
        args.method,
        args.input,
        exec.agent,
        exec.signal,
      );
      const envelope = projected => ({ platform: args.platform, provider: args.provider, method: args.method, data: projected });
      return envelope(compactInspection(args.provider, args.method, data, args, envelope));
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Compact Cordis ${args.platform} ${args.provider}.${args.method}`,
      kind: "read",
      rawInput: args,
    }),
  }));
}
