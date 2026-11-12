import { resolve, isAbsolute, sep } from 'node:path';

const SKILLS_ROOT = 'D:\\agents\\skills-manager\\skills';
const GUARDED_ENTRY = 'D:\\Codex\\.codex\\scripts\\install-skill-guarded.cmd';

function isInsideSkillsRoot(filePath, cwd) {
  if (!filePath || typeof filePath !== 'string') return false;
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd || '', filePath);
  const normalized = absolute.replace(/\//g, '\\');
  return normalized.toLowerCase().startsWith(SKILLS_ROOT.toLowerCase() + '\\')
    || normalized.toLowerCase() === SKILLS_ROOT.toLowerCase();
}

export const inject = ['workingDirectory'];

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow') return decision;

    const toolName = exec.name;
    if (toolName !== 'write' && toolName !== 'edit') return decision;

    const args = exec.arguments;
    const filePath = args?.file_path;
    if (!filePath) return decision;

    // Only absolute paths can be checked without the working-directory service.
    if (!isAbsolute(filePath)) return decision;

    if (!isInsideSkillsRoot(filePath)) return decision;

    return {
      kind: 'deny',
      reason: `直接写入现役 skills 根（${SKILLS_ROOT}）被拦截。` +
        `skill 的安装、更新和重写只能走受管入口 ${GUARDED_ENTRY}（先 --dry-run 再 apply）。` +
        '请先在候选目录里改好，再用受管入口安装。',
    };
  });
}
