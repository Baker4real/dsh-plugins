const CONFIG_PACKAGE_DIR_PAGE = 5;

function hostInput(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return input;
  const { includeSchema: _includeSchema, ...rest } = input;
  return rest;
}

function declaredProperties(contract) {
  const schema = contract?.method?.inputSchema;
  if (!schema || schema.additionalProperties !== false || !schema.properties || typeof schema.properties !== 'object') return null;
  return Object.keys(schema.properties);
}

function undeclaredInput(contract, input, args) {
  const allowed = declaredProperties(contract);
  if (!allowed || input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const extra = Object.keys(input).filter(key => key !== 'includeSchema' && !allowed.includes(key));
  if (extra.length === 0) return null;
  const names = allowed.length > 0 ? allowed.join(', ') : '(none)';
  return { error: { code: 'UNDECLARED_INPUT', message: `${args.platform ?? 'host'} ${args.provider}.${args.method} rejected undeclared input: ${extra.join(', ')}. Allowed properties: ${names}.` } };
}

async function projectConfig(data, input, query) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data.entries)) {
    if (data.entries.length > CONFIG_PACKAGE_DIR_PAGE) return data;
    const entries = [];
    for (const row of data.entries) {
      if (!row || typeof row !== 'object' || typeof row.packageDir === 'string' || typeof row.id !== 'string') {
        entries.push(row);
        continue;
      }
      try {
        const detail = await query({ entry: row.id });
        entries.push({ ...row, packageDir: detail && typeof detail.packageDir === 'string' ? detail.packageDir : null });
      } catch {
        entries.push({ ...row, packageDir: null });
      }
    }
    return { ...data, entries };
  }
  if (input?.includeSchema === true || !Object.hasOwn(data, 'schema')) return data;
  const { schema: _schema, ...rest } = data;
  return { ...rest, schemaOmitted: true };
}

export function createInspectTool(ctx, lens) {
  return {
    name: 'dsh_inspect',
    description: 'Bounded read-only Harness discovery for small plugin changes. Start with the compact Provider directory, then request one method contract or run its declared query. Never invokes business operations. Config.listConfigs pages of up to 5 rows include packageDir. An entry result omits the plugin schema unless input.includeSchema is true. Host and Client methods with the same name do not share an input contract.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['providers', 'contract', 'query'], description: 'Defaults to providers. contract reads one schema; query runs that read-only method.' },
      platform: { type: 'string', enum: ['host', 'client'] },
      provider: { type: 'string', description: 'Exact id from the directory; required for contract/query.' },
      method: { type: 'string', description: 'Exact method from the directory; required for contract/query.' },
      input: { type: 'object', additionalProperties: true, description: 'Input matching the selected platform method contract. includeSchema is not forwarded; set it true only to return a Config.listConfigs plugin schema.' },
      offset: { type: 'integer', description: 'Directory cursor; default zero.' },
      limit: { type: 'integer', description: 'Directory page size, 1-100; default 20.' },
      maxBytes: { type: 'integer', description: 'Output budget, 800-16000 bytes; default 6000. Oversized query results return a narrower-query hint.' },
    }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute(args = {}, exec) {
      const action = args.action ?? 'providers';
      const maxBytes = args.maxBytes ?? 6000;
      if (!Number.isInteger(maxBytes) || maxBytes < 800 || maxBytes > 16000) throw new Error('INVALID_OUTPUT_BUDGET');
      const manifests = ctx.cordisInspect.list();
      if (action === 'providers') return lens.providers(manifests, args);
      if (!['contract', 'query'].includes(action)) throw new Error('INVALID_INSPECT_ACTION');
      const contract = lens.provider(manifests, args);
      if (action === 'contract' || contract.error) return contract;
      const rejected = undeclaredInput(contract, args.input, args);
      if (rejected) return rejected;
      if (!exec.agent) throw new Error('AGENT_REQUIRED');
      const platform = args.platform ?? 'host';
      const forwarded = hostInput(args.input);
      let data = await ctx.cordisInspect.query(platform, args.provider, args.method, forwarded, exec.agent, exec.signal);
      if (args.provider === 'Config' && args.method === 'listConfigs') {
        data = await projectConfig(data, args.input, input => ctx.cordisInspect.query(platform, 'Config', 'listConfigs', input, exec.agent, exec.signal));
      }
      const result = { platform, provider: args.provider, method: args.method, data };
      const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      return bytes <= maxBytes ? result : { error: { code: 'QUERY_RESULT_TOO_LARGE', requiredBytes: bytes, message: 'Use a narrower method/input or pagination. Inspect.method and SourceNav support exact bounded reads.' }, maxBytes };
    },
  };
}
