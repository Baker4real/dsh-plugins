import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const installed = process.env.DSH_GOAL_WAIT_DSH_ROOT || 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh';
const packageRoot = process.env.DSH_GOAL_WAIT_CHAT_PACKAGE || join(installed, 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat');

test('the Chat seat publishes a stable final-response inspection marker', () => {
  const source = readFileSync(join(packageRoot, 'src/client/chat/ChatNodeSeat.tsx'), 'utf8');
  assert.match(source, /data-chat-final-response=\{processAnswer\s*\|\|\s*undefined\}/);
  const bundle = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8');
  assert.equal(bundle.split('"data-chat-final-response":').length - 1, 1);
  assert.match(bundle, /"data-chat-final-response":processAnswer\|\|void 0/);
});
