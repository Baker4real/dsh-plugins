# dsh-progress-guard

DeepSeek Harness 的本地进度防复读插件；`devtools/` 是独立诊断 bundle，`goal-wait/` 提供持续目标的人工等待与单次恢复。

## 运行与验证

使用宿主现有 Electron 与依赖；在项目根执行：

```powershell
& 'D:/Codex/tools/bin/node.exe' scripts/check.mjs
& 'D:/Codex/tools/bin/node.exe' devtools/scripts/check.mjs
```

这不是独立 Web 应用，不启动替代服务器。已有插件的局部修改先走 [小改动指引](docs/plugin-small-change.md)；诊断契约、预检和绑定页面验收见 [环境工具](docs/environment-tools.md)。

## 技术与目录

JavaScript ESM、Cordis Host 插件、ModuleLoader Client 产物、Session projection；无构建步骤。
`index.js` 注册 Host，`policy.js` 判定重复，`client.js` 包装官方 renderer；`tests/` 放行为和边界回归，`scripts/` 放统一检查，`smoke/` 与 `ui-smoke/` 是临时安装后卸载的验收源码。

## 改动边界

通过 `plugin_manager` 安装、启停和移除 bundle；按返回的 application/nextStep 判断生效。保留官方安装包，不另装宿主核心依赖。
修改 Client 前核对实时 Slot 契约。`entriesOfSlot` 只返回 keyed 获胜者；包装器注册后原条目被隐藏，不能因此注销重建。启动时序回归在 `tests/client-lifecycle.test.js`。
本目录属于上级 `dsh-plugins` Git 仓库；提交与推送从仓库根进行，保留各插件独立包目录。desktop profile 通过本地链接加载源码，安装路径变更使用插件管理器。

## 状态与接手

功能与接口以 [README](README.md) 和 [环境工具](docs/environment-tools.md) 为准，阶段性证据见 [实施验证](docs/verification.md)。
接手先分别读取 Host 激活、Client 实际 revision，以及这个包自己的 `registrations`。要某个槽的获胜者才传 `slot`。Config schema 的 absent 不是停用。

维护目标等待时读 [goal-wait 说明](goal-wait/README.md)，运行 `node goal-wait/scripts/check.mjs`。需要实际安装器联调时才运行该说明的显式跨包入口；不要在真实任务上为测试调用 `wait_goal`。
