# 来源与读取保障

此 Host bundle 包装已挂载工具并使用官方 `llm/stream` 扩展点。它不改写 DSH、GenUI 或 Magpie 的发行文件，也不改写用户的 profile 配置文件。支持的宿主基线是 DSH 0.2.2-rc.1。

## 能力与范围

- 引用：仅承认本会话受控网页工具写入 metadata 的来源记录。编码引用标记 `\uE200cite…\uE201` 在发送到界面和会话日志前校验；合法 ID 转为真实 URL 链接，未知 ID 替换为明确的未验证提示，并每轮至多请求一次解释重写。代码围栏中的示例保留；GenUI 围栏仍做检查。推理、工具参数、usage 和提供商 replay state 原样通过。此检查证明来源 ID 的来历，不证明网页事实本身。
- 搜索：`web_search` 通过工具执行器调用已存在的 `mcp__magpie__call_tool` → `exa__web_search_exa`，复用现有连接、授权和凭据。它不选择新外部端点、不读取凭据、不修改原 DeepSeek 搜索配置。查询成功后才标记 ready；协议、鉴权、限流、超时和缺少连接分别报告，不自动换服务重试。
- 网页：`web_fetch` 保留原始安全 HTML 转换，提供有界正文、标题目录、唯一章节选择和明确的分页位置。原始结果保留在结构化值里，模型收到的是短投影。
- 技能正文：首次 `skill(name=...)` 保留原生加载结果；只有相同名称、正文 SHA-256 与资源提示都一致的完整内容仍在当前有效上下文中，重复调用才返回简短回执。正文逐字比较，换行或源码内容变化会重新返回全文。`skill_reload(name=...)` 始终请求当前全文，包括 GenUI；它复用原生 skill 的参数和模型调用权限。原生 skill 定义对象保持同一身份，宿主技能目录的 identity 可见性判断不变。
- GenUI：`skill(name=genui)` 继续默认读取核心指导；高级内容通过 `genui_reference(section=...)` 请求，`section=all` 保留完整上游原文。核心与分段投影不算完整加载；只有上下文中已有同版本全文时，普通 `skill` 调用才会收到已加载回执。核心和重复读取均通过 `tools/post-execute` 投影；其它插件的 content/value/block 决定及 additionalContexts 原样保留。

## 技能加载的上下文边界

去重直接读取正式 `Session.surface` 和 `deriveEventMessage()` 的当前投影，没有插件内存中的“已加载”列表。原生技能调用成功后提交的完整工具结果，以及用户或 Harness 注入的完整 `<skill_content>` 块，均可成为证据。工具结果还须通过 `sourceEventSeqs` 关联到 `skill`、`skill_reload` 或读取 `all` 的 `genui_reference` 调用。失败和取消结果、普通文件/网页工具中的示例、未知封装、代码围栏引用、缺失资源提示或分段正文均不生成已加载回执。

fork、resume 和重放只依赖各自实际保留的 Session 消息；压缩替换或消息投影裁掉全文后，下次读取恢复全文。旧回执和摘要里的“曾加载”文字不算正文证据。并发执行按宿主提交顺序判定：前一次全文尚未提交时，允许重复返回全文；不会用未提交的成功假设省略内容。仅独立、完整且与当前原生 renderer 一致的文本块受支持，未知情况保留原结果。

## 使用与验证

本目录使用 `pnpm run check`，通过 DSH bundled Node 运行 bundled pnpm。安装前运行所有本目录测试；通过官方 `plugin_manager` 以本目录作为 `install_bundle` 的 target 安装。完整测试包含流式引用分片、来源伪造边界、失败与取消、网页分段、GenUI 原文保留以及注册/清理生命周期。技能加载回归经真实 `ToolExecutionPipeline` 和 `SessionStore` 执行，覆盖正文重复、注入、内容变化、重载、会话隔离、fork/resume、压缩替换、消息投影、并发和 waterfall 合作。

安装后用 Cordis Inspect 的 `AgentReliability.status` 查看挂载工具、当前会话来源数和最后一次搜索状态。它只读，不探测网络也不暴露凭据。输入 `sessionId` 可检查目标会话。搜索状态是上一次真实请求的结果，不是永久可用性保证。

实时验收应包含：一次官方站点搜索、对同一网页的目录和章节读取、GenUI 核心与高级分段读取，以及真实 Host 流水线上的引用负控。技能去重在现有与新 Agent 分别确认原生目录可见、首次完整/重复短回执/显式重载，之后验收一次用户技能注入、改正文再读、fork/resume 和压缩后重读；回执只应在全文仍保留的上下文出现。`skill_reload` 的新增 schema 会增加首次请求的工具说明开销，部署时以同预设、模型和消息比较首次请求 token 用量，再比较重复技能结果的节省。现有 Agent 与新 Agent 均应确认工具包装；仅安装成功不代表完成。

## 更新与回滚

这是独立本地扩展。完整上游工具可通过卸载此 bundle 恢复。升级已安装的 linked bundle 前先跑检查，按 plugin_manager 返回的 nextStep 完成移除、安装和必要的宿主重启，再重新验证。保留其它插件与用户配置。

图标是本目录原创 SVG。用户可见标题和说明随 bundle 一起提供中英文 locale。没有新建服务、自启动或计划任务。
