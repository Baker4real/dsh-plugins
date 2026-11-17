# Skills Root Guard

`@local/dsh-skills-root-guard` 在 Host 的 `tools/pre-execute` 事件中拦截两类误用：指向现役 skills 根的 `write`/`edit`，以及指向 `app.asar` 内部的原生 `grep`/`glob`。前者提示受管安装入口，后者提示 Host `SourceNav` 与 `Source.searchFile`。

- 实体根：`D:\agents\skills-manager\skills`。
- 相对路径按会话工作目录解析；已有文件通过 `realpath` 解析 junction，新文件解析其父目录。
- 只覆盖 DSH 的 `write`/`edit`/`grep`/`glob` 工具，不扫描 shell 命令；Claude Code 的对应 `Write`/`Edit` 拦截由统一环境的受管 hook 负责。
- 插件没有 Client UI、Config schema 或外部网络依赖。

## 安装与验证

用 Harness 的 `plugin_manager` 安装本目录。安装结果必须是 `application: applied`，并确认 desktop profile 的 bundles 含 `@local/dsh-skills-root-guard`。

源码检查：`npm test` 使用 Node 内置测试运行器，覆盖 ASAR 绝对/相对路径、普通目录放行、既有 skills 写入护栏与下游拒绝保留。

行为验收：对 skills 根下现有文件发起 `write`，应返回指向 `install-skill-guarded.cmd` 的拒绝理由；对 `resources/app.asar/dsh` 发起 `grep`，应返回 `SourceNav` 指引；对普通证据目录的写入和普通源码目录的搜索不受影响。
