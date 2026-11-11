# 持续目标等待人工动作

本包是独立的 Host bundle：只有人工动作尚未完成时，Agent 可调用 `wait_goal` 保留目标并停止后续自动轮次。顶层直接人工回复，或本次已登记的有界 JSON 回执，可恢复原目标一次。

## 使用与授权

Agent 先向用户说清剩余的一个人工动作，再读取当前目标，调用 `wait_goal`，传入 `goal_id`、`revision`、具体 `reason` 和 `action`。工具结束当前 Turn；等待期间不会定时发消息或启动 Goal round。`get_goal_wait` 返回当前官方目标、最近等待记录和回执观察状态。

`exec.concludeTurn()` 会立即结束本轮，模型不会在工具之后再补 final 提示，因此可读的人工动作和等待原因必须在调用前告诉用户。

进入等待只允许精确 live Agent 的活动 driver 调用；该 Agent 必须属于 `ctx.agents.roots()`，当前 Turn 必须含直接人工消息，或原目标精确 revision 的正编号 Goal round。子代理、工具结果、定时任务和普通系统消息不能登记或恢复人工等待。工具名和参数由当前宿主 `defineTool()` 编译器生成并校验。

这是显式能力：模型需要选择 `wait_goal`。本包不会根据回复中的“等你”“请确认”等文字猜测授权，也不替换官方 `get_goal` / `update_goal`。

## 激活契约

版本 1.0.1 使用 `index-v2.js` 公开入口转发到 `index.js?generation=2`，避免首次失败的旧 ESM link job 被再次复用。Config 采用已有 Zod 的 `~standard` schema：这是当前 Cordis `resolveConfig()` 支持的公开契约，三个默认值保持不变。曾发生的 Schemastery default import 激活失败已有真实 Host 诊断；公开文件中存在 default，具体 namespace/alias 原因未确定，本版本移除了不必要的 Schemastery 依赖，未升级 profile 核心包。

`check-cold-entry.mjs` 不注册 Node resolution hooks，使用实际 profile 的 Zod 公开 import 入口与宿主提供的官方 SDK 公开入口，在独立证据目录中加载同一 fresh source 闭包并运行真实 Cordis Config 验证。显式路径映射与版本写入报告；它不伪装 Host 的 SDK alias，安装后的真实激活仍是最后一道门禁。

## 保留目标与恢复

等待使用官方 `goals.disarm(agent)`，原 `phase`、revision、objective 和轮次计数保持不变。等待状态使用独立 `waiting / released / invalidated` 字段，不增加官方 GoalPhase。

恢复必须同时匹配原 Session、精确 Agent 实例、`goalRef` 和 `waitId`。直接人工输入来自真实 pending inbox 的 `message.source.kind === 'user'`，且 Agent 仍为顶层 root。恢复先消费等待令牌并检查持久化 barrier，再调用官方 `goals.resume(agent, ref)`；官方 resume 推进 revision 并重新 armed。一个等待令牌只消费一次，重复消息和回执不会再次推进 revision。

首次登记及 flush 后也会处理真实 inbox 中尚未 claimed 的人工回复，覆盖“模型已提示动作、工具尚未执行时人工已完成”的顺序；当前原始任务消息已 claimed，不计入新回复。该扫描仅发生于本次新登记，不用于重载重新授权。

任意目标 revision 改变都会使尚未消费的等待失效，后来的人工回复或旧回执不能重臂新 revision。恢复过程中卸载、Agent 更换或 revision 漂移也会阻止重臂。checkpoint 失败时保留停止状态，`resolution` 为 `resume-failed`；用户可在新的直接人工 Turn 中通过官方目标工具明确恢复。

## 持久状态

使用当前 `sessionProjections.register({ key, stateSchema, init, apply, stateVersion })` 的 host-only 投影。完整记录通过标准 `Agent.inject()` 插入 `agent/inbox/spliced`，随后用公开 `inbox.remove()` 取出，留下可重放日志而不留下待运行消息。这是正常的 inbox 插入/撤销审计，日志中可见这一对操作；不会追加未知 Session event，也不调用保留给官方 experimental 包的 `appendPluginRecord()`。

会话重开时通过日志或 projection checkpoint 还原记录。记录绑定原 Session id，fork 不继承等待授权。日志持久性依赖宿主已有 session writer；缺少持久化后端时，与官方 Goal 一样只能保留进程内日志。本包不创建另一个存储根。

插件卸载会清理监听器和所有 timer，并等待已开始的有限恢复任务完成。插件或 Agent 重载、宿主重启只还原可读状态，不重建文件观察器，也不自行 armed。若卸载发生在等待令牌已经消费但 resume 尚未提交之间，状态可能显示 `released` 而目标仍 disarmed；新的人工 Turn 可用官方 `update_goal` 明确恢复。这一分支选择停止，避免重启自行授权。

## 可选文件回执

源码 `Config` 默认仍是 `receiptRoots: []`，供其他组合选择仅人工回复恢复。本机交付的 `cordis.patch.yml` 已显式登记 `D:/agents/run-evidence/dsh-goal-wait-receipts` 这一专用目录；主 Agent 创建目录并负责安装、生效与生产者接线，本包不会在检查中写这个真实目录。插件 Config 最多允许八个专用 D 盘回执目录。路径必须为绝对 D 盘 `*.goal-wait.json`，位于登记目录内；拒绝 drive-relative、UNC、ADS、越界路径、常见凭据目录、symlink/junction 和实际路径变换。使用专用回执目录，不要登记账号或配置目录。

`receipt_timeout_seconds` 仅与 `receipt_path` 一起提供。默认取 900 秒与 `maxReceiptSeconds` 中的较小值；允许 1 至 Config 上限，硬上限 3600 秒。`receiptPollMs` 默认 1000，允许 250 至 60000 毫秒。每个等待只保留一个串行观察器，至多检查 3600 次；到时只记录一次 expired，仍保留等待，不发提醒。

文件只接受最多 4096 字节 UTF-8 JSON，单次读取上限 4097 字节用于识别读取期间增长的文件；只接受下面五个固定字段，额外字段也不接受。waitId、goalId、revision 均取自 `wait_goal` 返回值；文件应由已获授权的人工步骤或独立回执生产者在动作完成后写入。状态匹配代表原目标的恢复触发，不扩展原任务授权。

```json
{
  "version": 1,
  "waitId": "本次返回的 UUID",
  "goalId": "原目标 id",
  "revision": 1,
  "status": "ready"
}
```

### 需要事先冻结标识的生产者

安装器等生产者在启动时就冻结回执配置，需按以下顺序接线：

1. 读取当前 Goal 的 id 和 revision，预生成一个 UUID nonce（例如 PowerShell 的 `[guid]::NewGuid().ToString()`），选择专用目录中的唯一 `*.goal-wait.json` 路径。
2. 将 `{ path, waitId: nonce, goalId, revision }` 写入生产者的受支持回执配置，并先启动生产者。生产者应等待人工操作；只有成功完成其校验后才原子写入 `status: "ready"`，失败不发回执。
3. 向用户明确说明需要完成的人工动作，然后调用 `wait_goal`，同时传原 `goal_id / revision`、同一个 `wait_id: nonce`、同一个 `receipt_path`，以及有界超时。调用结束当前 Turn，之后无需再调用启动工具或发送 final。
4. 成功回执会触发原目标的一次官方 resume；失败、超时或无匹配文件保留等待。用户直接回复始终优先。

`wait_id` 仅能与 `receipt_path` 同用，必须为完整 RFC UUID（版本 1 至 8、RFC variant，拒绝空值、nil、缺段或附加字符）；省略时仍由工具生成随机 UUID。已有等待的相同 nonce 重试只返回原记录，不更换路径、期限或 goalRef；其他 nonce 不能替换它。已消费或失效 nonce 不能再次登记，大小写变体也视为同一个 nonce。消耗历史由持久投影重放，旧 revision 和 fork 历史中的 nonce 同样不可重放。

本包不执行文件内代码或命令、不读取凭据、不记录文件正文。无效、未匹配、过大或暂时不可读的回执继续等待，直到有界观察过期；人工回复优先。`observation` 返回 `none / observing / expired / suspended`。只有进入等待的本次插件生命周期持有观察授权，重载后 `suspended`，即使磁盘已有匹配回执也不会唤醒。

## 安装与卸载

由主 Agent 使用 `plugin_manager` 的 `install_bundle`，target 指向本目录 `D:/agents/projects/dsh-plugins/dsh-progress-guard/goal-wait`。本机 patch 仅插入 `goal-wait` 这一行并配置上述专用 `receiptRoots`，复用已启用的 `agents / goals / sessions / sessionProjections / tools`，无需安装核心依赖、修改 root index 或 Agent preset。缺少服务时 Cordis 按 inject 契约保持 inactive，应补齐宿主原有服务。

按安装返回的 `application / nextStep` 判断生效，再检查 Config 激活、工具 schema 与中英文 metadata。本机 patch 只允许登记的专用目录；源码默认空 allowlist 与本机显式启用配置是两个不同层次。需要变更时通过受支持的插件配置方式设置 `receiptRoots`。禁用/移除本 bundle 不清除原目标或会话日志，也不恢复已 disarm 的目标。后续明确恢复仍使用官方目标服务。维护时保留源码目录供本地链接引用。

本执行体没有安装插件、改变现有 profile、重启真实宿主或写入官方 ASAR。主 Agent 已验证 1.0.1 安装返回 `application: applied`、Host fiber active，并通过实际 `get_goal_wait` 读取当前目标，返回 `wait: null / observation: none`。

当前只读 Config Inspector 对 Zod StandardSchema 的投影显示 `status: unsupported`；这不影响 Cordis 运行时配置校验与已激活的插件。本机 patch 中的专用 `receiptRoots` 仍已启用。此限制仅涉及 schema 展示，不扩展官方 Inspector 或添加兼容层。

## 统一检查

在项目根运行：

```powershell
& 'D:/Codex/tools/bin/node.exe' goal-wait/scripts/check.mjs
```

需要保留证据时传 `--report` 的绝对 D 盘 JSON 文件；目录需已存在。可用 `--runtime` 指定现有 Electron exe，`--dsh-root` 指定对应安装的 DSH 根。检查仅以 Electron Node 模式加载官方依赖，不启动 GUI、替代服务或安装包。

检查覆盖 distribution closure、patch/locale/icon、所有 JS 语法、当前工具 schema compiler、官方 AgentLoop + native tool pipeline、预先启动并冻结 nonce 的生产者原子成功回执、官方 Goal/Session/round driver、官方 JSONL 写入重开，以及人工/子代理权限、nonce 重放拒绝、单次恢复、revision 漂移、重载卸载、checkpoint 竞态、回执超时去重和输入边界。模型边界使用本地确定性 adapter，未向外部模型发送请求。测试写入自身 `D:/Codex/evidence/dsh-goal-wait-20261110/`，不使用现有 profile 数据。

### 显式跨包安装器联调

当前 Windows Explorer 桌面可用时可独立运行：

```powershell
& 'D:/Codex/tools/bin/node.exe' goal-wait/scripts/check-installer-integration.mjs --report 'D:/Codex/evidence/dsh-goal-wait-20261110/cross-integration.json'
```

它实际启动现有 `Start-Installation.ps1 -GoalWaitReceipt`，在自己的 evidence 下创建 ASAR 字节 fixture、SHA 清单和复制 Node exe。先启动等待退出的安装器，再由官方 AgentLoop 执行等待工具；Agent idle/disarmed 后才释放原 fixture。实际 Apply、确认重开和 installer 原子 ready 触发一次官方 Goal round。它不用于真实 ASAR、不重启现役应用，因依赖 Explorer 不放进默认检查。

已通过的完整跨包与进程证据位于 `D:/Codex/evidence/dsh-goal-wait-20261110/cross-installer-a21abcf4-253f-40ab-ae0f-aba90156d976/`；原 fixture、Explorer worker 与重开 fixture 的实际 exit code 均为 0，launcher 和 observer 同样退出。`cross-cleanup.json` 另核对了此前失败调试 fixture 也无存活进程。1.0.1 的 Config/fresh-entry 与 early-human 修复之后仅重跑相关回归并做真实激活，未重复该跨包测试。

兼容基线为官方 `@deepseek-ai/*` 0.2.2-rc.1。此版本公开 manifest 中部分 `.d.ts` 导出实际缺失，因此开发依据当前 Inspect 契约及已安装 JS，并用真实官方 runtime 验证。更换宿主版本后先重新运行 check。
