---
title: 生图工作台 · magpie 模型
type: readme
status: verified-local
owner: dsh-gpt-image-playground-magpie
intent: 让 DeepSeek Harness 的生图工作台（dsh-gpt-image-playground）经同源路由使用 magpie 网关里幻灵AI 的两个 GPT Image 模型
tags:
  - deepseek-harness
  - dsh-plugin
  - magpie
  - gpt-image
  - huanling
---

# 生图工作台 · magpie 模型（DSH bundle）

给已安装的 [dsh-gpt-image-playground](https://www.npmjs.com/package/dsh-gpt-image-playground)（左栏「生图工作台」）接入 magpie 网关里幻灵AI（provider `ai`）的两个生图模型：

- `ai/gpt-image-2.6-sunburst`
- `ai/gpt-image-2.6-flare`

模型名来自 `magpie tools` 里 `generate_image` 的 `--model` 可选值（2026-11-09，magpie 0.1.3358）。

## 组成

| 部分 | 文件 | 作用 |
|---|---|---|
| Host 路由 | `index.js` | `/plugins/dsh-gpt-image-playground-magpie/v1/{models,images/generations,images/edits}` 转发到 magpie 网关 `http://127.0.0.1:3425/v1`；其他路径 404。浏览器的 `Authorization`（工作台必填的占位 key）、cookie 和 `User-Agent` 不转发；Host 进程有 `MAGPIE_GATEWAY_KEY` 时改发这个 key。成功的 JSON 生图响应里的 `url` 在主机侧下载（带浏览器 UA）并改成 `b64_json`；下载失败时保留 `url`。 |
| 浏览器端 | `client.js` | 工作台 iframe 第一次出现、且应用存储里还没有 `magpie-huanling` 配置时，把 iframe 指向带上游 URL 导入参数的同一地址，导入「幻灵AI · magpie」配置；每个 `SEED_VERSION` 只做一次，之后用户改或删这个配置都不再干预。 |

为什么要单独的路由：magpie 网关不回 CORS 预检（`OPTIONS` 返回 404），工作台在页面里直连会被浏览器拦截；工作台插件自带的 `/proxy` 只有一个全局目标，而且会把 DSH 主机 cookie 一起转发出去，所以没有占用它。路由只接受 DSH 同源页面、`dsh-app://app` 桌面桥或无 `Origin` 的本机非浏览器请求，拒绝其他网站经 loopback 触发生图。

两处改写的原因（2026-11-09 实测）：

- magpie 会把客户端 `User-Agent` 透传给幻灵；幻灵的 Cloudflare 对非浏览器 UA（如 `Python-urllib`）回 `403 error code: 1010`。不带浏览器 UA 时 magpie 用自己的，能过。
- 幻灵把结果图放在 `https://api.huanling.icu/sub2api-temp-images/...` 临时链接里，不带 `Access-Control-Allow-Origin`，非浏览器 UA 同样 1010；工作台在页面里下载必然失败，所以由主机侧转成 base64。

桌面版里工作台的源是 `dsh-app://app`，导入的 API URL 是 `dsh-app://app/plugins/dsh-gpt-image-playground-magpie/v1`，由桌面壳转发给 DSH 主机，不依赖主机端口。网页版用当时页面的 origin。

## 上游集成契约

需要修改导入、配置存储或模型切换时，先查上游文档和源码，不要从 `vendor-app/assets/` 的压缩产物反推：

- [URL 传参快速填充](https://github.com/CookSleep/gpt_image_playground#url-quick-fill)：本插件使用 `profileId`、`profileName`、`apiUrl`、`apiKey`、`model`、`apiMode`。`profileId` 相同则更新原配置；应用会把模型列表规整成逗号加空格，所以验证时按数组解析，不做整串字面比较。
- [预置配置 JSON](https://github.com/CookSleep/gpt_image_playground#preset-config-json)：`baseUrl` 末尾 `/` 的拼接规则、模型列表和 `apiMode` 的正式定义。
- [上游 `src/`](https://github.com/CookSleep/gpt_image_playground/tree/main/src)：实现细节的优先来源；插件内 vendored 构建只用于核对当前实际运行版本。
- 工作台在自己的 `localStorage["gpt-image-playground"]` 持久化 `{ state: { settings: { profiles, activeProfileId } } }`；本插件导入的 ID 是 `magpie-huanling`。这与 Host 侧 `~/.dsh/gpt-image-playground/profiles.json` 是两套存储，不要混用。

## 配置

`gatewayUrl`（可选，默认 `http://127.0.0.1:3425/v1`），写在 profile 的 `cordis.patch.yml`：

```yaml
- id: gpt-image-playground-magpie
  config:
    gatewayUrl: http://127.0.0.1:3425/v1
```

## 测试

需要 Node 22+，全部使用本地假网关、假图床和模拟浏览器；不访问外部网络、不消耗真实生图额度。

```powershell
npm test
npm run check
```

覆盖：浏览器 UA/Key/cookie 与同源检查、Cloudflare 1010 错误透传、图片 `url` 下载 403 后保留原值、成功时 `url` 转 `b64_json`、路由 allowlist、Client 已 seed/已有配置/iframe 后出现且只导入一次，以及 CDP 白名单、Snappy 和压缩 SSTable 离线解析。

## UI 验证

`scripts/verify-workbench-profile.mjs` 只输出目标 profile 的白名单字段和布尔检查，不输出任何 API Key 或其他供应商配置。退出码：`0` 全部通过，`1` 配置不完整，`2` 数据源不可用。

获得浏览器操作授权后，优先按 `web-access` skill 的前置检查复用 CDP Proxy，再只读当前已打开的工作台 iframe；脚本不创建 tab、不点击、不写页面状态：

```powershell
# 桌面版目标；网页版可改 --target 127.0.0.1:1903
node scripts/verify-workbench-profile.mjs --cdp http://localhost:3456 --target dsh-app://app
```

CDP 不可用或只需离线证据时，才读 Chromium LevelDB。解析器支持 `.log` 和 Snappy 压缩的 `.ldb` SSTable（含 restart array），接受模型列表的空白差异，选择最新可解析记录，并且同样只输出白名单：

```powershell
node scripts/verify-workbench-profile.mjs --leveldb 'C:/Users/WINDOWS/AppData/Roaming/@deepseek-ai/dsh-desktop/Local Storage/leveldb'
```

## 安装与撤销

- 安装：DSH 插件管理安装本目录绝对路径（`plugin_manager install_bundle`）。本地源码升级按 `D:\Codex\.codex\docs\agent-guidance\dsh-desktop-plugin-install.md` 的「本地目录 bundle 升级」执行，不重复调用安装来冒充更新。
- 撤销：移除 bundle；工作台里已导入的「幻灵AI · magpie」配置需要在 设置 → API 配置 里手动删除。
- 想重新导入：删掉工作台里的该配置，并在页面存储里清除 `dsh-gpt-image-playground-magpie:seeded`，或把 `client.js` 的 `SEED_VERSION` 加一。
