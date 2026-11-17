# 运行失败红点

这是 DSH 0.2.2-rc.3 的独立本地 bundle：失败且未读的完成圆点使用错误色，其他状态沿用官方行为。

## 运行与检查

使用宿主提供的 Node 和 pnpm。`pnpm run check` 校验生成产物、入口语法及全部行为测试；`pnpm run build` 更新客户端产物。CI 单独执行 `node scripts/build.mjs --check` 和 `node --test tests/*.test.js`。

## 源码与边界

JavaScript ESM、Cordis Session projection、ModuleLoader Client；无独立 Web 服务。

- `index.js` 注册增量投影，`policy.js` 保存纯状态判断和局部样式。
- 编辑 `src/client.js` 后构建 `client.js`；生成产物与源码一起提交。
- `smoke/` 是一次性真实会话验收 bundle，按其 README 安装和清理；不调用外部模型、不改变默认模型。
- 安装和启停使用 `plugin_manager`，以 application/nextStep 及实际 Client revision 判断生效。

## 维护

宿主升级时复核主题 token、前导圆点 DOM 与 Slot 契约，再更新 manifest 版本范围。行为测试与真实颜色/已读验收分开记录，模块加载成功不能替代界面验收；当前用法见 README。
