# 代码约束与长行合并

## Code style and conventions

- Use ECMAScript modules. `lib/index.js` uses `export` and the package is explicitly marked as ESM.
- Match the existing semicolon-free JavaScript style and two-space indentation where code is formatted across lines.
- Keep the host entry (`lib/index.js`) minimal; the UI is loaded through the package `dsh.client` declaration.
- 源码与生成物的修改边界见 [AGENTS.md](../../AGENTS.md)。The bundle is a DSH module-loader module: `scripts/build.mjs` erases types with sucrase (`disableESTransforms`), dissolves the single-line relative imports and `export ` prefixes, and wraps the concatenated bodies in the `window.__ModuleLoader__.load({ id, factory })` shell that obtains React and `react/jsx-runtime` through the supplied `require` function and returns `{ inject, apply }`.
- TypeScript source conventions (kept so the emitted bundle stays byte-consistent with the hand-written original): annotate only in erasable positions (parameter/variable types, generics, optional parameters, function-declaration return types); **never** use arrow-function return-type annotations (`): T =>`), `as` casts, `satisfies`, enums, or namespaces (they leave artifacts or get rewritten); keep `import` statements single-line; comments only on their own lines; no comments or blank lines inside the `css` template literal; keep shared top-level names unique across modules (they link into one factory scope).
- Register UI through the existing DSH `sessions` and `slots` injections. The current slot is `conversation.session.header.actions` and the manager id is `subagent-workspace-manager`.
- CSS 前缀、偏好键与中文文案约束见 [入口持续约束](../../AGENTS.md#持续约束)；任务明确要求调整文案时按该要求执行。

处理 manager 长行冲突时另读 [Merge hotspots](#merge-hotspots)。

## Merge hotspots

- Two features that touch the same manager row conflict at the **character** level: `src/client/manager.ts` renders a whole row in one very long line (status dot, row-action buttons, the expanded/collapsed disclosure row), so git cannot merge those edits line-wise. Resolve by keeping every side's semantics inside that line and then regenerating the bundle (`git checkout --ours lib/client.js && pnpm run build`) — never hand-merge `lib/client.js` and never take one side wholesale.
