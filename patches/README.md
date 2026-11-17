# 本机 npm 插件补丁

本目录保存通过 `pnpm patch` / `patch-commit` 生成、并在干净临时目录完成安装验证的本地补丁。补丁只用于其文件名标明的精确版本；升级前按 `D:/Codex/tools/dsh-maint/Invoke-DshPatchedPluginUpgrade.ps1` 的受管流程迁移，不直接套用到其他版本。

- `dsh-better-sidebar@0.32.1.patch`：在 Better Sidebar 的 RenderBoundary 上报结构化的 `dsh-better-sidebar/render-error` 与 `render-recovered` 事件，附 boundary、session 和 tab 身份；本地 `@local/dsh-devtools` 收集后暴露为 Runtime/Page 的有界 renderErrors。补丁同时更新 TypeScript 来源与 npm 内置 Client 产物，未修改官方 DSH ASAR。
