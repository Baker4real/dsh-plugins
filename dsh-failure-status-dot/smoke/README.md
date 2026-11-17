# 真实会话圆点验收夹具

临时安装本目录后，会在独立的 D 盘验收工作区创建两个普通会话，使用本插件注册的本地 LLM adapter，经真实 Session Controller 提交并完成成功与失败回合。它不会修改默认模型，也不会发出外部模型请求。

先确认目标桌面页面已连接，再通过 `plugin_manager` 安装；读取只读 `FailureDotSmoke.status` 得到 workspaceId、会话 id 和真实 turn/end 结果。展开该验收工作区，用唯一 selector `[data-row-key="session:<sessionId>"] > span:first-child > span:first-child` 调用 Client `Desktop.inspectElement`，读取实际 `paint.color`（圆点通过 currentColor 绘制，backgroundColor 可以是透明）。失败应为主题错误色，成功应为主题成功色；打开失败会话后其未读圆点应清除。结束前返回原会话，再通过插件管理器移除本夹具，清理会归档两个测试会话并移除验收工作区注册，保留日志与 D 盘证据。

操作前记录当前 Page 的主会话和完整身份。`dsh_page click` 必须带该次检查的 pageId、documentId、graphRevision 与 element token。打开另一会话会改变绑定身份；若返回 `PAGE_OR_ELEMENT_CHANGED` 且 `mayHaveExecuted: true`，先按新会话 id 重新 inspect，确认导航和圆点状态，再继续，避免重复点击。恢复原会话后也应重新核对身份。当前窗口最小化时先激活已核实的 DSH 窗口，否则入场动画可能仍处于不可见状态。

此包是一次性测试 fixture，按测试包例外省略图标与展示 locale，不作为用户功能长期安装。验收必须基于真实客户端，不能用模拟 DOM 或模块加载成功代替颜色与已读清除结果。
