const field = (type, description, extra = {}) => ({
  type,
  description: [description, extra.minimum === undefined ? '' : `Minimum ${extra.minimum}.`, extra.maximum === undefined ? '' : `Maximum ${extra.maximum}.`, extra.maxLength === undefined ? '' : `At most ${extra.maxLength} characters.`].filter(Boolean).join(' '),
  ...(extra.enum === undefined ? {} : { enum: extra.enum }),
});
const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const bounds = {
  maxBytes: field('integer', 'Maximum pretty-printed provider bytes, with transport headroom; default 6000.', { minimum: 800, maximum: 16000 }),
};
const paging = { ...bounds, offset: field('integer', 'Zero-based cursor; default 0.', { minimum: 0 }), limit: field('integer', 'Page size; default 20.', { minimum: 1, maximum: 100 }) };
const platform = field('string', 'Runtime owning the Service; default host.', { enum: ['host', 'client'] });
const refresh = field('boolean', 'Bypass the 30-second, per-Agent contract cache after a runtime change.');
const packageName = field('string', 'Exact installed npm package name.', { maxLength: 214 });
const method = (name, description, inputSchema) => ({ name, description, inputSchema, outputSchema: { description: 'Bounded JSON result; omissions and continuation are explicit.' } });
export const inspectManifest = {
  id: 'Inspect', description: 'Bounded discovery and exact Service methods. Cache is per Agent and runtime graph; unknown names are preflighted.',
  methods: [
    method('providers', 'List provider purposes and method names without schemas; use provider for one exact contract.', object({ ...paging, platform })),
    method('provider', 'Read the input and output schema of one discovered Provider method.', object({ ...bounds, platform, provider: field('string', 'Exact Provider id from providers.'), method: field('string', 'Exact method name from providers.') }, ['provider', 'method'])),
    method('services', 'List Service names and method names; cached for 30 seconds per Agent and runtime graph.', object({ ...paging, platform, refresh })),
    method('method', 'Read one exact Service method and access expressions. Types are opt-in and limited to reachable declarations.', object({ ...bounds, platform, refresh, service: field('string', 'Exact Service key from services.', { maxLength: 128, pattern: '^[A-Za-z_$][\\w$.-]{0,127}$' }), method: field('string', 'Method name from services.', { maxLength: 128, pattern: '^[A-Za-z_$][\\w$]{0,127}$' }), includeTypes: field('boolean', 'Include only this method\'s reachable type declarations; default false.') }, ['service', 'method'])),
  ],
};
export const deploymentManifest = {
  id: 'Deployment', description: 'Read-only plugin change preflight: file identity, loaded-module ownership and restart requirements; never installs or applies changes.',
  methods: [method('preflight', 'Compare installed and source entry files and inspect the runtime replacement plan before changing a plugin.', object({ packageName, installedDirectory: field('string', 'Absolute installed package directory; omitted uses Config packageDir.'), sourceDirectory: field('string', 'Absolute source checkout directory.'), files: { type: 'array', items: { type: 'string' }, description: 'Optional 1-12 relative entry files; default uses manifest entries and patch.' }, maxBytes: bounds.maxBytes }, ['packageName', 'sourceDirectory']))],
};
export const sourceManifest = {
  id: 'SourceNav', description: 'Read-only package exports, actual file listings and centered source snippets inside the installed DSH source root, including ASAR.',
  methods: [
    method('resolve', 'Read a package export target and whether each conditional target actually exists; no guessed type paths.', object({ ...bounds, packageName, entry: field('string', 'Exact export key, such as . or ./client; default .', { maxLength: 256 }) }, ['packageName'])),
    method('files', 'List one actual package directory, sorted and paginated; no recursive tree dump.', object({ ...paging, packageName, directory: field('string', 'Relative package directory; default .', { maxLength: 512 }) }, ['packageName'])),
    method('search', 'Find literal text in a source file and center snippets on each match, including deep into a minified line.', object({ ...bounds, packageName, file: field('string', 'Relative source file inside the selected package.', { maxLength: 512 }), needle: field('string', 'Literal search text; regular expressions are not evaluated.', { minLength: 1, maxLength: 256 }), offset: field('integer', 'Zero-based UTF-16 character cursor from a previous nextOffset; default 0.', { minimum: 0 }), contextChars: field('integer', 'Characters retained on each side; default 160.', { minimum: 0, maximum: 500 }), maxMatches: field('integer', 'Match count limit; default 5.', { minimum: 1, maximum: 25 }) }, ['packageName', 'file', 'needle'])),
  ],
};
export const desktopManifest = {
  id: 'Desktop', description: 'Read-only native Windows hit testing for a selector-derived point; no window activation, navigation or input.',
  methods: [
    method('hitTest', 'Convert a Client CSS point with DPR, then use ClientToScreen and SendMessageTimeout(WM_NCHITTEST) on the supplied Harness window handle.', object({ handle: field('string', 'Positive top-level native window handle as a decimal string.'), x: field('number', 'CSS-pixel x coordinate from Desktop.inspectElement.'), y: field('number', 'CSS-pixel y coordinate from Desktop.inspectElement.'), devicePixelRatio: field('number', 'Client device pixel ratio; default 1, maximum 4.', { maximum: 4 }) }, ['handle', 'x', 'y'])),
  ],
};
export const runtimeManifest = {
  id: 'Runtime', description: 'Read-only Host activation, Client graph and project-validation status. Config schema absence is separate from plugin activation.',
  methods: [
    method('status', 'Read exact managed row activation and Config schema status without dumping configs, plus graph revision and optional Session presence.', object({ packageName, sessionId: field('string', 'Optional exact Session id; this query does not restore or open history.', { maxLength: 128 }), offset: paging.offset, limit: paging.limit })),
    method('checks', 'Read the latest automatic project check; this method never runs checks or changes state.', object({})),
  ],
};
