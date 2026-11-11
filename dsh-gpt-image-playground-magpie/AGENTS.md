# 生图工作台 · magpie 模型

## 定位

DeepSeek Harness 本地 bundle：让 `dsh-gpt-image-playground` 通过本机 magpie 网关使用幻灵AI 的 `ai/gpt-image-2.6-sunburst` 与 `ai/gpt-image-2.6-flare`。不是独立应用，不修改上游 vendored 工作台。

## 运行与验收

- 运行前提：DSH desktop profile 安装本 bundle，magpie 网关在 `http://127.0.0.1:3425/v1`。
- `npm test`：离线回归；`npm run check`：语法检查加全部测试。需要 Node 22+，禁止用真实生图作为日常测试。
- `node scripts/verify-workbench-profile.mjs --leveldb <LevelDB目录>`：脱敏回读工作台配置；CDP 用法见 README。
- 安装、升级和卸载先读 `D:\Codex\.codex\docs\agent-guidance\dsh-desktop-plugin-install.md`；本地源码升级不得重复 `install_bundle` 冒充更新。

## 技术栈

Node.js ESM；Cordis Host `webServer` 路由 + Web Client module；`node:test`；无运行时 npm 依赖。README 的 Markdown 纳入 OKF，本文件是 Agent 控制文件，不纳入。

## 目录与约定

- `index.js`：Host 转发、同源与请求头边界、图片 URL 转 base64。
- `client.js`：通过上游 URL 参数导入 `magpie-huanling`；每个 `SEED_VERSION` 最多一次。
- `scripts/verify-workbench-profile.mjs`：CDP 优先、LevelDB 回退，只输出目标 profile 白名单。
- `test/`：公开 HTTP 路由和 Client `apply()` 行为测试；浏览器存储用模拟环境。
- `locale/`、`icon.svg`：插件管理展示资源。

真实 Key、cookie、完整工作台存储和临时图片签名 URL 不写入源码、测试、文档或输出。路由只转发 allowlist 路径，拒绝跨源浏览器调用。

## 当前状态

2026-11-09：0.2.1 已在本机安装，两个模型均完成真实出图；离线测试和真实 LevelDB 回读通过。CDP 实机读取因 Edge 连接超时未验证，不能宣称该路径已 live verified。后续只在上游契约变化、运行异常或 CDP 可用时继续，无额外待办功能。
