import { relative } from 'node:path';

function excerpt(value, limit) {
  const text = String(value ?? '').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function describeFailure(data) {
  const error = data.details.error.cause ?? data.details.error;
  const lines = String(error.message ?? error).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const diff = lines.filter(line => /^[+-] /.test(line)).slice(0, 2).map(line => excerpt(line, 140));
  return {
    test: excerpt(data.name, 160),
    ...(data.file ? { file: relative(process.cwd(), data.file).replaceAll('\\', '/') } : {}),
    ...(data.line ? { line: data.line } : {}),
    message: excerpt(lines[0], 190),
    ...(diff.length > 0 ? { diff } : {}),
  };
}

export default async function* testDiagnostics(events) {
  const failures = [];
  let summary;
  for await (const { type, data } of events) {
    if (type === 'test:fail' && data.details.error.failureType !== 'subtestsFailed' && failures.length < 5) {
      failures.push(describeFailure(data));
    }
    if (type === 'test:summary' && !data.file) {
      const { passed, failed, skipped, todo } = data.counts;
      summary = { passed, failed, skipped, todo };
    }
  }
  yield `${JSON.stringify({ ...summary, failures })}\n`;
}
