# DSH Compaction 256K

本机 DeepSeek Harness desktop profile 的本地插件项目：默认 256K、可配置阈值的官方压缩扩展，预设与源码 Inspect、带过滤的插件清单工具，以及输入框下方的压缩剩余百分比。

## 怎么跑

- 通过 `plugin_manager` 从 `D:/agents/projects/dsh-plugins/dsh-compaction-256k` 安装；不要直接编辑 profile 配置。
- 完整门禁使用 DSH bundled Node 24+ 运行 `pnpm run check`；单项回归可用 `node --test tests/*.test.js`。
- 本地安装/重新启用由本项目 `plugin_manager` 自动先检查；独立检查、GUI/linked 源码操作前置检查和有界宿主源码查询见 `README.md` 的「使用」「查询当前宿主源码」。
- `smoke/` 是一次性新会话验收 bundle；安装后读固定 smoke result，再移除测试 bundle。

## 技术栈

Node.js ESM、Cordis 插件、YAML composition、DSH compaction API、Node 内置测试器。

## 目录与约定

- `index.js`：默认 262,144 tokens、可用 `thresholdTokens` 配置的官方阈值扩展。
- `preset-inspect.js`：Host `Preset.listEntries` Provider。
- `source-inspect.js`：Host `Source.searchFile` Provider，受限检索 DSH 源码根与 `app.asar` 文件。
- `plugin-manager-tools.js`：`plugin_manager` 的 `name` 过滤与 bundle 摘要。
- `compact-inspect.js`：`cordis` 预设的只读 `cordis_inspect_compact`，裁剪 Service/Slots 的大段 schema 与类型展开；完整契约仍用原查询工具。
- `package.json`：源码直接 import 的 `@deepseek-ai/*` 宿主包写进 `peerDependencies`，DSH 运行时据此改用宿主自带的那一份；同版本的 `devDependencies`、`node_modules/` 和 pnpm lockfile 只供本地测试。写进 `dependencies` 会让插件加载私有副本，引擎不再继承宿主的 `BasicCompactionEngine`（证据：`D:/agents/run-evidence/dsh-compaction-256k/20261109-peer-dependencies/`）。
- `context-meter/`：独立 Client/Host bundle，以 `compactionSettings` 投影和 `contextPressure` 在输入框 dock 显示压缩剩余百分比；需单独安装该目录。
- `daily-update-guards/`：独立 Host bundle，包装每日更新 Schedule 与高风险 PowerShell 工具；需单独安装该目录，现役 Agent 与新 Agent 都要验收。
- `agent-reliability/`：来源校验、Exa 搜索及网页/GenUI 读取扩展；独立安装，先跑子包检查。宿主验收和回滚见 `agent-reliability/README.md`。
- `tests/`：行为回归。
- `smoke/`：真实新会话的引擎、投影和工具验收；`ui-smoke.mjs` 只读检查已鉴权会话的实际 DOM，`opener/` 是 Desktop 的一次性官方鉴权 handoff，不输出令牌。

## 当前状态

四个 Agent 预设均使用本地可配置阈值引擎，当前为 262,144；余量 UI 单独安装。维护与验收细节以 `D:/Codex/.codex/docs/agent-guidance/host-runbook/dsh-compaction.md` 为准；上游预设变化后必须重放完整覆盖并重新跑测试和 smoke。
