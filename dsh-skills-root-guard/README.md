# Skills Root Guard

`@local/dsh-skills-root-guard` 在 Host 的 `tools/pre-execute` 事件中拦截指向现役 skills 根的 `write` 与 `edit` 工具调用，并提示改用受管安装入口。

- 实体根：`D:\agents\skills-manager\skills`。
- 相对路径按会话工作目录解析；已有文件通过 `realpath` 解析 junction，新文件解析其父目录。
- 只覆盖 DSH 的 `write`/`edit` 工具，不扫描 shell 命令；Claude Code 的对应 `Write`/`Edit` 拦截由统一环境的受管 hook 负责。
- 插件没有 Client UI、Config schema 或外部网络依赖。

## 安装与验证

用 Harness 的 `plugin_manager` 安装本目录。安装结果必须是 `application: applied`，并确认 desktop profile 的 bundles 含 `@local/dsh-skills-root-guard`。

行为验收：对 skills 根下现有文件发起 `write`，应返回指向 `install-skill-guarded.cmd` 的拒绝理由；通过 `D:\Codex\.codex\skills` junction 写入也应被拒；对普通证据目录的写入不受影响。
