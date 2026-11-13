---
type: readme
title: DeepSeek Harness 进度防复读
tags: [dsh, plugin, progress]
intent: 说明独立插件的修复行为、安装边界、验证和回滚方式。
---

# 进度防复读

本插件的已验证基线是 DeepSeek Harness 0.2.2-rc.1；后续宿主升级应重新核对版本、Slot 和依赖。独立 bundle 为 `@local/dsh-progress-guard`，源码位于 D 盘，通过 desktop profile 链接加载。插件自身不写入官方包；加载排查曾修改正式 ASAR，该残留状态与处理见 [实施验证](docs/verification.md)。

## 行为

Host projection 从持久会话事件检测同一 Turn 中相同的中间进度。候选必须带工具调用、纯文字长度为 40–2000 字符，且不含代码围栏或附件。只对全文相同的相邻进度去重；没有文字的工具步骤允许穿插。不同进度、真实用户输入和新 Turn 会结束当前重复序列；最终回答不参与去重。

官方 `llm/stream` 包装只缓冲仍可能等于上一条进度的前缀；文本一旦分叉就立即放行。若完成帧确认是带工具调用的完全重复，文本块在消息组装和持久化前移除，工具调用、reasoning、usage、replayState 和 finish 原样保留。没有 finish 的中断流、不带工具的最终回答和显式复述请求均原样通过。过滤掉的重复文字仍可从紧邻的上一条原文阅读。

对绕过流式入口的历史事件或外部追加，下一步仍通过官方 `agent/pre-step` 接口插入至多一次纠偏提醒。Client 的 `conversation.chat.node` 包装继续把这类残留重复放进默认收起的 `<details>`，作为兼容兜底。两种兜底都不修改冻结请求、不重试响应、不修改工具参数。

用户直接要求复述的常见中文和英文表述会跳过当前 Turn 的流式去重、纠偏和折叠；复杂或间接表达没有语义分类保证。最终答案无条件保留。

## 文件

- [Host 注册及纠偏](index.js)
- [重复判定](policy.js)
- [Client 包装器](client.js)
- [行为测试](tests/progress.test.js)、[流式发送前去重](tests/stream.test.js)及[边界测试](tests/boundaries.test.js)
- [Client 生命周期回归](tests/client-lifecycle.test.js)
- [隔离 GUI 诊断](scripts/dsh-diagnostic.mjs)及[本地回归](tests/diagnostic.test.js)
- [真实 Host 冒烟测试](smoke/verify.js)：仅使用合成适配器，不访问模型网关，不读写用户文件；临时安装后卸载。

## 安装和回滚

通过 Harness 的 `plugin_manager.install_bundle` 安装此目录，不能用 shell 直接改 profile。若需要停用，使用插件管理器禁用 `@local/dsh-progress-guard`；卸载不会改写已有会话。

Client 产物是直接可加载的 module-loader JavaScript，不需要额外构建。已安装包的 Host 源码变化要按插件管理器返回的重启要求处理；Client 的新代文件也必须用实时 Slot 和运行态验证，不能只靠源码或安装成功推断生效。

Client 在插槽声明出现后订阅条目变化，等待官方 `assistant-step` 就绪；每个声明生命周期只注册一次包装器。包装器获胜后不再因自己触发的通知注销或重建，避免 keyed winner 隐藏原条目时形成微任务循环。启动时序与真实页面验收见 [实施验证](docs/verification.md)。

## 验证

在项目目录执行统一入口：

```powershell
& 'D:/Codex/tools/bin/node.exe' ./scripts/check.mjs
# 已配置 Node 的终端也可执行 npm run check
```

[check CLI](scripts/check.mjs) 在普通 Node 中定位桌面 Electron，然后在 `ELECTRON_RUN_AS_NODE=1` 的真实 Electron 内访问 ASAR 和运行校验。默认优先复用当前 Electron，其次使用环境变量 `DSH_DESKTOP_EXE`，最后尝试本机已核实的桌面安装 EXE。资源默认取所选 EXE 相邻的 resources，可用 `DSH_DESKTOP_RESOURCES` 或显式参数覆盖：

```powershell
& 'D:/Codex/tools/bin/node.exe' ./scripts/check.mjs --runtime 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe' --resources 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/resources'
```

`--resources` 接受桌面 resources 目录、app.asar 路径或其 dsh 根目录。显式参数优先于环境变量。普通 Node 不直接读 ASAR；测试在 Electron 内解析当前所选安装包的 Cordis、Session、SessionProjectionRegistry、LLM 和 zod，不安装第二份宿主依赖，也不依赖旧机器日志。[事故重放夹具](tests/fixtures/incident-replay.json) 是短小脱敏的项目资源，保留重复文字、穿插工具步骤和 replayState 结构。

校验覆盖清单声明、分发文件与相对模块依赖闭包、locale、内联 SVG icon、JavaScript 语法、独立的 Client 生命周期边界和真实 Host 行为。Client 生命周期使用 VM 执行 ModuleLoader 注册，不模拟 React/DOM；`coverage.clientLifecycle` 与 `coverage.clientRuntime` 分别报告，前者通过不能代替真实页面验收。缺少生命周期测试时明确返回 `not-covered`，不能从语法通过推断行为覆盖。[CLI 回归测试](tests/check-cli.test.js) 在必要输入的临时副本上验证缺 icon、Client 语法错误、Host 断言失败、正常报告和缺失生命周期覆盖，不改活动源码做反证。

CLI stdout 始终为一份小 JSON，成功退出 0，失败退出 1。报告 schemaVersion 为 1，含 `status: "passed" | "failed"`、`checks: [{ name, status, durationMs?, details?, error? }]`、`durationMs`；成功定位运行时后还含 `runtime: { executable, electron, node, resources, dshVersion }`。检查项含 `runtime`、`manifest-resources`、`syntax`、`client-lifecycle`、`host-tests`；以整份报告的 status 和各项覆盖状态判断，不只检查单个成功项。写报告失败会追加 `report` 失败项。错误最多保留 6000 字符；子进程输出和等待都有上限，整个 Electron worker 上限 150 秒，建议调用者给予 180 秒总超时。

`--report <absolute-json-path>` 将同一份 JSON 写到调用者明确指定的文件，便于 Host 以 stdio ignore 调用后读取。父目录必须已存在；入口不创建 evidence 目录，不推断其他输出目标，拒绝相对路径和文件本身为符号链接的目标。调用者负责选择获授权的 D 盘 evidence 文件。报告文件写入失败时以 stdout 的失败报告为准。

Host 也可导入 `runProjectChecks({ runtime?, resources?, report?, projectRoot? })` 并 await 同一份报告；函数以报告的 status 表达检查失败，调用者必须据此阻止后续动作。CLI 默认项目根为入口所在项目，不受调用工作目录影响。`projectRoot` 只用于明确目标的本地调用。

## 隔离 GUI 诊断

排查 `Loading plugins...` 或 Client 挂载问题时使用下面的受管入口，不修改官方 ASAR，不重启或连接用户的正式桌面：

```powershell
& 'D:/Codex/tools/bin/node.exe' scripts/dsh-diagnostic.mjs --work-root 'D:/Codex/temp/dsh-gui-diagnostics/<new-run-name>'
```

入口读取正式 profile 的插件清单和 patch 文件，复制到新的隔离 `DSH_HOME`，不复制凭据或 `dependencies`。每次使用新的工作目录和独立 Electron user-data，动态分配回环 CDP 端口；启动后核对真实 PID、启动时间、EXE、user-data 和调试端口。只有本次浏览器 CDP 上下文列出的页面才能被检查，外来或残留调试端点不参与结果。

探针等待页面 load 事件，再以短间隔有界读取 DOM、`__ModuleLoader__` 和 renderer ping，不固定睡眠 14 秒。主进程 stdout/stderr 统一经脱敏 sink 落盘，renderer 的异常与日志通过 CDP 收集。`readDiagnosticLog` 也使用相同脱敏函数。即使已脱敏，临时日志和隔离 home 也按敏感临时数据处理，不自动复制进 evidence。

结束时对本次拥有的进程树执行关闭，并等待进程 `close` 和调试端口释放；身份不一致、关闭超时或端口仍被占用都失败闭锁。成功结果为 `status: "ready"`，包含 `loading: false`、模块加载状态、renderer 异常和 `teardown: { closed: true, portReleased: true }`。这不替代正式客户端中的用户界面回读。工具不自动递归删除临时目录。

真实 Host 冒烟结果和安装验证记录在 [实施验证](docs/verification.md)。只读运行态诊断、方法级 Inspect、ASAR 导航及安装/交付自动检查见 [环境工具入口](docs/environment-tools.md)。
