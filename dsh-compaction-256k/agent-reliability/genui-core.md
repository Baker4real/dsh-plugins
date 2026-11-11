# GenUI 核心入口

本节是常用规则的完整短入口，`skill({"name":"genui"})` 默认返回本节。完整能力用 `genui_reference({"section":"all"})` 读取上游全文，保留全部内容；`section="core"` 返回本节。需要详细字段或示例时，按下面的条件调用 `genui_reference` 读取对应 section，再写规格。相对文档路径继续以工具返回的原始 resourceBase 为基准。

## 按需读取

- `charts`：chart 多序列、echart preset/full option、plot 函数和参数动画。
- `interaction`：表单、聚合提交、测验、本地持久化与 action payload。
- `advanced`：svg、mermaid、diagram、scene3d、quiz 的完整字段与限制。
- `examples`：按内容选择版式及每种版式不适用的情况；`composition`：成套编排范式。
- `layout` / `display`：布局和展示组件的完整字段、媒体、图标及本地筛选。
- `computed`：输入驱动计算、插值与数值引用；`map`：地点选择和内联路线。
- `mapping` / `rich-text` / `rules`：内容映射、富文本和完整使用规则。还可用原文的唯一标题或 `#anchor` 读取一个章节及其子章节。未知或重复标题会报错，改用 `all` 查看实际标题。

## 输出与语言

所有用户可见文案沿用用户明确指定的语言，否则沿用当前对话语言；包括正文、标题、标签、选项、解释和图注。示例语言不改变对话语言。JSON 键、type、ID、action 保持协议原样；元占位符必须替换为实际内容。

UI 写在回答正文的 `dsh-ui` 围栏内，围栏正文是一份严格 JSON 对象，形如 `{"title":"标题","gap":14,"items":[{"type":"text","content":"正文"}]}`。开头语言标记只写 dsh-ui，收尾独占一行。围栏只出现在回答正文，思考块里的 UI 不渲染；一闭合即渲染。工具行卡片可用 `render_ui`，内联回答用围栏。

当结构能帮助理解时直接用 UI。≥3 条并列要点用 list；数字对比用 table；指标、进度、状态用 stat/progress/badge；步骤用 steps/timeline；流程和架构用 diagram/mermaid；单条结论或风险用 callout；代码、变更、配置用 code/diff/json；趋势或占比用 chart/echart。纯问答、一句话能说清的事或用户明确不要 UI 时用文字。

一份信息只表达一次，一个主题选一个主组件，一条回答只有一个视觉焦点。默认不套卡片；card 用于并排项、数据对象或统一底色的风险清单。先按内容选择编排，避免复用固定骨架。hero 一条回答最多一个；grid 子节点可用 span 做宽窄混排，章节切换用带 label 的 divider。主题跟随宿主，只有颜色确实携带语义时才指定 palette 或 accent。

## 验证与资源边界

发出前检查 JSON 括号配对、引号转义、无尾逗号，根对象最后一个字符为 `}`。每个组件节点必须有字符串 type；字段名照契约写。错误字段可能使组件被丢弃，结构错误可能使围栏退化为代码块。

spec ≥3 个组件、包含 table、任一组件接近资源上限，或字段不确定时，先调用 `validate_dsh_ui`，spec 传实际准备发出的 JSON 文本。`next=fix_and_revalidate` 时按诊断修正并重验；`next=emit_fence` 时发已验证规格；`next=emit_repaired_fence` 时照抄 repaired_json。若返回 native_fence_json，发这个确切 JSON，保留原生投影。`warning=unknown_field` 修字段后重验；`warning=block_markdown` 按 replacement 改为结构节点并重验。≤2 个简单组件且未接近上限可跳过验证。

整棵树 ≤200 节点、嵌套 ≤8 层；单个 table ≤50 行、≤12 列，list ≤50 项，file-tree 每层 ≤50 节点，tabs ≤12 页，accordion ≤24 项。超长内容拆成多个组件并验证，别依赖静默截断。一条回答通常 3-8 个组件，数量服从信息需要；hero 只用一个，scene3d 的 mesh 1-5 个，plot 指定合理 xMin/xMax。svg 文档最多 12000 字符，超限精简或拆分后重验。

## 常用字段

下列代码是字段样例，省略号代表实际文案。组件节点一律带 type，字段名不能按直觉改写。

- text：`{"type":"text","content":"...","size":"body"}`；size 可用 display/h1/h2/h3/body/muted/caption，align 为 left/center/right。
- row / col：`{"type":"row","items":[],"gap":12}`；row.justify 可设 center，col.width 为 1-100。grid：`{"type":"grid","cols":2,"items":[]}`，子节点用 `"span":2`。
- card：`{"type":"card","title":"...","items":[],"flat":true}`；tone 为 info/success/warning/danger。divider 用 label；hero 用 title/subtitle/value/label。
- list：`{"type":"list","items":[{"title":"...","desc":"..."}]}`；也可用字符串数组。table：`{"type":"table","columns":["项目","结果"],"rows":[["...","..."]]}`。
- keyvalue：`{"type":"keyvalue","pairs":[{"key":"...","value":"..."}]}`；stat：`{"type":"stat","label":"...","value":"..."}`。
- progress：`{"type":"progress","label":"...","value":70}`，value 为 0-100；badge 用 label 和 tone。
- callout：`{"type":"callout","tone":"info","content":"..."}`，tone 为 info/success/warning/error，正文是 content。
- steps：`{"type":"steps","steps":[{"title":"...","desc":"..."}]}`；timeline：`{"type":"timeline","items":[{"title":"...","desc":"...","time":"..."}]}`。
- file-tree：`{"type":"file-tree","items":[{"name":"...","type":"file"}]}`，目录记录 type 为 dir，可有 children。
- code：`{"type":"code","lang":"js","code":"..."}`；json：`{"type":"json","value":{}}`；diff：`{"type":"diff","diffs":[{"path":"...","oldText":null,"newText":"..."}]}`；copy 用 text。
- image 用 src/alt/caption；audio/video 用 src/alt。媒体仅使用可访问的 http(s) 或同源相对地址，不使用 file/data/javascript。图片组用 image-group.items，轮播用 carousel.items，详情读 display/layout。
- chart：`{"type":"chart","kind":"bars","data":[{"label":"...","value":1}]}`；kind 为 bars/line/donut，≤8 点优先 chart。多序列、缩放、大数据先读 charts；series[].data 是 label/value 对象数组。
- tabs：`{"type":"tabs","tabs":[{"label":"...","items":[]}]}`；accordion：`{"type":"accordion","items":[{"title":"...","items":[]}]}`。

文本字段支持行内 `code`、加粗、高亮、链接与公式；JSON 的反斜杠须转义，换行用 `\n`。HTML 不解析。text.content、callout.content、list 项、keyvalue 值、table 单元格内只放行内富文本；Markdown 表格改为 table，代码围栏改为 code，变更用 diff，结构化数据用 json。可粘贴命令按用户实际 shell 提供完整可执行内容。

数据多时用带 id 的 input/select 绑定 table/list 的 filter，按需加 filterColumn；表格排序、展开详情、复制导出均为本地能力。只给真实可执行动作加按钮，不放装饰性动作。

## 本地交互与秘密禁令

UI 自己能做的判卷、重置、展开、选择、排序、筛选一律本地即时完成，零模型往返。action 只用于生成内容、执行工具或需要模型建议的操作；button 没有 action 会禁用。模型收到 `[genui-action]` 后才处理外部动作并重渲染相应 UI。

不得索取或生成密码、API Key、访问令牌、恢复码等秘密输入；遇到此类需求拒绝并解释。表单中也不收集这些信息。

常用表单：input 用 label/inputType/value/id，inputType 为 text/email/color/number；select 用 options/selected/id；textarea 用 label/rows/value/id；slider 用 min/max/step/value/id；switch 用 checked。带 id 的值会保存并进入 submit 的 fields。输入失焦只有值改变才触发 action，input 回车、textarea 的 Ctrl/Cmd+Enter 可提交。

聚合选择：radio 用 label/options/group，checkbox 用 label/group/checked。同组选择先保存在本地。submit 用 label/action/groups；groups 列出本 block 中需要完成的 radio.group、checkbox.group 或字段 id。radio 需已选、checkbox 组需至少一项、字段值 trim 后非空；非本地判卷提交一次回传 answers/fields/total/answered。

测验：每题一个 radio，唯一 group，加 answer（正确下标或标签）与 explanation；最后一个 submit 的 groups 列全题号。纯 radio 范围有答案且没有额外待发状态时本地判卷，换题或建议才需要模型。单题可用 quiz。状态按会话和内容指纹持久化：相同内容重渲染保留状态，新内容重置。

## 扩展能力仍可用

完整词汇还包含 avatar、breadcrumb、icon、blocks、arrow、link、svg、mermaid、diagram、scene3d、quiz、plot、echart、map。用到这些能力时读对应 section 的原始契约；图标名单与其他相对文档从原始 resourceBase 读取。链接只用有效 http(s)/mailto 或宿主支持的本地文件链接；缺少 href 时是普通文本。

高级图形使用白名单数据，不执行 JavaScript。computed 支持声明计算字段与插值；map 支持离线坐标地点和路线，不代替真实导航核验、不请求定位权限、不在 JSON 中放凭据；各自详情由同名 section 提供。

面板用根属性 `panel:true`，原地更新；`append:true` 追加，上限 200 节点和 200 次追加，满后替换重建。面板来的 action 只回一个 panel:true 围栏与至多一行简短确认。普通围栏的交互状态由宿主持久化，不另造重复状态协议。
