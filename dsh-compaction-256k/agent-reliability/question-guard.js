import { z } from 'zod';

const optionSchema = z.object({
  label: z.string().trim().min(1),
  description: z.string().optional(),
}).strict();

const questionSchema = z.object({
  header: z.string().optional(),
  id: z.string().trim().min(1),
  question: z.string().trim().min(1),
  multi_select: z.boolean().optional(),
  options: z.array(optionSchema).optional(),
}).strict();

const inputSchema = z.object({
  questions: z.array(questionSchema).min(1),
}).strict().superRefine((input, context) => {
  const seen = new Set();
  input.questions.forEach((question, index) => {
    if (seen.has(question.id)) context.addIssue({ code: 'custom', path: ['questions', index, 'id'], message: 'duplicate id' });
    seen.add(question.id);
  });
});

/** Synchronous ToolsService guard; diagnostic paths never echo user question text. */
export function guardAskUserQuestion(exec) {
  if (exec.name !== 'ask_user_question') return undefined;
  const result = inputSchema.safeParse(exec.arguments);
  if (result.success) return undefined;
  const issues = result.error.issues.slice(0, 12).map(issue => `${issue.path.join('.')} (${issue.code})`).join('; ');
  return `Invalid ask_user_question input: ${issues}. Fix the schema before asking the user.`;
}
