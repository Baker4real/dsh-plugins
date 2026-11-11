# Daily update guards

独立 Host bundle，包装宿主已有 `schedule_view`、`schedule_edit` 和 `pwsh`，不重新实现 Schedule 服务或 PowerShell 执行器。`agent/created` 在预设挂载完成后触发，插件先在 Agent scope 捕获原 definition，再以同名 scoped registration 覆盖；包装只闭包调用捕获的原 definition，避免执行时递归 lookup。新建或恢复的 Agent 会应用这些包装；插件加载时也通过 `agents.list()` 包装当前已存活的 Agent，因此主会话无需等待重建。

## Schedule 投影与 canonical prompt

两个 Schedule 工具默认返回紧凑任务结果：移除完整 `prompt`，增加 `promptSha256`、`promptBytes` 和最长 80 个 Unicode 字符的单行 `preview`。其他字段及 Schedule 错误结果保持不变。显式 `full: true` 返回原工具的完整结果。

目标任务 `schedule-2a8292b0-5876-4d7c-a20a-080f98e18eab` 的 compact 结果还包含 `canonicalPromptSha256` 和 `promptMatchesCanonical`；两边都按 Schedule 服务的 `prompt.trim()` 规范化后计算 SHA-256，避免文件尾换行造成假漂移。canonical 文件唯一允许为：

```text
D:/agents/projects/统一环境/docs/automation/daily-update-prompt.md
```

`schedule_edit` 可用 `promptFile` 从该文件读取新 prompt。此参数只接受上述精确 task id、精确路径和 `action: "update"`，不能与内联 `prompt` 同用；其他 id、路径形式或 delete 均在读取文件及调用原工具前拒绝。`full: true` 也可与合法 `promptFile` 同用，此时只关闭结果投影，不改变 prompt 来源。

## PowerShell guard

`pwsh` 的原 `execute`、输出、presenter、后台任务、sandbox 与 timeout 参数均直接保留。仅当命令同时满足以下条件时，在调用原 `execute` 前抛 `UnsafeCheckedPowerShellError`（code `UNSAFE_CHECKED_POWERSHELL_COMMANDTEXT`）：

- 包含 `Invoke-CheckedPowerShell` 或 `Invoke-CheckedPowerShell.ps1`；
- `-CommandText "..."` 或 `-CommandText:"..."` 使用双引号；
- 字符串内含未转义的 `$` 变量或 `$()` 子表达式。

错误建议使用 `-ScriptPath`。普通 PowerShell、`ScriptPath`、静态双引号 CommandText、单引号 CommandText，以及用反引号转义的 `$` 均不受阻。

Windows 上，包含 `gh` 与 `--json` 的调用还会先通过现有 `D:/Codex/.codex/scripts/Invoke-CheckedPowerShell.ps1 -CheckOnly` 做 AST 参数预检，覆盖未加引号的字段逗号列表及 `gh issue view --comments --json` 互斥参数。预检仅解析命令文本，不执行 `gh` 或待执行代码；通过后将原参数对象交回原工具，工作目录、沙箱、后台、超时和展示保持原有语义。不含这两个标记的调用不增加进程开销。取消时不执行原命令；检查器缺失、超时或不可用时明确失败。错误信息不回显原命令或子进程 argv。当前确定性检查覆盖直接 `gh` 调用、分离的 `--json` 参数和已验证的静态语法；带双引号的 executable、`--json=` 及嵌套脚本文本继续由原执行入口处理，不宣称完成通用命令分析。

## 本地检查

使用 Node ESM、`node:test`、fake tool registry 和 fake original definitions 验证包装行为；Windows 原生参数回归会真实启动 PowerShell Core 7 和受检入口的 `-CheckOnly`，只解析命令，不执行其中的 `gh`。测试不访问真实 Schedule 服务、不读取真实 canonical 文件，也不安装或修改 profile。运行时只依赖宿主已有的 `@deepseek-ai/dsh-tools` peer；本地测试复用仓库根已有的同版本 devDependencies，子 bundle 不声明额外 dependencies 或 devDependencies。

使用 DSH bundled Node/pnpm 在本目录运行：

```powershell
$node = 'C:/Users/WINDOWS/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
$pnpm = 'C:/Users/WINDOWS/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
& $node $pnpm --dir 'D:/agents/projects/dsh-plugins/dsh-compaction-256k/daily-update-guards' run check
```

也可在已解析测试依赖后运行 `node --test tests/*.test.js`。根 package 的 `check` 也聚合此 bundle 的语法和行为测试；`plugin_manager` 安装或重新启用它前执行同一根检查。
