import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';

const absoluteD = value => typeof value === 'string' && /^[dD]:[\\/]/.test(value) && !/[\x00-\x1f]/.test(value) && !value.slice(2).includes(':');
const normalized = value => win32.normalize(value).replaceAll('\\', '/');
const inside = (path, root) => { const rel = win32.relative(root, path); return rel !== '' && !rel.startsWith('..') && !win32.isAbsolute(rel); };
const sensitive = /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.dsh|credentials?|secrets?)(?:[\\/]|$)/i;

export function receiptPath(value, roots) {
  if (!absoluteD(value) || !value.toLowerCase().endsWith('.goal-wait.json') || sensitive.test(value)) throw new TypeError('Receipt must be an absolute D-drive *.goal-wait.json path in a configured receipt directory.');
  const path = normalized(value);
  if (!roots.some(root => inside(path, root))) throw new TypeError('Receipt is outside configured receiptRoots.');
  return path;
}
export function receiptRoots(values) {
  if (!Array.isArray(values) || values.length > 8) throw new TypeError('receiptRoots must contain at most eight dedicated directories.');
  return values.map(value => {
    if (!absoluteD(value) || sensitive.test(value)) throw new TypeError('receiptRoots must use dedicated D-drive directories.');
    const root = normalized(value);
    if (win32.parse(root).root.replaceAll('\\', '/').toLowerCase() === root.toLowerCase()) throw new TypeError('A drive root is not a receipt directory.');
    return root;
  });
}
function noLinks(path) {
  for (let current = path; ; current = win32.dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) return false; }
    catch (error) { if (current === path && error.code === 'ENOENT') continue; return false; }
    if (win32.dirname(current) === current) break;
  }
  return true;
}
export function receiptMatches(path, wait) {
  let fd;
  try {
    if (!noLinks(path)) return false;
    const real = normalized(realpathSync(path));
    if (!absoluteD(real) || real.toLowerCase() !== path.toLowerCase()) return false;
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.size < 2) return false;
    const buffer = Buffer.alloc(4097);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 4096) return false;
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)));
    return record !== null && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).sort().join(',') === 'goalId,revision,status,version,waitId' && record.version === 1 && record.status === 'ready' && record.waitId === wait.waitId && record.goalId === wait.goalRef.id && record.revision === wait.goalRef.revision;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
