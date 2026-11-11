---
type: reference
title: 本地安装路径与迁移边界
tags: [dsh, installation, migration]
intent: 解释集中目录的安装目标、临时兼容入口和宿主重载边界。
---

# 安装路径

本机源码实体集中在 `D:/agents/projects/dsh-plugins/`。各包继续独立安装；目录迁移不会改变包名、配置键或 npm 发布状态。

| Bundle | 相对目录 |
|---|---|
| `@local/dsh-compaction-256k` | `dsh-compaction-256k/` |
| `@local/dsh-compaction-context-meter` | `dsh-compaction-256k/context-meter/` |
| `@local/daily-update-guards` | `dsh-compaction-256k/daily-update-guards/` |
| `@local/dsh-agent-reliability` | `dsh-compaction-256k/agent-reliability/` |
| `@local/dsh-progress-guard` | `dsh-progress-guard/` |
| `@local/dsh-devtools` | `dsh-progress-guard/devtools/` |
| `@local/dsh-goal-wait` | `dsh-progress-guard/goal-wait/` |
| `dsh-gpt-image-playground-magpie` | `dsh-gpt-image-playground-magpie/` |
| `dsh-subagent-workspace-ui` | `dsh-subagent-ui/` |

迁移期间，旧项目根只保留指向新实体的临时兼容 junction，供已有模块 URL、其他活跃会话和历史证据读取。迁移前只读 preflight 对压缩包返回 `restart-required (unmanaged-plugin)`；实际通过 `plugin_manager` 逐个移除再安装后，九个 bundle 均返回 `application: applied`，profile 安装路径已指向新实体。以实际安装结果为准，不把预检计划当成已执行动作；没有为此终止 Host。兼容入口不放源码副本，不是新的安装目标。

移除兼容入口前，应确认 profile 中所有对应本地包都已指向新路径，并在必要的 Host 重启后验证四个 Agent 预设、余量 UI 和工具。还应更新仍引用旧路径的知识页来源与主机文档；历史日志和不可变运行证据不回写。其他机器请按实际检出路径安装，无需创建这些本机兼容入口。

公开 CI 覆盖 JavaScript 语法、包清单、不访问外部模型的生图工作台 fixture，以及子代理工作台的构建、行为回归和 Windows 原生标题栏检查。依赖已安装 Harness 的完整检查在本机运行，不能把公开 CI 当作当前 Host 激活或真实页面验收。子代理工作台保留原 MIT 许可证和完整上游历史；原检出的 Git 元数据与未提交状态在仓库外单独备份。
