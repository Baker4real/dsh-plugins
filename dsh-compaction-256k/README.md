---
type: readme
title: DSH Compaction 256K
tags: [deepseek-harness, compaction, cordis, plugins]
intent: 维护本机可配置绝对阈值的官方自动压缩扩展、预设与源码 Inspect、插件清单工具和压缩余量 UI，并提供可重复的验收路径。
---
# DSH Compaction 256K

这是 DeepSeek Harness desktop profile 的本地插件项目，包含四个 Agent 预设共用的可配置阈值压缩引擎、`Preset.listEntries` 与 `Source.searchFile` 只读 Provider、紧凑版 `cordis_inspect_compact`，以及支持 `name` 过滤和 `summary` 的 `plugin_manager` 实现。包名保留 `256k` 以维持现有安装身份，默认阈值仍为 262,144 tokens。

`Source.searchFile` 通过 Host 文件 API 检索当前 DSH 源码根内的单个文件，因此可读取 `app.asar` 内路径；路径逃逸、超过 2 MiB 的文件和超过 100 条返回行均被拒绝或限界。

## 阈值语义

`thresholdTokens` 只增加一个绝对 token 上限，实际普通压力触发点取它与官方触发点的较小值：

```text
min(thresholdTokens, floor(min(W × thresholdRatio, W − O − headroomTokens)))
```

其中 `W` 是模型上下文窗口，`O` 是输出预留。输出预留、headroom、`retainRatio` / `retainTokens`、逐模型策略、工具结果裁剪、摘要、重试、真实溢出恢复和 `/compact` 都继续由官方 `BasicCompactionEngine` 处理。小窗口模型由官方预算提前触发，不再因为放不下固定 256K 而报错。

四个预设的引擎行都可以覆盖默认值，例如改为 128K：

```yaml
- id: compaction-basic
  name: "@local/dsh-compaction-256k"
  config:
    thresholdTokens: 131072
```

当前 `cordis.patch.yml` 在四个预设中均显式配置 `thresholdTokens: 262144`。

## 压缩余量 UI

`context-meter/` 是独立 bundle：通过 `compactionSettings` 会话投影读取当前预设实际声明的压缩配置，在输入框下方显示距离有效自动压缩阈值的剩余百分比。百分比使用 `contextPressure` 的当前投影用量；有效阈值取绝对阈值与官方模型预算阈值的较小值，达到或超过阈值时显示 0%。官方上下文卡片没有内部追加点，因此该入口位于同一 dock，不修改官方组件。

## 每日更新工具守卫

`daily-update-guards/` 是独立 Host bundle：以同名 scoped registration 包装现有 `schedule_view`、`schedule_edit` 和 `pwsh`，提供每日更新 prompt 的 compact/full 投影、唯一 canonical 文件读取边界、高风险 `-CommandText` 拦截，以及直接 `gh` 调用的确定性参数预检。语法范围、检查命令和回归见[子包说明](daily-update-guards/README.md)。

## 来源与读取保障

[agent-reliability](agent-reliability/README.md) 是独立 Host bundle，校验模型响应中的来源引用、复用当前已配置的 Exa 搜索并报告健康状态、提供有界网页章节读取及 GenUI 核心/高级分层读取。通过官方工具安装该目录；检查命令为该目录的 `pnpm run check`。技能读取使用结果投影，保留原生 `skill` 身份与技能目录；完整同版本正文仍在有效上下文时返回短回执，`skill_reload` 强制重读全文。GenUI 核心与分段读取保留，部分内容不作为全文去重证据。

## 使用

通过 `plugin_manager` 安装项目根目录，提供压缩引擎、Inspect 和清单工具；需要余量 UI 时再单独安装 `context-meter/`。已有会话保留启动时的预设修订；验收必须包含新会话。不要直接编辑 profile 的 `package.json` 或 `cordis.patch.yml`。

本项目提供的 `plugin_manager` 在安装项目根、`context-meter/` 或 `daily-update-guards/`，以及重新启用相应 bundle 或插件行之前，自动执行本地检查：确认工具注册时捕获的宿主版本与磁盘版本一致，核对实际宿主包、本地测试包和精确版本 pin，再使用 bundled Node/pnpm 执行现有 `check`。失败时管理调用不执行，成功结果含 `localValidation`。`agent-reliability/` 不在这组预检内，按其[独立检查](agent-reliability/README.md#使用与验证)验收；关闭、卸载和其他包不受预检阻挡。

升级前先运行下面的独立检查，避免先卸载旧包后才发现检查失败。官方 GUI 直接切换、手工操作和 linked 源码监听不经过本项目的 Agent 工具，也先运行此入口；检查只证明该时点的源码和运行时，线上验收仍按下节进行。

```powershell
$desktop = 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness'
$node = "$desktop/resources/runtime/primary-runtime/dependencies/node/bin/node.exe"
& $node 'D:/agents/projects/dsh-plugins/dsh-compaction-256k/scripts/dsh-desktop.mjs' check --resources "$desktop/resources"
```

命令在独立 Electron Node 进程中只读宿主 ASAR，随后运行项目测试，不启动桌面窗口或写 profile。成功输出带宿主版本、bundled Node 版本和测试依赖版本的 JSON；失败退出非零。内部会移除子测试进程的 `ELECTRON_RUN_AS_NODE`，并让 `check` 中的裸 `node` 解析到 bundled Node。

## 查询当前宿主源码

DSH 内使用现有 Host `Source.searchFile`。Codex 未暴露该 Provider 时，通过同一个 Electron Node 方式调用 `scripts/dsh-inspect.mjs`；先查实际 manifest 的 `exports`/`types`/`main`，用 `files` 确认文件真的在包里，再搜索或按行读取。manifest 声明的文件不一定随安装包发布：0.2.2-rc.1 的 `@deepseek-ai/dsh-session-projection` 在 `exports` 里写了 `./lib/types/index.d.ts`，包里的 `lib/types/` 只有 `index.js` 和 `types.js`。

```powershell
& $node 'D:/agents/projects/dsh-plugins/dsh-compaction-256k/scripts/dsh-desktop.mjs' manifest --resources "$desktop/resources" --package '@deepseek-ai/dsh-session-projection'
& $node 'D:/agents/projects/dsh-plugins/dsh-compaction-256k/scripts/dsh-desktop.mjs' files --resources "$desktop/resources" --package '@deepseek-ai/dsh-session-projection' --directory 'lib' --limit 50
& $node 'D:/agents/projects/dsh-plugins/dsh-compaction-256k/scripts/dsh-desktop.mjs' search --resources "$desktop/resources" --package '@deepseek-ai/dsh-session-projection' --file 'lib/index.js' --pattern 'viewSchema' --max-matches 3 --context 1
& $node 'D:/agents/projects/dsh-plugins/dsh-compaction-256k/scripts/dsh-desktop.mjs' read --resources "$desktop/resources" --package '@deepseek-ai/dsh-session-projection' --file 'lib/index.js' --start-line 1 --max-lines 80
```

四个命令都以包目录为边界，单文件最多 2 MiB，每行最多 500 字符，总 JSON 最多 50,000 字符。`search` 返回最多 100 行，`totalMatches` 与 `truncated` 说明省略情况；`files` 按名字排序，每页最多 100 项，用 `nextOffset` 翻页；`read` 每次最多 200 行，用 `nextLine` 续读。每个命令只接受自己的参数，带了别的命令的参数直接报错。路径、包名、参数或读取失败均退出非零；真实零命中返回空数组。只读工具不访问 profile、cookie 或会话历史，也不解包、替换官方产物。

## 紧凑 Inspect

`cordis` 预设注册只读工具 `cordis_inspect_compact`，支持 `Service.listService` 和 `Slots.listSubTree`。目录结果只保留服务 key、方法名和 Slot 导航字段；精确 Service 查询保留方法契约，精确 Slot 查询保留选中节点的 props 与 occupants。大段说明、访问规则和 `referencedTypes` 被省略，需要这些完整内容时继续使用 `cordis_inspect_query`。其他 Provider 会明确拒绝，不做静默降级。

## 验证

- 完整门禁：使用 DSH bundled Node 24+ 运行 `pnpm run check`，覆盖主 bundle、`context-meter/`、`daily-update-guards/`、`smoke/` 的语法和全部测试。
- 运行态：用 Host `Preset.listEntries` 检查四个预设的自定义引擎、阈值配置和诊断。Client `Slots.listSubTree` 只证明 occupant 已注册，不证明数据或 DOM 正确。
- 新会话：安装 `smoke/` 下的一次性 bundle，读取 `D:/agents/run-evidence/dsh-compaction-256k/smoke-result.json`，然后移除 smoke bundle。结果覆盖 Host 引擎、真实 `compactionSettings` 投影，以及紧凑 Inspect 相对原工具的字符缩减；任一失败都不能验收。
- Retro Host 回归：`smoke/retro/` 是无模型请求的一次性 fixture，验证原生技能目录、完整正文→重复短回执→显式重载、原生定义身份及命令预检正负控制，结果写入 `D:/agents/run-evidence/retro-improvements/20261111/host-smoke.json`。通过 `plugin_manager` 安装后读取结果，再移除 fixture。旧 Host 仍缓存旧模块时保留 `pending-runtime-reload`；须在新 Host 重跑，不以包文件或 applied 状态代替运行代次。fixture 是一次性验收工具，省略库存 locale 和图标。
- 真实 UI：先打开一个包含余量组件的会话，在已连接且已鉴权的 Harness 页面运行 `node smoke/ui-smoke.mjs`。Desktop 没有可见 URL 时，可临时安装 `smoke/opener/`，它调用官方 handoff 打开鉴权页面但不打印或返回令牌；页面打开后立即移除 opener。脚本优先只读复用页面，读取 `[data-compaction-remaining]` 的百分比、阈值和可见文本；没有现有页面时才打开默认本机地址，并在结束后关闭自己创建的失败标签。鉴权页、首页、缺失元素或非法数值均失败，结果写入 `D:/agents/run-evidence/dsh-compaction-256k/ui-smoke-result.json`。

完整维护步骤见 `D:/Codex/.codex/docs/agent-guidance/host-runbook/dsh-compaction.md`。
