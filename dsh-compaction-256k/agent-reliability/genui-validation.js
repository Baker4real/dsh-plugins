// The native validator returns a protocol string, followed by optional JSON fences.
// Keep schema validity, every diagnostic and both payloads; truncation only changes
// permission to emit. In particular, native_fence_json may already be truncated.
export function projectGenuiValidation(exec, result, decision, nativeValidation) {
  if (exec.name !== 'validate_dsh_ui' || !nativeValidation || result.isError || exec.signal?.aborted
    || decision.kind !== 'accept' || Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')
    || typeof result.value !== 'string') return decision;
  const raw = result.value;
  if (!raw.startsWith('[genui-validation]\n') && !raw.startsWith('[genui-validation]\r\n')) return decision;
  const payload = /\r?\n(?:repaired_json|native_fence_json):/.exec(raw);
  const boundary = payload?.index ?? raw.length;
  const header = raw.slice(0, boundary);
  if (!/^warning=policy_truncated(?:\s|$)/m.test(header)) return decision;
  const newline = header.includes('\r\n') ? '\r\n' : '\n';
  const corrected = header.replace(/^next=(?:emit_fence|emit_repaired_fence|fix_and_revalidate)\r?$/m,
    `next=fix_and_revalidate${newline}content_fidelity=not_preserved${newline}required_action=split_or_reduce_without_omitting_content_then_revalidate`);
  if (corrected === header) return decision;
  return { ...decision, value: corrected + raw.slice(boundary) };
}
