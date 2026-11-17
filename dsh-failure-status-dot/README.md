# 运行失败红点

用于 DeepSeek Harness 0.2.2-rc.3 的本地界面修复。会话最后一轮以 `turn/end.reason.kind = error` 结束，且官方状态仍有未读完成提醒时，标题左侧圆点使用主题的错误红色。成功完成继续使用原来的绿色；打开会话后沿用官方的已读清除行为。开始新一轮时清除旧失败状态。

通过 `plugin_manager` 安装本目录，无需设置。通过插件管理器停用本插件即可恢复官方样式。

Host 使用增量 Session projection，并将一个布尔值作为 summary 发布。Client 通过 `sidebar.session.row.trailing` 挂载不占布局的样式，只替换相应行前导圆点区域的成功颜色 token。不打开或保留会话，不读取错误文本，不修改官方 ASAR。

样式适配依赖当前版本的 `data-row-key` 和前导单元结构，因此 manifest 将宿主版本限定为 0.2.2-rc.3。宿主升级时需复核该结构和主题 token。

使用宿主提供的 Node 运行 `node scripts/build.mjs` 更新产物；`node scripts/build.mjs --check` 只验证一致性，过期或模板插入点异常均以非零退出，检查不会重写文件。`pnpm run check` 执行产物一致性、入口语法及全部行为测试；生成的 `client.js` 与源码一起保留。现有 CI 单独运行一致性检查和行为测试。

真实客户端验收使用 `smoke/` 一次性 bundle：生成受控成功/失败普通会话，读取 `Desktop.inspectElement` 的实际 `paint.color`，再打开失败会话核对未读圆点清除。此测试不调用外部模型，不修改默认模型；结束时回原会话并卸载 fixture。纯策略测试、实际颜色与已读行为的证据分开保存，模块加载成功不能替代颜色验收。
