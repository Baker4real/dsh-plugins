---
type: reference
title: Harness 环境诊断与自动校验
intent: 说明现役诊断能力、可调用入口、验收边界及回滚。
tags: [dsh, inspect, source, validation, retro]
---

# 环境诊断与自动校验

本机通过独立本地 bundle `@local/dsh-devtools` 提供诊断和交付检查，源码在 [devtools](../devtools/package.json)。这些 Provider 不改模型网关，也不把用户会话正文或未知异常原文作为诊断结果返回。项目不在 Git 仓库中，因此没有初始化 Git，也没有安装无效的提交 hook；自动执行由现有 Cordis 工具和 Turn 生命周期承载。加载排查遗留的 Host 依赖解析补丁及未确认的回滚见 [实施验证](verification.md)。

## 调用入口

已有插件的局部调整先读 [小改动指引](plugin-small-change.md)。`dsh_inspect` 默认返回精简目录，再以 `contract` 读取一个 Provider 方法的 schema、以 `query` 执行它；目录和查询都有输出预算。下列 Provider 也可通过 `cordis_inspect_query` 调用，均保持只读。`dsh_page` 是独立 Agent 工具：`inspect` 只读，`reload` 等待新文档，`click` 使用该次检查的完整页面身份与元素令牌，并验证预期状态。后两者有副作用，只在当前授权范围内调用。

| 平台 / Provider.方法 | 输入与用途 |
|---|---|
| Host / `Runtime.status` | `packageName` 精确包名。分别返回 Host `enabled`、`fiberPhase`、Config schema 状态、`configSchemas[].packageDir` 和 Client graph revision。可用 `offset`、`limit` 分页。原始 `Config.listConfigs` 目录行没有 `packageDir`；`dsh_inspect` 对不超过 5 行的结果补上它，entry 默认省略 schema，要 schema 时传 `includeSchema: true`。 |
| Client / `Runtime.status` | `packageName`；可选 `slot`、`entryKey`、`sessionId`。不传 `slot` 时 `slot` 为 null，`registrations` 只含这个包自己的占用（registrant 或 id 前缀）。传了 `slot` 才返回该槽获胜者。不传 `slot` 不会改看别的默认槽。 |
| Client / `Desktop.inspectElement` | `selector` 必须唯一且可见。返回真实 rect、上/中/下 CSS 点、DPR、`elementFromPoint` 命中归属、白名单计算样式和标题栏/Popover 状态；不返回 DOM 正文。 |
| Host / `Desktop.hitTest` | `handle`、`x`、`y`、`devicePixelRatio`。仅接受 Host 父进程（Desktop 主进程）拥有的 HWND；将 selector 点换算为物理客户区坐标，使用 `ClientToScreen` 与带 1 秒上限的 `WM_NCHITTEST`；不激活窗口或发送输入。 |
| Host / `Runtime.checks` | 空对象；只读最近一次自动校验的阶段、源文件指纹和报告路径，本查询不触发校验。 |
| Host / `Inspect.providers` | `offset`、`limit`、可选 `platform`。仅返回 Provider 用途和方法名称。 |
| Host / `Inspect.provider` | `platform`、`provider`、`method`、可选 `maxBytes`。返回一个已发现方法的完整输入/输出 schema。 |
| Host / `Deployment.preflight` | `packageName`、`sourceDirectory`，可选 `installedDirectory`、`files`、`maxBytes`。比较文件身份/入口 hash，并读取 HMR 的替换规划；不执行安装或替换。 |
| Client / `Page.inspect` | 必须 `url`、`sessionId`；可选 `pageId`、`documentId`、`graphRevision`、`packageName`、`selector`。对不上时只返回该页 origin 和 pathname（`status: mismatch`），不返回 pageId 或模块代次。匹配时才返回主会话、模块代次和元素状态，不返回 DOM 正文。 |
| Host / `Inspect.services` | `platform`，可选 `offset`、`limit`、`refresh`、`maxBytes`。返回当前 Agent 可见的 Service 和方法名称。 |
| Host / `Inspect.method` | `platform`、`service`、`method`；默认不带类型，`includeTypes: true` 时仅带选定方法可达的声明。 |
| Host / `SourceNav.resolve` | `packageName`、可选 `entry`，如 `.` 或 `./client`。返回 exports 的条件目标和真实存在性，不猜测类型文件位置。 |
| Host / `SourceNav.files` | `packageName`、相对 `directory`、`offset`、`limit`。分页列出实际目录。 |
| Host / `SourceNav.search` | `packageName`、相对 `file`、字面 `needle`；可选 `contextChars`、`maxMatches`、`offset`。按匹配位置截取片段，支持压缩单行代码的深处命中；继续读取使用 `nextOffset`。 |

Inspect 合同缓存按 Agent 隔离，最多保留 30 秒，并随 Client graph 或 Provider 目录代际变化而失效；`refresh: true` 可立即重新读取。未知 Service 在目录预检中返回固定错误，不发起无意义的 Client 精确查询。`maxBytes` 默认 6000，范围 800–16000，以格式化 JSON 的 UTF-8 字节计算，并保留传输包装余量。省略和续页均有明确标记；不足以容纳一个完整方法时返回预算错误，不静默截断签名。

SourceNav 只访问安装包 source root 内的指定 npm 包；拒绝路径穿越和符号链接逃逸，文本文件最多 2 MiB。搜索使用字面匹配，不执行外部正则。结果的 `offset`、`column` 是 UTF-16 字符位置，`line` 从 1 开始。

## 绑定页面与刷新

`dsh_page` 使用用户当前 GUI origin/path 和主会话 id（默认请求 Agent id），通过 `Page.inspect` 确认页面，再接受该次返回的完整身份。对不上时没有完整身份，只有 origin 和 pathname。Desktop 的实际页面可以是 `dsh-app://app/`；这个已识别地址可传给 `dsh_page`，其他未知 scheme 仍被拒绝。工具内部传 `requireMatch: true`，使不匹配页面不抢占另一匹配页面的回复；直接 `Page.inspect` 默认保留 origin/path 诊断。`pageId` 随插件挂载变化；`documentId` 存在 document 的私有 Symbol 上，插件重挂载保留、真正新文档改变；`graphRevision` 是该页内模块 id/rev 清单发生变化时推进的 opaque 代次，不是 Host 广告值或源码 hash。

刷新与页面点击通过现有 `connection.fetch.register` 的认证 `/api/dsh-devtools/page/poll` 与 `/ack` 通道交付。Inspect 查询不会入队操作。Client 在接收命令、ack 后和副作用之前复核身份/卸载状态；刷新只接受新文档回执，点击只接受同页的实际执行回执，再查询预期元素和目标模块。会话漂移、模块变化或验收不符保留 `unverified`。连接重绑定撤销待办，不永久销毁整个桥。

宿主 Fetch carrier 将 Request.url 写为 `http://dsh.internal`，保留已经通过 Host/Origin/admit 与 owner-peer 检查的 Host 头；页面通道据此恢复来源。Desktop 的 `dsh-app://app/` 请求经官方转发器改发 loopback HTTP 并移除 Origin，只在显式 Desktop 模式、精确 app URL、loopback Host 且 Origin 真正缺失时接受。字符串 `null`、空 Origin、旧 app scheme 和公网 Host 都不能取得这项许可。通道不替代宿主认证。

入口文件一致、Host 广告一致和真实行为一致是不同证据。`sourceBuildVerified: false` 明确表示页面工具没有替你跑源码构建。无法读取页面实际 URL 时不能拿调用者提供的 URL 充当页面身份，也不能退回窗口标题或快捷键。

### 绑定元素点击

先 `dsh_page inspect` 指定唯一 selector，取得 `pageId / documentId / graphRevision` 和 `element.token`。再用 `action: "click"`，传回这些身份、同一 selector、`elementToken`、`verifySelector` 与必填 `expectedVisible`；可用 `expectedExpanded` 检查验证元素的 aria-expanded。操作在匹配页面内调用元素 click，不发送原生按键、屏幕坐标或打开新页；因此不会把某个 renderer 的旧坐标交给另一个 HWND。

令牌绑定实际元素对象、会话/文档/模块、位置、状态和命中归属。元素替换、布局或状态改变会拒绝旧令牌；执行前再次检查遮挡和禁用状态。可见性包含视口相交、透明度与可用时的祖先 CSS 可见性；验收正向可见还要求中心未被其它元素遮挡。ACK 只表示接受，不是成功；点击后的实际状态必须另验。

执行许可有期限。ACK 之前取消可确认未点击；ACK 之后的取消、超时或断连可能已有在途点击，返回 `mayHaveExecuted: true`，不能自动重试，应先重新检查页面。卸载、过期许可与旧页面身份不会继续执行。

## 只读替换规划边界

`Deployment.preflight` 在安装前读取真实目录、清单与入口文件，`patchId` 不作热更新依据。对已核验的 `@deepseek-ai/dsh-hmr@0.2.2-rc.1`，使用其 `loadedUrls`、`hasEsmCache` 和明确只读的 `planReplacement`；只规划安装包内已加载模块，不调用 `stopPlanned`、`reconcileProfile`、evict 或安装动作。版本/能力/缓存/规划证据不足时返回 `unknown`。结果不覆盖包迁移、后续激活成败或页面验收；每次实际变更仍读 `application`/`nextStep`。

## Desktop DOM 与原生命中

先用 Client `Desktop.inspectElement` 按 selector 取得 `points` 和 `devicePixelRatio`，再把选定点传给 Host `Desktop.hitTest`。Host 通过现有 DSH 安装内的 Koffi 调用 user32，不新增宿主核心依赖。`hitTargets` 用来确认 DOM 覆盖归属，`hitName` 区分 `HTCLIENT` 与 `HTCAPTION`；两者必须分别核对，不能从 DOM 命中推断 Windows 原生命中，也不能从原生命中推断具体 DOM 元素。

Inspect 查询始终保持只读。Client `Desktop.inspectElement` 是未绑定页面的旧几何诊断，Host `Desktop.hitTest` 只证明所给 HWND 与原生命中；两者不能证明 DOM 和窗口是同一目标。页面控件操作使用上面的 `dsh_page click`，不再把这些坐标拼接成普通点击流程。遗留 [Invoke-DshScreenClick.ps1](../devtools/scripts/Invoke-DshScreenClick.ps1) 只留给明确授权的原生输入诊断；它不能绑定 renderer，也不验收结果，`SCREEN_CLICK_SENT` 不能作为行为成功证据。

真实 Koffi 驱动初始化、坐标转换与有界 WM_NCHITTEST 已接入 `devtools/scripts/check.mjs`；不再只依赖替身驱动。真实 Chromium 夹具是 `devtools/scripts/verify-page-client.cjs`：使用版本匹配的 Electron 分别验证 HTTP 与 `--desktop` 的 dsh-app 转发。夹具复刻当前 carrier 的 `dsh.internal + Host` 形状，证明 DOM/协议行为；它不执行正式连接的 admit，不作为认证或当前用户页面验收。

## 激活状态的判断

Config 的 `status: absent` 仅表示插件没有声明 Config schema。它不表示插件未安装或未运行。Host 行的 `fiberPhase: active`、Client module graph 中存在条目、Client 实际加载版本与 Slot 获胜者是不同事实，需要分别核对。Client 超时或未连接属于未完成的页面验收，不能用 Host 检查通过代替。

`Runtime.checks` 是当前 Host 进程内的最近记录；重启后返回 `status: not-run` 属于尚未触发，不是失败，也不能代表新进程已通过交付校验。历史验收保存在独立证据中，不能用旧记录替代当前检查。GUI 地址随启动变化，使用会话提供的当前 URL，不固定端口或保存授权 URL。`dsh_page` 接受 http(s) 和已识别的本机 Desktop 页面地址。HTTP 后端地址与 Desktop renderer 地址可能不同；2026-11-10 实测 renderer 为 `dsh-app://app/`。直接 `Page.inspect` 的 mismatch 只报告安全 origin/path，不返回不匹配会话 id。目标会话未在该页打开时仍拒绝刷新；诊断响应不代表页面验收通过。

只读 Runtime 输出不包含插件完整配置、用户消息、未知异常文本或凭据。已知错误只映射为固定错误码，Slot 和模块标识来自结构化运行态。

## 项目校验与自动执行

在项目根执行：

```powershell
& 'D:/Codex/tools/bin/node.exe' scripts/check.mjs
& 'D:/Codex/tools/bin/node.exe' devtools/scripts/check.mjs
```

前一个入口检查产品清单、资源、ModuleLoader 语法、Client 生命周期边界和真实 Host 行为，并支持 `--runtime`、`--resources`、`--report`，详见 [README](../README.md)。报告的 `coverage.clientRuntime: not-covered` 表示命令行没有运行真实 DOM，并不撤销独立页面证据；每次所需运行态仍应另验。后一个入口检查开发工具源码、回归和当前安装包支持的 Provider schema。

[隔离桌面诊断脚本](../scripts/dsh-diagnostic.mjs) 是另一个入口，会启动并清理它自己创建的桌面进程，不能当作只读 Inspect 查询自动执行；使用前按当前 GUI 与进程操作授权核对范围。其定向测试可单独执行 `node --test tests/diagnostic.test.js`，统一 Host 测试有意排除了这组测试。

```powershell
& 'D:/Codex/tools/bin/node.exe' scripts/dsh-diagnostic.mjs --work-root 'D:/Codex/temp/dsh-gui-diagnostics/<new-run-name>'
```

工作目录必须是新的绝对路径。默认复制当前 desktop profile 的 bundle 清单及 patch 文件，不复制凭据；可用 `--plugin <installed-package>` 重复指定保留的已安装插件，基础包自动保留。`--runtime`、`--source-profile`、`--timeout-ms` 分别显式选择已安装桌面、源 profile 和最长等待时间。

动态 CDP 端口、独立 user-data、进程身份复核和浏览器/页面归属共同防止读到旧实例。主进程日志只经统一脱敏 sink 写入，覆盖 URL token、Cookie、Authorization、`sk-` 和 JWT；读取日志也走 `readDiagnosticLog`。CDP 异常有数量与长度上限，正文不进入报告。页面 load、DOM 内容、加载文本、ModuleLoader 状态和 renderer 应答共同决定结果，不使用固定长睡眠。

结束时必须等待进程树退出和 CDP 端口释放，身份不符直接失败。`status: "ready"` 仅证明隔离实例离开加载页且 renderer 存活，不代表正式客户端界面已回读。临时目录含隔离运行时生成的本地凭据；工具不自动删除，需另行取得精确目标的清理授权。

开发工具会在 Agent 安装或重新启用进度插件前执行相同校验；成功后仍需页面运行态验收。源码写入与安装动作归属于发起它的顶层 Agent，独立只读审查不承担另一个 Agent 的页面检查。交付时复核源码指纹和实际 Client 版本；源码在检查中变化、Host 测试失败、Client 未连接或未挂载时均不能通过。失败只给当前 Turn 一次纠偏机会，继续失败则终止该次交付，避免无限续步。

CLI 与 Client 验收分开：安装前允许 Client 标记为 deferred；交付前必须确认进度插件实际获胜、没有已记录的模块或 Slot 错误，且加载的 revision 与 Host 广告相同。已通过且源码未变的 CLI 结果可以复用，Client 仍每次复查。检查进程有输出和时间上限；Windows 取消或超时会清理其自有进程树。

## retro 解析修复

现役 retro 的 `scripts/transcripts.py` 已通过受管 skill 更新器激活，保留原有 `--unknown-details` 和上游 provenance。助手正文兼容 `data.message.content` 与旧的 `data.content`。审计按 Turn、Step、调用和消息身份配对，历史 `surfaceOp: replace` 不再被当作新执行；不同 append 异步观察仍保留。`Read` 与 `read` 都参与重复读取统计；`find`、`show` 保留原始记录行号。

原会话有若干历史工具结果被压缩后重写。修复前它们被错算为数小时工具耗时；修复后的同一有界日志审计不再出现这种慢调用。该结论不等于原会话没有失败，既有失败记录仍保留。

## 持续目标等待人工动作

独立 [goal-wait bundle](../goal-wait/README.md) 提供 `wait_goal / get_goal_wait`：记录一个明确人工动作，保留原目标并停止自动轮次；根会话直接人工回复或本次已登记回执只恢复一次。状态写入原会话的公开 inbox 审计与 host-only 投影，重载可读但不自行重臂。文件观察有时间/次数上限、专用 D 盘目录与固定 JSON schema，不根据普通聊天文字猜测等待，不定时提醒。

安装器的可选回执与先启动生产者、再结束 Turn 的调用顺序见该包说明；仅本次冻结的 `waitId + goalRef` 能触发恢复，失败安装不发 ready。这个扩展不替代官方目标的完成、暂停与恢复策略。

## 回滚

通过插件管理器停用或移除 `@local/dsh-devtools` 可撤销诊断 Provider 和自动检查，不改历史消息。进度插件的展示及纠偏独立存在，停用开发工具不会停用它。retro 的更新有独立的受管事务记录与备份；回退同样走 skill 更新器，不手工覆盖 active 根或台账。
