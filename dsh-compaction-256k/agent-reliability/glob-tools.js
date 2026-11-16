import { resolve } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  buildGlobCommand, parseGlobArgs, runRipgrep, toWorkdirRelative,
  RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES,
} from '@deepseek-ai/dsh-tool-fs-search';

export const GIT_DISCOVERY_HINT = 'A repository may use a .git file (worktree), so an empty config search does not prove that no repository exists. For a cross-project GitHub inventory, run git remote -v in each candidate repository and check ALL fetch remotes; do not narrow the inventory to account-owned repositories from an empty config search.';

export function explicitGitGlob(args) {
  return typeof args?.pattern === 'string' && (args.pattern.split('/').includes('.git')
    || (typeof args.path === 'string' && args.path.split(/[\\/]/).includes('.git')));
}

// Reuse the shipped argv builder, execution/error handling and raw-output bounds.
// Only literal .git requests opt in; the other VCS exclusions remain in force.
export async function recoverExplicitGitGlob(ctx, exec, result, nativeGlob) {
  if (result.isError || !explicitGitGlob(exec.arguments) || !Array.isArray(result.value?.paths)
    || result.value.paths.length !== 0 || typeof result.value.root !== 'string') return result;
  const input = parseGlobArgs(exec.arguments);
  const workdir = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  const searchRoot = resolve(workdir, input.path ?? '.');
  // Slash-containing rg globs anchor to cwd, even with an absolute search path.
  // Run only this subprocess at the requested root; never change the Session cwd.
  const argv = buildGlobCommand({ pattern: input.pattern }).filter(arg => arg !== '--glob=!**/.git' && arg !== '--glob=!**/.git/**');
  const searchContext = { subprocess: ctx.subprocess, workingDirectory: { ensure: async () => searchRoot } };
  const run = await runRipgrep(searchContext, exec, 'glob', argv, RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES);
  const value = { ...result.value, paths: run.noMatches ? [] : run.stdout.split('\n').filter(Boolean).map(path => toWorkdirRelative(resolve(searchRoot, path), workdir)) };
  const meta = nativeGlob.output.presentationMeta?.(exec.arguments, value);
  return { ...result, value, content: nativeGlob.output.render(exec.arguments, value), ...(meta === undefined ? {} : { meta }) };
}

export function projectGitGlob(exec, result, decision) {
  if (exec.name !== 'glob' || !explicitGitGlob(exec.arguments) || result.isError || exec.signal?.aborted
    || decision.kind !== 'accept' || Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')
    || !Array.isArray(result.value?.paths)) return decision;
  if (result.value.paths.length === 0) return { ...decision, content: [...result.content, { type: 'text', text: GIT_DISCOVERY_HINT }] };
  // A context-only enrichment keeps the native spill listener authoritative even
  // when it is outside this listener in the waterfall. A nonempty config search
  // still cannot account for worktrees or decide repository ownership.
  return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), createUserMessage({
    source: { kind: 'git-discovery-scope' }, content: [{ type: 'text', text: GIT_DISCOVERY_HINT }],
  })] };
}
