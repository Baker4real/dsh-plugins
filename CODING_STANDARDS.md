---
type: reference
title: DSH Plugins 编码与评审规范
tags: [deepseek-harness, cordis, coding-standards, review]
intent: 供评审阶段把关跨文件一致性、插件边界、中间件合作与真实宿主验收等需要工程判断的标准；机械性检查交由自动化护栏执行。
---

# DSH Plugins Coding Standards

本文件面向评审阶段，仅沉淀无法由静态脚本替代的工程判断标准。语法、`peerDependencies`/宿主自带包边界、兼容范围和提交前单测由确定性护栏执行（见末节）。

## 1. 宿主非侵入与扩展边界

- 优先使用官方 Cordis 扩展点（`llm/stream`、`tools.guard`、`tools/post-execute`、投影与官方服务接口）实现兜底或增强；不要在插件代码中直接改写用户现场 profile（`cordis.yml` / `cordis.patch.yml`）或官方 `app.asar`。
- 确需修改官方 `app.asar` 时，改动必须登记到 `D:/Codex/tools/dsh-maint/local-patches.json`，使用精确基线校验，不得以未登记的就地替换代替。

## 2. 中间件与多插件合作

- 在 `llm/stream`、`tools/post-execute` 或工具包装中间件中，保留其他插件已做出的 `content`、`value`、`block`、`additionalContexts` 和 provider replay state 决定，不吞掉非目标块或未命中分支。
- 对流式 chunk、事件对象和请求上下文保持不可变转换：需要改写字段时返回浅拷贝新对象，不就地篡改共享上游对象，避免污染日志或并发观察者。

## 3. 错误归类、重试与失败语义

- 任何错误重分类、降级或守卫逻辑都必须限定在精确可观察特征之内：明确排除 `4xx` 客户端错误、已取消（`aborted`）和非目标错误码，并保留原始错误文案与可诊断指标。
- 禁止静默降级或无界重试：重试次数与退避策略复用宿主 `@deepseek-ai/dsh-llm-retry` 及 provider 自有 `retryPolicy`，确保最终失败时按原始错误停止。

## 4. 可观察行为测试与真实宿主验收

- 单元测试验证公开行为、边界条件与负控（不该触发的分支、并发/取消、部分输出已产生等场景），避免绑定易漂移的私有实现细节。
- 涉及 Cordis 挂载生命周期、`AgentLoop`、工具执行管线或 `app.asar` 模块契约的改动，须使用真实宿主模块夹具（参考 `dsh-progress-guard/goal-wait/tests/agent-loop.test.js`）和 `D:/Codex/tools/dsh-maint/Invoke-DshEvalCompat.ps1` 验证，不得只靠手工 stub 宣称已兼容。

## 5. 包契约、文档与多语言一致性

- 修改子包可见能力、工具参数、状态输出或兼容基线时，在同一次改动中同步更新：
  - 子包 `package.json` 的 `version`、`files`、`engines.dsh` 与 `scripts.check`；
  - 子包 `README.md` 与 `locale/*.json` 中的用户可见文案；
  - 变更触及仓库导航指针时同步对应 `AGENTS.md`。
- Host 模块严禁依赖浏览器全局对象；带前端构建产物的子包（如 `dsh-subagent-ui`）修改源码后须重新构建并核验产物一致。

## 6. 凭据、隐私与仓库卫生

- 源码、测试夹具与文档不得出现真实 API key、一次性认证 URL、token、cookie 或本机个人会话原文；验收时产生的临时脚本、日志和运行证据留在仓库外（`D:/agents/run-evidence/` 或会话 scratch）。
- 仅修改当前任务白名单目录，保留同仓库中其他未提交工作与无关子包。

## 7. 机械性检查分工（勿以人工评审替代）

以下规则由确定性护栏自动校验，评审时核对其通过证据即可：

- **语法、相对路径与宿主 `peerDependencies` 边界**：`node scripts/check-source.mjs`（CI `portable-checks` 与 `.githooks/pre-commit` 自动运行）。
- **子包行为回归**：CI [check.yml](.github/workflows/check.yml) 覆盖 `dsh-skills-root-guard`、`dsh-gpt-image-playground-magpie`、`dsh-failure-status-dot`、`dsh-progress-guard/devtools`、`dsh-subagent-ui`、`dsh-compaction-256k` 与 `dsh-compaction-256k/agent-reliability`；本地提交前由 `.githooks/pre-commit` 按改动包触发对应测试。
- **宿主兼容与本地补丁预检**：`D:/Codex/tools/dsh-maint/Invoke-DshEvalCompat.ps1` 与 `Invoke-DshHostUpgradePreflight.ps1`。
