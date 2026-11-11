import { defineTool } from "@deepseek-ai/dsh-tools";

const SUPPORTED = new Set(["Service/listService", "Slots/listSubTree"]);

function methodName(signature) {
  const match = /([A-Za-z_$][\w$]*)\s*\(/u.exec(signature);
  if (match !== null) return match[1];
  return signature.replace(/^readonly\s+/u, "").split(":", 1)[0].trim();
}

function compactSlotTree(node) {
  return {
    type: node.type,
    name: node.name,
    ...node.kind === undefined ? {} : { kind: node.kind },
    ...node.scope === undefined ? {} : { scope: node.scope },
    ...node.occupants === undefined ? {} : { occupants: node.occupants },
    children: (node.children ?? []).map(compactSlotTree),
  };
}

export function compactInspection(provider, method, data) {
  if (!SUPPORTED.has(`${provider}/${method}`)) {
    throw new Error("cordis_inspect_compact only supports Service.listService and Slots.listSubTree; use cordis_inspect_query for this provider");
  }
  if (provider === "Service") {
    if (data.mode === "catalog") {
      return {
        mode: "catalog",
        services: (data.services ?? []).map((service) => ({
          key: service.key,
          methods: (service.methods ?? []).map((method) => methodName(method.signature)),
        })),
        compact: { omitted: ["service descriptions", "method signatures", "method descriptions", "referencedTypes"] },
      };
    }
    if (data.mode === "service") {
      return {
        mode: "service",
        service: { key: data.service.key, methods: data.service.methods ?? [] },
        compact: { omitted: ["service description", "access", "referencedTypes"] },
      };
    }
    throw new Error("Service.listService returned an unknown data mode; use cordis_inspect_query for the full result");
  }
  return {
    ...data.requestedRoot === undefined ? {} : { requestedRoot: data.requestedRoot },
    trees: (data.trees ?? []).map(compactSlotTree),
    ...data.selected === undefined ? {} : { selected: data.selected },
    compact: { omitted: ["purpose", "registration schemas", "replaceRisk", "keyDomain", "referencedTypes"] },
  };
}

export const inject = ["tools", "cordisInspect"];

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "cordis_inspect_compact",
    description: "Run a read-only Service.listService or Slots.listSubTree query and omit large descriptions, referenced types, and topology metadata. Provider and method must come from cordis_inspect_list. Use cordis_inspect_query when you need complete Config schemas, type declarations, access rules, or slot registration documentation.",
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
      const data = await ctx.cordisInspect.query(
        args.platform,
        args.provider,
        args.method,
        args.input,
        exec.agent,
        exec.signal,
      );
      return {
        platform: args.platform,
        provider: args.provider,
        method: args.method,
        data: compactInspection(args.provider, args.method, data),
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Compact Cordis ${args.platform} ${args.provider}.${args.method}`,
      kind: "read",
      rawInput: args,
    }),
  }));
}
