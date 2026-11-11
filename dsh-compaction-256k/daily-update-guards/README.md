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

## 本地检查

只使用 Node ESM、`node:test`、fake tool registry 和 fake original definitions；测试不访问真实 Schedule 服务、不执行 PowerShell、不读取 canonical 文件，也不安装或修改 profile。运行时只依赖宿主已有的 `@deepseek-ai/dsh-tools` peer；本地测试复用仓库根已有的同版本 devDependencies，子 bundle 不声明额外 dependencies 或 devDependencies。

使用 DSH bundled Node/pnpm 在本目录运行：

```powershell
$node = 'C:/Users/WINDOWS/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
$pnpm = 'C:/Users/WINDOWS/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
& $node $pnpm --dir 'D:/agents/projects/dsh-plugins/dsh-compaction-256k/daily-update-guards' run check
```

也可在已解析测试依赖后运行 `node --test tests/*.test.js`。根 package 的 `check` 也聚合此 bundle 的语法和行为测试；`plugin_manager` 安装或重新启用它前执行同一根检查。
