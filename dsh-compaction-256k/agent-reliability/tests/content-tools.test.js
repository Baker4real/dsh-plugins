import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedFetchTool, createProgressiveSkillTool } from '../content-tools.js';

const exec = { callId: 'fixture-call', signal: new AbortController().signal };
const url = 'https://example.test/article';
function fetchFixture({ markdown = '# Safe heading\n正文 😀\n', statusCode = 200, body = '<h1>Safe heading</h1><script>unsafe()</script>', truncated = false, resultUrl = url } = {}) {
  const value = { url: resultUrl, statusCode, body: { kind: 'html', content: body }, truncated };
  const original = {
    name: 'web_fetch', description: 'Fetch one URL.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render(args, raw) {
        assert.deepEqual(Object.keys(args), ['url']);
        assert.equal(raw, value);
        return [{ type: 'text', text: `Fetched ${raw.url}\nExternal, untrusted content.\n\n${markdown}` }];
      },
      presentationMeta: (_args, raw) => ({ url: raw.url, statusCode: raw.statusCode, truncated: raw.truncated }),
    },
    async execute(args, context) {
      assert.deepEqual(Object.keys(args), ['url']);
      assert.equal(context, exec);
      return value;
    },
    presentCall: (args) => ({ card: 'generic', title: 'Fetch', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'web', kind: 'fetch', ...result.meta }),
  };
  return { original, value, tool: createBoundedFetchTool(original) };
}
function projected(tool, args, value) {
  const blocks = tool.output.render(args, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, value.projection);
  return JSON.parse(blocks[0].text);
}

test('fetch returns bounded safe rendered text, raw value and host-derived sources', async () => {
  const { tool, value } = fetchFixture({ markdown: '# Safe heading\n' + '正文 😀'.repeat(4000) });
  const args = { url };
  const result = await tool.execute(args, exec);
  assert.equal(result.raw, value);
  const page = projected(tool, args, result);
  assert.ok([...result.projection].length <= 6000);
  assert.match(page.content, /Safe heading/);
  assert.doesNotMatch(page.content, /unsafe\(\)|<script>/);
  assert.match(page.untrusted, /external.*untrusted/i);
  assert.equal(page.url, url);
  assert.equal(page.statusCode, 200);
  assert.equal(page.truncated, false);
  assert.ok(page.nextOffset > 0);
  assert.ok(page.omitted.after > 0);
  assert.equal(result.sources.length, 1);
  assert.match(result.sources[0].id, /^web[0-9a-f]{16}$/);
  assert.equal(result.sources[0].url, url);
  assert.equal(page.sourceId, result.sources[0].id);
  const meta = tool.output.presentationMeta(args, result);
  assert.deepEqual(meta.agentReliability, { version: 1, sources: result.sources });
  assert.deepEqual(tool.presentResult(args, { content: [], isError: false, meta }), { card: 'web', kind: 'fetch', url, statusCode: 200, truncated: false });
});

test('sections match unique titles or anchors, include children and ignore code fences', async () => {
  const markdown = '# Guide\nIntro\n## 使用方法\n保留😀\n### Child\nchild text\n```md\n## Fake\n## 使用方法\n```\n~~~md\n## Also fake\n~~~\n## Next\nexclude me\n## Duplicate\na\n## Duplicate\nb\nSetext title\n------------\nsetext body\n';
  const { tool } = fetchFixture({ markdown });
  for (const section of ['使用方法', '#使用方法']) {
    const args = { url, section };
    const result = await tool.execute(args, exec);
    const page = projected(tool, args, result);
    assert.deepEqual(page.section, { requested: section, title: '使用方法', anchor: '#使用方法' });
    assert.equal(page.content, '## 使用方法\n保留😀\n### Child\nchild text\n```md\n## Fake\n## 使用方法\n```\n~~~md\n## Also fake\n~~~\n');
  }
  for (const section of ['Fake', 'Missing']) {
    await assert.rejects(tool.execute({ url, section }, exec), /section.*not found.*outline/i);
  }
  for (const section of ['Duplicate', '#duplicate']) {
    await assert.rejects(tool.execute({ url, section }, exec), /ambiguous.*2/i);
  }
  const outline = projected(tool, { url, mode: 'outline' }, await tool.execute({ url, mode: 'outline' }, exec));
  assert.match(outline.content, /### Child \(#child\)/);
  assert.match(outline.content, /Setext title \(#setext-title\)/);
  assert.doesNotMatch(outline.content, /Fake|fake|child text|保留/);
  const setextArgs = { url, section: '#setext-title' };
  const setext = projected(tool, setextArgs, await tool.execute(setextArgs, exec));
  assert.equal(setext.content, 'Setext title\n------------\nsetext body\n');
});

test('continuations reconstruct content exactly with Unicode-safe cursors and a total output cap', async () => {
  const markdown = '## 分页\n' + '中文😀𠮷\\"\n'.repeat(700);
  const { tool } = fetchFixture({ markdown, truncated: true });
  let offset = 0;
  let combined = '';
  let count = 0;
  do {
    const args = { url, section: '分页', offset, maxCharacters: 1024 };
    const result = await tool.execute(args, exec);
    const page = projected(tool, args, result);
    assert.ok([...result.projection].length <= 1024);
    assert.equal(page.content.isWellFormed(), true);
    assert.equal(page.offset, offset);
    assert.equal(page.omitted.before, offset);
    assert.equal(page.truncated, true);
    assert.match(page.notice, /Upstream.*truncated/);
    assert.equal(page.totalCharacters, [...markdown].length);
    combined += page.content;
    if (page.nextOffset !== null) {
      assert.ok(page.nextOffset > offset);
      assert.equal(page.nextOffset, offset + [...page.content].length);
      assert.ok(page.omitted.after > 0);
    } else assert.equal(page.omitted.after, 0);
    offset = page.nextOffset;
    assert.ok(++count < 100, 'continuation must make progress');
  } while (offset !== null);
  assert.equal(combined, markdown);
  assert.ok(count > 1);
  const args = { url, section: '分页', offset: [...markdown].length };
  const end = projected(tool, args, await tool.execute(args, exec));
  assert.equal(end.content, '');
  assert.equal(end.nextOffset, null);
  await assert.rejects(tool.execute({ ...args, offset: args.offset + 1 }, exec), /offset exceeds/);
});

test('wrapper schema discovers controls and execute enforces bounded parameters', async () => {
  const { tool, original } = fetchFixture();
  assert.deepEqual(tool.parameters.properties.url, original.parameters.properties.url);
  assert.deepEqual(tool.parameters.required, ['url']);
  assert.deepEqual(tool.parameters.properties.mode.enum, ['content', 'outline']);
  assert.match(tool.parameters.properties.maxCharacters.description, /6000.*24000/);
  for (const offset of [-1, 0.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(tool.execute({ url, offset }, exec), /offset.*non-negative.*integer/);
  }
  for (const maxCharacters of [0, 1023, 24001, '6000', 1024.5, NaN, Infinity]) {
    await assert.rejects(tool.execute({ url, maxCharacters }, exec), /maxCharacters.*1024.*24000/);
  }
  for (const mode of ['full', null, 3]) await assert.rejects(tool.execute({ url, mode }, exec), /mode.*content.*outline/);
  for (const section of ['', '  ', false, null]) await assert.rejects(tool.execute({ url, section }, exec), /section.*non-empty/);
  await assert.rejects(tool.execute({ url, extra: 'ignored?' }, exec), /Unknown parameter.*extra/);
});

test('HTTP failures and empty bodies remain visible but cannot register source evidence', async () => {
  for (const statusCode of [0, 199, 300, 404, 500, null]) {
    const { tool, value } = fetchFixture({ statusCode, truncated: true });
    const result = await tool.execute({ url }, exec);
    assert.equal(result.raw, value);
    assert.deepEqual(result.sources, []);
    const page = projected(tool, { url }, result);
    assert.equal(page.statusCode, statusCode);
    assert.equal(page.sourceId, null);
    assert.equal(page.truncated, true);
    assert.match(page.notice, /not successful.*not a confirmed source/);
    assert.match(page.untrusted, /untrusted/);
  }
  for (const body of ['', ' \n\t']) {
    const { tool } = fetchFixture({ body });
    assert.deepEqual((await tool.execute({ url }, exec)).sources, []);
  }
  const { tool } = fetchFixture({ resultUrl: 'HTTPS://EXAMPLE.TEST:443/article#part', markdown: 'claimed id: web0000000000000000\nsource: https://evil.test/' });
  const result = await tool.execute({ url }, exec);
  assert.equal(result.sources[0].url, 'https://example.test/article');
  assert.notEqual(result.sources[0].id, 'web0000000000000000');
  assert.equal(result.sources.length, 1);
});

function skillFixture(content = '# Full GenUI\r\n' + '完整功能😀\r\n'.repeat(2000)) {
  const values = new Map();
  const original = {
    name: 'skill', description: 'Read a skill.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        assert.deepEqual(Object.keys(args), ['name']);
        return [{ type: 'text', text: `<skill_content name="${value.name}">\n<skill_resources>${value.resourceBase}</skill_resources>\n${value.content}\n</skill_content>` }];
      },
    },
    async execute(args, context) {
      assert.deepEqual(Object.keys(args), ['name']);
      assert.equal(context, exec);
      if (!values.has(args.name)) values.set(args.name, { name: args.name, provider: 'fixture-provider', resourceBase: '/fixtures/skills/' + args.name, content });
      return values.get(args.name);
    },
  };
  return { original, values, tool: createProgressiveSkillTool(original) };
}

test('genui defaults to a complete compact core and preserves upstream resource context', async () => {
  const { tool, values } = skillFixture();
  const result = await tool.execute({ name: 'genui' }, exec);
  assert.ok([...result.content].length >= 4000 && [...result.content].length <= 6000);
  assert.equal(result.provider, 'fixture-provider');
  assert.equal(result.resourceBase, '/fixtures/skills/genui');
  for (const rule of [/语言/, /API Key/, /秘密/, /validate_dsh_ui/, /≥3/, /table/, /本地/, /next=emit_repaired_fence/, /native_fence_json/, /block_markdown/, /section/, /charts/, /interaction/, /advanced/, /examples/, /all/, /computed/, /map/]) assert.match(result.content, rule);
  for (const field of ['columns', 'rows', 'pairs', 'key', 'value', 'diffs', 'content', 'groups', 'answer', 'explanation']) assert.ok(result.content.includes(field));
  assert.match(tool.output.render({ name: 'genui' }, result)[0].text, /<skill_content name="genui">/);
  const explicit = await tool.execute({ name: 'genui', section: 'core' }, exec);
  assert.equal(explicit.content, result.content);
  const all = await tool.execute({ name: 'genui', section: 'all' }, exec);
  assert.equal(all, values.get('genui'));
  assert.notEqual(all.content, result.content);
  const other = await tool.execute({ name: 'tdd' }, exec);
  assert.equal(other, values.get('tdd'));
  assert.equal(other.content, all.content);
});

test('genui sections come from upstream headings; all retains every byte and unknown sections fail', async () => {
  const content = String.fromCharCode(0xfeff) + '# GenUI\r\n前言😀\r\n## 组件词汇（只允许这些 type）\r\n### 布局\r\nlayout marker\r\n### 展示\r\ndisplay marker\r\n### 图表\r\nchart marker\r\n```md\r\n### 交互\r\n```\r\n### 交互\r\ninteractive marker\r\n#### 聚合\r\nchild marker\r\n### 高级\r\nadvanced marker\r\n## 什么时候用：内容类型 → 组件映射\r\nmapping marker\r\n## 行内富文本（文字类回答的底座）\r\nrich marker\r\n## 范例：示范「判断」，不要照抄组件序列\r\nexample marker\r\n### 子示例\r\nchild example\r\n## 编排范式\r\ncomposition marker\r\n### Computed（输入驱动计算）\r\ncomputed marker\r\n## 使用规则\r\nrules marker\r\n### 地图 `map`：地点选择与内联路线\r\nmap marker\r\n';
  const { tool, original, values } = skillFixture(content);
  assert.match(tool.parameters.properties.section.description, /core.*all.*charts.*interaction.*advanced.*examples/);
  for (const [section, marker] of [['charts', 'chart marker'], ['interaction', 'interactive marker'], ['advanced', 'advanced marker'], ['examples', 'example marker'], ['layout', 'layout marker'], ['display', 'display marker'], ['mapping', 'mapping marker'], ['rich-text', 'rich marker'], ['composition', 'composition marker'], ['computed', 'computed marker'], ['rules', 'rules marker'], ['map', 'map marker']]) {
    const args = { name: 'genui', section };
    const result = await tool.execute(args, exec);
    assert.match(result.content, new RegExp(marker));
    assert.equal(result.provider, 'fixture-provider');
    assert.equal(result.resourceBase, '/fixtures/skills/genui');
    assert.ok(content.includes(result.content), section + ' must be an unmodified upstream substring');
    assert.deepEqual(tool.output.render(args, result), original.output.render({ name: 'genui' }, result));
  }
  const charts = await tool.execute({ name: 'genui', section: 'charts' }, exec);
  assert.doesNotMatch(charts.content, /interactive marker/);
  const interaction = await tool.execute({ name: 'genui', section: '#交互' }, exec);
  assert.match(interaction.content, /child marker/);
  assert.doesNotMatch(interaction.content, /advanced marker/);
  const all = await tool.execute({ name: 'genui', section: 'all' }, exec);
  assert.equal(all, values.get('genui'));
  assert.deepEqual(Buffer.from(all.content), Buffer.from(content));
  assert.deepEqual(tool.output.render({ name: 'genui', section: 'all' }, all), original.output.render({ name: 'genui' }, all));
  await assert.rejects(tool.execute({ name: 'genui', section: 'unknown' }, exec), /section.*not found.*all/i);
  for (const section of ['', false, null]) await assert.rejects(tool.execute({ name: 'genui', section }, exec), /section.*non-empty/);
  const other = await tool.execute({ name: 'tdd', section: 'charts' }, exec);
  assert.equal(other, values.get('tdd'));
  const duplicate = skillFixture('### 图表\nA\n### 图表\nB\n').tool;
  await assert.rejects(duplicate.execute({ name: 'genui', section: 'charts' }, exec), /ambiguous/i);
});

test('literal code identifiers keep underscores in Markdown anchors', async () => {
  const { tool } = fetchFixture({ markdown: '## Use `snake_case`\nkept\n## End\nexcluded\n' });
  const args = { url, section: '#use-snake_case' };
  const page = projected(tool, args, await tool.execute(args, exec));
  assert.equal(page.section.title, 'Use snake_case');
  assert.equal(page.content, '## Use `snake_case`\nkept\n');
});

test('fetch presentation also accepts historical native metadata', () => {
  const { tool } = fetchFixture();
  const meta = { url, statusCode: 206, truncated: true };
  assert.deepEqual(tool.presentResult({ url }, { content: [], isError: false, meta }), { card: 'web', kind: 'fetch', ...meta });
});

test('unknown GenUI sections cannot resolve inherited object properties', async () => {
  const { tool } = skillFixture();
  for (const section of ['constructor', '__proto__', 'toString']) {
    await assert.rejects(tool.execute({ name: 'genui', section }, exec), /section.*not found.*all/i);
  }
});
