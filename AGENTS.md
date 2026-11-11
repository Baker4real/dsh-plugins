# DSH 插件集合

本仓库汇集独立的 DeepSeek Harness 插件。根目录负责索引、Git 和跨包迁移，各包的源码、检查和安装按其自己的 AGENTS.md、README.md 与 package.json 执行。

## 目录

- `dsh-compaction-256k/`：压缩引擎、Inspect、余量 UI、每日更新守卫、来源与读取保障。
- `dsh-progress-guard/`：进度防复读，子目录 `devtools/` 与 `goal-wait/` 是独立 bundle。
- `dsh-gpt-image-playground-magpie/`：生图工作台的 magpie 接入。
- `dsh-subagent-ui/`：子代理管理工作台，保留上游 MIT 许可证与本地改动。

## 操作

先进入目标包读取其规则并运行已有检查。安装、移除和路径变更使用宿主 `plugin_manager`，根据 application/nextStep 验证；仓库根本身不是 bundle。

公开 Git 只收源码、测试、文档、锁文件和分发资源。凭据、依赖、profile 和本机运行证据保持在仓库外。子代理工作台的构建入口仍在其包目录执行，产物与源码一起提交。
