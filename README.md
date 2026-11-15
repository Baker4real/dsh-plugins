---
type: readme
title: DeepSeek Harness 插件集合
tags: [deepseek-harness, cordis, plugins]
intent: 汇集本地维护的 DSH 插件源码，说明各目录、检查与安装入口。
---

# DSH Plugins

本仓库集中维护 DeepSeek Harness 的本地插件。各目录保留独立的 package、Cordis bundle、测试和安装边界；安装具体目录，不把仓库根作为 bundle 安装。

| 目录 | 内容 | 维护入口 |
|---|---|---|
| `dsh-compaction-256k/` | 可配置压缩阈值、Inspect、余量 UI、每日更新守卫、来源与有界读取 | [说明](dsh-compaction-256k/README.md) |
| `dsh-progress-guard/` | 进度防复读、只读诊断工具、目标人工等待 | [说明](dsh-progress-guard/README.md) |
| `dsh-gpt-image-playground-magpie/` | 生图工作台的本地 magpie 网关接入 | [说明](dsh-gpt-image-playground-magpie/README.md) |
| `dsh-subagent-ui/` | 子代理管理浮窗与默认收起、本地界面和验收改进 | [中文说明](dsh-subagent-ui/README.zh.md) |
| `dsh-skills-root-guard/` | 拦截对现役 skills 根的直接 write/edit 工具调用 | [说明](dsh-skills-root-guard/README.md) |

子代理工作台基于 [miuzel/dsh-subagent-ui](https://github.com/miuzel/dsh-subagent-ui)，保留完整上游历史和原始 [MIT 许可证](dsh-subagent-ui/LICENSE)，本地改动随源码一并纳入。其余目录为本地维护的独立插件，许可按各包自身声明。

## 安装

使用 Harness 的 `plugin_manager` 安装各包目录。部分目录下的子 bundle 需要独立安装；所需宿主版本和实际检查命令见对应 README。`@local/*` 包名和 `private: true` 保留其本地安装语义，不表示 GitHub 仓库是私有的，也不发布 npm 包。

## 开发

保留各包现有依赖、宿主 peer 约束和独立检查。源码、测试和可分发资源纳入 Git；依赖目录、凭据、profile、日志与运行证据留在本机。不要把本机运行凭证或客户端认证信息提交到仓库。

当前验证基线为 DSH `0.2.2-rc.3`：2026-11-14 已在本机 rc.3 宿主上跑通除 `dsh-subagent-ui` 外各包的检查；同日重启后，真实客户端的会话投影缓存显示 progress-guard 与 goal-wait 均已激活，其余包未逐一核对客户端行为。DSH 只替链接安装的包解析本包或上层 `package.json` 的 `peerDependencies` 里声明过的宿主包，未声明的回落到普通 Node 解析（rc.1 上 2026-11-09 已用隔离 Host 探针实测，rc.3 相同），所以运行时导入的宿主包都要声明为 peer；根目录的 `scripts/check-source.mjs` 在 CI 里逐包核对这一点，只查 Host 侧，Client 依赖由渲染进程的模块加载器提供。涉及宿主安装的检查需在对应 Harness 环境运行；纯函数和离线 fixture 可独立运行。
