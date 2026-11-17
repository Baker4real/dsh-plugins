import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

const root = resolveRoot();
const installed = process.env.DSH_GOAL_WAIT_DSH_ROOT || 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh';
const packageRoot = process.env.DSH_GOAL_WAIT_CHAT_PACKAGE || join(installed, 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat');
const sourceFiles = [
  'src/client/conversation-nodes/turn-process.ts',
  'src/client/conversation-nodes/event-projection.ts',
  'src/client/conversation-nodes/common.ts',
  'src/client/contract/assistant-content.ts',
  'src/client/contract/turn-process.ts',
];
// Electron cannot strip TypeScript types below node_modules. Copy the exported
// source closure into this test's owned D-drive directory, then import it there.
const work = mkdtempSync(join(root, '.chat-fold-test-'));
assert.ok(work.startsWith(`${root}${sep}`));
after(() => rmSync(work, { recursive: true, force: true }));
for (const file of sourceFiles) {
  const target = join(work, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(packageRoot, file), target);
}
const { turnProcessDefinition } = await import(pathToFileURL(join(work, 'src/client/conversation-nodes/turn-process.ts')).href);
const { toAssistantBlocks } = await import(pathToFileURL(join(work, 'src/client/conversation-nodes/event-projection.ts')).href);

function resolveRoot() {
  return fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
}

function project(toolName, withText = true) {
  const turnStart = { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } };
  const content = [
    ...(withText ? [{ type: 'text', text: 'Final reply that must stay visible.' }] : []),
    ...(toolName ? [{ type: 'tool-call', id: 'call-1', name: toolName, arguments: '{}' }] : []),
  ];
  const message = {
    seq: 3,
    time: 3000,
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { id: 'message-1', content } },
  };
  const turnEnd = { seq: 5, time: 5000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } };
  let state = turnProcessDefinition.start({}, { event: turnStart });
  state = turnProcessDefinition.update({ state }, { event: message });
  const blocks = toAssistantBlocks(content);
  const finalNode = {
    kind: 'assistant', seq: message.seq, messageId: 'message-1', time: message.time,
    turn: 1, step: 1, blocks,
    timing: { stepStartTime: null, firstTokenTime: null, completedTime: message.time },
  };
  const assistant = { status: 'settled', turn: 1, step: 1, blocks, time: message.time, finalNode };
  const step = { step: 1, status: 'closed', data: new Map([['assistant-step', assistant]]) };
  const turn = { turn: 1, status: 'closed', start: turnStart, end: turnEnd, steps: [step] };
  const location = { kind: 'turn', turn };
  const context = {
    state,
    current: new Map(),
    matches: [{ event: message, location }],
    start: { event: turnStart, location },
  };
  return turnProcessDefinition.buildLocationData(context, 'turn', undefined)?.value;
}

test('a plain final reply is outside process folding', () => {
  assert.equal(project(null)?.answerAnchorSeq, 3);
});

test('a final reply ending in wait_goal is outside process folding', () => {
  assert.equal(project('wait_goal')?.answerAnchorSeq, 3);
});

test('the production Chat bundle contains the wait_goal final-answer predicate', () => {
  const bundle = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8');
  assert.ok(bundle.includes('function latestAnswer(t){const d=t.steps.at(-1)?.data.get(`assistant-step`);if(!isFinalAssistant(d)||!hasAssistantReplyContent(d.blocks))return null;return d.blocks.some(b=>b.kind===`tool-call`&&b.name!==`wait_goal`)?null:d}'));
});

test('ordinary tool progress is not promoted to a final answer', () => {
  assert.equal(project('read')?.answerAnchorSeq, null);
});

test('wait_goal without visible reply content is not a final answer', () => {
  assert.equal(project('wait_goal', false)?.answerAnchorSeq, null);
});
