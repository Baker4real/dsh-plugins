# 子代理插件维护参考

本文保留项目概览、独立 Web 安装和目录索引。日常执行、授权边界、Windows 工具路径和当前 GUI 生效判定只在 [AGENTS.md](../AGENTS.md) 维护；历史测试版本与安装示例不代表当前运行态。其他维护内容按任务分支分别加载：

- TypeScript、linker、生成物或长行合并：[代码约束与长行合并](maintenance/code-style.md)。
- 检查层级、真实浏览器或原生标题栏验收：[验证与测试](maintenance/validation.md)。
- 提交约定、dsh-graph 或获准发布：[发布与提交工作流](maintenance/release.md)。
- 投影、Prompt、retention、删除、认证、导航、header shadow 或移动浮层：[兼容性与已知边界](maintenance/compatibility.md)。

## Project overview

`dsh-subagent-workspace-ui` is a DeepSeek Harness Web client plugin. It adds a Chinese-labeled subagent manager to the conversation header, with search, workspace/session scope, sorting, grouping, local classification tabs, archive/restore controls, batch selection, and active-child live status when the runtime exposes it.

The package is ESM (`"type": "module"`) and publishes the `lib/` directory. Its package entry is `lib/index.js`; its client export is `lib/client.js`. The package declares `@deepseek-ai/cordis` `^4.0.1` as a peer dependency and uses DSH client injection declarations in `package.json`.

Since v1.4.0 the client bundle is generated from TypeScript; the source and generated-file boundary is defined in [AGENTS.md](../AGENTS.md).

## Common commands

Run commands from the repository root.

### Install / use in DSH Web

仅在任务选定独立 Web profile 时，从仓库根使用以下安装入口；当前 Desktop 实例按 [AGENTS.md](../AGENTS.md) 的预检与插件管理器流程处理。

```bash
dsh plugin --profile web add file:.
```

以预检确认安装目录是链接还是副本。副本需重新 add 才能取得新构建；链接本身不能证明内存模块已刷新。旧版独立 `dsh web` 的 Host 入口变更需要重启进程；仅在授权覆盖时重启选定宿主，刷新其实际 URL 并验收。历史 `3080` 是测试地址，不是当前 GUI 的固定端口。

新克隆先安装开发依赖（`pnpm install`；`sucrase`、`typescript`）。[构建脚本](../scripts/build.mjs) 需要 Node >= 18；真实浏览器测试的更高环境要求见 [Smoke run](maintenance/validation.md#smoke-run)。

## Directory guide

- `lib/index.js` — host-side plugin entry; exports `apply()`. Hand-written, edit directly.
- `lib/client.js` — **generated** browser bundle (manager UI, styles, filtering, archive state, live activity rendering, DSH session/slot integration). Do not edit; run `pnpm run build`.
- `src/client/` — TypeScript sources of the client bundle, concatenated in original bundle order: `types.ts` (types-only), `ambient.d.ts` (React/jsx/`sessionsRt` declarations + the `SessionReferenceSourceMap` declaration merge), `styles.ts` (css), `bootstrap.ts`, `format.ts`, `runtime.ts`, `retain.ts`, `live-output.ts`, `detail.ts`, `markdown.ts` (prompt markdown → text-node DOM), `live-events.ts`, `active-float.ts`, `manager.ts`, `i18n.ts`, `prompt-view.ts` (subagent-session prompt preview), `apply.ts`.
- `scripts/build.mjs` — builds `lib/client.js` from `src/client/` (sucrase + linker + wrapper).
- `scripts/verify-build.mjs` + `scripts/css-diff.mjs` — full token/line migration proof and delta viewer; optional selector-level CSS declarations and bounded diagnostics never change the full-bundle pass/fail decision.
- `scripts/verify-fresh.mjs` — bundle freshness gate used by `pnpm run check` (fails on a stale committed bundle).
- `docs/images/` — README screenshots (`screenshot-1.png` and `screenshot-2.png`); the README banner is `docs/banner.png`.
- `icon.svg` — the plugin-manager icon (36×36, same visual language as the official provider plugins: stacked rounded cards over a teal→blue gradient). Referenced by the manifest `icon` field, listed in `files` and exported as `./icon.svg`. The host presents `icon` as a **Base64 data URL** read from the package root, and renders it as an image — never inline markup, so no `<script>`/`<foreignObject>` belongs in it.
- `locale/` — `zh.json` and `en.json` carrying `meta.title` / `meta.description` for the plugin manager's installed-plugin row and detail view. The host reads `meta.title` / `meta.description` per locale (`LocalizedText = string | { en, [locale]: string }`) and resolves this plugin's row through these files, which is why the row reads 「子代理管理工作台」 in a zh host and "Subagent Workspace" in an en one. Both files must stay in `files` and be exported as `./locale/*.json`, or they are omitted from the tarball and the row silently falls back to the manifest `description`.
- `cordis.patch.yml` — bundle patch that inserts this plugin (and nothing else; the two slot shadows live in `src/client/apply.ts`, not in this file).

改 bundle patch 或 slot 注册时读 [Header shadows and uninstall](maintenance/compatibility.md#header-shadows-and-uninstall)。

- `test.sh` — local DSH Web smoke setup described in [Smoke run](maintenance/validation.md#smoke-run).
- `test/browser-smoke.mjs` + `test/smoke-runtime.mjs` + `test/owned-processes.mjs` + `test/fixtures/browser/` — one-command managed DSH/Chromium acceptance with pnpm preflight and verified owned-tree cleanup; the one-time Web URL stays in launcher memory, and retained `testHome` data requires managed cleanup.
- `test/native-titlebar.mjs` + `test/fixtures/native-titlebar/` — real Electron `WM_NCHITTEST` regression with upper/center/lower points, negative controls, a bounded launcher and owned-process cleanup.
- `test/smoke-runtime.test.mjs`, `test/owned-processes.test.mjs`, `test/verify-build.test.mjs` — unit gates for runtime planning, cleanup ownership/failure races, selector diagnostics and output bounds.
- `package.json` — package metadata, exports, DSH client injection declarations, peer dependency, and scripts.
- `README.md` / `README.zh.md` — feature, installation, runtime-boundary, and validation documentation; they carry no release-note bodies, only a link to the changelogs.
- `CHANGELOG.md` / `CHANGELOG.zh.md` — release history, newest first (English brief back to v1.3.2; Chinese complete back to v1.0.1). Not listed in `files`, so it ships to GitHub only, and the READMEs link to it with absolute GitHub URLs.
