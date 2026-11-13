import { mkdir, writeFile } from 'node:fs/promises';

export const inject = ['tools', 'agents'];
const ROOT = 'D:/agents/run-evidence/retro-all-20261113/live-question-guard';

export async function apply(ctx) {
  const agent = ctx.agents.list()[0];
  const report = { status: 'failed', externalRequests: 0, userQuestionDisplayed: false };
  if (!agent) throw new Error('No live agent for question guard smoke');
  const execute = async (id, arguments_) => {
    const response = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id, name: 'ask_user_question', arguments: JSON.stringify(arguments_) }],
      signal: AbortSignal.timeout(10000), agent,
    });
    return response.results[0]?.result;
  };
  try {
    const malformed = await execute('question-smoke-malformed', {
      questions: [{ id: '', question: '', 'multi_select false': false }],
    });
    const duplicate = await execute('question-smoke-duplicate', {
      questions: [{ id: 'same', question: 'first' }, { id: 'same', question: 'second' }],
    });
    const valid = await execute('question-smoke-valid', {
      questions: [{ id: 'valid', question: 'Valid schema negative control; do not display.' }],
    });
    report.malformed = { isError: malformed?.isError, error: malformed?.error?.message ?? null };
    report.duplicate = { isError: duplicate?.isError, error: duplicate?.error?.message ?? null };
    report.valid = { isError: valid?.isError, error: valid?.error?.message ?? null };
    report.status = malformed?.isError && /Invalid ask_user_question input/.test(malformed.error?.message ?? '')
      && duplicate?.isError && /Invalid ask_user_question input/.test(duplicate.error?.message ?? '')
      && valid?.isError && /aborted before the user answered/i.test(valid.error?.message ?? '') ? 'passed' : 'failed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  await mkdir(ROOT, { recursive: true });
  await writeFile(`${ROOT}/result.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (report.status !== 'passed') throw new Error(`Question guard smoke failed: ${JSON.stringify(report)}`);
}
