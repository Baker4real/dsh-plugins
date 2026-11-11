---
type: report
title: 进度防复读实施验证
tags: [dsh, progress, verification]
intent: 记录本次修复的可观察验收事实、验证边界和回滚方法。
---

# 实施验证

验证对象是本机 DeepSeek Harness Desktop 0.2.2-rc.1 的 desktop profile。正式修复包为 `@local/dsh-progress-guard`；没有改动模型网关或凭据。插件自身不覆盖官方安装包，但此前加载排查在正式 ASAR 中留下 Host 依赖解析补丁，不能描述为官方包保持原样。补丁恢复影响尚未独立验收；临时备份已获授权清场，不把清场当成恢复。需要恢复时从同版本官方安装产物重新取得基线，再核验文件与客户端状态。

## 行为回归

2026-11-09 首次修复使用当时安装包的真实 Cordis、Session 和 SessionProjectionRegistry。先验证没有实现时 `the progress guard must publish duplicate decisions` 断言变红，再实现后通过；该阶段五个测试全部通过。此处与下文的 DOM 计数是分阶段历史证据，现役检查范围以统一入口报告为准。

覆盖原截图文字、原始脱敏会话回放、不同工具调用、穿插无文字工具步骤、不同进度、短句中断、最终回答、附件、用户要求复述、新 Turn，以及持久提醒重放后不重复注入。

脱敏原始夹具含模型 replayState；回放前后 JSON 完全一致，表明检测没有改写原文、工具参数或提供商元数据。

## 真实 Host

2026-11-09 临时安装测试插件，在当时的 Host 中创建真实 Agent，挂载 cordis 预设，使用唯一命名的合成 LLM adapter。它主动连续返回相同进度，用于证明即使模型继续复读，工具仍完整执行且投影正确标记。没有访问外部模型网关。

结果：五个真实 Agent 模型步骤；工具参数序列为 1、2、3、4，均只执行一次；第二次相同输出后，下一请求已经含纠偏提醒；整个 Turn 只有一条提醒；投影有三条重复记录；原始回复和最后答案均保留。

冒烟会话由临时测试上下文拥有，不作为用户工作区的持久会话继续运行。该临时测试插件已在当次验收后从 profile 卸载；可复用源码仍保留在项目的 smoke 目录。

测试过程中修正了两项夹具错误：工具参数应使用 value-schema property map；会话标题生成请求要与 Agent loop 请求分开计数。最终通过的是修正后的夹具。

## 真实 Client

Client 包装器通过 `conversation.chat.node` 的 `assistant-step` 键挂载，priority 比现有 renderer 小一。它委托原有组件，复用原有注入和 locale，不复制官方 Chat renderer。

初次尝试重复声明官方子插槽，被框架拒绝。最终实现读取原有子插槽的实时获胜组件，保留官方所有权；当前 reasoning 和 image 子组件均是无 store、inject、children 的 Factory 转发器。未来若改成带状态的子组件，抛出的错误会由官方 Slot ErrorBoundary 接管并恢复后备 renderer，而不会删除原始消息。

实时 `ProgressGuard.status` 已确认 `active: true`、实际发生渲染、`errors: []`；官方 reasoning/image 子插槽仍归官方注册者所有。

2026-11-09 首次页面验证直接打开原始问题会话，使用真实会话历史和投影，不使用模拟 DOM。`ProgressGuardSmoke.status` 返回 `state: pass`：原截图中那段文字的四条后续重复均已折叠、默认收起、展开后原文完整，展开前后的实际布局高度会变化；页面仍有 207 个工具节点。整个原始会话投影共有五条重复记录，其中一条属于另一段相同进度。

验收通过后移除临时 UI 检查 bundle，恢复修复会话。页面验证脚本只读取原文匹配结果和节点计数，不向模型发消息，也不执行历史工具。

## retro 环境改进验收

后续环境改进通过独立 `@local/dsh-devtools` bundle 安装到相同 profile。插件安装路径与正式 ASAR 的补丁边界分开，见本文开头。入口和边界见 [环境工具](environment-tools.md)。

2026-11-10 该批次受管激活后的 retro CLI 回归为 67 项通过；这是当次运行计数，后续版本应重新执行现役入口。对原始会话前 1900 行的有界审计确认：历史 replace 重写不再形成虚假的数小时工具耗时，超过 60 秒的慢调用归零；仍保留 24 条既有失败。真实审计结果为 530 条工具结果，Read/read 重复路径为 22 条。没有把失败数改成零来表示修复成功。

环境改进首次交付时，统一检查覆盖 15 个分发文件、10 个 JavaScript 源文件和五个测试文件。后续检查已将 Client 生命周期单列为阶段；数量和覆盖以对应执行报告为准。负对照确认缺 icon、损坏 Client 语法及真实 Host 断言失败都会使公开 CLI 非零退出。新增 Client 注册边界回归覆盖“插槽声明先于官方 keyed occupant”和“包装器获胜后原条目被 winner API 隐藏”，避免启动时漏挂载或形成微任务循环。

2026-11-10 环境改进验收页确认进度包装器只注册一次、实际渲染、priority 为 -1、无模块和 Slot 错误。该次真实 DOM 验收中，问题段落的四条重复默认折叠、原文保留、展开改变高度，页面保留 418 个工具节点。418 与早期的 207 分属不同历史快照，均不是后续页面的预期常量。

当前 Client 仍订阅插槽变化以等待官方条目，注册成功后通过 `dispose !== undefined` 守卫停止重复安装；声明销毁时清理订阅与包装器。`entriesOfSlot` 只返回 keyed 获胜条目，包装器获胜后不能用“找不到原条目”推断原条目已卸载。注册边界测试验证这一时序，不把 VM 测试冒充 DOM 验收。

方法级查询在真实 Host 和 Client 上返回单个合同；未知 Client Service 由缓存目录预检返回，不等超时。ASAR 查询确认官方 chat 包的 JavaScript 导出存在、声明的类型文件实际缺失；压缩源文件中第 123 行、第 92078 列的命中能在指定预算内显示中心片段。字节预算、控制字符输入、缓存隔离和异常文本不回显均有定向回归。

自动安装/重新启用校验已由真实 Host 执行通过，并包括开发工具自身检查；Client 安装前标记 deferred，交付前另验实际加载版本。只读审查不触发别的任务的页面门禁，同一个 Turn 只给予一次失败纠偏机会。

## 加载修复后续环境落地

2026-11-10 统一检查新增独立 `client-lifecycle` 阶段和 `coverage` 字段。生命周期测试覆盖初次等待、包装器获胜后的自身变化、声明重入、无原始 entry、locale 注销和微任务排空；移除测试文件的 CLI 负对照报告 `not-covered`。最终 17 个分发文件、12 个 JavaScript 源文件通过语法检查，Host、CLI 与生命周期分组通过；普通 CLI 的 `clientRuntime` 保持 `not-covered`。

新增 `scripts/dsh-diagnostic.mjs` 使用隔离 home、独立 user-data 和动态 CDP 端口，不修改官方 ASAR。它回读 PID、启动时间、可执行文件和隔离参数，在 CDP 读取前复核进程身份；外来页面拒绝连接。统一 sink 已用合成 token、Cookie、Authorization、API key 和 JWT 输入验证 stdout、文件及文件读取均脱敏。进程结束等待、端口释放和拒绝终止外来进程均有定向回归。

最终隔离运行使用正式 profile 的完整插件集合，观察到页面加载完成、`loading: false`、模块加载器 `live`、微任务待处理数为零、renderer 异常为空；进程关闭且 CDP 端口释放。早期实现的两次身份读取失败留下的隔离进程树已按所有权精确停止。没有删除临时诊断目录，仍按敏感数据处理。收尾时另修复启动身份失败路径的清理结果回填，避免异常报告掩盖残留进程。

开发工具的四项回归和真实运行时 Provider schema 检查通过。以上工具与测试落地不等同于再次检查用户正式客户端的当前 DOM；正式界面是否仍正常需独立回读。当前 Host `Runtime.checks` 的重启语义见 [环境工具](environment-tools.md)，旧交付记录不能替代新进程验收。

## Desktop 联合命中验收

2026-11-10 该次交付中，Host `Runtime.status` 为 `active`，Client 实际 revision 与 Host 广告一致，模块与 Slot 错误为空。Client selector 几何和 `hitTargets`、Host 按钮 `HTCLIENT`、标题栏 `HTCAPTION` 均经实时查询核对；外来 Explorer HWND 返回 `WINDOW_NOT_OWNED_BY_DESKTOP`。Koffi driver 跨模块实例缓存、Win32 命中常量和 HWND 所有权均有定向单测。

该证据只覆盖受管诊断通道与原生命中。正式窗口的真实 `SendInput` 点击没有打开管理面板，因此当次没有取得面板打开/关闭的行为证据；不能用 `SCREEN_CLICK_SENT`、DOM 命中或原生命中替代这项验收。

## 边界和回滚

源头提醒依赖模型服从，不能保证模型永不复读；界面折叠是确定性补充。流式过程中尚未完整的回复保持原样，完成后才判定是否折叠。明确要求复述的常见中英文句式会跳过检测，复杂表达仍可能被折叠但原文可展开。

在插件管理器停用或移除 `@local/dsh-progress-guard` 即可回滚展示和后续纠偏；已记录的一次提醒仍作为上下文事件留在发生过问题的会话中。安装使用 D 盘本地链接，因此应保留项目目录。宿主升级后需要重新核对当前 Client 插槽契约。
