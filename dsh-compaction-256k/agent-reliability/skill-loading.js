import { createHash } from 'node:crypto';

function fullSkill(text) {
  if (typeof text !== 'string') return undefined;
  // The installed dsh-skill renderer uses this framing for both tool loads and user invocations.
  const match = /^<skill_content name="([^"\n]+)">\n<skill_resources>\n([\s\S]*?)\n<\/skill_resources>\n\n<skill_instructions>\n([\s\S]*)\n<\/skill_instructions>\n<\/skill_content>$/.exec(text);
  if (!match || !match[3].trim()) return undefined;
  return { name: match[1], resources: match[2], body: match[3], fingerprint: createHash('sha256').update(match[3]).digest('hex') };
}

function isSkillResult(session, event, message) {
  if (message?.role !== 'tool' || message.isError || event.data.message.isError) return false;
  const callId = message.source?.callId;
  return event.sourceEventSeqs?.some(seq => {
    const call = session.eventAt(seq);
    if (call?.type !== 'tool/call' || call.data.callId !== callId) return false;
    if (call.data.name === 'skill' || call.data.name === 'skill_reload') return true;
    if (call.data.name !== 'genui_reference') return false;
    try { return JSON.parse(call.data.arguments).section?.trim().toLowerCase() === 'all'; }
    catch { return false; }
  }) === true;
}

/** A value and its complete canonical rendered body must agree before any projection. */
export function completeSkillResult(exec, result, nativeSkill) {
  const raw = result.value;
  if (result.isError || typeof raw?.name !== 'string' || raw.name !== exec.arguments?.name
    || typeof raw.provider !== 'string' || typeof raw.content !== 'string' || !nativeSkill) return undefined;
  const rendered = nativeSkill.output.render({ name: raw.name }, raw);
  if (rendered.length !== 1 || rendered[0].type !== 'text' || result.content?.length !== 1
    || result.content[0].type !== 'text' || result.content[0].text !== rendered[0].text) return undefined;
  const expected = fullSkill(rendered[0].text);
  return expected?.body === raw.content ? expected : undefined;
}

/** Read the formal, projected Session surface: replaced/pruned content cannot authorize a receipt. */
export function projectLoadedSkill(exec, result, decision, nativeSkill) {
  if (exec.name !== 'skill' || result.isError || exec.signal?.aborted || decision.kind !== 'accept'
    || Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision;
  const expected = completeSkillResult(exec, result, nativeSkill);
  if (!expected) return decision;
  const raw = result.value;
  const session = exec.agent?.session;
  if (!session || !Array.isArray(session.surface?.nodes) || typeof session.deriveEventMessage !== 'function') return decision;
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (!event || !['user/message', 'tool/result'].includes(event.type)) continue;
    const message = session.deriveEventMessage(event);
    if (event.type === 'user/message' ? message?.role !== 'user' : !isSkillResult(session, event, message)) continue;
    for (const block of message.content ?? []) {
      if (block.type !== 'text') continue;
      const previous = fullSkill(block.text);
      if (previous?.name === expected.name && previous.resources === expected.resources
        && previous.fingerprint === expected.fingerprint && previous.body === expected.body) {
        return { ...decision, content: [{ type: 'text', text: `Skill "${raw.name}" is already loaded in the current effective context (body SHA-256: ${expected.fingerprint}). Reuse those complete instructions. To read the full body again, call skill_reload({"name":${JSON.stringify(raw.name)}}).` }] };
      }
    }
  }
  return decision;
}

/** Independent entry point; the original skill registration and catalog identity remain untouched. */
export function createSkillReloadTool(nativeSkill) {
  return {
    ...nativeSkill,
    name: 'skill_reload',
    description: 'Reload the full current instructions for a skill, even when the same body is already in this context. Use skill for normal loading.',
    execute: (args, exec) => nativeSkill.execute(args, exec),
    presentCall: args => ({ card: 'generic', title: '重新加载技能', kind: 'read', rawInput: args }),
  };
}
