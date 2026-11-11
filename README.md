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

子代理工作台基于 [miuzel/dsh-subagent-ui](https://github.com/miuzel/dsh-subagent-ui)，保留完整上游历史和原始 [MIT 许可证](dsh-subagent-ui/LICENSE)，本地改动随源码一并纳入。其余目录为本地维护的独立插件，许可按各包自身声明。

## 安装

使用 Harness 的 `plugin_manager` 安装各包目录。部分目录下的子 bundle 需要独立安装；所需宿主版本和实际检查命令见对应 README。`@local/*` 包名和 `private: true` 保留其本地安装语义，不表示 GitHub 仓库是私有的，也不发布 npm 包。

## 开发

保留各包现有依赖、宿主 peer 约束和独立检查。源码、测试和可分发资源纳入 Git；依赖目录、凭据、profile、日志与运行证据留在本机。不要把本机运行凭证或客户端认证信息提交到仓库。

当前验证基线为 DSH `0.2.2-rc.1`。涉及宿主安装的检查需在对应 Harness 环境运行；纯函数和离线 fixture 可独立运行。
