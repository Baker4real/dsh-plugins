const TTL_MS = 30_000;
const textBytes = value => Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
function budget(input) {
  const value = input.maxBytes ?? 6000;
  if (!Number.isInteger(value) || value < 800 || value > 16000) throw new Error('maxBytes must be an integer from 800 to 16000');
  return value;
}
function platformOf(input) {
  const value = input.platform ?? 'host';
  if (!['host', 'client'].includes(value)) throw new Error('platform must be host or client');
  return value;
}
export function signatureName(signature) {
  const plain = signature.trim().replace(/^(?:@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*)+/u, '').replace(/^(?:(?:declare|abstract|public|protected|readonly|async|static)\s+)+/u, '').replace(/^\*\s*/u, '');
  return /^(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)/u.exec(plain)?.[1] ?? plain;
}
function clipped(value, max = 500) {
  return typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value;
}
function page(base, key, values, input) {
  const maxBytes = budget(input);
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('offset must be nonnegative and limit must be from 1 to 100');
  const result = { ...base, [key]: [], total: values.length, nextOffset: null, truncated: false };
  for (const value of values.slice(offset, offset + limit)) {
    result[key].push(value);
    if (textBytes(result) > maxBytes - 256) { result[key].pop(); result.truncated = true; break; }
  }
  if (result[key].length === 0 && offset < values.length) return { error: { code: 'BUDGET_TOO_SMALL', message: 'Increase maxBytes for the selected item.' }, maxBytes };
  result.nextOffset = offset + result[key].length < values.length ? offset + result[key].length : null;
  return result;
}

/** Cache a requesting Agent's readonly contract snapshots; never share scoped data across Agents. */
export class InspectionLens {
  constructor({ query, generation = () => '', now = Date.now }) {
    this.query = query;
    this.generation = generation;
    this.now = now;
    this.scopes = new WeakMap();
  }
  async load(platform, service, input, context) {
    const { agent, signal = new AbortController().signal } = context;
    if (agent === null || typeof agent !== 'object') throw new Error('An Agent-backed inspection request is required');
    signal.throwIfAborted();
    let cache = this.scopes.get(agent);
    if (cache === undefined) { cache = new Map(); this.scopes.set(agent, cache); }
    const key = `${this.generation()}\0${platform}\0${service ?? ''}`;
    const existing = cache.get(key);
    if (!input.refresh && existing !== undefined && this.now() - existing.at < TTL_MS) return { data: existing.data, cacheHit: true, ageMs: this.now() - existing.at };
    const data = await this.query(platform, 'Service', 'listService', service === undefined ? {} : { service }, agent, signal);
    signal.throwIfAborted();
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    cache.set(key, { at: this.now(), data });
    return { data, cacheHit: false, ageMs: 0 };
  }
  async services(input = {}, context) {
    const platform = platformOf(input);
    const { data, cacheHit, ageMs } = await this.load(platform, undefined, input, context);
    return page({ platform, cache: { hit: cacheHit, ageMs, ttlMs: TTL_MS } }, 'services', (data.services ?? []).map(row => ({ key: row.key, methods: [...new Set((row.methods ?? []).map(method => signatureName(method.signature)))] })), input);
  }
  async method(input, context) {
    const maxBytes = budget(input);
    const platform = platformOf(input);
    if (typeof input.service !== 'string' || !/^[A-Za-z_$][\w$.-]{0,127}$/u.test(input.service) || typeof input.method !== 'string' || !/^[A-Za-z_$][\w$]{0,127}$/u.test(input.method)) throw new Error('service and method must be exact identifier names from the catalog');
    const catalog = await this.load(platform, undefined, input, context);
    if (!(catalog.data.services ?? []).some(service => service.key === input.service)) {
      return { platform, error: { code: 'UNKNOWN_SERVICE', service: clipped(input.service, 128), message: 'Not present in this Agent\'s cached Service catalog. Use refresh:true after a service change.' }, cache: { hit: catalog.cacheHit, ageMs: catalog.ageMs } };
    }
    const selected = await this.load(platform, input.service, input, context);
    const contracts = (selected.data.service?.methods ?? []).filter(method => signatureName(method.signature) === input.method).map(method => ({ ...method, description: clipped(method.description) }));
    if (contracts.length === 0) return { platform, service: input.service, error: { code: 'UNKNOWN_METHOD', method: clipped(input.method, 128) } };
    const result = { platform, service: input.service, method: input.method, access: selected.data.service.access, contracts, cache: { hit: selected.cacheHit, ageMs: selected.ageMs, ttlMs: TTL_MS }, truncated: (selected.data.service?.methods ?? []).some(method => signatureName(method.signature) === input.method && typeof method.description === 'string' && method.description.length > 500) };
    if (textBytes(result) > maxBytes - 256) return { error: { code: 'BUDGET_TOO_SMALL', requiredBytes: textBytes(result) + 256, message: 'The exact method contract does not fit. Increase maxBytes.' }, maxBytes };
    if (input.includeTypes === true) {
      const types = selected.data.referencedTypes ?? [];
      const chosen = new Set();
      let text = JSON.stringify(contracts);
      let previousSize = -1;
      while (chosen.size !== previousSize) {
        previousSize = chosen.size;
        for (const type of types) {
          if (chosen.has(type.name) || !/^[A-Za-z_$][\w$]*$/u.test(type.name)) continue;
          if (new RegExp(`\\b${type.name}\\b`, 'u').test(text)) { chosen.add(type.name); text += `\n${type.declaration}`; }
        }
      }
      result.referencedTypes = [];
      result.omittedTypes = [];
      for (const type of types.filter(type => chosen.has(type.name))) {
        result.referencedTypes.push(type);
        if (textBytes(result) > maxBytes - 256) { result.referencedTypes.pop(); result.omittedTypes.push(type.name); result.truncated = true; }
      }
      while (textBytes(result) > maxBytes - 256 && result.omittedTypes.length) result.omittedTypes.pop();
    }
    return result;
  }
  providers(manifests, input = {}) {
    if (input.platform !== undefined) platformOf(input);
    return page({}, 'providers', manifests.filter(row => input.platform === undefined || row.platform === input.platform).map(row => ({ platform: row.platform, id: row.id, purpose: clipped(row.description, 160), methods: row.methods.map(method => method.name) })), input);
  }
  provider(manifests, input = {}) {
    const platform = platformOf(input), maxBytes = budget(input);
    if (typeof input.provider !== 'string' || typeof input.method !== 'string') throw new Error('provider and method are required');
    const manifest = manifests.find(row => row.platform === platform && row.id === input.provider);
    const method = manifest?.methods.find(row => row.name === input.method);
    if (!method) return { platform, error: { code: 'UNKNOWN_PROVIDER_METHOD' } };
    const result = { platform, provider: manifest.id, purpose: manifest.description, method };
    if (textBytes(result) > maxBytes - 256) return { error: { code: 'BUDGET_TOO_SMALL', requiredBytes: textBytes(result) + 256 }, maxBytes };
    return result;
  }
}
