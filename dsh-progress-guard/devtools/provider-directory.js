export function projectProviderDirectory(exec, result, decision, lens) {
  if (exec.name !== 'cordis_inspect_list' || result.isError || decision.kind !== 'accept' || Object.hasOwn(decision, 'content')) return decision;
  const value = Object.hasOwn(decision, 'value') ? decision.value : result.value;
  if (!Array.isArray(value?.providers)) return decision;
  const directory = lens.providers(value.providers, { maxBytes: 5600, limit: 100 });
  return { ...decision, value: { ...directory, contractLookup: 'Inspect.provider', continuation: 'Use dsh_inspect providers with nextOffset; query the chosen Provider method contract before invoking it.' } };
}
