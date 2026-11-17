import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';

function isWindowsAbsolute(path) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function isAnyAbsolute(path) {
  return isAbsolute(path) || isWindowsAbsolute(path);
}

function absolutePath(filePath, cwd) {
  if (isWindowsAbsolute(filePath)) return win32.normalize(filePath);
  if (isAbsolute(filePath)) return filePath;
  if (cwd && isWindowsAbsolute(cwd)) return win32.resolve(cwd, filePath);
  return resolve(cwd, filePath);
}


const SKILLS_ROOT = 'D:\\agents\\skills-manager\\skills';
const GUARDED_ENTRY = 'D:\\Codex\\.codex\\scripts\\install-skill-guarded.cmd';

async function canonicalPath(filePath, cwd) {
  const absolute = absolutePath(filePath, cwd);
  try { return await realpath(absolute); } catch { /* A new write target does not exist yet. */ }
  try { return join(await realpath(dirname(absolute)), basename(absolute)); }
  catch { return absolute; }
}

function isInsideSkillsRoot(path) {
  const normalized = path.replace(/\//g, '\\');
  return normalized.toLowerCase().startsWith(SKILLS_ROOT.toLowerCase() + '\\')
    || normalized.toLowerCase() === SKILLS_ROOT.toLowerCase();
}

function isInsideAsar(path) {
  return /\/app\.asar(?:\/|$)/i.test(path.replace(/\\/g, '/'));
}

export const inject = ['workingDirectory'];

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow') return decision;

    const toolName = exec.name;
    const args = exec.arguments;

    if (toolName === 'grep' || toolName === 'glob') {
      const searchPath = args?.path ?? '.';
      const cwd = exec.agent ? ctx.workingDirectory.get(exec.agent.session) : undefined;
      if (!isAnyAbsolute(searchPath) && !cwd) return decision;
      if (!isInsideAsar(await canonicalPath(searchPath, cwd))) return decision;
      return {
        kind: 'deny',
        reason: 'app.asar 是打包文件，原生 grep/glob 不能检索其中的路径。' +
          '请改用 Host SourceNav 定位包内文件，或用 Source.searchFile 检索单个已知文件。',
      };
    }

    if (toolName !== 'write' && toolName !== 'edit') return decision;

    const filePath = args?.file_path;
    if (!filePath) return decision;

    const cwd = exec.agent ? ctx.workingDirectory.get(exec.agent.session) : undefined;
    if (!isAnyAbsolute(filePath) && !cwd) return decision;

    if (!isInsideSkillsRoot(await canonicalPath(filePath, cwd))) return decision;

    return {
      kind: 'deny',
      reason: `直接写入现役 skills 根（${SKILLS_ROOT}）被拦截。` +
        `skill 的安装、更新和重写只能走受管入口 ${GUARDED_ENTRY}（先 --dry-run 再 apply）。` +
        '请先在候选目录里改好，再用受管入口安装。',
    };
  });
}
