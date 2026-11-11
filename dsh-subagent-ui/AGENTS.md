# 子代理管理工作台

`dsh-subagent-workspace-ui` 是 DSH Web Client 插件。源码在 `src/client/`；`lib/client.js` 是生成物，必须构建，不能直接编辑。Host 入口 `lib/index.js` 可直接修改。

## 已安装插件的小改动

1. 检查目标文件的现有 diff，保留其他人的改动。默认状态、文字等局部变更直接定位对应源码和既有测试；不展开新插件模板或全量 API 文档。更换扩展点或调用契约时再做精确 Inspect。
2. 修改源码；运行 `pnpm run check` 和相关既有测试。界面默认状态至少跑 `node test/render.test.mjs`。`check` 已包含构建和类型检查，不必先重复 build；其他门禁以 `package.json` 和 `.github/workflows/check.yml` 为准。
3. 先做只读生效预检，再决定是否重新安装。安装目录可能是链接或副本，不从 `file:`/`link:` 字样推断运行态。当前桌面实例使用 `plugin_manager`；以其 `application`/`nextStep` 判定。需要重启时，保留页面验收待办，不自动终止活跃宿主。
4. Web 使用当前 runtime context 的 GUI URL；Desktop 以 `Page.inspect` 返回的实际页面地址为准。通过 `dsh_page` 先 inspect，匹配主会话和完整页面身份后再 reload。用新文档和实际元素状态验收；Host 广告与 Client 模块相符也不能单独证明最新源码已加载。

本机工具入口和预检参数见 [DSH 小改动指引](../dsh-progress-guard/docs/plugin-small-change.md)。缺少这些本地工具的环境，明确记录未验证项；按下面参考文档的对应宿主分支验证，不启动替代服务器冒充当前 GUI。

Windows 使用 `load_workspace_dependencies` 返回的 Node 和 pnpm 脚本；只给本次进程补 Node PATH，不假设 PATH 已有 node/pnpm。PowerShell 命令遵守本机受检入口。

## 持续约束

- 保留 `dsh-sam-` CSS 前缀和 `dsh-subagent-workspace-ui/preferences` 偏好键，用户可见文案及可访问性标签保持一致。
- 模型、类型、用量仅展示宿主只读投影；不要增加模型写入。Prompt 只从受保留的子会话消息读取，并按 message id 匹配，不读不存在的 `SessionSummary.prompt`，不渲染不可信 HTML。
- 主工作区已有未提交改动时不回退、不覆盖、不擅自创建分支或 worktree。提交、推送、发布及重启只在本次授权覆盖时执行。
- `main` 是发布线；需要切开发分支时先取得授权。发布纪律只在获准发布后启用，不把普通修复自动升级为发布任务。

## 按需深入

- TypeScript、linker、生成物或长行合并：读 [代码约束](docs/maintenance/code-style.md#code-style-and-conventions)。
- 包资源、icon、locale、bundle patch 或目录定位：读 [目录与资源](docs/maintenance-reference.md#directory-guide)。
- 投影、Prompt、retention、删除、认证、导航、header shadow 或移动浮层：按 [兼容主题索引](docs/maintenance/compatibility.md#known-gotchas) 定点读取，并核对相关测试。
- 检查层级、真实浏览器或原生标题栏验收：读 [验证与测试](docs/maintenance/validation.md#validation)。
- 获准发布：读 [发布纪律](docs/maintenance/release.md#release-discipline-default-after-every-release)；提交约定或 dsh-graph：读 [工作流补充](docs/maintenance/release.md#workflow-cadence-core-memo)。

维护细节已下沉。历史结果仅作线索；实际版本、目录、GUI 地址与加载状态以当前源码和运行态为准。
