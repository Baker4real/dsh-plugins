# 已安装 DSH 插件的小改动

用于当前已安装插件的默认值、文案、局部样式或已有交互调整。新增插件、改扩展点、改公开接口时，转入完整 `cordis-plugin-development` 流程；不要把本入口当作跳过真实契约与验收的许可。

## 定位与检查

先确认当前工作目录并读取项目 AGENTS。Git 工作树先运行 `git status --short`，定位后只运行 `git diff -- <目标文件>` 检查现有改动；长行 TS/CSS 使用局部读取或项目已有的 selector 诊断，避免整目录 diff。保留其他人的改动，已有明确源码指针时直接使用，不枚举宿主目录，不把生成 bundle 当源码。Windows 通过 `load_workspace_dependencies` 取得 Node 和 pnpm 脚本；只设置本次进程 PATH，不探测或修复全局 PATH。

采用项目既有检查和相关行为用例。`pnpm run check` 若已包含 build，不重复构建；已有测试先修正行为期望，验证旧行为失败再改实现。命令成功、文件相同、Host 激活、Client 加载和用户可见行为分别记录。

## 按需发现

使用 `dsh_inspect`：不带参数时只返回有预算的 Provider 目录；`action: "contract"` 加 `platform`、`provider`、`method` 读取一个方法的完整输入/输出 schema；`action: "query"` 再传符合 schema 的 `input` 执行只读查询。默认预算 6000 bytes，可分页。超预算明确要求缩小查询，不静默截断契约。Host 和 Client 的同名方法不共用输入；未声明字段会报错并列出该方法允许的字段。`Config.listConfigs` 不超过 5 行的目录自带 `packageDir`；entry 结果默认不含插件 schema，要 schema 时传 `includeSchema: true`。

已有入口也可查询 Host `Inspect.providers`、`Inspect.provider`。Service 的精确声明使用 `Inspect.method`；ASAR 源码位置与局部匹配使用 `SourceNav`。只在确需类型时请求 `includeTypes`，不重复加载全量 Provider schema。Provider 只能读，不能通过它调用业务操作。

## 变更生效预检

安装、移除或重新启用现有插件前，通过 `dsh_inspect` 的 query 或 `cordis_inspect_query` 调用 Host `Deployment.preflight`：

```json
{"packageName":"dsh-subagent-workspace-ui","sourceDirectory":"D:/agents/projects/misc/dsh-subagent-ui"}
```

`installedDirectory` 默认从当前 Config entry 的 `packageDir` 解析；无 entry 时显式提供已核实的安装包目录。可选 `files` 只比较指定相对入口文件，不能把入口相同推断为整个源码一致。

预检同时报告链接/副本、版本、入口 SHA-256、运行模块归属和重启要求。`patchId` 只表示补丁可寻址；符号链接及相同字节不代表内存里的模块已更新。

内部 HMR 适配限定已核验的 `0.2.2-rc.1`，只调用原宿主标为只读的替换规划；版本、缓存或能力不符返回 `unknown`。按预检结果选择下一步，每次实际变更后仍读 `application`/`nextStep`：

| 预检结果 | 下一步 |
| --- | --- |
| `relationship: symlink-to-source` 且 `requirements.host: live-reload-candidate` | 先用 `plugin_manager.list_plugins` 取得既有 entry，再通过 `set_plugin` 禁用并重新启用以应用当前源码；跳过 `install_bundle`。 |
| 安装目录是副本，或入口文件需要复制进 profile | 使用 `plugin_manager` 支持的更新路径；已安装时按 `nextStep` 处理，必要时在授权范围内移除后重新安装。 |
| `requirements.host: restart-required` | 保留页面验收待办，仅在授权覆盖时重启选定宿主。 |
| 规划为 `unknown` 或能力不足 | 保持页面验收未完成，按实际 `nextStep` 选择受支持操作。 |

`live-reload-candidate` 只是规划，不代表内存模块已更新；不用卸载来探测能否热更新。

## 绑定真实页面验收

Web 使用 runtime context 当前给出的 GUI 地址，不保存固定端口，不使用带 query/fragment 的授权 URL。Desktop 先由 `Page.inspect` 确认安全 origin/path，renderer 可能是 `dsh-app://app/`，与 HTTP 后端地址不同。然后调用 `dsh_page`：

```json
{"action":"inspect","url":"http://127.0.0.1:CURRENT_PORT/","packageName":"dsh-subagent-workspace-ui","selector":".dsh-sam-active-collapse","expectedExpanded":false}
```

将示例端口替换成当前地址。`sessionId` 默认取请求 Agent 的会话；需要其他主会话时明确提供 id。只有 URL 和主会话匹配的页面会回答。检查返回 `pageId`、`documentId`、`graphRevision`、实际模块 revision 和结构化元素状态；不返回 DOM 正文或 URL 中的凭据。

确需刷新时，在 `action: "reload"` 中带上上述完整身份；调用本身有副作用，应在本次用户授权范围内。工具只向匹配的页面发固定 reload 命令，不发送按键、不导航、不打开替代页面。命令 ack 只代表接受；新文档回执和再次检查通过后，结果才是 `verified`。页面、会话或模块代次变化时拒绝旧身份。

`matchesAdvertisedModule` 仅比较当前 Host 广告，`sourceBuildVerified` 不会因此变成 true。仍需结合构建/文件预检和实际行为证明新代码。未连接、识别能力缺失、元素不存在、动作未确认、需要重启等情况保留为未验证，不把成功发出命令当作完成。

## 变更与发布边界

源码和检查在本地完成；只有实际需要时才使用插件管理器更新 profile，不直接写 profile 配置，不修改官方 ASAR。CI 文件已索引仅说明本地版本管理状态；提交、推送和远端 job 成功是独立阶段，必须有相应授权与执行证据。

完整接口、校验入口及回滚见 [环境工具](environment-tools.md)。
