# 来源与读取保障

此 Host bundle 包装已挂载工具并使用官方 `llm/stream` 扩展点。它不改写 DSH、GenUI 或 Magpie 的发行文件，也不改写用户的 profile 配置文件。支持的宿主基线是 DSH 0.2.2-rc.1。

## 能力与范围

- 引用：仅承认本会话受控网页工具写入 metadata 的来源记录。编码引用标记 `\uE200cite…\uE201` 在发送到界面和会话日志前校验；合法 ID 转为真实 URL 链接，未知 ID 替换为明确的未验证提示，并每轮至多请求一次解释重写。代码围栏中的示例保留；GenUI 围栏仍做检查。推理、工具参数、usage 和提供商 replay state 原样通过。此检查证明来源 ID 的来历，不证明网页事实本身。
- 搜索：`web_search` 通过工具执行器调用已存在的 `mcp__magpie__call_tool` → `exa__web_search_exa`，复用现有连接、授权和凭据。它不选择新外部端点、不读取凭据、不修改原 DeepSeek 搜索配置。查询成功后才标记 ready；协议、鉴权、限流、超时和缺少连接分别报告，不自动换服务重试。
- 网页：`web_fetch` 保留原始安全 HTML 转换，提供有界正文、标题目录、唯一章节选择和明确的分页位置。原始结果保留在结构化值里，模型收到的是短投影。
- GenUI：只有 `skill(name=genui)` 默认读取核心指导；高级内容通过 `genui_reference(section=...)` 请求。`section=all` 保留完整上游原文，其它技能不变。原生 skill 对象保持同一身份，宿主的技能目录可见性不受影响；核心投影通过 tools/post-execute 完成。

## 使用与验证

本目录使用 `pnpm run check`。安装前运行所有本目录测试；通过官方 `plugin_manager` 以本目录作为 `install_bundle` 的 target 安装。完整测试包含流式引用分片、来源伪造边界、失败与取消、网页分段、GenUI 原文保留以及注册/清理生命周期。

安装后用 Cordis Inspect 的 `AgentReliability.status` 查看挂载工具、当前会话来源数和最后一次搜索状态。它只读，不探测网络也不暴露凭据。输入 `sessionId` 可检查目标会话。搜索状态是上一次真实请求的结果，不是永久可用性保证。

实时验收应包含：一次官方站点搜索、对同一网页的目录和章节读取、GenUI 核心与高级分段读取，以及真实 Host 流水线上的引用负控。现有 Agent 与新 Agent 均应确认工具包装；仅安装成功不代表完成。

## 更新与回滚

这是独立本地扩展。完整上游工具可通过卸载此 bundle 恢复。升级已安装的 linked bundle 前先跑检查，按 plugin_manager 返回的 nextStep 完成移除、安装和必要的宿主重启，再重新验证。保留其它插件与用户配置。

图标是本目录原创 SVG。用户可见标题和说明随 bundle 一起提供中英文 locale。没有新建服务、自启动或计划任务。
