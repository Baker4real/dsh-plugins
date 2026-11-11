import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
function within(root, target) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function localPath(value, allowDot = false) {
  if (typeof value !== 'string' || value.length > 512 || (!value && !allowDot) || isAbsolute(value) || value.includes(':') || value.split(/[\\/]/u).includes('..')) {
    throw new Error('Expected a relative path inside the selected package; traversal is not allowed');
  }
  return value;
}
function integer(value, fallback, min, max, name) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return result;
}
export function boundedRows(base, key, rows, maxBytes = 6000) {
  integer(maxBytes, 6000, 800, 16000, 'maxBytes');
  const output = { ...base, [key]: [], total: rows.length, truncated: false };
  for (const row of rows) {
    output[key].push(row);
    if (Buffer.byteLength(JSON.stringify(output, null, 2), 'utf8') > maxBytes - 256) {
      output[key].pop();
      output.truncated = true;
      break;
    }
  }
  if (rows.length > 0 && output[key].length === 0) throw new Error('The first selected item does not fit maxBytes; increase the budget');
  if (Buffer.byteLength(JSON.stringify(output, null, 2), 'utf8') > maxBytes - 256) throw new Error('Metadata exceeds maxBytes; narrow the request');
  return output;
}

/** Read only one installed package at a time, through Electron's ASAR filesystem. */
export class SourceNavigator {
  constructor(root) { this.root = resolve(root); }
  async package(packageName) {
    if (typeof packageName !== 'string' || packageName.length > 214 || !packagePattern.test(packageName)) throw new Error('Expected an exact npm package name');
    const root = await realpath(this.root);
    const directory = await realpath(join(root, 'node_modules', packageName));
    if (!within(root, directory)) throw new Error('Package resolves outside the configured source root');
    const manifestPath = await this.target(directory, 'package.json');
    const manifest = JSON.parse(await this.text(manifestPath));
    if (manifest.name !== packageName) throw new Error('Resolved package identity does not match the requested package');
    return { directory, manifest };
  }
  async target(directory, file) {
    localPath(file, true);
    const target = await realpath(resolve(directory, file || '.'));
    if (!within(directory, target)) throw new Error('File resolves outside the selected package');
    return target;
  }
  async text(file) {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Expected a regular UTF-8 source file of at most 2 MiB');
    const bytes = await readFile(file);
    if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new Error('Expected a UTF-8 text source file of at most 2 MiB');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  async resolve({ packageName, entry = '.', maxBytes = 6000 }) {
    if (entry !== '.' && (typeof entry !== 'string' || !entry.startsWith('./'))) throw new Error('entry must be . or an exported ./subpath');
    localPath(entry);
    const { directory, manifest } = await this.package(packageName);
    let value = manifest.exports;
    let substitution;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).some(key => key.startsWith('.'))) {
      if (Object.hasOwn(value, entry)) value = value[entry];
      else {
        const pattern = Object.keys(value).filter(key => key.includes('*')).sort((a, b) => b.length - a.length).find(key => {
          const [before, after] = key.split('*');
          return entry.startsWith(before) && entry.endsWith(after) && entry.length >= before.length + after.length;
        });
        if (pattern === undefined) value = undefined;
        else {
          const [before, after] = pattern.split('*');
          substitution = entry.slice(before.length, entry.length - after.length);
          value = value[pattern];
        }
      }
    } else if (entry !== '.') value = undefined;
    if (value === undefined && entry === '.' && manifest.exports === undefined) value = manifest.main;
    const targets = [];
    const walk = async (node, conditions = []) => {
      if (targets.length >= 32) throw new Error('Export has too many targets; select a narrower entry');
      if (typeof node === 'string') {
        const target = substitution === undefined ? node : node.replaceAll('*', substitution);
        if (!target.startsWith('./')) throw new Error('Export target must be inside the selected package');
        localPath(target);
        let exists = false;
        try { exists = (await stat(await this.target(directory, target))).isFile(); }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
        targets.push({ conditions, path: target, exists });
      } else if (Array.isArray(node)) {
        for (let index = 0; index < node.length; index += 1) await walk(node[index], [...conditions, String(index)]);
      } else if (node !== null && typeof node === 'object') {
        for (const [condition, next] of Object.entries(node)) await walk(next, [...conditions, condition]);
      }
    };
    await walk(value);
    return boundedRows({ packageName, version: manifest.version, directory, entry, exported: value !== undefined }, 'targets', targets, maxBytes);
  }
  async files({ packageName, directory: requested = '.', offset = 0, limit = 25, maxBytes = 6000 }) {
    integer(offset, 0, 0, 100000, 'offset');
    integer(limit, 25, 1, 100, 'limit');
    const { directory } = await this.package(packageName);
    const target = await this.target(directory, localPath(requested));
    const entries = (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const rows = entries.slice(offset, offset + limit).map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' : item.isSymbolicLink() ? 'symlink' : 'file' }));
    const result = boundedRows({ packageName, directory: requested, offset }, 'files', rows, maxBytes);
    result.total = entries.length;
    result.nextOffset = offset + result.files.length < entries.length ? offset + result.files.length : null;
    if (Buffer.byteLength(JSON.stringify(result, null, 2)) > maxBytes - 128) throw new Error('Metadata exceeds maxBytes');
    return result;
  }
  async search({ packageName, file, needle, contextChars = 160, maxMatches = 5, maxBytes = 6000, offset = 0 }) {
    if (typeof needle !== 'string' || needle.length === 0 || needle.length > 256) throw new Error('needle must contain 1 to 256 literal characters');
    integer(contextChars, 160, 0, 500, 'contextChars');
    integer(maxMatches, 5, 1, 25, 'maxMatches');
    integer(offset, 0, 0, MAX_FILE_BYTES, 'offset');
    const { directory } = await this.package(packageName);
    const text = await this.text(await this.target(directory, localPath(file)));
    const matches = [];
    let cursor = offset;
    let nextOffset = null;
    while (cursor <= text.length) {
      const at = text.indexOf(needle, cursor);
      if (at === -1) break;
      if (matches.length === maxMatches) { nextOffset = at; break; }
      const before = text.slice(0, at);
      const newline = before.lastIndexOf('\n');
      const start = Math.max(0, at - contextChars);
      const end = Math.min(text.length, at + needle.length + contextChars);
      matches.push({ offset: at, line: before.split('\n').length, column: at - newline, start, end, text: text.slice(start, end) });
      cursor = at + Math.max(1, needle.length);
    }
    const result = boundedRows({ packageName, file, needle, offset, nextOffset, sourceChars: text.length }, 'matches', matches, maxBytes);
    if (result.truncated && result.matches.length < matches.length) result.nextOffset = matches[result.matches.length].offset;
    return result;
  }
}
