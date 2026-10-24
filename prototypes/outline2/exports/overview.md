<!-- 由 prototypes/outline2/outline.py export 生成（第 33 个提交）。真相源是 data/log.jsonl，不要手改。 -->

# 大纲总览

## p · NarraFork

- [p/Pa320SYM] 设计决策
  - [p/7QQgsP3M] 这一页记录大纲系统的设计决策。已确认的决策带着负责人在对话里的原话作为证据；建议还是「假设」，等负责人确认。详细论证见 docs/OUTLINE_KNOWLEDGE-DESIGN.md §17（决策记录）。
  - [p/aQdrRFwd] D1 D1 默认直写：每次写入都带来源、可以撤销；探索 fork 的写入进层
    - [p/cSRo6HMn] D1a 例外（删除或移动团队之外的人写的块、单次改动超过 50 个已有块）自动转成提议，不打断 agent
  - [p/PeiyVKZE] D2 D2 知识过期默认在读取时复核；批量复核由用户点按钮触发；后台复核默认关闭
  - [p/OjBAfwCV] D3 D3 共享空间历史永久保留，会话空间历史随会话；管理员可以彻底清除；被引用的版本不能删
  - [p/iMIREuDd] D4 D4 时间机器按当前权限显示历史
  - [p/74dzXAGs] D5 D5 数据库是唯一真相源；永远不以 markdown 文件为真相源，永远不与 Obsidian vault 双向同步
  - [p/oyRkMECT] D6 D6 支持多人实时协同编辑同一个块
    - [p/NEN9Br1I] D6a 选型：按页建实时会话，一页一个 Y.Doc，块正文是其中的 Y.Text；结构由服务端排序；agent 按读取版本三方合并
  - [p/UX1YUbm4] D7 D7 embedding 与 rerank 从模型目录配置，支持 API 与 OpenAI 兼容的本地端点；没配置时退化为 FTS
  - [p/1byjKamb] D8 D8 知识库空间默认走审核（层即提议），可以按空间改成直写
  - [p/YjEt8WXX] D9 D9 会话的读权限取所有驱动者权限的交集
  - [p/BG0a5PpL] D10 D10 向量初版存成 BLOB，在 db-worker 里暴力扫描，不引入原生扩展
  - [p/4Z0d9qlG] D11 D11 自研大纲编辑器，建在 ProseMirror 视图层上；块模型是真相，编辑器文档只是投影
    - [p/D0h4UHSk] 不用「每块一个编辑器」作为主架构
  - [p/I6StRgTN] D12 D12 多 agent：图谱是黑板；委派即建任务；角色由任务推导；开始做即领取；验收默认关闭
    - [p/nFdzmREY] 第二版（D18）：去掉验收关口，完成后通知管理者，不满意可以重开；试用里 3 次验收全部原样通过
  - [p/aYM78wgu] D13 D13 计划分草稿和已批准两档，由写计划的人声明；已批准的计划要改先停下汇报；agent 可以在权限内批准，后果落到责任人头上
    - [p/rDUGYfqZ] 第二版（D18）：做法从「两档 + 骨架 + 契约」改为一个「锁定」开关，锁定后的改动先交给锁定人确认
  - [p/YRVOALjs] D14 D14 计划模式重做：计划就是任务子树，审批时选择草稿或已批准，计划文件退役
    - [p/gUgKSWlV] 计划不再是一段 markdown
  - [p/4HXBJkws] D15 D15 计划结项：系统分拣、agent 提炼进主题页；计划归档并钉在完成那一刻；用「出处」双向追溯
  - [p/CZyp6nnF] D16 D16 系统要支持派「没有什么约束」的专注 agent 集中攻坚，由遵循规则的协调 agent 帮它们记账、处理规则
    - [p/QSWtw144] D16a 专注 agent 只拿到普通语言写的任务说明，不知道大纲、地址、角色和规则；它交一份报告就结束
    - [p/oYaXx3vw] D16b 协调 agent 把报告翻译成大纲上的东西：状态、证据、结论、遗留、提议；以专注 agent 的身份代记，并留下自己的名字 ‹不成立：第一版标为否定›
      - [p/Vgac6c7S] 复核：不成立。第二版取消（D18）：子代理默认不碰大纲，由派它的会话用自己的名义记账，不再有协调者模式和代记
    - [p/ZZkZIZOE] D16c 「无约束」指不背大纲协议，不是不受安全约束：工具权限、行为边界照旧由系统强制
  - [p/S7dMgVAI] D17 D17 一个会话能同时管多个工作区（多台设备上的目录、多个仓库）；agent 在全局的大网上有几个「泡」作为注意范围，泡外的内容也可以适当查看；主 agent 或人批准下级改变范围
    - [p/F6n8ISQG] D17a 范围是会话空间里的一页，泡是这页上的「涉及」链接，级别（关注、修改、执行）和期限写在链接上，不新增概念；范围是权限之内再圈出的注意力与行动边界，不是权限 ‹不成立：第一版标为否定›
      - [p/H55kyLHe] 复核：不成立。第二版取消（D18）：关注范围存在会话上，不再是一页大纲；没有级别
    - [p/AJSRsINT] D17b 泡外可读可搜，标「范围外」并记下来给上级看；泡外写入自动转成扩大范围请求，附上那次操作；缩小范围、自己加「关注」都不需要批准 ‹不成立：第一版标为否定›
      - [p/isEhqvEW] 复核：不成立。第二版取消（D18）：关注范围只管注意力，不设写入关卡；试用里 3 次扩大范围请求全部原样通过
    - [p/v8ZWaFWs] D17c 扩大范围沿创建链找第一个能转授的上级批，都不行就由人批；工作区的「执行」只有人或自己就有这一级的上级能给；期限从批准时算起
      - [p/6ymZEpQq] 复核：需要改写。第二版只保留工作区这一半：给工作区的执行权限由派它的会话或人给，生产设备一律人确认，期限从确认时算起
  - [p/SEK5MhWU] D18 D18 按需求清单收缩概念：六个概念（块、任务、依据、空间、历史、待确认），agent 和人各三条规则，关口只留少数几种，每道关口统计原样通过率

- [p/BUvPjg55] 现状：spec://
  - [p/sqzCCSvC] 2026-10-23 对 main @ 7c5170d7 的盘点。每条结论都锚在代码上，main 变了就会存疑。
  - [p/5SbJBOHq] 每个叙述者一个 spec 命名空间（narrator_id 唯一）
  - [p/nxoITrqe] fork 时子会话的文件指针直接引用父会话的修订行，修订行随父会话的命名空间级联删除；父会话被硬删后，子会话的文件会悄悄消失
  - [p/BYer0yuP] 回退会话时 spec 内容不跟着回退：只把 spec 修订的来源消息置空
  - [p/GGLDhXV9] tasks.json 最多 100 条，任务以正文的 hash 为身份，改一个字就成了删旧建新
  - [p/iZyoacoR] 任务摘要默认每 15 次工具调用注入一次
  - [p/CEIo4QC5] spec 上的 Grep 是把全部文件读出来跑正则，没有索引
  - [p/5nB0TYwk] [x] 核实：在 SpecMarkdownEditor 里编辑含表格的 spec 文件并保存，表格会不会丢；属实就给出修复方案（来自 Q6 调研的顺带发现 [[p/f3TO9Yre]]） @agent:w-table
    - [p/wvzYm9E3] 专注 agent agent:w-table 的报告（核实 SpecMarkdownEditor 丢表格）
      - [p/Vb6nVWye] 结论
        - [p/2zgEKypO] **属实。** 在 Spec 面板里打开任意含 GFM 表格的非 tasks 文件，随手改一个字再保存，整张表格（表头加所有行）会从文件里删掉，其余内容保留。表格在编辑器里本来就显示不出来，用户保存前看不到它。
        - [p/YBQH5ZDL] 补充三点：
        - [p/oDHHbLTB] 原推断说"没有对应节点的语法一律直接丢弃"，这只部分成立。表格、HTML 注释、只含 `<img>` 的 HTML 块确实整段消失；其他语法是降级或被改写：图片只剩 alt 文字，HTML 标签被剥掉但文字留着，任务列表丢掉复选框和勾选状态，脚注被改成一个坏链接。另有一批语法渲染结果不变，但源文本被改写了（`snake_case` 变成 `snake\_case`，`&` 变成 `&amp;` 等）。
        - [p/fr50e2nC] 只打开不改不会写入。脚本里打字前 onUpdate 一次都没触发过；必须先有一次编辑，再点保存或按 Ctrl/Cmd+S。
        - [p/ZDfuF7Wr] 被覆盖的旧内容还在数据库里，就是 `spec_file_revisions` 里的上一条 revision。但现在没有任何 UI 或 API 能查看或恢复它。
      - [p/pMge42gO] 怎么复现的
        - [p/t6RBpvCK] **位置**：`/tmp/claude-0/-home-user-NarraFork/13582635-c8be-5e3d-9f41-f14f8cb5ad58/scratchpad/w-table/`。仓库里没有 node_modules，所有包都装在这个目录；仓库文件没动过。
        - [p/8SLWJ0hc] **版本（与 `bun.lock` 一致，装完逐个核对过）**
        - [p/20W60wzo] `@tiptap/core`、`@tiptap/pm`、`@tiptap/starter-kit`、`@tiptap/markdown`、`@tiptap/extension-link` 都是 3.27.1。
        - [p/liTQlzLF] `@tiptap/markdown` 用的是它自己嵌套的 `marked@17.0.6`（`bun.lock:2631`），不是根目录的 18.0.7。
        - [p/DbsNTucD] `prosemirror-model@1.25.9`、`prosemirror-view@1.42.0` 等全部用 `overrides` 钉死。
        - [p/mqeMO7Lt] DOM 用 `happy-dom@21.0.4`（通过 `@happy-dom/global-registrator`）。它提供 `window.DOMParser`，所以 HTML 走的是浏览器里那条分支。linkedom 也装了，但没用上。
        - [p/REdNcFr5] 运行时是 bun 1.4.3。
        - [p/LfwuwOOR] **脚本**
        - [p/DCMRTpty] `harness.ts`：照 `frontend/components/narrator/spec/SpecMarkdownEditor.tsx:43-69` 原样建编辑器：
          - [p/HMGS5CEd] extensions 一致：`StarterKit.configure({ link: { openOnClick: false } })` 加 `Markdown.configure({ indentation: { style: "space", size: 2 } })`；
          - [p/Rw9GsQDb] 用 `contentType: "markdown"` 加载内容，`onUpdate` 里调 `getMarkdown()`；
          - [p/GF2L0uB2] 照 `:64-69` 再用 `emitUpdate: false` 执行一次 `setContent`；
          - [p/O71Qxq3l] 然后在第一个文本块末尾插入一个 `X` 模拟打字，记下 onUpdate 交给 onChange 的字符串。这个字符串就是 SpecPanel 会 PUT 出去的内容。
          - [p/SDyzyWEd] 判断"渲染是否变了"用的参照渲染器照搬 NarraFork 自己的 `MarkdownContent` 管线：react-markdown 10.1.0 的做法，加 remark-gfm 4.0.1 和 remark-math 6.0.0；raw HTML 和 react-markdown 一样转成文本。
        - [p/sw3eesWi] `cases.ts`：41 个样例。
        - [p/fBVVGA2A] `repro.ts`：用基线配置跑全部样例。
        - [p/WmVkJ5wT] `idempotency.ts`：连续往返三次，看结果会不会收敛。
        - [p/YJpjW7Oa] `realistic.ts`：一篇典型的设计笔记。
        - [p/6ENM8iHJ] `fix.ts`：加 TableKit 等扩展后的对比，另含 6 个表格边界样例。
        - [p/8dx7fsnH] `latest/`：同一套脚本，装的是 Tiptap 3.32.0。
        - [p/n5ZxclQZ] `headless.ts`：完全不提供 DOM，跑同样的往返。
        - [p/HN69yRq1] `guard-cost2.ts`、`lexer-cost.ts`、`remark-cost.ts`：测防丢检查的耗时。
        - [p/BD71avTm] 输出存档：`repro-output.txt`、`fix-all-output.txt`、`latest/fix-all-3.32.txt`。
        - [p/oi88TwmE] **命令**
        - [p/hBB2eMLz] ```
          cd /tmp/claude-0/-home-user-NarraFork/13582635-c8be-5e3d-9f41-f14f8cb5ad58/scratchpad/w-table
          bun install
          bun run repro.ts                          # 全部样例；也可以 bun run repro.ts table-basic 只跑一个
          TYPE_AT=text bun run repro.ts task-list   # 在任务行的文字里打字
          bun run realistic.ts
          bun run fix.ts table+task+imageinline
          cd latest && bun install && bun run fix.ts table+task+imageinline
          ```
        - [p/b37YcyvG] **关键输出**
        - [p/tVts8DAP] `LOAD` 是打开后直接 `getMarkdown()` 的结果；`SAVED` 是打一个 X 之后 onChange 收到的内容。
        - [p/AxQuc6vV] ```
          === [table-basic] GFM 表格（夹在标题和段落之间，含对齐、行内代码、粗体）
          IN   : "# 方案对比\n\n| 方案 | 优点 | 缺点 |\n| --- | :---: | ---: |\n| A | 快 | 贵 |\n| B | `便宜` | **慢** |\n\n表格后的段落。\n"
          LOAD : "# 方案对比\n\n表格后的段落。"
          SAVED: "# 方案对比X\n\n表格后的段落。"
          parsed blocks=[heading,paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          
          === [table-only] 整份文件只有一个表格
          LOAD : ""          （编辑器里是一个空文档）
          SAVED: "X"
          ```
        - [p/1OnRsWwX] `realistic.ts` 用的是一篇含"方案对比"表的设计笔记，保存结果从 286 字符变成 186 字符：
        - [p/99k6L4re] ```
          ## 方案对比
          
          ## 步骤
          ```
        - [p/SGTS9hIh] "方案对比"一节下面原本是一张表，列着 A、B 两个方案和"✅ 采用"的结论。保存后整张表都没了，只剩小节标题。`headless.ts` 完全不给 DOM，结果也一样（`"# 方案对比\n\n表格后的段落。"`）。
        - [p/yj8Rv7K5] **原因**（以下源码都在上面目录的 node_modules 里）：
        - [p/V64VIazj] marked 解析出的 `table` token 只有 `type,raw,header,align,rows` 这几个键，没有 `tokens`。
        - [p/895ALT9p] StarterKit 里没有任何扩展处理 `table`，于是走到 `@tiptap/markdown@3.27.1 src/MarkdownManager.ts:920-925` 的兜底分支：有子 token 就解析子 token，否则 `return null`。整张表就在这里被扔掉了。
        - [p/5FU4W3sv] `getMarkdown()` 只是把编辑器里的 JSON 再序列化一遍（`src/Extension.ts:185-187`），而文档里早就没有表格了。
        - [p/Ron3SWq1] 其他语法的结果也出自这几处：
          - [p/99lSqvVt] `:803-805`：不认识的行内 token 只保留子 token，所以图片只剩 alt 文字。
          - [p/yRBrVuVU] `:939-960`：认识的 HTML 交给 `generateJSON`，按 schema 剥掉标签；不认识的保留为原文。
          - [p/pm99EFzB] `:1091-1114`：所有文本先编码 `& < >`，再转义 `` \ ` * _ [ ] ~ ``。
          - [p/dVweG48b] `@tiptap/core src/utilities/htmlEntities.ts:7-26`：解码只认 `&lt; &gt; &quot; &amp;` 四个实体。
      - [p/wx6GaQ3w] 编辑器的使用路径
        - [p/PSY9inYA] 入口与默认视图
          - [p/sVaoAIrh] SpecPanel 挂在三个地方：
            - [p/YSD1dAcZ] dock 面板：`frontend/components/narrator/dock/panels.tsx:614`
            - [p/AnGK8Bn3] 叙述者面板内嵌或移动端抽屉：`frontend/components/narrator/NarratorPanel.tsx:3749`
            - [p/WWHdV89f] 独立窗口：`frontend/components/window/StandalonePanelWindow.tsx:263`
            - [p/4Cjwn9Tp] 聊天里"打开某个 spec 文件"的入口（`NarratorPanel.tsx:2079` 调 `revealSpecFile`，`SpecPanel.tsx:181-184` 接收）也是切到这个面板的对应标签。
          - [p/9kOnG468] 面板默认选中 `spec://tasks.json`（`SpecPanel.tsx:55,61`），显示的是任务看板，不经过 Markdown 编辑器。
          - [p/mS7LuBTk] tasks.json 以外的每个标签都只能用 `SpecMarkdownEditor` 查看和编辑（`SpecPanel.tsx:386-394`）。没有源码模式，也没有源码/预览切换。
            - [p/RIkk8KnN] 代码里其实有一个只读预览分支（`SpecPanel.tsx:324-327`，用 `MarkdownContent`），条件是 `!uiEditable`（`:98`）。
            - [p/Z8u0pmIu] 但内置文件全部是 `uiEditable: true`（`server/services/spec-vfs-service.ts:54-64`），非内置文件恒为 true（`:157-161`），所以这个分支现在走不到。
          - [p/wNzwaSHj] 受影响的文件：
            - [p/XvHA3wiR] `spec://index.md`；
            - [p/QoGhCC4r] `spec://behavior_fence`：没有扩展名的纯文本，内容会原样注入模型提示（`server/services/spec-reminder.ts:105-114`）；
            - [p/YBavA6Qu] agent 用 Write 建的任何 `spec://` 文件。路径允许任何扩展名（`server/lib/spec-uri.ts:42-44`），所以 `.json`、`.txt`、`.yaml` 也会被当成 Markdown 打开。
        - [p/UXrh4bzV] 触发条件
          - [p/BR3f8YOn] 任何改动文档的操作都会触发 `onUpdate`，进而调用 `onChange(editor.getMarkdown())`（`SpecMarkdownEditor.tsx:56-59`）：打字、工具栏加粗、撤销、重做都算。
          - [p/CSxLcwxQ] `handleContentChange` 把重新序列化出来的整份 Markdown 存进 `editContent`，并置 `dirty`（`SpecPanel.tsx:274-278`）。它不比较内容是否真的变了，所以打一个字再删掉也算 dirty。
          - [p/fMEmM5Dq] 只有 dirty 之后，工具栏才出现保存按钮（`SpecMarkdownEditor.tsx:99-126`）；Ctrl/Cmd+S 也只在 dirty 时生效（`SpecPanel.tsx:258-266`）。
          - [p/rKdYL1IW] 刚打开、切换文件、重新加载时，都是用 `emitUpdate: false` 设置内容（`SpecMarkdownEditor.tsx:64-69`），不会置 dirty。脚本里所有样例打字前的 onUpdate 次数都是 0。
          - [p/2dG9cLei] 没有自动保存。带着未保存的改动切标签会弹确认框（`SpecPanel.tsx:155-172`）。
          - [p/GpCZYFyG] 所以"打开 → 随手改一个字 → 保存"就足以触发。
        - [p/CBwGJm2n] 保存路径
          - [p/SLsaUepr] `SpecPanel.handleSave`（`SpecPanel.tsx:200-241`）把 `editContent` 原样作为 content 发出，同时带上 `baseRevisionId` 和 `notifyAgent: true`。
          - [p/29coeqIe] 经 `useUpdateSpecFile`（`frontend/hooks/useSpec.ts:103-123`）和 `api.writeSpecFile`（`frontend/lib/api/spec.ts:61-74`），发出 `PUT /api/narrators/:id/spec/file`。路由挂载在 `server/app.ts:427`。
          - [p/DcIPbx8h] 路由在 `server/routes/spec.ts:155-256`：
            - [p/UD5ojCh4] 先用 `baseRevisionId` 做乐观并发检查，不一致返回 409（`:172-181`）；
            - [p/HvGpLez0] 再调用 `specVfsService.writeSpecFile(..., { createdBy: "user", actor: "user" })`（`:183-187`）。
          - [p/22H8H49k] `server/services/spec-vfs-service.ts:209-293` 校验内容不超过 20 万字符、`index.md` 不为空（`:229-234`），然后调用 `knowledgeWriteStore.writeSpecFileRevision`。SQLite 实现在 `server/services/knowledge/sqlite-write-store.ts:1008-1038`：
            - [p/bR6XVJeW] 往 `spec_file_revisions` 插入一条新 revision，`parentRevisionId` 指向旧的那条；
            - [p/wHRjivZj] 把 `spec_namespace_files.revisionId` 指针切到新 revision。
            - [p/mdUP4AMp] spec 文件不落盘，只存在数据库里。
          - [p/X6RuvX61] 写完后广播 `spec_changed`，并通知叙述者（`server/routes/spec.ts:201-247`）；非 tasks 文件只带前 300 个字符的预览（`:227`）。叙述者正在工作时，这条通知会作为一条真正的 user 消息插进对话（`server/services/spec-edit-interject.ts:1-17`）。也就是说，表格消失会以"用户编辑了这个文件"的名义告诉 agent。agent 会不会因此以为用户有意删了表，没有验证。
      - [p/M8CfmjL0] 影响范围
        - [p/DhGZs3oB] **仓库里没有 spec 文件实体。** spec 存在数据库里，仓库只有内置默认内容，都不含表格：
          - [p/WLLE3oNB] `index.md` 的默认模板（`spec-vfs-service.ts:33-41`）；
          - [p/TqzEQQRQ] 空的 `behavior_fence`；
          - [p/sPzUuJG3] 没有任务的 `tasks.json`。
          - [p/jhnyvY6b] 这个环境里也没有 `~/.narrafork` 数据库，抽样不到真实的 spec 内容。
        - [p/BUF4dTlN] **替代样本：仓库里 agent 写的 Markdown。**
          - [p/AYroXQcQ] git 跟踪的 `.md` 文件共 71 个（不算 `prototypes/`），其中 48 个含 GFM 表格。
          - [p/dRiozb53] `docs/` 顶层 29 篇文档中 23 篇含表格，如 `docs/BLOCK_STORAGE-DESIGN.md` 有 49 张，`docs/OUTLINE_KNOWLEDGE-DESIGN.md` 有 28 张，`docs/DYNAMIC_SPEC_TEAM_TASKS.md` 有 13 张。
          - [p/rfNybaDi] 当前克隆能看到的历史里，改过 `docs/*.md` 的提交有 70 个，其中 54 个带 Claude 署名。
        - [p/EX1HimM8] **agent 被引导往 spec 里写笔记。** 系统提示让 agent 把复杂工作的规划/设计笔记写进 `spec://index.md` 或另建的 `spec://*.md`（`server/lib/prompts/system-reminders.ts:59`、`:97`）。前端用来模拟"典型模型输出"的语料里也有好几张表（`frontend/components/narrator/mock/mock-stream-corpus.ts:153-181`）。
        - [p/bpQlvsyF] **粗略判断**：agent 写的设计笔记里出现表格很常见（方案对比、文件清单、风险矩阵之类），但真实比例没有数据。
        - [p/ivaQbtDu] **只有用户通过 Spec 面板保存才会丢。** agent 用 Write/Edit 写 spec 不经过这个编辑器，不受影响。
        - [p/NC4bbEbP] **以后会更多。** `docs/DYNAMIC_SPEC_TEAM_TASKS.md:525-528` 规划了 `spec://team/tasks.md`、`spec://designs/*`、`spec://notes/<member>/*`，Markdown 类的 spec 文件只会增加。
        - [p/Bedn55p1] **压测**：用 20 万字符（上限 `MAX_SPEC_FILE_CHARS`，`spec-vfs-service.ts:24`）的文档往返一次，结果从 200,000 字符变成 97,633 字符，少掉的一半是表格。
      - [p/3Rr40324] 其他会丢或被改写的语法
        - [p/j4WihCHn] "输出"是打开后不改、直接 `getMarkdown()` 的结果，也就是保存时会写回的内容（不算用户打的那个字）。`\n` 表示换行。"渲染"指用 NarraFork 的 MarkdownContent 管线渲染前后是否一致。41 个样例里有 19 个渲染变了。
        - [p/2ruU1ntQ] | 语法 | 输入 | 输出 | 是否丢失 |
          | --- | --- | --- | --- |
          | GFM 表格 | `# 方案对比\n\n\| 方案 \| 优点 \| 缺点 \|\n\| --- \| :---: \| ---: \|\n…\n\n表格后的段落。` | `# 方案对比\n\n表格后的段落。` | **丢失**（整张表消失） |
          | 无首尾竖线的表格 | `前文\n\na \| b\n--\|--\n1 \| 2\n\n后文` | `前文\n\n后文` | **丢失** |
          | 整份文件只有表格 | `\| key \| value \|\n\| --- \| --- \|\n\| a \| 1 \|` | `""`（编辑器里是空文档） | **丢失** |
          | 列表项里的表格 | `- 第一项\n\n  \| x \| y \|…\n\n- 第二项` | `- 第一项\n- 第二项` | **丢失** |
          | 图片（行内） | `见下图：![架构图](./arch.png "架构")` | `见下图：架构图` | **丢失**（只剩 alt 文字，地址和标题没了） |
          | 图片（单独成段） | `![流程图](https://example.com/flow.png)` | `流程图` | **丢失**（同上） |
          | 行内 HTML（kbd/sub/br） | `按 <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存，H<sub>2</sub>O，第一行<br>第二行` | `按 Ctrl+S 保存，H2O，第一行  \n第二行` | **标签丢失**（文字保留；`<br>` 变成硬换行，这一处等价） |
          | 行内 HTML（span/u/b） | `<span style="color:red">红字</span>，<u>下划线</u>，<b>粗</b>` | `红字，++下划线++，**粗**` | **样式丢失**；`<u>` 被改成非标准的 `++下划线++`（`@tiptap/extension-underline src/underline.ts:68-69`），NarraFork 和 GitHub 都会把加号原样显示出来；`<b>` 改成 `**` 是等价的 |
          | HTML 块 `<details>` | `<details>\n<summary>展开</summary>\n\n隐藏内容\n\n</details>` | `展开\n\n隐藏内容\n\n` | **结构丢失**（折叠效果没了，文字变成普通段落） |
          | HTML 块 `<div>` 包 `<img>` | `<div align="center">\n  <img src="logo.png" width="100">\n</div>` | `""` | **丢失**（整块消失） |
          | HTML 注释 | `段落一\n\n<!-- TODO: 补充风险评估 -->\n\n段落二` | `段落一\n\n\n\n段落二` | **丢失**（注释内容没了，原位置留下一个空段落） |
          | 脚注 | `结论见脚注[^1]。\n\n[^1]: 这是脚注内容。` | `结论见脚注[^1](这是脚注内容。)。` | **语义改变**：marked 把它当成引用式链接，脚注变成一个以脚注正文作 URL 的坏链接，定义行消失 |
          | 任务列表 | `- [ ] 待办一\n- [x] 已完成二` | `- 待办一\n- 已完成二` | **丢失**（复选框和勾选状态都没了）。另外文档结构不合法（listItem 里直接是文本），在这一行里打字会抛 `Called contentMatchAt on a node with invalid content`；这只在脚本里复现，浏览器里具体会怎样没验证 |
          | 任务项与普通项混排 | `- [ ] 待办\n- 普通项` | `- 待办\n- 普通项` | **丢失**（同上） |
          | 带下划线的普通文本 | `调用 snake_case 函数，修改 spec_vfs_service.ts 和 __init__.py` | `调用 snake\_case 函数，修改 spec\_vfs\_service.ts 和 **init**.py` | 等价改写：渲染相同，但源文本多了反斜杠，`__init__` 变成了 `**init**` |
          | 单个 `~` | `大约 ~5 分钟，路径 ~/project` | `大约 \~5 分钟，路径 \~/project` | 等价改写 |
          | 成对的单 `~` | `~删除~ 与 ~~删除~~` | `~~删除~~ 与 ~~删除~~` | 等价改写 |
          | 尖括号、`&` | `返回 Promise<void>，a < b && c > d，R&D` | `返回 Promise&lt;void&gt;，a &lt; b &amp;&amp; c &gt; d，R&amp;D` | 等价改写：在 NarraFork 里渲染相同，源文本变成了实体 |
          | 反斜杠、方括号、星号 | `C:\Users\dev\app.log`；`数组 [1, 2]，a * b * c` | `C:\\Users\\dev\\app.log`；`数组 \[1, 2\]，a \* b \* c` | 等价改写 |
          | HTML 实体 | `版权 &copy; 2026，不换行&nbsp;空格` | `版权 &amp;copy; 2026，不换行&amp;nbsp;空格` | **语义改变**：© 和不换行空格变成了字面的 `&copy;`、`&nbsp;` |
          | 数学公式 | `$a_b$`、`$$\nx_i^2\n$$` | `$a\_b$`、`$$\nx\_i^2\n$$` | **语义改变**：公式里多了 `\_`，KaTeX 不再把它当下标 |
          | YAML front matter | `---\ntitle: 设计\nstatus: draft\n---\n\n# 正文` | `---\n\n## title: 设计\nstatus: draft\n\n# 正文` | **结构被破坏**：变成一条分隔线加一个二级标题；第二次保存还会再变 |
          | `*` 和 `+` 列表 | `* a\n* b\n\n+ c` | `- a\n- b\n\n- c` | **语义改变**：两个列表合成一个松散列表；第二次保存还会再变 |
          | 从 3 开始的列表接 `1)` 列表 | `3. 三\n4. 四\n\n1) 一\n2) 二` | `3. 三\n4. 四\n5. 一\n6. 二` | **语义改变**：第二个列表被并进第一个并重新编号 |
          | 非 md 文件：JSON | `{\n  "key_name": [1, 2],\n  "nested": {"a": "*"}\n}` | `{\n  "key\_name": \[1, 2\],\n  "nested": {"a": "\*"}\n}` | **文件损坏**（不再是合法 JSON） |
          | 非 md 文件：YAML | `steps:\n  - name: build_app\n    run: bun run build` | `steps:\n\n- name: build\_app\nrun: bun run build` | **文件损坏**（缩进和结构都变了） |
          | behavior_fence 样例 | `- 只改 server/services/spec_vfs_service.ts，别动 *.test.ts\n- 回答使用中文 & 简洁` | `- 只改 server/services/spec\_vfs\_service.ts，别动 \*.test.ts\n- 回答使用中文 &amp; 简洁` | 渲染上是等价改写，但这个文件会原样注入模型提示，模型看到的是带转义的文本 |
          | 其余写法 | Setext 标题、`~~~` 围栏、`***`/`___`、`_斜体_`/`__粗体__`、引用式链接、`<URL>` 和裸 URL、4 空格嵌套、反斜杠硬换行 | 分别变成 ATX 标题、```` ``` ````、`---`、`*`/`**`、行内链接（定义行删掉）、`[url](url)`、2 空格、两个空格的硬换行 | 等价改写 |
          | 原样保留 | 段内软换行、连续空行、mermaid 代码块、`\*` 转义、`==高亮==`、`{#id}` | 只差文末换行或多出空行 | 不丢 |
        - [p/3KOy2DZo] 稳定性：front matter 和 `*`/`+` 列表在第二次保存时还会再变一次，其余样例第一次保存后就不再变化（`idempotency.ts`）。
      - [p/413AFrp5] 修复建议
        - [p/4sg92ex6] 修复前的低成本防丢（纯前端，不加依赖）
          - [p/60ZR7mPd] **加载时检测编辑器保不住的语法，检测到就不允许在所见即所得模式下保存。**
            - [p/07KK2jJk] 检测用 `marked.lexer` 即可。前端已经通过 `shared/pretext-layout/parse-markdown.ts:30` 打包了 marked，不需要新依赖。
            - [p/QbnxOjQK] 遍历 token，遇到以下任一种就标记：`table`、`html`、`image`、带 `task` 的 `list_item`、标签以 `^` 开头的链接定义（即脚注）、文件开头的 front matter。
            - [p/q7wNYNxP] 样例上的效果：
              - [p/2HzmH3f6] 标出了这几类全部 15 个样例；
              - [p/jRdrdhxj] 另外把 `Promise<void>` 当成 HTML 标了出来，算偏保守；
              - [p/k3mR4yoL] 漏掉的 4 个是数学公式、HTML 实体和两种列表合并，可以补几条正则，或者用第 4 条兜底。
            - [p/lFgswFrI] 耗时：20 万字符单独跑约 80ms。
            - [p/4SpFkuaG] 检测到之后显示提示条，比如"此文件含表格、HTML 等，在所见即所得模式下保存会丢失这些内容"。然后在 `SpecPanel.handleSave`（`SpecPanel.tsx:200`）和 Ctrl/Cmd+S（`:258-266`）里拦住保存，或者直接 `editor.setEditable(false)`。查看时改用现成的只读 `MarkdownContent` 分支（`SpecPanel.tsx:324-327`），它能正确渲染表格。
          - [p/qJxY2yZw] **加一个源码模式。**
            - [p/QWeUSCOc] SpecPanel 本来就把内容当字符串（`editContent`）保存。源码模式只需要一个等宽 `Textarea` 直接改 `editContent`，保存路径不用动，内容一个字节都不会被改写。
            - [p/ShOhQxfe] 检测到不支持的语法时默认进源码模式。
            - [p/YqNPSQql] 交互可以照文件编辑器已有的 raw / split / preview 三种模式来做（`frontend/components/narrator/file-editor/editor-mode-prefs.ts`）。
          - [p/s3Z1YthG] **非 `.md` 路径（包括 `behavior_fence`）默认用源码模式。**
            - [p/tsrKoYq6] JSON 和 YAML 经所见即所得保存一次就坏了。
            - [p/EBH2eNYM] `behavior_fence` 会原样注入模型提示，`\_`、`&amp;` 这类转义会直接进到 prompt 里。
          - [p/wJNSRN2Z] **可选的通用兜底：比较往返前后的渲染结果。**
            - [p/mIaOEOR1] 加载后马上执行一次 `getMarkdown()`，用 remark-gfm 分别渲染原文和往返结果，不一致就当作有损。
            - [p/qoGfDR3O] 样例上的效果：标出全部 19 个渲染变化的样例；其余 22 个都没报。这 22 个里，20 个确实只是等价改写；另外 2 个是 JSON/YAML 文件，按 Markdown 渲染看不出变化，但作为文件已经坏了。这种情况渲染比较抓不到，要靠第 3 条。
            - [p/cNi5cIBI] 耗时：5k–20k 字符单次渲染约 130–170ms；20 万字符约 1.8s，而比较要渲染两次。适合只对小文件做，或者放到空闲时做。
        - [p/QCLHsjlZ] 正式修复：加表格扩展
          - [p/j6wRCnqB] **能直接用，lock 里只多一个包。** `@tiptap/extension-table@3.27.1` 的 peer 是 `@tiptap/core` 和 `@tiptap/pm` 3.27.1，和锁定版本完全一致，也没有别的依赖。它需要的 `prosemirror-tables@1.8.5` 已经通过 `@tiptap/pm` 进了 `bun.lock`（`:2055`）。
          - [p/iZGY5EOq] **不需要额外配置 markdown 序列化。** 表格扩展自带 `parseMarkdown` 和 `renderMarkdown`（`@tiptap/extension-table src/table/table.ts:318-361`），`@tiptap/markdown` 会自动用上。建议配 `TableKit.configure({ table: { resizable: false } })`，因为列宽写不进 Markdown。
          - [p/ormDyYRc] **实测（`fix.ts`）**：在 3.27.1 上加 TableKit 后，4 个表格样例和那篇设计笔记都完整保留，渲染一致，第二次保存也不再变化，对齐标记保留。源码会被重排：各列补空格对齐，表格前后各多出一个空行。
          - [p/NQmqeYkp] **3.27.1 的表格序列化有两个缺陷**，3.32.0 上都已修好：
            - [p/xFgZjnQS] 单元格里转义过的竖线 `\|`（包括行内代码里的）写回时没有再转义。例如 `| a \| b | 或 |` 会变成 `| a | b | 或   |`，多出一列，"或"那一格被挤掉，而且每保存一次就再坏一点。
            - [p/cezEpH89] 单元格里的 `<br>` 会变成空格。
            - [p/MpgDWyYl] `latest/` 下实测 3.32.0：`| a \| b | 或   |` 原样保留，`<br>` 也保留。不加表格扩展时，3.32.0 的输出和 3.27.1 逐字相同，所以光升级解决不了问题。可选做法：
            - [p/eLEyBfLk] 把整套 `@tiptap/*` 一起升到 3.32.0。`InlineComposerEditor.tsx:38` 也用 StarterKit，升级后要回归一下输入框。
            - [p/7WAFsj3W] 或者留在 3.27.1，自己覆盖 Table 的 `renderMarkdown`，给 `|` 加转义。
          - [p/i5mPVCnU] **界面要补。** `@mantine/tiptap@9.5.1` 的 `styles.css` 里没有任何表格样式，RichTextEditor 也没有表格按钮（只有任务列表相关的按钮）。所以要在 `SpecMarkdownEditor.module.css` 里给 `.ProseMirror table/th/td` 加边框和内边距。增删行列的按钮可以后补，没有按钮也能改单元格里的文字。
          - [p/COrI2DV2] **顺手可以一起修的：**
            - [p/FD5YxDGN] 任务列表：`TaskList` 和 `TaskItem` 来自 `@tiptap/extension-list@3.27.1`。它已经在 `bun.lock`（`:703`）里，只是 `package.json` 没有直接依赖它。实测加上后，`- [ ]`/`- [x]` 完整保留，上面说的"任务行结构不合法、打字抛错"也一并消失。Mantine 有现成的 `RichTextEditor.TaskList` 按钮。混排的任务列表会变成松散列表，只是间距变了。
            - [p/fFMSpNeC] 图片：`@tiptap/extension-image@3.27.1` 必须配 `inline: true`。用默认的块级图片时，遇到行内图片（如 `见下图：![…](…)`）会生成不合法的文档，打字同样抛错。配了 `inline: true` 后，两种图片都原样保留。
          - [p/QXsBUcwF] **检测要长期保留。** HTML、脚注、front matter、数学公式、HTML 实体在所见即所得里没有对应的表示，加了扩展也照样会丢：3.32.0 加上全部扩展后，仍有 12 个样例渲染有变化。所以上一节的检测不能拿掉。
          - [p/IPvYOpyh] **回归测试可以不依赖 DOM。** `headless.ts` 用 `element: null` 在纯 bun 环境里跑出了同样的结果，所以表格、任务列表、图片可以写成普通单元测试；只有 HTML 相关的需要 `window.DOMParser`。
        - [p/z00C6zMW] 已经受损的数据
          - [p/DsuAFN9U] 每次保存都是插入一条新 revision，旧内容仍在 `spec_file_revisions` 里，由新行的 `parent_revision_id` 指向（`sqlite-write-store.ts:1008-1026`）。
          - [p/z6fPr7Qp] 但现在没有查看或恢复历史的 UI 或 API。
          - [p/TP5k4lrr] 可以写一个离线排查脚本：找出 `created_by = 'user'`、父 revision 含表格分隔行、而本条不含的记录。按项目的主线程规则，这只能放在后台或离线跑，不能进请求路径。
      - [p/FhE50i6T] 需要人决定的点
        - [p/SqZsmypz] **Spec 文件以什么方式编辑。**
          - [p/uCBhzxAK] 方案一：继续以所见即所得为主，补上表格、任务列表、图片扩展，并长期保留检测。
          - [p/NtnalZNd] 方案二：改成源码优先、所见即所得可选，类似文件编辑器的 raw/split/preview。
          - [p/91q7hjiH] 关键考虑：agent 读写 spec 靠精确字符串匹配（Edit 的 `old_string`），而所见即所得一定会改写字节。比如 `spec_vfs_service.ts` 存回去会变成 `spec\_vfs\_service.ts`，agent 再拿原文去 Edit 就对不上了。
        - [p/sDWgp79M] **检测到不支持的语法时怎么处理。** 可以禁止保存，可以只读并提供源码按钮，也可以只弹确认框。确认框最弱，用户很容易直接点过去。
        - [p/GYtrC1zO] **Tiptap 版本。** 整体升到 3.32.0（修好单元格竖线转义，但要回归输入框），还是留在 3.27.1、自己补 `|` 的转义。
        - [p/CDdQQnjY] **非 `.md` 文件和 `behavior_fence` 是否一律改用纯文本编辑。**
        - [p/ZkRmkA2c] **数据恢复。** 要不要做 spec 的历史查看和恢复功能；要不要先离线排查一遍现有数据库里被 UI 保存吞掉表格的记录。
    - [p/HcVYDQev] 属实：在 Spec 面板里打开含 GFM 表格的非 tasks 文件，随手改一个字再保存，整张表格（表头和所有行）会从文件里删掉，其余内容保留；表格在编辑器里本来就不显示，保存前看不到。只打开不改不会写入：加载、切换文件、重新加载都用 `emitUpdate: false` 设置内容；任何一次改动（打字、工具栏加粗、撤销）都会把整份重新序列化的 Markdown 存进 editContent 并置 dirty（不比较内容是否真的变了），之后点保存或按 Ctrl/Cmd+S 就写回，没有自动保存。实测 Tiptap 3.27.1：标题、表格、段落三块保存成只剩标题和段落，只有表格的文件保存成「X」，20 万字符的文档往返后剩 97,633 字符；不给 DOM 结果相同
    - [p/XuAmy5zV] 原因：SpecMarkdownEditor 只装了 StarterKit 和 Markdown 两个扩展，没有处理表格的扩展。marked 解析出的 table token 没有子 token，@tiptap/markdown@3.27.1 的 MarkdownManager.ts:920-925 兜底分支是「有子 token 就解析子 token，否则 return null」，加载时整张表就被扔掉了；getMarkdown() 只是把编辑器里的文档再序列化一遍（Extension.ts:185-187）
    - [p/48LIQZoc] 不只表格，但也不是「一律直接丢弃」（修正 [[p/s5RvMT7z]]）：整段消失的是表格、HTML 注释、只含 `<img>` 的 HTML 块；降级的是图片（只剩 alt 文字）、HTML 标签（剥掉、文字留下，`<u>` 变成非标准的 `++x++`）、任务列表（丢复选框和勾选状态）、脚注（变成以脚注正文作 URL 的坏链接）、front matter（变成分隔线加二级标题）、数学公式（多出 `\_`，不再是下标）、HTML 实体（`&copy;` 变成字面文字）；另有一批渲染不变、源文本被改写：`snake_case` 变成 `snake\_case`，`&` 变成 `&amp;`，`__init__` 变成 `**init**`。41 个样例里 19 个渲染变了；front matter 和 `*`、`+` 列表第二次保存还会再变
    - [p/mTbiTmRJ] 受影响的是 tasks.json 以外的所有 spec 文件：它们只能用 SpecMarkdownEditor 查看和编辑，没有源码模式。SpecPanel 里的只读预览分支（`!uiEditable` 时用 MarkdownContent）走不到，因为内置文件都是 `uiEditable: true`，非内置文件恒为 true。路径允许任何扩展名，agent 建的 .json、.yaml 也按 Markdown 打开，保存一次就不再合法；behavior_fence 会原样注入模型提示，`\_`、`&amp;` 这类转义会直接进 prompt。agent 用 Write/Edit 写 spec 不经过这个编辑器，不受影响
    - [p/jr2Sj3AY] 被吞掉表格的旧内容还在数据库里：每次保存都往 spec_file_revisions 插入一条新 revision，parent_revision_id 指向旧的那条，再把文件指针切过去。但 spec 的 API 只有列文件、读文件、读任务、清任务、重置、写文件，前端也没有历史视图，现在没法查看或恢复旧 revision
    - [p/MfSBwmQs] 表格消失会以「用户编辑了这个文件」的名义告诉 agent：UI 保存后会通知叙述者，它正在工作时这条通知作为一条真正的 user 消息插进对话，非 tasks 文件只带前 300 个字符的预览。agent 会不会因此以为用户有意删了表、照着继续改，没有验证
    - [p/45GeEso2] 修复：加 @tiptap/extension-table@3.27.1 就能保住表格。它的 peer 和锁定的 @tiptap/core、@tiptap/pm 版本一致，依赖的 prosemirror-tables@1.8.5 已在 bun.lock 里，lock 只多一个包；扩展自带 parseMarkdown 和 renderMarkdown，@tiptap/markdown 会自动用上。实测加 TableKit（建议 resizable: false，列宽写不进 Markdown）后，4 个表格样例和一篇设计笔记都完整保留、渲染一致、第二次保存不再变化，只是源码会补空格对齐列宽。任务列表（@tiptap/extension-list，已在 lock 里）和图片（@tiptap/extension-image，必须 inline: true）可以一起加；Mantine 的 RichTextEditor 没有表格样式，要在 SpecMarkdownEditor.module.css 里补。这几类不依赖 DOM，回归测试可以写成普通单元测试
    - [p/9K1u88rW] 留在 3.27.1 加表格扩展有两个序列化缺陷：单元格里转义过的竖线（包括行内代码里的）写回时不再转义，`| a \| b | 或 |` 变成 `| a | b | 或 |`，多出一列、「或」被挤掉，每保存一次再坏一点；单元格里的 `<br>` 变成空格。3.32.0 两处都修好了；但不加表格扩展时 3.32.0 的输出和 3.27.1 逐字相同，光升级解决不了丢表格
    - [p/93bNRxN4] 加了扩展也要长期保留「保不住的语法」检测：HTML、脚注、front matter、数学公式、HTML 实体在所见即所得里没有对应表示，3.32.0 加上全部扩展后仍有 12 个样例渲染有变化。低成本的检测用前端已经打包的 marked（shared/pretext-layout/parse-markdown.ts 在用）跑 lexer，遇到 table、html、image、任务项、脚注定义、开头的 front matter 就标记：样例上这几类 15 个全部标出，偏保守地多标了 `Promise<void>`，漏掉数学、实体和两种列表合并，20 万字符约 80ms。渲染比较兜底能标出全部 19 个渲染变化的样例，但 20 万字符单次渲染约 1.8 秒，也抓不到 JSON、YAML 被改坏
    - [p/72vz2mUB] 实际受损的 spec 可能不少，但没有数据：spec 只存在数据库里，这个环境没有数据库可抽样；替代样本是仓库里 agent 写的 Markdown，git 跟踪的 71 个 .md（不算 prototypes/）有 48 个含 GFM 表格；系统提示又让 agent 把规划和设计笔记写进 spec://index.md 或另建的 spec://*.md
    - [p/60fYKsDg] 协调者（agent:steward2）：报告挂在 [[p/wvzYm9E3]]，主要结论代记成上面 10 条断言（作者 agent:w-table，steward2 代记）。报告末尾「需要人决定的点」5 条建成提问，复核 Q6 的顺带发现 [[p/f3TO9Yre]]；这两处都在待定问题页，在我的范围外，分别转成了 CR2、CR3，等 agent:main 决定。复核意见：成立。w-table 没在真浏览器里点，用 happy-dom 和完全不给 DOM 两种环境照原样配置复现，结果相同：丢表格发生在 Markdown 解析阶段，和 DOM 无关。（verify 的 --note 没出现在 CR3 的操作里，所以记在这里）
    - [p/TmcWTdQF] 复现输出（Tiptap 3.27.1，41 个样例）
      - [p/f7GO5ZS2] ````
        window.DOMParser available: true
        
        === [table-basic] GFM 表格（夹在标题和段落之间，含对齐、行内代码、粗体）
        IN   : "# 方案对比\n\n| 方案 | 优点 | 缺点 |\n| --- | :---: | ---: |\n| A | 快 | 贵 |\n| B | `便宜` | **慢** |\n\n表格后的段落。\n"
        LOAD : "# 方案对比\n\n表格后的段落。"
        SAVED: "# 方案对比X\n\n表格后的段落。"
        parsed blocks=[heading,paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <h1>方案对比</h1><table><thead><tr><th>方案</th><th align="center">优点</th><th align="right">缺点</th></tr></thead><tbody><tr><td>A</td><td align="center">快</td><td align="right">贵</td></tr><tr><td>B</td><td align="center"><code>便宜</code></td><td align="right"><strong>慢</strong></td></tr></tbody></table><p>表
          render OUT: <h1>方案对比</h1><p>表格后的段落。</p>
        
        === [table-no-outer-pipes] GFM 表格（无首尾竖线）
        IN   : "前文\n\na | b\n--|--\n1 | 2\n\n后文\n"
        LOAD : "前文\n\n后文"
        SAVED: "前文X\n\n后文"
        parsed blocks=[paragraph,paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <p>前文</p><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><p>后文</p>
          render OUT: <p>前文</p><p>后文</p>
        
        === [table-only] 整份文件只有一个表格
        IN   : "| key | value |\n| --- | --- |\n| a | 1 |\n"
        LOAD : ""
        SAVED: "X"
        parsed blocks=[] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <table><thead><tr><th>key</th><th>value</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>
          render OUT: 
        
        === [table-in-list] 列表项里的表格
        IN   : "- 第一项\n\n  | x | y |\n  | - | - |\n  | 1 | 2 |\n\n- 第二项\n"
        LOAD : "- 第一项\n- 第二项\n\n"
        SAVED: "- 第一项X\n- 第二项\n\n"
        parsed blocks=[bulletList] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <ul><li><p>第一项</p><table><thead><tr><th>x</th><th>y</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></li><li><p>第二项</p></li></ul>
          render OUT: <ul><li>第一项</li><li>第二项</li></ul>
        
        === [image] 图片
        IN   : "见下图：![架构图](./arch.png \"架构\")\n"
        LOAD : "见下图：架构图"
        SAVED: "见下图：架构图X"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <p>见下图：<img src="./arch.png" alt="架构图" title="架构"></p>
          render OUT: <p>见下图：架构图</p>
        
        === [image-block] 单独成段的图片
        IN   : "![流程图](https://example.com/flow.png)\n"
        LOAD : "流程图"
        SAVED: "流程图X"
        parsed blocks=[text] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <p><img src="https://example.com/flow.png" alt="流程图"></p>
          render OUT: <p>流程图</p>
        
        === [inline-html-kbd] 行内 HTML：<kbd>/<sub>/<br>
        IN   : "按 <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存，H<sub>2</sub>O，第一行<br>第二行\n"
        LOAD : "按 Ctrl+S 保存，H2O，第一行  \n第二行"
        SAVED: "按 Ctrl+S 保存，H2O，第一行  \n第二行X"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <p>按 &#x3C;kbd>Ctrl&#x3C;/kbd>+&#x3C;kbd>S&#x3C;/kbd> 保存，H&#x3C;sub>2&#x3C;/sub>O，第一行&#x3C;br>第二行</p>
          render OUT: <p>按 Ctrl+S 保存，H2O，第一行<br> 第二行</p>
        
        === [inline-html-span] 行内 HTML：<span style>/<u>/<b>
        IN   : "<span style=\"color:red\">红字</span>，<u>下划线</u>，<b>粗</b>\n"
        LOAD : "红字，++下划线++，**粗**"
        SAVED: "红字，++下划线++，**粗X**"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <p>&#x3C;span style="color:red">红字&#x3C;/span>，&#x3C;u>下划线&#x3C;/u>，&#x3C;b>粗&#x3C;/b></p>
          render OUT: <p>红字，++下划线++，<strong>粗</strong></p>
        
        === [html-block-details] HTML 块：<details>/<summary>
        IN   : "<details>\n<summary>展开</summary>\n\n隐藏内容\n\n</details>\n"
        LOAD : "展开\n\n隐藏内容\n\n"
        SAVED: "展开X\n\n隐藏内容\n\n"
        parsed blocks=[paragraph,paragraph,paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : &#x3C;details> &#x3C;summary>展开&#x3C;/summary><p>隐藏内容</p> &#x3C;/details>
          render OUT: <p>展开</p><p>隐藏内容</p>
        
        === [html-block-div] HTML 块：<div align> 包 <img>
        IN   : "<div align=\"center\">\n  <img src=\"logo.png\" width=\"100\">\n</div>\n"
        LOAD : ""
        SAVED: "X"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : &#x3C;div align="center"> &#x3C;img src="logo.png" width="100"> &#x3C;/div>
          render OUT: 
        
        === [html-comment] HTML 注释
        IN   : "段落一\n\n<!-- TODO: 补充风险评估 -->\n\n段落二\n"
        LOAD : "段落一\n\n\n\n段落二"
        SAVED: "段落一X\n\n\n\n段落二"
        parsed blocks=[paragraph,paragraph,paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <p>段落一</p> &#x3C;!-- TODO: 补充风险评估 --><p>段落二</p>
          render OUT: <p>段落一</p><p>段落二</p>
        
        === [footnote] 脚注
        IN   : "结论见脚注[^1]。\n\n[^1]: 这是脚注内容。\n"
        LOAD : "结论见脚注[^1](这是脚注内容。)。"
        SAVED: "结论见脚注[^1](这是脚注内容。)。X"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <p>结论见脚注<sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref aria-describedby="footnote-label">1</a></sup>。</p><section data-footnotes class="footnotes"><h2 class="sr-only" id="footnote-label">Footnotes</h2><ol><li id="user-content-fn-1"><p>这是脚注内容。 <a href="#user-content-fnr
          render OUT: <p>结论见脚注<a href="%E8%BF%99%E6%98%AF%E8%84%9A%E6%B3%A8%E5%86%85%E5%AE%B9%E3%80%82">^1</a>。</p>
        
        === [task-list] 任务列表
        IN   : "- [ ] 待办一\n- [x] 已完成二\n"
        LOAD : "- 待办一\n- 已完成二\n\n"
        SAVED: "- 待办一\n- 已完成二\n\nX"
        parsed blocks=[bulletList] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=Invalid content for node listItem: <"待办一"> typeError=null
          render IN : <ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> 待办一</li><li class="task-list-item"><input type="checkbox" checked disabled> 已完成二</li></ul>
          render OUT: <ul><li>待办一</li><li>已完成二</li></ul>
        
        === [task-list-mixed] 任务项与普通项混排
        IN   : "- [ ] 待办\n- 普通项\n"
        LOAD : "- 待办\n- 普通项\n\n"
        SAVED: "- 待办\n- 普通项X\n\n"
        parsed blocks=[bulletList] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=Invalid content for node listItem: <"待办"> typeError=null
          render IN : <ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> 待办</li><li>普通项</li></ul>
          render OUT: <ul><li>待办</li><li>普通项</li></ul>
        
        === [snake-case] 带下划线的普通文本
        IN   : "调用 snake_case 函数，修改 spec_vfs_service.ts 和 __init__.py\n"
        LOAD : "调用 snake\\_case 函数，修改 spec\\_vfs\\_service.ts 和 **init**.py"
        SAVED: "调用 snake\\_case 函数，修改 spec\\_vfs\\_service.ts 和 **init**.pyX"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [single-tilde] 单个 ~
        IN   : "大约 ~5 分钟，路径 ~/project\n"
        LOAD : "大约 \\~5 分钟，路径 \\~/project"
        SAVED: "大约 \\~5 分钟，路径 \\~/projectX"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [single-tilde-pair] 成对单 ~ 与 ~~
        IN   : "~删除~ 与 ~~删除~~\n"
        LOAD : "~~删除~~ 与 ~~删除~~"
        SAVED: "~~删除~~ 与 ~~删除X~~"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [angle-brackets] 尖括号 / & 普通文本（泛型、比较）
        IN   : "返回 Promise<void>，Map<string, number>，a < b && c > d，R&D\n"
        LOAD : "返回 Promise&lt;void&gt;，Map&lt;string, number&gt;，a &lt; b &amp;&amp; c &gt; d，R&amp;D"
        SAVED: "返回 Promise&lt;void&gt;，Map&lt;string, number&gt;，a &lt; b &amp;&amp; c &gt; d，R&amp;DX"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [backslash-path] Windows 路径（反斜杠）
        IN   : "日志在 C:\\Users\\dev\\app.log\n"
        LOAD : "日志在 C:\\\\Users\\\\dev\\\\app.log"
        SAVED: "日志在 C:\\\\Users\\\\dev\\\\app.logX"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [brackets-asterisk] 方括号 / 星号普通文本
        IN   : "数组 [1, 2]，乘法 a * b * c\n"
        LOAD : "数组 \\[1, 2\\]，乘法 a \\* b \\* c"
        SAVED: "数组 \\[1, 2\\]，乘法 a \\* b \\* cX"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [front-matter] YAML front matter
        IN   : "---\ntitle: 设计\nstatus: draft\n---\n\n# 正文\n"
        LOAD : "---\n\n## title: 设计\nstatus: draft\n\n# 正文\n\n"
        SAVED: "---\n\n## title: 设计\nstatus: draftX\n\n# 正文\n\n"
        parsed blocks=[horizontalRule,heading,heading] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <hr><h2>title: 设计 status: draft</h2><h1>正文</h1>
          render OUT: <hr><h2>title: 设计</h2><p>status: draft</p><h1>正文</h1>
        
        === [soft-break] 段内软换行
        IN   : "第一行\n第二行（同一段落）\n"
        LOAD : "第一行\n第二行（同一段落）"
        SAVED: "第一行\n第二行（同一段落）X"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [blank-lines] 连续多个空行
        IN   : "段落一\n\n\n\n段落二\n"
        LOAD : "段落一\n\n\n\n段落二"
        SAVED: "段落一X\n\n\n\n段落二"
        parsed blocks=[paragraph,paragraph,paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [bullets-star-plus] * / + 列表符号
        IN   : "* a\n* b\n\n+ c\n"
        LOAD : "- a\n- b\n\n- c\n\n"
        SAVED: "- aX\n- b\n\n- c\n\n"
        parsed blocks=[bulletList,bulletList] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <ul><li>a</li><li>b</li></ul><ul><li>c</li></ul>
          render OUT: <ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>
        
        === [setext-heading] Setext 标题
        IN   : "标题\n===\n\n副标题\n---\n"
        LOAD : "# 标题\n\n## 副标题\n\n"
        SAVED: "# 标题X\n\n## 副标题\n\n"
        parsed blocks=[heading,heading] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [tilde-fence] ~~~ 代码围栏
        IN   : "~~~ts\nconst a_b = 1;\n~~~\n"
        LOAD : "```ts\nconst a_b = 1;\n```\n\n"
        SAVED: "```ts\nconst a_b = 1;X\n```\n\n"
        parsed blocks=[codeBlock] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [code-fence-mermaid] mermaid 代码块
        IN   : "```mermaid\ngraph TD; A-->B\n```\n"
        LOAD : "```mermaid\ngraph TD; A-->B\n```\n\n"
        SAVED: "```mermaid\ngraph TD; A-->BX\n```\n\n"
        parsed blocks=[codeBlock] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [ref-link] 引用式链接
        IN   : "见 [文档][doc]。\n\n[doc]: https://example.com/doc \"Doc\"\n"
        LOAD : "见 [文档](https://example.com/doc \"Doc\")。"
        SAVED: "见 [文档](https://example.com/doc \"Doc\")。X"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [autolink] <URL> 自动链接与裸 URL
        IN   : "<https://example.com> 和 https://example.com/a_b\n"
        LOAD : "[https://example.com](https://example.com) 和 [https://example.com/a\\_b](https://example.com/a_b)"
        SAVED: "[https://example.com](https://example.com) 和 [https://example.com/a\\_bX](https://example.com/a_b)"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [ordered-start] 从 3 开始的有序列表 / 1) 写法
        IN   : "3. 三\n4. 四\n\n1) 一\n2) 二\n"
        LOAD : "3. 三\n4. 四\n5. 一\n6. 二\n\n"
        SAVED: "3. 三X\n4. 四\n5. 一\n6. 二\n\n"
        parsed blocks=[orderedList] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <ol start="3"><li>三</li><li>四</li></ol><ol><li>一</li><li>二</li></ol>
          render OUT: <ol start="3"><li>三</li><li>四</li><li>一</li><li>二</li></ol>
        
        === [nested-4space] 4 空格缩进的嵌套列表
        IN   : "- a\n    - b\n        - c\n"
        LOAD : "- a\n  - b\n    - c\n\n"
        SAVED: "- aX\n  - b\n    - c\n\n"
        parsed blocks=[bulletList] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [hard-break] 硬换行（两个空格 / 反斜杠）
        IN   : "行一  \n行二\\\n行三\n"
        LOAD : "行一  \n行二  \n行三"
        SAVED: "行一  \n行二  \n行三X"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [hr-variants] *** / ___ 分隔线
        IN   : "上\n\n***\n\n中\n\n___\n\n下\n"
        LOAD : "上\n\n---\n\n中\n\n---\n\n下"
        SAVED: "上X\n\n---\n\n中\n\n---\n\n下"
        parsed blocks=[paragraph,horizontalRule,paragraph,horizontalRule,paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [emphasis-underscore] 下划线强调
        IN   : "_斜体_ 和 __粗体__\n"
        LOAD : "*斜体* 和 **粗体**"
        SAVED: "*斜体* 和 **粗体X**"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [escaped] 反斜杠转义
        IN   : "\\*不是斜体\\*\n"
        LOAD : "\\*不是斜体\\*"
        SAVED: "\\*不是斜体\\*X"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [math] 数学公式
        IN   : "质能 $E=mc^2$，下标 $a_b$\n\n$$\nx_i^2\n$$\n"
        LOAD : "质能 $E=mc^2$，下标 $a\\_b$\n\n$$\nx\\_i^2\n$$"
        SAVED: "质能 $E=mc^2$，下标 $a\\_b$X\n\n$$\nx\\_i^2\n$$"
        parsed blocks=[paragraph,paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <p>质能 <code class="language-math math-inline">E=mc^2</code>，下标 <code class="language-math math-inline">a_b</code></p><pre><code class="language-math math-display">x_i^2</code></pre>
          render OUT: <p>质能 <code class="language-math math-inline">E=mc^2</code>，下标 <code class="language-math math-inline">a\_b</code></p><pre><code class="language-math math-display">x\_i^2</code></pre>
        
        === [entities] HTML 实体
        IN   : "版权 &copy; 2026，不换行&nbsp;空格\n"
        LOAD : "版权 &amp;copy; 2026，不换行&amp;nbsp;空格"
        SAVED: "版权 &amp;copy; 2026，不换行&amp;nbsp;空格X"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=DIFF docValid=ok typeError=null
          render IN : <p>版权 © 2026，不换行 空格</p>
          render OUT: <p>版权 &#x26;copy; 2026，不换行&#x26;nbsp;空格</p>
        
        === [highlight-heading-id] ==高亮== 与 {#id}
        IN   : "## 标题 {#sec-1}\n\n==重点==\n"
        LOAD : "## 标题 {#sec-1}\n\n==重点=="
        SAVED: "## 标题 {#sec-1}X\n\n==重点=="
        parsed blocks=[heading,paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [behavior-fence] 典型 behavior_fence（原样注入给模型）
        IN   : "- 不要修改 drizzle/ 目录下的文件\n- 只改 server/services/spec_vfs_service.ts，别动 *.test.ts\n- 命令统一用 bunx，不要用 npx\n- 回答使用中文 & 简洁\n"
        LOAD : "- 不要修改 drizzle/ 目录下的文件\n- 只改 server/services/spec\\_vfs\\_service.ts，别动 \\*.test.ts\n- 命令统一用 bunx，不要用 npx\n- 回答使用中文 &amp; 简洁\n\n"
        SAVED: "- 不要修改 drizzle/ 目录下的文件X\n- 只改 server/services/spec\\_vfs\\_service.ts，别动 \\*.test.ts\n- 命令统一用 bunx，不要用 npx\n- 回答使用中文 &amp; 简洁\n\n"
        parsed blocks=[bulletList] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [json-file] 非 md 文件：JSON 内容（如 spec://notes.json）
        IN   : "{\n  \"key_name\": [1, 2],\n  \"nested\": {\"a\": \"*\"}\n}\n"
        LOAD : "{\n  \"key\\_name\": \\[1, 2\\],\n  \"nested\": {\"a\": \"\\*\"}\n}"
        SAVED: "{\n  \"key\\_name\": \\[1, 2\\],\n  \"nested\": {\"a\": \"\\*\"}\n}X"
        parsed blocks=[paragraph] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        
        === [yaml-file] 非 md 文件：YAML 内容
        IN   : "steps:\n  - name: build_app\n    run: bun run build\n"
        LOAD : "steps:\n\n- name: build\\_app\nrun: bun run build\n\n"
        SAVED: "steps:X\n\n- name: build\\_app\nrun: bun run build\n\n"
        parsed blocks=[paragraph,bulletList] updatesBeforeEdit=0 source=changed appRender=same docValid=ok typeError=null
        ````
    - [p/t0I8gh2A] 加扩展后的对比输出（3.27.1）
      - [p/VD6W0Dqi] ````
        extensions: StarterKit + Markdown + table+task+imageinline
        
        === [table-basic] GFM 表格（夹在标题和段落之间，含对齐、行内代码、粗体）
        IN   : "# 方案对比\n\n| 方案 | 优点 | 缺点 |\n| --- | :---: | ---: |\n| A | 快 | 贵 |\n| B | `便宜` | **慢** |\n\n表格后的段落。\n"
        LOAD : "# 方案对比\n\n\n| 方案  | 优点   | 缺点    |\n| --- | :----: | -----: |\n| A   | 快    | 贵     |\n| B   | `便宜` | **慢** |\n\n\n表格后的段落。"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [table-no-outer-pipes] GFM 表格（无首尾竖线）
        IN   : "前文\n\na | b\n--|--\n1 | 2\n\n后文\n"
        LOAD : "前文\n\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\n\n后文"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [table-only] 整份文件只有一个表格
        IN   : "| key | value |\n| --- | --- |\n| a | 1 |\n"
        LOAD : "\n| key | value |\n| --- | ----- |\n| a   | 1     |\n\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [table-in-list] 列表项里的表格
        IN   : "- 第一项\n\n  | x | y |\n  | - | - |\n  | 1 | 2 |\n\n- 第二项\n"
        LOAD : "- 第一项\n  \n  | x   | y   |\n  | --- | --- |\n  | 1   | 2   |\n  \n- 第二项\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [image] 图片
        IN   : "见下图：![架构图](./arch.png \"架构\")\n"
        LOAD : "见下图：![架构图](./arch.png \"架构\")"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [image-block] 单独成段的图片
        IN   : "![流程图](https://example.com/flow.png)\n"
        LOAD : "![流程图](https://example.com/flow.png)"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [inline-html-kbd] 行内 HTML：<kbd>/<sub>/<br>
        IN   : "按 <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存，H<sub>2</sub>O，第一行<br>第二行\n"
        LOAD : "按 Ctrl+S 保存，H2O，第一行  \n第二行"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>按 &#x3C;kbd>Ctrl&#x3C;/kbd>+&#x3C;kbd>S&#x3C;/kbd> 保存，H&#x3C;sub>2&#x3C;/sub>O，第一行&#x3C;br>第二行</p>
          render OUT: <p>按 Ctrl+S 保存，H2O，第一行<br> 第二行</p>
        
        === [inline-html-span] 行内 HTML：<span style>/<u>/<b>
        IN   : "<span style=\"color:red\">红字</span>，<u>下划线</u>，<b>粗</b>\n"
        LOAD : "红字，++下划线++，**粗**"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>&#x3C;span style="color:red">红字&#x3C;/span>，&#x3C;u>下划线&#x3C;/u>，&#x3C;b>粗&#x3C;/b></p>
          render OUT: <p>红字，++下划线++，<strong>粗</strong></p>
        
        === [html-block-details] HTML 块：<details>/<summary>
        IN   : "<details>\n<summary>展开</summary>\n\n隐藏内容\n\n</details>\n"
        LOAD : "展开\n\n隐藏内容\n\n"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : &#x3C;details> &#x3C;summary>展开&#x3C;/summary><p>隐藏内容</p> &#x3C;/details>
          render OUT: <p>展开</p><p>隐藏内容</p>
        
        === [html-block-div] HTML 块：<div align> 包 <img>
        IN   : "<div align=\"center\">\n  <img src=\"logo.png\" width=\"100\">\n</div>\n"
        LOAD : "![](logo.png)"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : &#x3C;div align="center"> &#x3C;img src="logo.png" width="100"> &#x3C;/div>
          render OUT: <p><img src="logo.png" alt=""></p>
        
        === [html-comment] HTML 注释
        IN   : "段落一\n\n<!-- TODO: 补充风险评估 -->\n\n段落二\n"
        LOAD : "段落一\n\n\n\n段落二"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>段落一</p> &#x3C;!-- TODO: 补充风险评估 --><p>段落二</p>
          render OUT: <p>段落一</p><p>段落二</p>
        
        === [footnote] 脚注
        IN   : "结论见脚注[^1]。\n\n[^1]: 这是脚注内容。\n"
        LOAD : "结论见脚注[^1](这是脚注内容。)。"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>结论见脚注<sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref aria-describedby="footnote-label">1</a></sup>。</p><section data-footnotes class="footnotes"><h2 class="sr-only" id="footnote-label">Footnotes</h2><ol><li id="user-content-fn-
          render OUT: <p>结论见脚注<a href="%E8%BF%99%E6%98%AF%E8%84%9A%E6%B3%A8%E5%86%85%E5%AE%B9%E3%80%82">^1</a>。</p>
        
        === [task-list] 任务列表
        IN   : "- [ ] 待办一\n- [x] 已完成二\n"
        LOAD : "- [ ] 待办一\n- [x] 已完成二\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [task-list-mixed] 任务项与普通项混排
        IN   : "- [ ] 待办\n- 普通项\n"
        LOAD : "- [ ] 待办\n\n- 普通项\n\n"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> 待办</li><li>普通项</li></ul>
          render OUT: <ul class="contains-task-list"><li class="task-list-item"><p><input type="checkbox" disabled> 待办</p></li><li><p>普通项</p></li></ul>
        
        === [snake-case] 带下划线的普通文本
        IN   : "调用 snake_case 函数，修改 spec_vfs_service.ts 和 __init__.py\n"
        LOAD : "调用 snake\\_case 函数，修改 spec\\_vfs\\_service.ts 和 **init**.py"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [single-tilde] 单个 ~
        IN   : "大约 ~5 分钟，路径 ~/project\n"
        LOAD : "大约 \\~5 分钟，路径 \\~/project"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [single-tilde-pair] 成对单 ~ 与 ~~
        IN   : "~删除~ 与 ~~删除~~\n"
        LOAD : "~~删除~~ 与 ~~删除~~"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [angle-brackets] 尖括号 / & 普通文本（泛型、比较）
        IN   : "返回 Promise<void>，Map<string, number>，a < b && c > d，R&D\n"
        LOAD : "返回 Promise&lt;void&gt;，Map&lt;string, number&gt;，a &lt; b &amp;&amp; c &gt; d，R&amp;D"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [backslash-path] Windows 路径（反斜杠）
        IN   : "日志在 C:\\Users\\dev\\app.log\n"
        LOAD : "日志在 C:\\\\Users\\\\dev\\\\app.log"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [brackets-asterisk] 方括号 / 星号普通文本
        IN   : "数组 [1, 2]，乘法 a * b * c\n"
        LOAD : "数组 \\[1, 2\\]，乘法 a \\* b \\* c"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [front-matter] YAML front matter
        IN   : "---\ntitle: 设计\nstatus: draft\n---\n\n# 正文\n"
        LOAD : "---\n\n## title: 设计\nstatus: draft\n\n# 正文\n\n"
        appRender=DIFF stableOn2ndPass=false updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <hr><h2>title: 设计 status: draft</h2><h1>正文</h1>
          render OUT: <hr><h2>title: 设计</h2><p>status: draft</p><h1>正文</h1>
        
        === [soft-break] 段内软换行
        IN   : "第一行\n第二行（同一段落）\n"
        LOAD : "第一行\n第二行（同一段落）"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [blank-lines] 连续多个空行
        IN   : "段落一\n\n\n\n段落二\n"
        LOAD : "段落一\n\n\n\n段落二"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [bullets-star-plus] * / + 列表符号
        IN   : "* a\n* b\n\n+ c\n"
        LOAD : "- a\n- b\n\n- c\n\n"
        appRender=DIFF stableOn2ndPass=false updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <ul><li>a</li><li>b</li></ul><ul><li>c</li></ul>
          render OUT: <ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>
        
        === [setext-heading] Setext 标题
        IN   : "标题\n===\n\n副标题\n---\n"
        LOAD : "# 标题\n\n## 副标题\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [tilde-fence] ~~~ 代码围栏
        IN   : "~~~ts\nconst a_b = 1;\n~~~\n"
        LOAD : "```ts\nconst a_b = 1;\n```\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [code-fence-mermaid] mermaid 代码块
        IN   : "```mermaid\ngraph TD; A-->B\n```\n"
        LOAD : "```mermaid\ngraph TD; A-->B\n```\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [ref-link] 引用式链接
        IN   : "见 [文档][doc]。\n\n[doc]: https://example.com/doc \"Doc\"\n"
        LOAD : "见 [文档](https://example.com/doc \"Doc\")。"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [autolink] <URL> 自动链接与裸 URL
        IN   : "<https://example.com> 和 https://example.com/a_b\n"
        LOAD : "[https://example.com](https://example.com) 和 [https://example.com/a\\_b](https://example.com/a_b)"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [ordered-start] 从 3 开始的有序列表 / 1) 写法
        IN   : "3. 三\n4. 四\n\n1) 一\n2) 二\n"
        LOAD : "3. 三\n4. 四\n5. 一\n6. 二\n\n"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <ol start="3"><li>三</li><li>四</li></ol><ol><li>一</li><li>二</li></ol>
          render OUT: <ol start="3"><li>三</li><li>四</li><li>一</li><li>二</li></ol>
        
        === [nested-4space] 4 空格缩进的嵌套列表
        IN   : "- a\n    - b\n        - c\n"
        LOAD : "- a\n  - b\n    - c\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [hard-break] 硬换行（两个空格 / 反斜杠）
        IN   : "行一  \n行二\\\n行三\n"
        LOAD : "行一  \n行二  \n行三"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [hr-variants] *** / ___ 分隔线
        IN   : "上\n\n***\n\n中\n\n___\n\n下\n"
        LOAD : "上\n\n---\n\n中\n\n---\n\n下"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [emphasis-underscore] 下划线强调
        IN   : "_斜体_ 和 __粗体__\n"
        LOAD : "*斜体* 和 **粗体**"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [escaped] 反斜杠转义
        IN   : "\\*不是斜体\\*\n"
        LOAD : "\\*不是斜体\\*"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [math] 数学公式
        IN   : "质能 $E=mc^2$，下标 $a_b$\n\n$$\nx_i^2\n$$\n"
        LOAD : "质能 $E=mc^2$，下标 $a\\_b$\n\n$$\nx\\_i^2\n$$"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>质能 <code class="language-math math-inline">E=mc^2</code>，下标 <code class="language-math math-inline">a_b</code></p><pre><code class="language-math math-display">x_i^2</code></pre>
          render OUT: <p>质能 <code class="language-math math-inline">E=mc^2</code>，下标 <code class="language-math math-inline">a\_b</code></p><pre><code class="language-math math-display">x\_i^2</code></pre>
        
        === [entities] HTML 实体
        IN   : "版权 &copy; 2026，不换行&nbsp;空格\n"
        LOAD : "版权 &amp;copy; 2026，不换行&amp;nbsp;空格"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>版权 © 2026，不换行 空格</p>
          render OUT: <p>版权 &#x26;copy; 2026，不换行&#x26;nbsp;空格</p>
        
        === [highlight-heading-id] ==高亮== 与 {#id}
        IN   : "## 标题 {#sec-1}\n\n==重点==\n"
        LOAD : "## 标题 {#sec-1}\n\n==重点=="
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [behavior-fence] 典型 behavior_fence（原样注入给模型）
        IN   : "- 不要修改 drizzle/ 目录下的文件\n- 只改 server/services/spec_vfs_service.ts，别动 *.test.ts\n- 命令统一用 bunx，不要用 npx\n- 回答使用中文 & 简洁\n"
        LOAD : "- 不要修改 drizzle/ 目录下的文件\n- 只改 server/services/spec\\_vfs\\_service.ts，别动 \\*.test.ts\n- 命令统一用 bunx，不要用 npx\n- 回答使用中文 &amp; 简洁\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [json-file] 非 md 文件：JSON 内容（如 spec://notes.json）
        IN   : "{\n  \"key_name\": [1, 2],\n  \"nested\": {\"a\": \"*\"}\n}\n"
        LOAD : "{\n  \"key\\_name\": \\[1, 2\\],\n  \"nested\": {\"a\": \"\\*\"}\n}"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [yaml-file] 非 md 文件：YAML 内容
        IN   : "steps:\n  - name: build_app\n    run: bun run build\n"
        LOAD : "steps:\n\n- name: build\\_app\nrun: bun run build\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [t-escaped-pipe] 单元格里转义的竖线 \|
        IN   : "| 表达式 | 含义 |\n| --- | --- |\n| a \\| b | 或 |\n"
        LOAD : "\n| 表达式   | 含义  |\n| ----- | --- |\n| a | b | 或   |\n\n\n"
        appRender=DIFF stableOn2ndPass=false updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <table><thead><tr><th>表达式</th><th>含义</th></tr></thead><tbody><tr><td>a | b</td><td>或</td></tr></tbody></table>
          render OUT: <table><thead><tr><th>表达式</th><th>含义</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>
        
        === [t-code-pipe] 单元格行内代码里的转义竖线
        IN   : "| 命令 | 说明 |\n| --- | --- |\n| `ls \\| wc -l` | 计数 |\n"
        LOAD : "\n| 命令           | 说明  |\n| ------------ | --- |\n| `ls | wc -l` | 计数  |\n\n\n"
        appRender=DIFF stableOn2ndPass=false updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <table><thead><tr><th>命令</th><th>说明</th></tr></thead><tbody><tr><td><code>ls | wc -l</code></td><td>计数</td></tr></tbody></table>
          render OUT: <table><thead><tr><th>命令</th><th>说明</th></tr></thead><tbody><tr><td>`ls</td><td>wc -l`</td></tr></tbody></table>
        
        === [t-br] 单元格里用 <br> 换行
        IN   : "| 步骤 | 说明 |\n| --- | --- |\n| 1 | 第一行<br>第二行 |\n"
        LOAD : "\n| 步骤  | 说明      |\n| --- | ------- |\n| 1   | 第一行 第二行 |\n\n\n"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <table><thead><tr><th>步骤</th><th>说明</th></tr></thead><tbody><tr><td>1</td><td>第一行&#x3C;br>第二行</td></tr></tbody></table>
          render OUT: <table><thead><tr><th>步骤</th><th>说明</th></tr></thead><tbody><tr><td>1</td><td>第一行 第二行</td></tr></tbody></table>
        
        === [t-empty-and-link] 空单元格、链接、下划线文本
        IN   : "| 文件 | 链接 | 备注 |\n| --- | --- | --- |\n| spec_vfs.ts | [文档](https://x.dev/a_b) |  |\n"
        LOAD : "\n| 文件           | 链接                      | 备注  |\n| ------------ | ----------------------- | --- |\n| spec\\_vfs.ts | [文档](https://x.dev/a_b) |     |\n\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [t-ragged] 行的列数少于表头
        IN   : "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n"
        LOAD : "\n| a   | b   | c   |\n| --- | --- | --- |\n| 1   | 2   |     |\n\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [t-realistic-spec] 典型 agent 设计笔记（标题+列表+表格+代码）
        IN   : "# 存储迁移设计\n\n## 目标\n\n- 把 `spec_file_revisions` 的大字段移出主表\n- 保持 API 不变\n\n## 方案对比\n\n| 方案 | 改动面 | 风险 | 结论 |\n| --- | --- | --- | --- |\n| A：原地加列 | 小 | 低 | ✅ 采用 |\n| B：新表 + 回填 | 大 | 中 | ❌ |\n\n## 步骤\n\n1. 改 `server/db/schema.ts`\n2. 运行 `bun run db:generate`\n\n```ts\nconst MAX_SPEC_FILE_CHARS = 200_000;\n```\n"
        LOAD : "# 存储迁移设计\n\n## 目标\n\n- 把 `spec_file_revisions` 的大字段移出主表\n- 保持 API 不变\n\n## 方案对比\n\n\n| 方案        | 改动面 | 风险  | 结论   |\n| --------- | --- | --- | ---- |\n| A：原地加列    | 小   | 低   | ✅ 采用 |\n| B：新表 + 回填 | 大   | 中   | ❌    |\n\n\n## 步骤\n\n1. 改 `server/db/schema.ts`\n2. 运行 `bun run db:generate`\n\n```ts\nconst MAX_SPEC_FILE_CHARS = 200_000;\n```\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        ````
    - [p/XPKKHAxk] 加扩展后的对比输出（3.32.0）
      - [p/jrIIdZ3a] ````
        extensions: StarterKit + Markdown + table+task+imageinline
        
        === [table-basic] GFM 表格（夹在标题和段落之间，含对齐、行内代码、粗体）
        IN   : "# 方案对比\n\n| 方案 | 优点 | 缺点 |\n| --- | :---: | ---: |\n| A | 快 | 贵 |\n| B | `便宜` | **慢** |\n\n表格后的段落。\n"
        LOAD : "# 方案对比\n\n\n| 方案  | 优点   | 缺点    |\n| --- | :----: | -----: |\n| A   | 快    | 贵     |\n| B   | `便宜` | **慢** |\n\n\n表格后的段落。"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [table-no-outer-pipes] GFM 表格（无首尾竖线）
        IN   : "前文\n\na | b\n--|--\n1 | 2\n\n后文\n"
        LOAD : "前文\n\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\n\n后文"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [table-only] 整份文件只有一个表格
        IN   : "| key | value |\n| --- | --- |\n| a | 1 |\n"
        LOAD : "\n| key | value |\n| --- | ----- |\n| a   | 1     |\n\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [table-in-list] 列表项里的表格
        IN   : "- 第一项\n\n  | x | y |\n  | - | - |\n  | 1 | 2 |\n\n- 第二项\n"
        LOAD : "- 第一项\n  \n  | x   | y   |\n  | --- | --- |\n  | 1   | 2   |\n  \n- 第二项\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [image] 图片
        IN   : "见下图：![架构图](./arch.png \"架构\")\n"
        LOAD : "见下图：![架构图](./arch.png \"架构\")"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [image-block] 单独成段的图片
        IN   : "![流程图](https://example.com/flow.png)\n"
        LOAD : "![流程图](https://example.com/flow.png)"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [inline-html-kbd] 行内 HTML：<kbd>/<sub>/<br>
        IN   : "按 <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存，H<sub>2</sub>O，第一行<br>第二行\n"
        LOAD : "按 Ctrl+S 保存，H2O，第一行  \n第二行"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>按 &#x3C;kbd>Ctrl&#x3C;/kbd>+&#x3C;kbd>S&#x3C;/kbd> 保存，H&#x3C;sub>2&#x3C;/sub>O，第一行&#x3C;br>第二行</p>
          render OUT: <p>按 Ctrl+S 保存，H2O，第一行<br> 第二行</p>
        
        === [inline-html-span] 行内 HTML：<span style>/<u>/<b>
        IN   : "<span style=\"color:red\">红字</span>，<u>下划线</u>，<b>粗</b>\n"
        LOAD : "红字，++下划线++，**粗**"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>&#x3C;span style="color:red">红字&#x3C;/span>，&#x3C;u>下划线&#x3C;/u>，&#x3C;b>粗&#x3C;/b></p>
          render OUT: <p>红字，++下划线++，<strong>粗</strong></p>
        
        === [html-block-details] HTML 块：<details>/<summary>
        IN   : "<details>\n<summary>展开</summary>\n\n隐藏内容\n\n</details>\n"
        LOAD : "展开\n\n隐藏内容\n\n"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : &#x3C;details> &#x3C;summary>展开&#x3C;/summary><p>隐藏内容</p> &#x3C;/details>
          render OUT: <p>展开</p><p>隐藏内容</p>
        
        === [html-block-div] HTML 块：<div align> 包 <img>
        IN   : "<div align=\"center\">\n  <img src=\"logo.png\" width=\"100\">\n</div>\n"
        LOAD : "![](logo.png)"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : &#x3C;div align="center"> &#x3C;img src="logo.png" width="100"> &#x3C;/div>
          render OUT: <p><img src="logo.png" alt=""></p>
        
        === [html-comment] HTML 注释
        IN   : "段落一\n\n<!-- TODO: 补充风险评估 -->\n\n段落二\n"
        LOAD : "段落一\n\n\n\n段落二"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>段落一</p> &#x3C;!-- TODO: 补充风险评估 --><p>段落二</p>
          render OUT: <p>段落一</p><p>段落二</p>
        
        === [footnote] 脚注
        IN   : "结论见脚注[^1]。\n\n[^1]: 这是脚注内容。\n"
        LOAD : "结论见脚注[^1](这是脚注内容。)。"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>结论见脚注<sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref aria-describedby="footnote-label">1</a></sup>。</p><section data-footnotes class="footnotes"><h2 class="sr-only" id="footnote-label">Footnotes</h2><ol><li id="user-content-fn-
          render OUT: <p>结论见脚注<a href="%E8%BF%99%E6%98%AF%E8%84%9A%E6%B3%A8%E5%86%85%E5%AE%B9%E3%80%82">^1</a>。</p>
        
        === [task-list] 任务列表
        IN   : "- [ ] 待办一\n- [x] 已完成二\n"
        LOAD : "- [ ] 待办一\n- [x] 已完成二\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [task-list-mixed] 任务项与普通项混排
        IN   : "- [ ] 待办\n- 普通项\n"
        LOAD : "- [ ] 待办\n\n- 普通项\n\n"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> 待办</li><li>普通项</li></ul>
          render OUT: <ul class="contains-task-list"><li class="task-list-item"><p><input type="checkbox" disabled> 待办</p></li><li><p>普通项</p></li></ul>
        
        === [snake-case] 带下划线的普通文本
        IN   : "调用 snake_case 函数，修改 spec_vfs_service.ts 和 __init__.py\n"
        LOAD : "调用 snake\\_case 函数，修改 spec\\_vfs\\_service.ts 和 **init**.py"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [single-tilde] 单个 ~
        IN   : "大约 ~5 分钟，路径 ~/project\n"
        LOAD : "大约 \\~5 分钟，路径 \\~/project"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [single-tilde-pair] 成对单 ~ 与 ~~
        IN   : "~删除~ 与 ~~删除~~\n"
        LOAD : "~~删除~~ 与 ~~删除~~"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [angle-brackets] 尖括号 / & 普通文本（泛型、比较）
        IN   : "返回 Promise<void>，Map<string, number>，a < b && c > d，R&D\n"
        LOAD : "返回 Promise&lt;void&gt;，Map&lt;string, number&gt;，a &lt; b &amp;&amp; c &gt; d，R&amp;D"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [backslash-path] Windows 路径（反斜杠）
        IN   : "日志在 C:\\Users\\dev\\app.log\n"
        LOAD : "日志在 C:\\\\Users\\\\dev\\\\app.log"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [brackets-asterisk] 方括号 / 星号普通文本
        IN   : "数组 [1, 2]，乘法 a * b * c\n"
        LOAD : "数组 \\[1, 2\\]，乘法 a \\* b \\* c"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [front-matter] YAML front matter
        IN   : "---\ntitle: 设计\nstatus: draft\n---\n\n# 正文\n"
        LOAD : "---\n\n## title: 设计\nstatus: draft\n\n# 正文\n\n"
        appRender=DIFF stableOn2ndPass=false updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <hr><h2>title: 设计 status: draft</h2><h1>正文</h1>
          render OUT: <hr><h2>title: 设计</h2><p>status: draft</p><h1>正文</h1>
        
        === [soft-break] 段内软换行
        IN   : "第一行\n第二行（同一段落）\n"
        LOAD : "第一行\n第二行（同一段落）"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [blank-lines] 连续多个空行
        IN   : "段落一\n\n\n\n段落二\n"
        LOAD : "段落一\n\n\n\n段落二"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [bullets-star-plus] * / + 列表符号
        IN   : "* a\n* b\n\n+ c\n"
        LOAD : "- a\n- b\n\n- c\n\n"
        appRender=DIFF stableOn2ndPass=false updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <ul><li>a</li><li>b</li></ul><ul><li>c</li></ul>
          render OUT: <ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>
        
        === [setext-heading] Setext 标题
        IN   : "标题\n===\n\n副标题\n---\n"
        LOAD : "# 标题\n\n## 副标题\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [tilde-fence] ~~~ 代码围栏
        IN   : "~~~ts\nconst a_b = 1;\n~~~\n"
        LOAD : "```ts\nconst a_b = 1;\n```\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [code-fence-mermaid] mermaid 代码块
        IN   : "```mermaid\ngraph TD; A-->B\n```\n"
        LOAD : "```mermaid\ngraph TD; A-->B\n```\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [ref-link] 引用式链接
        IN   : "见 [文档][doc]。\n\n[doc]: https://example.com/doc \"Doc\"\n"
        LOAD : "见 [文档](https://example.com/doc \"Doc\")。"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [autolink] <URL> 自动链接与裸 URL
        IN   : "<https://example.com> 和 https://example.com/a_b\n"
        LOAD : "[https://example.com](https://example.com) 和 [https://example.com/a\\_b](https://example.com/a_b)"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [ordered-start] 从 3 开始的有序列表 / 1) 写法
        IN   : "3. 三\n4. 四\n\n1) 一\n2) 二\n"
        LOAD : "3. 三\n4. 四\n5. 一\n6. 二\n\n"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <ol start="3"><li>三</li><li>四</li></ol><ol><li>一</li><li>二</li></ol>
          render OUT: <ol start="3"><li>三</li><li>四</li><li>一</li><li>二</li></ol>
        
        === [nested-4space] 4 空格缩进的嵌套列表
        IN   : "- a\n    - b\n        - c\n"
        LOAD : "- a\n  - b\n    - c\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [hard-break] 硬换行（两个空格 / 反斜杠）
        IN   : "行一  \n行二\\\n行三\n"
        LOAD : "行一  \n行二  \n行三"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [hr-variants] *** / ___ 分隔线
        IN   : "上\n\n***\n\n中\n\n___\n\n下\n"
        LOAD : "上\n\n---\n\n中\n\n---\n\n下"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [emphasis-underscore] 下划线强调
        IN   : "_斜体_ 和 __粗体__\n"
        LOAD : "*斜体* 和 **粗体**"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [escaped] 反斜杠转义
        IN   : "\\*不是斜体\\*\n"
        LOAD : "\\*不是斜体\\*"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [math] 数学公式
        IN   : "质能 $E=mc^2$，下标 $a_b$\n\n$$\nx_i^2\n$$\n"
        LOAD : "质能 $E=mc^2$，下标 $a\\_b$\n\n$$\nx\\_i^2\n$$"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>质能 <code class="language-math math-inline">E=mc^2</code>，下标 <code class="language-math math-inline">a_b</code></p><pre><code class="language-math math-display">x_i^2</code></pre>
          render OUT: <p>质能 <code class="language-math math-inline">E=mc^2</code>，下标 <code class="language-math math-inline">a\_b</code></p><pre><code class="language-math math-display">x\_i^2</code></pre>
        
        === [entities] HTML 实体
        IN   : "版权 &copy; 2026，不换行&nbsp;空格\n"
        LOAD : "版权 &amp;copy; 2026，不换行&amp;nbsp;空格"
        appRender=DIFF stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
          render IN : <p>版权 © 2026，不换行 空格</p>
          render OUT: <p>版权 &#x26;copy; 2026，不换行&#x26;nbsp;空格</p>
        
        === [highlight-heading-id] ==高亮== 与 {#id}
        IN   : "## 标题 {#sec-1}\n\n==重点==\n"
        LOAD : "## 标题 {#sec-1}\n\n==重点=="
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [behavior-fence] 典型 behavior_fence（原样注入给模型）
        IN   : "- 不要修改 drizzle/ 目录下的文件\n- 只改 server/services/spec_vfs_service.ts，别动 *.test.ts\n- 命令统一用 bunx，不要用 npx\n- 回答使用中文 & 简洁\n"
        LOAD : "- 不要修改 drizzle/ 目录下的文件\n- 只改 server/services/spec\\_vfs\\_service.ts，别动 \\*.test.ts\n- 命令统一用 bunx，不要用 npx\n- 回答使用中文 &amp; 简洁\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [json-file] 非 md 文件：JSON 内容（如 spec://notes.json）
        IN   : "{\n  \"key_name\": [1, 2],\n  \"nested\": {\"a\": \"*\"}\n}\n"
        LOAD : "{\n  \"key\\_name\": \\[1, 2\\],\n  \"nested\": {\"a\": \"\\*\"}\n}"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [yaml-file] 非 md 文件：YAML 内容
        IN   : "steps:\n  - name: build_app\n    run: bun run build\n"
        LOAD : "steps:\n\n- name: build\\_app\nrun: bun run build\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [t-escaped-pipe] 单元格里转义的竖线 \|
        IN   : "| 表达式 | 含义 |\n| --- | --- |\n| a \\| b | 或 |\n"
        LOAD : "\n| 表达式    | 含义  |\n| ------ | --- |\n| a \\| b | 或   |\n\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [t-code-pipe] 单元格行内代码里的转义竖线
        IN   : "| 命令 | 说明 |\n| --- | --- |\n| `ls \\| wc -l` | 计数 |\n"
        LOAD : "\n| 命令            | 说明  |\n| ------------- | --- |\n| `ls \\| wc -l` | 计数  |\n\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [t-br] 单元格里用 <br> 换行
        IN   : "| 步骤 | 说明 |\n| --- | --- |\n| 1 | 第一行<br>第二行 |\n"
        LOAD : "\n| 步骤  | 说明         |\n| --- | ---------- |\n| 1   | 第一行<br>第二行 |\n\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [t-empty-and-link] 空单元格、链接、下划线文本
        IN   : "| 文件 | 链接 | 备注 |\n| --- | --- | --- |\n| spec_vfs.ts | [文档](https://x.dev/a_b) |  |\n"
        LOAD : "\n| 文件           | 链接                      | 备注  |\n| ------------ | ----------------------- | --- |\n| spec\\_vfs.ts | [文档](https://x.dev/a_b) |     |\n\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [t-ragged] 行的列数少于表头
        IN   : "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n"
        LOAD : "\n| a   | b   | c   |\n| --- | --- | --- |\n| 1   | 2   |     |\n\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        
        === [t-realistic-spec] 典型 agent 设计笔记（标题+列表+表格+代码）
        IN   : "# 存储迁移设计\n\n## 目标\n\n- 把 `spec_file_revisions` 的大字段移出主表\n- 保持 API 不变\n\n## 方案对比\n\n| 方案 | 改动面 | 风险 | 结论 |\n| --- | --- | --- | --- |\n| A：原地加列 | 小 | 低 | ✅ 采用 |\n| B：新表 + 回填 | 大 | 中 | ❌ |\n\n## 步骤\n\n1. 改 `server/db/schema.ts`\n2. 运行 `bun run db:generate`\n\n```ts\nconst MAX_SPEC_FILE_CHARS = 200_000;\n```\n"
        LOAD : "# 存储迁移设计\n\n## 目标\n\n- 把 `spec_file_revisions` 的大字段移出主表\n- 保持 API 不变\n\n## 方案对比\n\n\n| 方案        | 改动面 | 风险  | 结论   |\n| --------- | --- | --- | ---- |\n| A：原地加列    | 小   | 低   | ✅ 采用 |\n| B：新表 + 回填 | 大   | 中   | ❌    |\n\n\n## 步骤\n\n1. 改 `server/db/schema.ts`\n2. 运行 `bun run db:generate`\n\n```ts\nconst MAX_SPEC_FILE_CHARS = 200_000;\n```\n\n"
        appRender=same stableOn2ndPass=true updatesBeforeEdit=0 docValid=ok typeError=null
        ````
    - [p/CybP6XBI] 复现脚本 package.json
      - [p/BtCqdxww] ```
        {
        	"name": "w-table-repro",
        	"private": true,
        	"type": "module",
        	"dependencies": {
        		"@happy-dom/global-registrator": "21.0.4",
        		"@tiptap/core": "3.27.1",
        		"@tiptap/extension-image": "3.27.1",
        		"@tiptap/extension-link": "3.27.1",
        		"@tiptap/extension-table": "3.27.1",
        		"@tiptap/markdown": "3.27.1",
        		"@tiptap/pm": "3.27.1",
        		"@tiptap/starter-kit": "3.27.1",
        		"happy-dom": "*",
        		"linkedom": "0.18.12",
        		"react-markdown": "10.1.0",
        		"rehype-stringify": "10.0.1",
        		"remark-gfm": "4.0.1",
        		"remark-math": "6.0.0",
        		"remark-parse": "11.0.0",
        		"remark-rehype": "11.1.2",
        		"unified": "11.0.5"
        	},
        	"overrides": {
        		"marked": "17.0.6",
        		"linkifyjs": "4.3.3",
        		"orderedmap": "2.1.1",
        		"prosemirror-changeset": "2.4.1",
        		"prosemirror-commands": "1.7.1",
        		"prosemirror-dropcursor": "1.8.2",
        		"prosemirror-gapcursor": "1.4.1",
        		"prosemirror-history": "1.5.0",
        		"prosemirror-inputrules": "1.5.1",
        		"prosemirror-keymap": "1.2.3",
        		"prosemirror-model": "1.25.9",
        		"prosemirror-schema-list": "1.5.1",
        		"prosemirror-state": "1.4.4",
        		"prosemirror-tables": "1.8.5",
        		"prosemirror-transform": "1.12.0",
        		"prosemirror-view": "1.42.0",
        		"rope-sequence": "1.3.4",
        		"w3c-keyname": "2.2.8",
        		"@tiptap/core": "3.27.1",
        		"@tiptap/pm": "3.27.1",
        		"@tiptap/extension-blockquote": "3.27.1",
        		"@tiptap/extension-bold": "3.27.1",
        		"@tiptap/extension-bullet-list": "3.27.1",
        		"@tiptap/extension-code": "3.27.1",
        		"@tiptap/extension-code-block": "3.27.1",
        		"@tiptap/extension-document": "3.27.1",
        		"@tiptap/extension-dropcursor": "3.27.1",
        		"@tiptap/extension-gapcursor": "3.27.1",
        		"@tiptap/extension-hard-break": "3.27.1",
        		"@tiptap/extension-heading": "3.27.1",
        		"@tiptap/extension-horizontal-rule": "3.27.1",
        		"@tiptap/extension-italic": "3.27.1",
        		"@tiptap/extension-link": "3.27.1",
        		"@tiptap/extension-list": "3.27.1",
        		"@tiptap/extension-list-item": "3.27.1",
        		"@tiptap/extension-list-keymap": "3.27.1",
        		"@tiptap/extension-ordered-list": "3.27.1",
        		"@tiptap/extension-paragraph": "3.27.1",
        		"@tiptap/extension-strike": "3.27.1",
        		"@tiptap/extension-text": "3.27.1",
        		"@tiptap/extension-underline": "3.27.1",
        		"@tiptap/extensions": "3.27.1"
        	}
        }
        ```
    - [p/9BndK8VK] 复现脚本 harness.ts
      - [p/Gjzb327y] ```
        // Shared harness: a browser-like DOM (happy-dom) + an Editor configured exactly like
        // frontend/components/narrator/spec/SpecMarkdownEditor.tsx:43-69, plus a reference
        // renderer equal to NarraFork's own MarkdownContent pipeline (remark-gfm + remark-math).
        import { GlobalRegistrator } from "@happy-dom/global-registrator";
        
        GlobalRegistrator.register({ url: "http://localhost/" });
        
        // Import Tiptap only after the DOM globals exist (prosemirror-view sniffs navigator on load).
        const { Editor } = await import("@tiptap/core");
        const { default: StarterKit } = await import("@tiptap/starter-kit");
        const { Markdown } = await import("@tiptap/markdown");
        const { unified } = await import("unified");
        const { default: remarkParse } = await import("remark-parse");
        const { default: remarkGfm } = await import("remark-gfm");
        const { default: remarkMath } = await import("remark-math");
        const { default: remarkRehype } = await import("remark-rehype");
        const { default: rehypeStringify } = await import("rehype-stringify");
        
        // biome-ignore lint/suspicious/noExplicitAny: scratch harness
        type AnyExt = any;
        
        export const hasDomParser = typeof window !== "undefined" && typeof window.DOMParser !== "undefined";
        
        /** Same options as SpecMarkdownEditor.tsx:47-55 (+ optional extra extensions for the fix test). */
        export function createSpecEditor(
        	value: string,
        	onChange: (markdown: string) => void,
        	extraExtensions: AnyExt[] = [],
        ) {
        	const element = document.createElement("div");
        	document.body.appendChild(element);
        	const editor = new Editor({
        		element,
        		extensions: [
        			StarterKit.configure({ link: { openOnClick: false } }),
        			Markdown.configure({ indentation: { style: "space", size: 2 } }),
        			...extraExtensions,
        		],
        		content: value,
        		contentType: "markdown",
        		onUpdate: ({ editor }) => {
        			if (editor.isDestroyed) return;
        			onChange(editor.getMarkdown());
        		},
        	});
        	// SpecMarkdownEditor.tsx:64-69: the revision effect re-applies the value once.
        	editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
        	return editor;
        }
        
        export interface RoundTrip {
        	/** getMarkdown() right after load, before any edit (== what a save writes, minus the typed char). */
        	loaded: string;
        	/** onUpdate count before the simulated keystroke (expect 0: opening alone never marks dirty). */
        	updatesBeforeEdit: number;
        	/** markdown handed to onChange after one typed "X" — exactly what SpecPanel would PUT on save. */
        	saved: string | null;
        	warnings: string[];
        	parsedTopLevelTypes: string[];
        	/** Error thrown by the simulated keystroke (null = typing worked). */
        	typeError: string | null;
        	/** ProseMirror schema check of the loaded document ("ok" or the error). */
        	docValid: string;
        }
        
        export function roundTrip(md: string, extraExtensions: AnyExt[] = []): RoundTrip {
        	const warnings: string[] = [];
        	const origWarn = console.warn;
        	const origError = console.error;
        	console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" ").slice(0, 160));
        	console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" ").slice(0, 160));
        	let saved: string | null = null;
        	let updates = 0;
        	try {
        		const editor = createSpecEditor(
        			md,
        			(next) => {
        				saved = next;
        				updates++;
        			},
        			extraExtensions,
        		);
        		const loaded = editor.getMarkdown();
        		const updatesBeforeEdit = updates;
        		const parsed = editor.markdown?.parse(md);
        		const parsedTopLevelTypes = (parsed?.content ?? []).map((n: { type?: string }) => n.type ?? "?");
        		let docValid = "ok";
        		try {
        			editor.state.doc.check();
        		} catch (e) {
        			docValid = (e as Error).message;
        		}
        		// Simulate the user typing one character at the end of the first text block
        		// (or, with TYPE_AT=text, right after the first text node wherever it sits).
        		let pos = -1;
        		const typeAtText = process.env.TYPE_AT === "text";
        		editor.state.doc.descendants((node, p) => {
        			if (pos !== -1) return false;
        			if (typeAtText ? node.isText : node.isTextblock) {
        				pos = typeAtText ? p + node.nodeSize : p + 1 + node.content.size;
        				return false;
        			}
        			return true;
        		});
        		if (pos === -1) pos = 1;
        		let typeError: string | null = null;
        		try {
        			editor.view.dispatch(editor.state.tr.insertText("X", pos));
        		} catch (e) {
        			typeError = (e as Error).message;
        		}
        		editor.destroy();
        		return {
        			loaded,
        			updatesBeforeEdit,
        			saved,
        			warnings,
        			parsedTopLevelTypes,
        			typeError,
        			docValid,
        		};
        	} finally {
        		console.warn = origWarn;
        		console.error = origError;
        	}
        }
        
        // react-markdown@10.1.0 lib/index.js:123,360-365: remark-rehype runs with allowDangerousHtml and
        // every `raw` node is then turned into a literal text node (MarkdownContent sets no skipHtml).
        function rawToText() {
        	// biome-ignore lint/suspicious/noExplicitAny: scratch harness
        	const walk = (node: any) => {
        		if (!node.children) return;
        		node.children = node.children.map((child: { type: string; value?: string }) =>
        			child.type === "raw" ? { type: "text", value: child.value } : child,
        		);
        		node.children.forEach(walk);
        	};
        	return walk;
        }
        
        const processor = unified()
        	.use(remarkParse)
        	.use(remarkGfm)
        	.use(remarkMath)
        	.use(remarkRehype, { allowDangerousHtml: true })
        	.use(rawToText)
        	.use(rehypeStringify);
        
        /** HTML as NarraFork's MarkdownContent would build it (react-markdown: raw HTML shown as text). */
        export function renderApp(md: string): string {
        	return String(processor.processSync(md))
        		.replace(/\s+/g, " ")
        		.replace(/>\s+</g, "><")
        		.trim();
        }
        ```
    - [p/SJHXKCk8] 复现脚本 cases.ts
      - [p/S8ng6R59] ````
        // Markdown samples fed through the SpecMarkdownEditor round-trip.
        // `group`: table = 表格；asked = 任务里点名要试的语法；extra = 额外补测（agent 常写的写法）。
        export interface Case {
        	id: string;
        	group: "table" | "asked" | "extra";
        	label: string;
        	md: string;
        }
        
        export const cases: Case[] = [
        	// ---- 表格 ----
        	{
        		id: "table-basic",
        		group: "table",
        		label: "GFM 表格（夹在标题和段落之间，含对齐、行内代码、粗体）",
        		md: "# 方案对比\n\n| 方案 | 优点 | 缺点 |\n| --- | :---: | ---: |\n| A | 快 | 贵 |\n| B | `便宜` | **慢** |\n\n表格后的段落。\n",
        	},
        	{
        		id: "table-no-outer-pipes",
        		group: "table",
        		label: "GFM 表格（无首尾竖线）",
        		md: "前文\n\na | b\n--|--\n1 | 2\n\n后文\n",
        	},
        	{
        		id: "table-only",
        		group: "table",
        		label: "整份文件只有一个表格",
        		md: "| key | value |\n| --- | --- |\n| a | 1 |\n",
        	},
        	{
        		id: "table-in-list",
        		group: "table",
        		label: "列表项里的表格",
        		md: "- 第一项\n\n  | x | y |\n  | - | - |\n  | 1 | 2 |\n\n- 第二项\n",
        	},
        	// ---- 任务里点名的语法 ----
        	{
        		id: "image",
        		group: "asked",
        		label: "图片",
        		md: '见下图：![架构图](./arch.png "架构")\n',
        	},
        	{
        		id: "image-block",
        		group: "asked",
        		label: "单独成段的图片",
        		md: "![流程图](https://example.com/flow.png)\n",
        	},
        	{
        		id: "inline-html-kbd",
        		group: "asked",
        		label: "行内 HTML：<kbd>/<sub>/<br>",
        		md: "按 <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存，H<sub>2</sub>O，第一行<br>第二行\n",
        	},
        	{
        		id: "inline-html-span",
        		group: "asked",
        		label: "行内 HTML：<span style>/<u>/<b>",
        		md: '<span style="color:red">红字</span>，<u>下划线</u>，<b>粗</b>\n',
        	},
        	{
        		id: "html-block-details",
        		group: "asked",
        		label: "HTML 块：<details>/<summary>",
        		md: "<details>\n<summary>展开</summary>\n\n隐藏内容\n\n</details>\n",
        	},
        	{
        		id: "html-block-div",
        		group: "asked",
        		label: "HTML 块：<div align> 包 <img>",
        		md: '<div align="center">\n  <img src="logo.png" width="100">\n</div>\n',
        	},
        	{
        		id: "html-comment",
        		group: "asked",
        		label: "HTML 注释",
        		md: "段落一\n\n<!-- TODO: 补充风险评估 -->\n\n段落二\n",
        	},
        	{
        		id: "footnote",
        		group: "asked",
        		label: "脚注",
        		md: "结论见脚注[^1]。\n\n[^1]: 这是脚注内容。\n",
        	},
        	{
        		id: "task-list",
        		group: "asked",
        		label: "任务列表",
        		md: "- [ ] 待办一\n- [x] 已完成二\n",
        	},
        	{
        		id: "task-list-mixed",
        		group: "asked",
        		label: "任务项与普通项混排",
        		md: "- [ ] 待办\n- 普通项\n",
        	},
        	{
        		id: "snake-case",
        		group: "asked",
        		label: "带下划线的普通文本",
        		md: "调用 snake_case 函数，修改 spec_vfs_service.ts 和 __init__.py\n",
        	},
        	{
        		id: "single-tilde",
        		group: "asked",
        		label: "单个 ~",
        		md: "大约 ~5 分钟，路径 ~/project\n",
        	},
        	{
        		id: "single-tilde-pair",
        		group: "asked",
        		label: "成对单 ~ 与 ~~",
        		md: "~删除~ 与 ~~删除~~\n",
        	},
        	// ---- 补测 ----
        	{
        		id: "angle-brackets",
        		group: "extra",
        		label: "尖括号 / & 普通文本（泛型、比较）",
        		md: "返回 Promise<void>，Map<string, number>，a < b && c > d，R&D\n",
        	},
        	{
        		id: "backslash-path",
        		group: "extra",
        		label: "Windows 路径（反斜杠）",
        		md: "日志在 C:\\Users\\dev\\app.log\n",
        	},
        	{
        		id: "brackets-asterisk",
        		group: "extra",
        		label: "方括号 / 星号普通文本",
        		md: "数组 [1, 2]，乘法 a * b * c\n",
        	},
        	{
        		id: "front-matter",
        		group: "extra",
        		label: "YAML front matter",
        		md: "---\ntitle: 设计\nstatus: draft\n---\n\n# 正文\n",
        	},
        	{
        		id: "soft-break",
        		group: "extra",
        		label: "段内软换行",
        		md: "第一行\n第二行（同一段落）\n",
        	},
        	{
        		id: "blank-lines",
        		group: "extra",
        		label: "连续多个空行",
        		md: "段落一\n\n\n\n段落二\n",
        	},
        	{
        		id: "bullets-star-plus",
        		group: "extra",
        		label: "* / + 列表符号",
        		md: "* a\n* b\n\n+ c\n",
        	},
        	{
        		id: "setext-heading",
        		group: "extra",
        		label: "Setext 标题",
        		md: "标题\n===\n\n副标题\n---\n",
        	},
        	{
        		id: "tilde-fence",
        		group: "extra",
        		label: "~~~ 代码围栏",
        		md: "~~~ts\nconst a_b = 1;\n~~~\n",
        	},
        	{
        		id: "code-fence-mermaid",
        		group: "extra",
        		label: "mermaid 代码块",
        		md: "```mermaid\ngraph TD; A-->B\n```\n",
        	},
        	{
        		id: "ref-link",
        		group: "extra",
        		label: "引用式链接",
        		md: '见 [文档][doc]。\n\n[doc]: https://example.com/doc "Doc"\n',
        	},
        	{
        		id: "autolink",
        		group: "extra",
        		label: "<URL> 自动链接与裸 URL",
        		md: "<https://example.com> 和 https://example.com/a_b\n",
        	},
        	{
        		id: "ordered-start",
        		group: "extra",
        		label: "从 3 开始的有序列表 / 1) 写法",
        		md: "3. 三\n4. 四\n\n1) 一\n2) 二\n",
        	},
        	{
        		id: "nested-4space",
        		group: "extra",
        		label: "4 空格缩进的嵌套列表",
        		md: "- a\n    - b\n        - c\n",
        	},
        	{
        		id: "hard-break",
        		group: "extra",
        		label: "硬换行（两个空格 / 反斜杠）",
        		md: "行一  \n行二\\\n行三\n",
        	},
        	{
        		id: "hr-variants",
        		group: "extra",
        		label: "*** / ___ 分隔线",
        		md: "上\n\n***\n\n中\n\n___\n\n下\n",
        	},
        	{
        		id: "emphasis-underscore",
        		group: "extra",
        		label: "下划线强调",
        		md: "_斜体_ 和 __粗体__\n",
        	},
        	{
        		id: "escaped",
        		group: "extra",
        		label: "反斜杠转义",
        		md: "\\*不是斜体\\*\n",
        	},
        	{
        		id: "math",
        		group: "extra",
        		label: "数学公式",
        		md: "质能 $E=mc^2$，下标 $a_b$\n\n$$\nx_i^2\n$$\n",
        	},
        	{
        		id: "entities",
        		group: "extra",
        		label: "HTML 实体",
        		md: "版权 &copy; 2026，不换行&nbsp;空格\n",
        	},
        	{
        		id: "highlight-heading-id",
        		group: "extra",
        		label: "==高亮== 与 {#id}",
        		md: "## 标题 {#sec-1}\n\n==重点==\n",
        	},
        	{
        		id: "behavior-fence",
        		group: "extra",
        		label: "典型 behavior_fence（原样注入给模型）",
        		md: "- 不要修改 drizzle/ 目录下的文件\n- 只改 server/services/spec_vfs_service.ts，别动 *.test.ts\n- 命令统一用 bunx，不要用 npx\n- 回答使用中文 & 简洁\n",
        	},
        	{
        		id: "json-file",
        		group: "extra",
        		label: "非 md 文件：JSON 内容（如 spec://notes.json）",
        		md: '{\n  "key_name": [1, 2],\n  "nested": {"a": "*"}\n}\n',
        	},
        	{
        		id: "yaml-file",
        		group: "extra",
        		label: "非 md 文件：YAML 内容",
        		md: "steps:\n  - name: build_app\n    run: bun run build\n",
        	},
        ];
        ````
    - [p/ZJsY1nv9] 复现脚本 repro.ts
      - [p/O7mgStSZ] ```
        // Baseline: the exact SpecMarkdownEditor configuration (StarterKit + @tiptap/markdown, no table).
        // Usage: bun run repro.ts [caseId ...]   (no args = all cases)
        import { cases } from "./cases";
        import { hasDomParser, renderApp, roundTrip } from "./harness";
        
        const pick = new Set(process.argv.slice(2));
        const selected = pick.size ? cases.filter((c) => pick.has(c.id)) : cases;
        
        console.log(`window.DOMParser available: ${hasDomParser}`);
        for (const c of selected) {
        	const r = roundTrip(c.md);
        	const sameSource = r.loaded === c.md;
        	const sameRender = renderApp(r.loaded) === renderApp(c.md);
        	console.log(`\n=== [${c.id}] ${c.label}`);
        	console.log(`IN   : ${JSON.stringify(c.md)}`);
        	console.log(`LOAD : ${JSON.stringify(r.loaded)}`);
        	console.log(`SAVED: ${JSON.stringify(r.saved)}`);
        	console.log(
        		`parsed blocks=[${r.parsedTopLevelTypes.join(",")}] updatesBeforeEdit=${r.updatesBeforeEdit} source=${sameSource ? "same" : "changed"} appRender=${sameRender ? "same" : "DIFF"} docValid=${r.docValid} typeError=${r.typeError}`,
        	);
        	if (!sameRender) {
        		console.log(`  render IN : ${renderApp(c.md).slice(0, 300)}`);
        		console.log(`  render OUT: ${renderApp(r.loaded).slice(0, 300)}`);
        	}
        	if (r.warnings.length) console.log(`  warnings: ${r.warnings.join(" | ")}`);
        }
        ```
    - [p/irq0c4CQ] 复现脚本 fix.ts
      - [p/SwNMaNR1] ````
        // Candidate fix: same editor + TableKit (@tiptap/extension-table@3.27.1), optionally
        // TaskList/TaskItem (@tiptap/extension-list@3.27.1, already in bun.lock) and Image.
        // Usage: bun run fix.ts [table|table+task|table+task+image] [caseId ...]
        import { cases as baseCases, type Case } from "./cases";
        import { renderApp, roundTrip } from "./harness";
        
        const { TableKit } = await import("@tiptap/extension-table");
        const { TaskList, TaskItem } = await import("@tiptap/extension-list");
        const { default: Image } = await import("@tiptap/extension-image");
        
        const tableEdgeCases: Case[] = [
        	{
        		id: "t-escaped-pipe",
        		group: "table",
        		label: "单元格里转义的竖线 \\|",
        		md: "| 表达式 | 含义 |\n| --- | --- |\n| a \\| b | 或 |\n",
        	},
        	{
        		id: "t-code-pipe",
        		group: "table",
        		label: "单元格行内代码里的转义竖线",
        		md: "| 命令 | 说明 |\n| --- | --- |\n| `ls \\| wc -l` | 计数 |\n",
        	},
        	{
        		id: "t-br",
        		group: "table",
        		label: "单元格里用 <br> 换行",
        		md: "| 步骤 | 说明 |\n| --- | --- |\n| 1 | 第一行<br>第二行 |\n",
        	},
        	{
        		id: "t-empty-and-link",
        		group: "table",
        		label: "空单元格、链接、下划线文本",
        		md: "| 文件 | 链接 | 备注 |\n| --- | --- | --- |\n| spec_vfs.ts | [文档](https://x.dev/a_b) |  |\n",
        	},
        	{
        		id: "t-ragged",
        		group: "table",
        		label: "行的列数少于表头",
        		md: "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n",
        	},
        	{
        		id: "t-realistic-spec",
        		group: "table",
        		label: "典型 agent 设计笔记（标题+列表+表格+代码）",
        		md: [
        			"# 存储迁移设计",
        			"",
        			"## 目标",
        			"",
        			"- 把 `spec_file_revisions` 的大字段移出主表",
        			"- 保持 API 不变",
        			"",
        			"## 方案对比",
        			"",
        			"| 方案 | 改动面 | 风险 | 结论 |",
        			"| --- | --- | --- | --- |",
        			"| A：原地加列 | 小 | 低 | ✅ 采用 |",
        			"| B：新表 + 回填 | 大 | 中 | ❌ |",
        			"",
        			"## 步骤",
        			"",
        			"1. 改 `server/db/schema.ts`",
        			"2. 运行 `bun run db:generate`",
        			"",
        			"```ts",
        			"const MAX_SPEC_FILE_CHARS = 200_000;",
        			"```",
        			"",
        		].join("\n"),
        	},
        ];
        
        const mode = process.argv[2] ?? "table";
        const ids = new Set(process.argv.slice(3));
        // biome-ignore lint/suspicious/noExplicitAny: scratch harness
        const extra: any[] = [TableKit.configure({ table: { resizable: false } })];
        if (mode.includes("task")) extra.push(TaskList, TaskItem.configure({ nested: true }));
        if (mode.includes("imageinline")) extra.push(Image.configure({ inline: true }));
        else if (mode.includes("image")) extra.push(Image);
        
        const all = [...baseCases, ...tableEdgeCases];
        const selected = ids.size ? all.filter((c) => ids.has(c.id)) : all;
        console.log(`extensions: StarterKit + Markdown + ${mode}`);
        for (const c of selected) {
        	const r = roundTrip(c.md, extra);
        	const sameRender = renderApp(r.loaded) === renderApp(c.md);
        	// Second round trip: is the output stable (idempotent) once written back?
        	const r2 = roundTrip(r.loaded, extra);
        	console.log(`\n=== [${c.id}] ${c.label}`);
        	console.log(`IN   : ${JSON.stringify(c.md)}`);
        	console.log(`LOAD : ${JSON.stringify(r.loaded)}`);
        	console.log(
        		`appRender=${sameRender ? "same" : "DIFF"} stableOn2ndPass=${r2.loaded === r.loaded} updatesBeforeEdit=${r.updatesBeforeEdit} docValid=${r.docValid} typeError=${r.typeError}`,
        	);
        	if (!sameRender) {
        		console.log(`  render IN : ${renderApp(c.md).slice(0, 260)}`);
        		console.log(`  render OUT: ${renderApp(r.loaded).slice(0, 260)}`);
        	}
        	if (r.warnings.length) console.log(`  warnings: ${r.warnings.join(" | ")}`);
        }
        ````
    - [p/Lf5IJPNy] 复现脚本 headless.ts
      - [p/zvT4eilt] ```
        // No DOM at all: can a regression test run the same parse→serialize round trip headlessly?
        import { Editor } from "@tiptap/core";
        import { TableKit } from "@tiptap/extension-table";
        import { Markdown } from "@tiptap/markdown";
        import StarterKit from "@tiptap/starter-kit";
        const md = "# 方案对比\n\n| 方案 | 优点 |\n| --- | :---: |\n| A | 快 |\n\n表格后的段落。\n";
        for (const withTable of [false, true]) {
        	const editor = new Editor({
        		element: null,
        		extensions: [
        			StarterKit.configure({ link: { openOnClick: false } }),
        			Markdown.configure({ indentation: { style: "space", size: 2 } }),
        			...(withTable ? [TableKit.configure({ table: { resizable: false } })] : []),
        		],
        		content: md,
        		contentType: "markdown",
        	});
        	console.log(`typeof document=${typeof document} withTable=${withTable} ->`, JSON.stringify(editor.getMarkdown()));
        	editor.destroy();
        }
        ```

- [p/pMf5hzCG] 现状：知识库
  - [p/aOYgbhLy] 2026-10-23 对 main @ 7c5170d7 的盘点。
  - [p/sv1MJ4Xo] 搜索先截取前 N 条，再做标签和 ACL 过滤，结果可能变少
  - [p/KojJGsXl] 知识注入按当轮发起人（_currentUserId）解析权限；但上下文跨轮共享，多人会话里 A 读进来的内容 B 能问出来
  - [p/3NGdju5z] 仓库里没有向量检索代码（sqlite-vec、pgvector）
  - [p/ga38jnrJ] human attention 现有五种：异步提问、阻塞提问、权限、计划审批、反思
  - [p/Xtj0I8nI] 计划模式提交的是一段 markdown，或 .narrafork/plans/ 下的计划文件

- [p/5N6EK3Bl] 待定问题
  - [p/i5q1KUdz] 提问指派给做决定的人（通常是 human:owner），会出现在收件箱里。需要先调研的，在提问下建调研子任务指派给 agent；调研做完，在提问下写一条带 #建议 的块，提问就带着建议进收件箱，负责人可以一次采纳多条（answer）。回答写成子块，形成决策后链接到「设计决策」。
  - [p/hLvWQ8rF] SpecMarkdownEditor 丢内容
    - [p/jrRCI1E3] [ ] Q27 Spec 文件以什么方式编辑：继续以所见即所得为主（补上表格、任务列表、图片扩展，长期保留检测），还是改成源码优先、所见即所得可选（像文件编辑器的 raw / split / preview）？ @human:owner
      - [p/jJqrLgBe] 建议：源码优先、所见即所得可选（agent:w-table 报告的倾向）。agent 读写 spec 靠精确字符串匹配（Edit 的 old_string），所见即所得一定会改写字节：`spec_vfs_service.ts` 存回去成了 `spec\_vfs\_service.ts`，agent 再拿原文去 Edit 就对不上；而且加了扩展，HTML、脚注、front matter 等照样保不住（[[p/93bNRxN4]]）
    - [p/DszXEDMJ] [ ] Q28 检测到编辑器保不住的语法（表格、HTML、图片、任务列表、脚注、front matter）时怎么处理：禁止在所见即所得里保存、改成只读并提供源码按钮，还是只弹确认框？ @human:owner
      - [p/Pl9BoUPf] 建议：不用确认框，它最弱，用户很容易直接点过去。检测到就不允许在所见即所得里保存（拦住 SpecPanel 的 handleSave 和 Ctrl/Cmd+S，或者 setEditable(false)），查看改用现成的只读 MarkdownContent 分支（能正确渲染表格），并默认进源码模式（agent:w-table 报告的倾向；检测方法见 [[p/93bNRxN4]]）
    - [p/FUd5vw6c] [ ] Q29 Tiptap 版本：整套 @tiptap/* 升到 3.32.0（修好单元格里竖线转义和 `<br>`，但要回归 InlineComposerEditor 输入框），还是留在 3.27.1、自己覆盖 Table 的 renderMarkdown 补竖线转义？见 [[p/9K1u88rW]] @human:owner
      - [p/gr8zXcfm] 建议：分两步，不把升级和修复绑在一起。先在 3.27.1 上加 TableKit（resizable: false），自己覆盖 Table 的 renderMarkdown 给单元格里的 `|` 补转义，配上不依赖 DOM 的单元测试（复现脚本 headless.ts 证明可行）；整套 Tiptap 升到 3.32.0 另开一个 PR，回归聊天输入框 InlineComposerEditor。理由：丢表格是数据丢失，要尽快修；升级会碰到每天都在用的输入框，风险不同
    - [p/2npkqyKh] [ ] Q30 非 .md 的 spec 文件（agent 建的 .json、.yaml 等）和 behavior_fence，是否一律改用纯文本编辑？ @human:owner
      - [p/Tuyh1rzU] 建议：是。非 .md 路径（包括 behavior_fence）默认用源码模式：JSON、YAML 经所见即所得保存一次就不再合法；behavior_fence 会原样注入模型提示，`\_`、`&amp;` 这类转义会直接进 prompt（agent:w-table 报告的倾向）
    - [p/aPJZmbvr] [ ] Q31 数据恢复：要不要做 spec 的历史查看和恢复功能？要不要先离线排查一遍现有数据库里被 UI 保存吞掉表格的记录？ @human:owner
      - [p/GX4PfHiP] 参考（报告对要不要做没有倾向，这条不是建议）：旧内容都还在 spec_file_revisions 里（[[p/jr2Sj3AY]]）；排查可以写离线脚本，找 created_by = 'user'、父 revision 含表格分隔行而本条不含的记录，按主线程规则只能在后台或离线跑，不能进请求路径
      - [p/LRsbfpSx] 建议：先写离线排查脚本，在后台跑、不进请求路径，找出 created_by 是 user、父 revision 含表格分隔行而本条不含的记录，把结果交给人看；历史查看和恢复不在 spec:// 上单独做，放进大纲系统的时间机器里统一做，因为 spec:// 在 P2 就退役了
  - [p/nYkmnrR7] 任务反思与 /goal
    - [p/aygA8oG9] [ ] Q25 任务反思：采纳 Q13 的调研建议吗？建议是不改成可选，等 P2 补齐四个缺口后，把门禁、两个决策工具、`spec_protected_tasks` 和 human attention 里的 task_reflection 一起删掉；还想要模型复核的话，照 §9.7 只在任务上留审查意见，不阻塞，默认关闭 @human:owner
      - [p/E5Mnjew9] 建议：采纳调研建议（[[p/MwhYZUvK]]）：不改成可选，P2 补齐四个缺口后一起删。理由：没有找到它拦对过的记录，误拦和故障却有一串；它自己不能验证，只能读历史
    - [p/E3mTuA2I] [ ] Q26 `/goal` 建的任务默认按草稿还是按已批准处理？调研建议默认按已批准：`/goal` 是用户在说「务必完成」；按草稿处理时，无人值守的 agent 可以提前标完成、停掉续跑，要等人看看板才会发现（设计文档 §11.4 现在写的是草稿；调研时是 §10.4，插入 §10 后顺延） @human:owner
      - [p/bi6wsRvl] 建议：默认按已批准。批准的只是 `/goal` 本身（目标和验收），agent 在下面建的步骤仍是草稿，可以随时调整；整个目标完成要人确认。这正好接住任务反思想防的「提前标完成」
  - [p/u0N4je9K] 块内方言的细项
    - [p/OdnlnA0S] [ ] Q17 表格是否正式进块体？设计文档已把表格写进块体，但标着「表格待定」（§7.7）；单元格里能不能换行（docs 样本里唯一的 HTML `<br>` 全用在表格里）？见原型发现 [[p/8ufzzqLQ]] @human:owner
      - [p/vgXD2A1o] 建议：表格进块体，按方言草案的 GFM 写法；单元格只放行内内容、不换行，docs 里 12 处 `<br>` 迁移时改成「；」。编辑器用 prosemirror-tables。SpecMarkdownEditor 丢表格的问题单独核实（[[p/5nB0TYwk]]），不等方言定稿
    - [p/4Z6Wizxz] [ ] Q18 提及 `[[…]]` 怎么写：存短 id 还是别名（人和 agent 都用别名，原型正文里存的就是别名，见 [[p/bBLXUFIK]]）？同一空间内要不要省略前缀？会话空间的块怎么写绝对地址（`s` 指「本会话」，随读者变，不能直接存）？要不要支持 `|显示文本`？ @human:owner
      - [p/9asRgmWS] 建议：正文存 `[[空间/短id]]`：短 id 稳定，改别名不断链。输入时可以写别名、省略本空间前缀，保存时规范成短 id；给人和 agent 显示时渲染成别名或标题。会话空间的块存绝对的会话空间 id。支持 `[[地址|显示文本]]`，表格里的竖线要转义
    - [p/Gg3kqVYm] [ ] Q19 嵌入 `![[…]]` 做成行内节点（设计文档 §7.7 现在这么写），还是只能独占一块？ @human:owner
      - [p/IhFIjzLA] 建议：首版只做独占一块的嵌入，行内只用提及。行内嵌入要在一行里放一棵可编辑的子树，编辑器和渲染都复杂，docs 样本和原型里也没有这种需求
    - [p/mrNkT2jT] [ ] Q20 块内要不要支持数学和图片？不支持的话写入时就得转义，否则只读视图（MarkdownContent）照样会渲染 @human:owner
      - [p/WM6CxNVZ] 建议：首版都不进方言，写入时转义（`!\[`、`\$`）。图片以后做成附件块（上传、预览、尺寸要单独设计），数学看需求再加
    - [p/JsCuWe1O] [ ] Q21 段内单换行：保留为软换行（显示成空格），还是统一规范成硬换行？ @human:owner
      - [p/hA5QrA8g] 建议：块内的换行就是换行：存的就是普通的换行符，渲染时按硬换行显示（marked 的 breaks、remark-breaks）。块已经是段落的单位，软换行在大纲里用处不大；也省掉「反斜杠加换行」这种 agent 容易写错的写法
    - [p/i4dnplQK] [ ] Q22 agent 写入列表、多段等方言外的结构时怎么办：拒绝、拆成子块，还是转义成普通文本？ @human:owner
      - [p/v5LsHi6G] 建议：拆成子块（列表项、多段各成一块），工具返回里告诉 agent 拆成了什么；拆不了的（HTML 块、定义列表）按普通文本保留。符合「能转换就不拒绝」
    - [p/iRCYt4KJ] [ ] Q23 块内转义用哪种策略：最小转义（好读，对 agent 写入的改动少，但要对三个解析器做模糊测试），还是 Tiptap 式保守转义（省心，但会把 `snake_case` 这类文本也转义掉）？agent 写反斜杠容易出错，见 [[p/6hhSPqRU]] @human:owner
      - [p/2DxhJEme] 建议：最小转义，再做三个解析器的一致性模糊测试：以 `shared/` 里的 marked@18 分词器为准，只读渲染的 micromark 和 Tiptap 自带的 marked@17 对不上的写成用例。保守转义会把 agent 写的 `snake_case` 改掉，和 Y.Text 做 diff 时还会来回改写
    - [p/e4GX76E5] [ ] Q24 标题级别用 1–6 还是 1–3？分隔线要不要做成块体（docs 样本里 `---` 有 135 处）？ @human:owner
      - [p/XCE1dFc7] 建议：标题 1–3 级。docs 样本里 h4 只有 18 个，层级本来就由大纲表达，迁移时 h4 及以下改成粗体段落。分隔线不做块体，迁移时丢掉，需要分组就用父块
  - [p/TxVzefA3] 协作规则的默认值
    - [p/G8CCrUUY] [ ] Q1 「创建人」指 agent 的创建者，还是计划的创建者？ @human:owner
      - [p/kNlmXIVr] 建议：指 agent 的创建者，也就是责任人链（§9.4）：后果落到派出这个 agent 的人身上。计划的作者另记为计划根的作者，计划被代批修改时通知他，但 agent 的后果不算到他头上
    - [p/8NPAfqiW] [ ] Q2 D1 的例外改成「转成提议、不打断 agent」，可以吗？ @human:owner
      - [p/u6vfIWaq] 涉及 [[p/D1a]]
      - [p/fi4qzubi] 建议：可以。原型按这个实现了，转成的提议进负责人的收件箱，agent 不停下；实际使用中这两种例外还没触发过，暂时没有反例
    - [p/t5G1F2nN] [ ] Q3 代批授权：只能逐个计划授权，还是允许责任人设一个会话级默认值？ @human:owner
      - [p/InRYqYtU] 建议：首版只做逐个计划授权，默认不授权；用起来发现每次都在勾同一个选项，再加责任人级的默认值
    - [p/iGqfdydQ] [ ] Q4 规划阶段默认只读（像现在的计划模式），还是默认宽松？ @human:owner
      - [p/t8VmsdVH] 建议：默认宽松，只读作为可选。计划就是大纲里的任务子树，规划时本来就要写大纲、读代码、跑只读命令；要防的是规划阶段改代码，可以单独做成「规划时不改文件」的选项
    - [p/7XCKKkng] [ ] Q5 主题页要不要标准结构（概述、职责、关键决策、坑、不变量、试过的方案），做成内置模板？ @human:owner
      - [p/2bNd52LS] 建议：做成可选的内置模板（P5），不强制；提炼归位时，目标页有对应小节就放进小节，没有就放到页尾的「待整理」
  - [p/sxbH6X7b] [x] Q6 块内 markdown 方言支持哪些行内语法和块体？规范写法怎么定？ @agent:w-dialect
    - [p/84a3O52n] 原型发现：表格要能做块体，见「原型发现」页
    - [p/M730ipwK] 调研说明（agent:w-dialect，只读调研，没有修改或创建文件）：仓库没装 node_modules，Tiptap 各包的源码按 bun.lock 里的版本从 npm 取下来读；marked 17 和 18 的行为是实际跑出来的，用校验和与 bun.lock 一致的包在内存里执行，没有落盘。下面写「实测」的都是这样得到的
    - [p/DEimNFzI] 样本：docs/ 下 54 篇（脚本统计），行内代码 9704 处；`**` 粗体 3296 处，`__` 为 0；`-` 列表 4142 行，其中嵌套 496 行；表格 249 张；h2 和 h3 共 1513 个，h4 只有 18 个；代码块 321 个，全部用反引号围栏；引用 150 行，`---` 135 处，链接 113 个，删除线 3 处；斜体、图片、脚注、数学、`[[…]]`、`#标签` 都是 0；HTML 只有表格里的 `<br>`，共 12 处。原型 log.jsonl 里 agent 写的 126 个块全是单行纯文本，唯一用到的语法是 `[[p/别名]]`
    - [p/QBhtNZSc] 方言草案：块内 markdown 的规范写法。未定稿，「支持」一栏的「待确认」「待定」和报告里需要人决定的各点，要负责人拍板
      | 项 | 规范写法 | 支持 | 依据 |
      |---|---|---|---|
      | 段落 | 行内内容。硬换行写 `\` 加换行。行首会被读成块结构的符号前加 `\`，包括 `#`、`>`、`-`、`+`、`1.`、`<`、竖线、反引号围栏、`---` | 是 | OD:99、438 |
      | 标题 | `## 文本`：单行，不写闭合 `#`；setext 改写成 ATX | 是 | OD:438 |
      | 代码 | 反引号围栏加语言。围栏长度取 3 和「内容里最长的反引号串 + 1」中较大的。不用 `~~~`，不用缩进代码。内容原样保留；`mermaid` 在只读视图里画成图 | 是 | MC:277；PM:505 |
      | 引用 | 每行以 `> ` 开头，内容是一段行内文本；不嵌套 | 是 | OD:438 |
      | 表格 | GFM 写法：首尾带竖线，格两侧各一个空格，不补齐列宽；分隔行用 `---`、`:--`、`--:`、`:-:`；必须有表头。格内只放行内内容，竖线一律加反斜杠转义（代码里和 `[[…]]` 里也要） | 待确认（[[p/Q17]]） | 原型发现 [[p/8ufzzqLQ]] |
      | 粗体、斜体 | `**x**`、`*x*`；输入的 `__`、`_` 改写成星号。沿用 EC 对中文标点的放宽，`**注意：**说明` 算粗体（`_` 不放宽） | 是 | EC:1-27，MC 和 PM 都已调用 |
      | 行内代码 | 外层反引号比内容里最长的反引号串多 1 个；内容首尾是反引号时补一个空格 | 是 | CommonMark |
      | 删除线 | `~~x~~`；单个 `~` 一律写成 `\~` | 是 | 实测 marked 把 `1~2天，3~5个` 解析成删除线；remark-gfm 默认也认单个 `~` |
      | 链接 | `[文本](目标)`，目标含空格或括号时用 `<>` 包起来。文本就是网址时写成 `<https://…>`。协议只放行 http、https、mailto、tel 和相对路径 | 是 | PM:1387、1550；实测裸网址会把后面的中文一起吞进链接 |
      | 提及 | `[[空间/短id]]`，目标形式待定（[[p/Q18]]） | 是 | OD:124、439；PR/outline.py:81 |
      | 嵌入 | `![[空间/短id]]`，建议独占一块（[[p/Q19]]） | 是 | OD:125、449 |
      | 标签 `#…` | 首版不进正文，`#` 按普通字符处理 | 否 | OD:984（标签方案 [[p/Q10]] 未定） |
      | 转义、实体 | 只在会被误读的地方转义，多余的 `\` 去掉。`&amp;` 这类实体解码成字符；看起来像实体的 `&` 写成 `\&` | — | PM 不解码实体，`&amp;` 会原样显示 |
      | HTML | 原样当文本保留 | 字面 | react-markdown 默认把 HTML 转成文本；PM:935 同样 |
      | 图片、数学、脚注 | 当普通文本保留，规范化时写成 `!\[`、`\$`、`\[^`，免得只读视图照原语法渲染 | 待定（[[p/Q20]]） | OD:101；MC:790-799 |
      | 列表、多段、分隔线、HTML 块、各种定义 | 方言外，需要结构就用子块 | 否 | OD:99 |
      | 下划线 `++`、高亮、上下标、emoji 短码、`@人` | 按普通字符处理 | 否 | — |
      | U+E000–E002、控制字符 | 写入时剔除 | — | PM:161；EC:31（渲染器内部用作哨兵） |
      - [p/HeGZubFu] 缩写：OD = docs/OUTLINE_KNOWLEDGE-DESIGN.md，行号按 eeb244b6 的版本（21c0ff6f 之后这份文档改过，行号已对不上）；MC = frontend/components/narrator/markdown/MarkdownContent.tsx；PM = shared/pretext-layout/parse-markdown.ts；EC = shared/markdown-emphasis-compat.ts；PR = prototypes/outline/
    - [p/xVo1qB82] 兼容性：能直接复用的
      - [p/nr4P8tvu] 只读渲染：MarkdownContent.tsx 和 pretext 的 parse-markdown.ts 已经覆盖方言内的全部块体和标记，HTML 都当文本显示，中文粗体也都先经过 markdown-emphasis-compat.ts 处理。缺的是 `[[…]]` 和 `![[…]]`，而且必须在分词阶段识别（micromark 扩展加 marked 扩展），不能解析完再替换：实测 `[[p/…]](上文)` 会被解析成链接，`![[p/…]](图)` 会被解析成图片
      - [p/h6bu1aby] 解析：marked@18 是纯 JS，已经在 shared/ 里用，浏览器和 Bun 都能跑，可以当方言的分词器；序列化器要自己写。浏览器和服务端必须共用 shared/ 里的同一份实现：编辑器会把块序列化后和 Y.Text 做 diff（设计文档 eeb244b6 版第 441 行），两边写法不一致就会互相改写
      - [p/mBXFjRkH] 编辑器：@tiptap/pm（含 prosemirror-tables）可以直接用；InlineComposerEditor.tsx:451-465 的行内 atom + NodeView、composer-document-adapter.ts 的位置映射，都可以当样板
      - [p/gc9dLB0q] 链接安全与文件链接：pretext 的 parse-markdown.ts 里的 parseHref（需要导出）和 shared/markdown-file-path.ts 可以复用
    - [p/r1hfFkKq] 兼容性：有冲突的
      - [p/xzTEAMhq] @tiptap/markdown（SpecMarkdownEditor 在用）不适合做方言的规范实现，原因见子块；TM 指 @tiptap/markdown@3.27.1 的 src/MarkdownManager.ts
        - [p/Azsb3xZu] 浏览器里用 DOMParser 把 HTML 解析成节点，服务端没有 window 就按文本保留（TM:953），同一段正文两边结果不同
        - [p/Dime2AKd] 普通文本里的 `\`、反引号、`*`、`_`、`[`、`]`、`~` 一律转义，`&`、`<`、`>` 编成实体（TM:1100、1112），`snake_case` 会变成 `snake\_case`
        - [p/xDXrrXPX] 硬换行写成两个尾随空格，代码围栏和行内代码的反引号个数是固定的
        - [p/s5RvMT7z] 没有对应处理器的语法直接丢弃（TM:921）：表格整张丢，图片只剩 alt 文字
        - [p/G7xOy6xD] StarterKit 自带的下划线输出 `++x++`，现有渲染器显示成原字符
        - [p/zG5OvBRc] 注册分词扩展会改动全局的 marked 实例（TM:262）
      - [p/f3TO9Yre] 顺带发现：SpecMarkdownEditor 没装表格扩展，编辑含表格的 spec 文件并保存会丢掉表格。这是读源码推断的，没在浏览器里实测
        - [p/q2HXRgKF] 复核：属实。agent:w-table 按 bun.lock 的版本用脚本复现了（不是在浏览器里），见 [[p/5nB0TYwk]]；原文「没在浏览器里实测」那句是当时的情况
      - [p/pb27hkSh] 三套解析器并存：micromark（MarkdownContent.tsx）、marked@18（pretext 的 parse-markdown.ts）、marked@17（Tiptap 自带，bun.lock:2631）。方言只能取三者行为一致的子集
      - [p/BBcHXgpM] MarkdownContent.tsx 没有方言模式：GFM 始终开着（包括脚注、自动链接、单个 `~` 删除线）；检测到公式就加载数学插件；外链图片直接加载（MarkdownImage.tsx:10）。浏览器不支持正则后行断言时，GFM 整个关掉（MarkdownContent.tsx:556-564、791）
      - [p/C0imM1Pv] MarkdownContent.tsx 和 pretext 的 parse-markdown.ts 已有分歧：脚注（实测 marked 会把它变成链接）；图片（parse-markdown 只显示 alt 文字，:921）；math 代码块（parse-markdown 渲染成公式 :519，MarkdownContent 显示成代码）；实体（parse-markdown 不解码）
      - [p/nkFQtdFm] `#` 已有别的用途：composer 的 `#file:路径:行`（file-reference-input.ts:147-155），原型的临时标签 `{#s1}` / `[[#s1]]`（原型 README.md:45-57），以及正文里的 `#81`、色值 `#1a1b1e`
      - [p/OAZH2GuS] 表格里的竖线：表格单元格里的 `[[p/x|显示]]` 会被竖线切开，实测 marked 把它拆成两格，多出来的格被丢掉
    - [p/yEFUKdSZ] 协调者（agent:steward）：上面的结论按 agent:w-dialect 的报告代记，提交里执行者是 w-dialect、代记人是 steward。报告「需要人决定」的 9 点里，8 点建成了提问：[[p/Q17]] 表格、[[p/Q18]] 提及写法、[[p/Q19]] 嵌入、[[p/Q20]] 数学和图片、[[p/Q21]] 段内换行、[[p/Q22]] 方言外结构、[[p/Q23]] 转义策略、[[p/Q24]] 标题级别与分隔线；第 4 点（`#标签` 进不进正文）和已有的 [[p/Q10]] 重复，补充说明记在 Q10 下面。设计文档 21c0ff6f 里「完整草案见原型里的 Q6」指的就是这里
    - [p/gM0R8Ege] 协调者的看法（agent:steward，不是调研结论）：原型自己就不符合这份草案。outline.py 在正文任何位置都把双中括号认成提及，行内代码里也一样，所以代记时没法照抄报告里用真实别名 D5、D6 写的示例，只能改成 `[[p/…]]`；转义（[[p/Q23]]）和提及写法（[[p/Q18]]）在原型里就该先有答案。另外，「SpecMarkdownEditor 保存会丢表格」（[[p/f3TO9Yre]]）如果属实，是现有产品里的数据丢失，建议不等方言定稿，先单独在浏览器里核实
    - [p/4LKK4aHV] 专注 agent agent:w-dialect 的报告（Q6：块内 markdown 方言）
      - [p/Elj9SXCJ] 只读调研，没有修改或创建任何文件。
      - [p/FSxNkR3h] **路径缩写**
        - [p/WtNtPzzf] MC = `frontend/components/narrator/markdown/MarkdownContent.tsx`（react-markdown + remark-gfm）
        - [p/6dPPNfgy] PM = `shared/pretext-layout/parse-markdown.ts`（聊天 vlist，用 marked@18）
        - [p/TOY9Bv9n] EC = `shared/markdown-emphasis-compat.ts`
        - [p/9jsrMSK2] OD = `docs/OUTLINE_KNOWLEDGE-DESIGN.md`
        - [p/leVQTV1L] PR = `prototypes/outline/`
        - [p/9vPny2kG] TM = npm 包 `@tiptap/markdown@3.27.1` 的 `src/MarkdownManager.ts`
      - [p/cjDrR8tS] **怎么核实的**：仓库没有装 node_modules。Tiptap 各包的源码按 bun.lock 里的版本从 npm 取下来读。marked 17 和 18 的行为是实际跑出来的：用校验和与 bun.lock 一致的包在内存里执行，没有落盘。
      - [p/gVRKBZIs] **样本**
        - [p/eW1ibpU5] docs/ 下 54 篇（脚本统计）：行内代码 9704 处；`**` 粗体 3296 处，`__` 为 0；`-` 列表 4142 行，其中嵌套 496 行；表格 249 张；h2 和 h3 共 1513 个，h4 只有 18 个；代码块 321 个，全部用 ```；引用 150 行，`---` 135 处，链接 113 个，删除线 3 处；斜体、图片、脚注、数学、`[[…]]`、`#标签` 都是 0；HTML 只有表格里的 `<br>`，共 12 处。
        - [p/xWDrIVaU] 原型 `PR/data/log.jsonl` 里 agent 写了 126 个块，全是单行纯文本，唯一用到的语法是 `[[p/别名]]`。
      - [p/nVFgDV49] 一、方言草案
        - [p/74zGBLJ1] | 项 | 规范写法 | 支持 | 依据 |
          |---|---|---|---|
          | 段落 | 行内内容。硬换行写 `\` 加换行。行首会被读成块结构的符号前加 `\`，包括 `#`、`>`、`-`、`+`、`1.`、`<`、竖线、反引号围栏、`---` | 是 | OD:99、438 |
          | 标题 | `## 文本`：单行，不写闭合 `#`；setext 改写成 ATX | 是 | OD:438 |
          | 代码 | 反引号围栏加语言。围栏长度取 3 和「内容里最长的反引号串 + 1」中较大的。不用 `~~~`，不用缩进代码。内容原样保留；`mermaid` 在只读视图里画成图 | 是 | MC:277；PM:505 |
          | 引用 | 每行以 `> ` 开头，内容是一段行内文本；不嵌套 | 是 | OD:438 |
          | 表格 | GFM 写法：首尾带竖线，格两侧各一个空格，不补齐列宽；分隔行用 `---`、`:--`、`--:`、`:-:`；必须有表头。格内只放行内内容，竖线一律加反斜杠转义（代码里和 `[[…]]` 里也要） | 待确认 | 原型发现 p/8ufzzqLQ |
          | 粗体、斜体 | `**x**`、`*x*`；输入的 `__`、`_` 改写成星号。沿用 EC 对中文标点的放宽，`**注意：**说明` 算粗体（`_` 不放宽） | 是 | EC:1-27，MC 和 PM 都已调用 |
          | 行内代码 | 外层反引号比内容里最长的反引号串多 1 个；内容首尾是反引号时补一个空格 | 是 | CommonMark |
          | 删除线 | `~~x~~`；单个 `~` 一律写成 `\~` | 是 | 实测 marked 把 `1~2天，3~5个` 解析成删除线；remark-gfm 默认也认单个 `~` |
          | 链接 | `[文本](目标)`，目标含空格或括号时用 `<>` 包起来。文本就是网址时写成 `<https://…>`。协议只放行 http、https、mailto、tel 和相对路径 | 是 | PM:1387、1550；实测裸网址会把后面的中文一起吞进链接 |
          | 提及 | `[[空间/短id]]`，目标形式见决定 2 | 是 | OD:124、439；PR/outline.py:81 |
          | 嵌入 | `![[空间/短id]]`，建议独占一块 | 是 | OD:125、449 |
          | 标签 `#…` | 首版不进正文，`#` 按普通字符处理 | 否 | OD:984（标签方案 Q10 未定） |
          | 转义、实体 | 只在会被误读的地方转义，多余的 `\` 去掉。`&amp;` 这类实体解码成字符；看起来像实体的 `&` 写成 `\&` | — | PM 不解码实体，`&amp;` 会原样显示 |
          | HTML | 原样当文本保留 | 字面 | react-markdown 默认把 HTML 转成文本；PM:935 同样 |
          | 图片、数学、脚注 | 当普通文本保留，规范化时写成 `!\[`、`\$`、`\[^`，免得只读视图照原语法渲染 | 待定 | OD:101；MC:790-799 |
          | 列表、多段、分隔线、HTML 块、各种定义 | 方言外，需要结构就用子块 | 否 | OD:99 |
          | 下划线 `++`、高亮、上下标、emoji 短码、`@人` | 按普通字符处理 | 否 | — |
          | U+E000–E002、控制字符 | 写入时剔除 | — | PM:161；EC:31（渲染器内部用作哨兵） |
      - [p/zEQRttat] 二、兼容性
        - [p/nHChxyEN] **能直接复用**
          - [p/KfadurXo] 只读渲染：MC 和 PM 已经覆盖方言内的全部块体和标记，HTML 都当文本显示，中文粗体也都先经过 EC 处理。缺的是 `[[…]]` 和 `![[…]]`，而且必须在分词阶段识别（micromark 扩展加 marked 扩展），不能解析完再替换。实测 `[[p/D5]](上文)` 会被解析成链接，`![[p/D6]](图)` 会被解析成图片。
          - [p/rp5CYHWb] 解析：marked@18 是纯 JS，已经在 `shared/` 里用，浏览器和 Bun 都能跑，可以当方言的分词器；序列化器要自己写。浏览器和服务端必须共用 `shared/` 里的同一份实现。编辑器会把块序列化后和 Y.Text 做 diff（OD:441），两边写法不一致就会互相改写。
          - [p/2dbVmun7] 编辑器：`@tiptap/pm`（含 prosemirror-tables）可以直接用。`InlineComposerEditor.tsx:451-465` 的行内 atom + NodeView、`composer-document-adapter.ts` 的位置映射，都可以当样板。
          - [p/R93Sfbse] 链接安全与文件链接：PM 里的 `parseHref`（需导出）和 `shared/markdown-file-path.ts` 可以复用。
        - [p/CuIK8rb1] **有冲突**
          - [p/Xe3bNB86] `@tiptap/markdown`（SpecMarkdownEditor 在用）不适合做规范实现：
            - [p/RoR1HRGQ] 浏览器里用 DOMParser 把 HTML 解析成节点，服务端没有 window 就按文本保留（TM:953），同一段正文两边结果不同。
            - [p/qkKa7IKv] 普通文本里的 `\`、反引号、`*`、`_`、`[`、`]`、`~` 一律转义，`&`、`<`、`>` 编成实体（TM:1100、1112），`snake_case` 会变成 `snake\_case`。
            - [p/WZ1Tg3lP] 硬换行写成两个尾随空格，代码围栏和行内代码的反引号个数是固定的。
            - [p/lmJIrHyc] 没有对应处理器的语法直接丢弃（TM:921）：表格整张丢，图片只剩 alt 文字。
            - [p/Oc0n9AVy] StarterKit 自带的下划线输出 `++x++`，现有渲染器显示成原字符。
            - [p/R8JR5M2D] 注册分词扩展会改动全局的 marked 实例（TM:262）。
          - [p/0sG8FhGX] 顺带发现：SpecMarkdownEditor 没装表格扩展，编辑含表格的 spec 文件并保存会丢掉表格。这是读源码推断的，没在浏览器里实测。
          - [p/Bt5GukHT] 三套解析器并存：micromark（MC）、marked@18（PM）、marked@17（Tiptap 自带，`bun.lock:2631`）。方言只能取三者行为一致的子集。
          - [p/kXcK8np5] MC 没有方言模式：GFM 始终开着（包括脚注、自动链接、单个 `~` 删除线）；检测到公式就加载数学插件；外链图片直接加载（`MarkdownImage.tsx:10`）。浏览器不支持正则后行断言时，GFM 整个关掉（MC:556-564、791）。
          - [p/Kgz4RBqZ] MC 和 PM 已有分歧：脚注（实测 marked 会把它变成链接）；图片（PM 只显示 alt 文字，PM:921）；math 代码块（PM 渲染成公式 PM:519，MC 显示成代码）；实体（PM 不解码）。
          - [p/2KVstikN] `#` 已有别的用途：composer 的 `#file:路径:行`（`file-reference-input.ts:147-155`），原型的临时标签 `{#s1}` / `[[#s1]]`（`PR/README.md:45-57`），以及正文里的 `#81`、色值 `#1a1b1e`。
          - [p/5bnTtlqU] 表格里的竖线：表格单元格里的 `[[p/x|显示]]` 会被竖线切开。实测 marked 把它拆成两格，多出来的格被丢掉。
      - [p/AkF3Epo3] 三、需要人决定
        - [p/770imkxO] 表格是否正式进块体（OD:99、438 只列了四种），单元格里能不能换行（样本里唯一的 HTML `<br>` 全用在表格里）。
        - [p/F1166yp1] `[[…]]` 的写法：存短 id 还是别名（原型发现 p/bBLXUFIK 指出人和 agent 都用别名，原型正文里存的就是 `[[p/D5]]`）；同一空间内要不要省略前缀；会话空间的块怎么写绝对地址（`s` 指「本会话」，会随读者变，不能直接存）；要不要支持 `|显示文本`。
        - [p/3646ChXp] 嵌入是行内节点（OD:439），还是只能独占一块。
        - [p/bcGoxrSD] `#标签` 是否进正文（取决于 Q10）。如果进，要定字符集和边界：中文不用空格分词、纯数字、色值、`#file:` 都要处理。
        - [p/w7GhgLNq] 数学和图片要不要支持。不支持就得转义，否则 MC 照样渲染。
        - [p/PIE894zI] 段内单换行：保留为软换行（显示成空格），还是统一规范成硬换行。
        - [p/OVo529oe] agent 写入列表、多段等方言外的结构时：拒绝、拆成子块，还是转义成普通文本。
        - [p/IbJ9dtvc] 转义策略：最小转义（可读，对 agent 写入的改动少，但要对三个解析器做模糊测试），还是 Tiptap 式保守转义（更省心，但会把 `snake_case` 这类文本也转义掉）。参考：原型发现 p/6hhSPqRU 记录了 agent 写反斜杠容易出错。
        - [p/PW82jPj4] 标题级别用 1–6 还是 1–3；分隔线要不要做成块体（样本里 `---` 有 135 处）。
  - [p/shELx7W7] [ ] Q7 块选择模式与移动端手势的交互细节
  - [p/uBFCt3q3] [ ] Q8 超长页：占位节点按需替换够不够，还是只靠折叠与聚焦？以 P0 性能数据为准
  - [p/OL2RTQbp] [ ] Q9 知识库旧修订：迁移时只迁当前状态，旧修订只读保留多久？
  - [p/3bxAuIFU] [ ] Q10 标签：属性里的字符串数组，还是像 Obsidian 一样每个标签对应一页？
    - [p/KYtP04jH] 补充（来自 Q6 方言调研，报告「需要人决定」第 4 点）：`#标签` 要不要进块正文取决于这一问。如果进，还要定字符集和边界：中文不用空格分词、纯数字（如 `#81`）、色值（如 `#1a1b1e`）、composer 的 `#file:路径:行` 都要处理；方言草案目前按「首版不进正文」写
  - [p/UMJvCvWQ] [ ] Q11 一个需求跨多个仓库时，项目空间怎么对应多个 projects 行？ @human:owner
    - [p/N5cdiUhM] [x] 调研：一个需求跨多个仓库时，会话、工作目录和项目现在怎么对应，多工作区以后该怎么对应 @agent:w-xrepo
      （运行记录：agent:w-xrepo 的 70 次调用，碰过 33 个文件，0 次失败）
      - [p/KEa7thwQ] 专注 agent agent:w-xrepo 的报告（跨仓库需求怎么对应项目）
        - [p/XqMNUMZX] > 只读调查，基线是当前分支 `claude/youthful-johnson-vu2z3q` @ `becf57ee`。下面的 `路径:行号` 都对应这个提交。标「推断」的是读代码得出、没有实际跑过的结论。唯一做过的实验是 git 探测：在 scratchpad 里分别对子模块、嵌套仓库、worktree、子目录跑了 `git rev-parse --git-common-dir`，看它们各输出什么。
        - [p/tedzQxma] 0. 结论
          - [p/W2wED9E6] **现状是单主项目模型**。会话只有一个「主项目」：有 `contextProjectId` 就用它，否则用本地 cwd 推导出的项目。ACL 的项目门、trait 层、routines、技能、设备授权、执行策略、知识注入、通知都只看主项目。`additional` 链接只在 `contextProjectId` 和 cwd 推导出的项目不同时才会产生，一个会话最多一条，作用也只有一个：让会话出现在另一个项目的会话列表里。即使出现了，列表仍然先过主项目的 ACL 门。远端设备上的目录完全不参与索引。
          - [p/5mqFt3dH] **现有代码里已经有好几种「一个会话碰多个仓库」的情况，每种都有缺口**。最严重的三个：
            - [p/Hr0uL4r5] 会话把 cwd 切到另一个仓库后，DB 里的主项目异步跟着变了，活动会话内存里的项目却没变。知识注入、trait、routines、设备列表用的还是旧项目。会话的可见范围也随之从旧项目成员换成了新项目成员，而会话历史里还留着旧仓库的内容。
            - [p/WTKzUxT1] 会话切到远端设备后，如果它没有 `contextProjectId`，主项目会变成 null。项目门随之消失，只授权给项目的设备也跟着失效（推断）。
            - [p/NrGPQ5XY] `contextProjectId=A`、cwd 在 B 的会话：B 的执行策略、设备、routines 都不生效，B 的成员也看不到这个会话。
          - [p/UwceYJOz] **倾向**：保留「一个主项目作归属和权限锚点」，并把它拆成两层：
            - [p/8Dvfwynk] **归属层**：谁能看会话，需求和任务挂在哪里。仍然只认一个主项目。
            - [p/RRwtNK6Z] **执行层**：每个工作区按它自己所属的项目生效，包括 CLAUDE.md/AGENTS.md、执行策略的 deny 层、设备授权。
            - [p/mznDaAH9] 需求和任务树放在主项目的空间里，用链接、嵌入和提交依据引用其他仓库，其他项目页通过反向链接看到「有外部需求在这里动过」。项目组先不做。真出现「固定几个仓库长期一起开发、成员一致」的需求时，再把项目组做成纯聚合视图，不给它单独的 ACL 轴。
          - [p/nthvYQ3N] **需要人拍板的有十来个点**，最关键的是：主项目怎么定、能不能换；把工作区 B 加进会话需要对 B 有什么权限；B 的成员能看到多少；执行策略按什么规则合并；远端工作区靠什么判断属于哪个项目。详见 §5。
        - [p/PloAcVUx] 1. 现状
          - [p/pxTGvwDP] 1.1 项目怎么建出来
            - [p/6WZT5QrH] **自动建（会话索引顺带建）**：入口是 `resolveProjectForDirectory`（`server/services/project-index.ts:207-234`），规则写在文件头 `server/services/project-index.ts:14-25`。
            - [p/1MXsYwrL] | 目录类型 | 处理 | 代码 |
              |---|---|---|
              | 已在某项目根下（含子目录） | 按路径段边界取**最长前缀**的项目根。已归档的项目也参与匹配，所以归档后不会为同一目录再建一个 | `matchProjectByKey` `server/services/project-index.ts:113-125`；`ancestorKeys` `:99-110`；`directoryKey`（realpath，macOS 下转小写）`:87-96` |
              | git 主仓库根或其子目录 | `git rev-parse --git-common-dir` 得到主仓库根，没有对应项目就当场建一个，**公开**、owner 是会话 owner、名字取目录名 | `probeRepositoryRoot` `:137-155`；`createProjectForRoot` `:173-201`（`visibility: "public"` 在 `:188`）；进程内单飞 `:171`，跨进程靠唯一索引 `uq_projects_root_key`（`server/db/schema.ts:256`） |
              | linked worktree | `--git-common-dir` 指向主仓库的 `.git`，所以归到主仓库的项目。会话 worktree 默认放在 `<repoRoot>/.worktrees/`（`server/services/narrator-worktree-service.ts:1061`），直接被前缀匹配到 | `:131-136` 注释 |
              | 非 git 目录 | 不建项目，会话保持独立 | `:22`、`:217` |
              | bare 仓库、`--separate-git-dir`、子模块 | 输出不以 `/.git` 结尾的都当作「不是仓库」 | `:153` |
              | 远端设备目录 | 不索引 | `isLocalDevice` `:236-238`；`deriveNarratorProjectLinks` 的 `:254` |
            - [p/i5a0DNH8] git 探测缓存 30 秒，最多 512 条（`:46-49`、`:157-168`）。
            - [p/45s8vsZZ] **手动建**：`POST /api/projects` 支持三种方式：clone、init、关联已有目录（`server/routes/projects.ts:149` 起，`:241-246`）。关联已有目录**不要求是 git 仓库**，只记元数据。手动设置或修改 `gitPath` 后，会认领 root key 并在后台全表重建索引（`server/routes/projects.ts:61-63`、`:380`）。有几点要注意：
              - [p/QAA0TTiK] root key 只给最早建的那个项目，同目录的后来者 key 为 null，不参与匹配（`assignProjectRootKey` `server/services/project-index.ts:379-403`）。
              - [p/F4tst3no] 项目表只有一个 `gitPath` 和一个 `rootKey`（`server/db/schema.ts:209`、`:251`），**一个项目只对应一个根目录**。
              - [p/nhUVMNJk] 手动把项目建在「多个仓库的共同父目录」上，按最长前缀规则，父目录下还没有自己项目的仓库都会归进来。这实际上就是一个「项目组」的土办法，只是配置只有一份。
          - [p/VepaVtEr] 1.2 会话怎么归到项目（链接表）
            - [p/OgvnRjwB] 表 `narrator_project_links`：`server/db/schema.ts:692-716`。
              - [p/ZJ7cTWhr] 字段：`role`（`primary`/`additional`）、`source`（`explicit`/`cwd`）、`device_id`（默认 `local`）、`directory`。
              - [p/8VLlV31C] 主键是 `(narrator_id, project_id)`（`:710`），每个会话最多一个 primary，由部分唯一索引保证（`:711-713`）。
            - [p/rkOWNbO9] 推导：`deriveNarratorProjectLinks`（`server/services/project-index.ts:241-267`）。
              - [p/a61A5ZFn] 有 `contextProjectId` 时 → 生成 primary/explicit（`:245-253`）。
              - [p/miqkOqiH] cwd 在本地、且推导出的项目 ≠ `contextProjectId` 时 → 生成一条 cwd 链接。前面没有 explicit 链接就是 primary，有就是 `additional`（`:254-265`）。
              - [p/uxBcEjkU] 所以 **`additional` 只出现在「从项目页或外部渠道创建会话，但 cwd 在另一个仓库」这一种情况**，一个会话最多 2 条链接，`device_id` 永远是 `local`。
            - [p/7Gto208e] `contextProjectId` 怎么来：从项目页创建会话时，要求调用者对该项目有 write（`server/routes/narrators.ts:1285-1292`）。cwd 不传时默认取项目 `gitPath`（`server/routes/narrators.ts:1243`）。传了任意 cwd 也**不检查 cwd 所属项目的权限**。另外 OAuth/外部渠道创建的会话也会带上它（列注释见 `server/db/schema.ts:494-497`）。
            - [p/0EsPvnBq] 什么时候同步：
              - [p/tDp9QQIk] 会话创建：`server/services/narrator-service.ts:1677`。
              - [p/AAkfOr2t] 会话运行时建立：`server/services/narrator-session.ts:1226`，先同步，再按项目取配置。
              - [p/VnTq9YPy] 切目录或切设备之后的 publish：`server/services/workspace-context-service.ts:543`、`:648`，这里是 `void` 异步调用，不等结果。
              - [p/NEmLuF4H] 启动时后台分页重建：`server/main.ts:1780` → `scheduleProjectIndexRebuild` `server/services/project-index.ts:492-513`。
              - [p/NawrTOaY] 改了项目根时也会触发重建。
              - [p/lD8Pzjrt] 子代理建档时（`server/services/narrator-service.ts:1681` 起）**不同步**，要等它的会话运行起来、走到 `:1226` 才同步。
            - [p/OgZogR7h] 链接有变化时会让执行策略缓存失效（`server/services/project-index.ts:357-360`）。
            - [p/RiAXzzH1] PostgreSQL 后端没有这张索引：只认 `contextProjectId`（`server/services/narrator-project.ts:35-37`，`server/services/project-index.ts:341`）。
          - [p/LH1fGD0v] 1.3 权限和配置看哪个项目
            - [p/tDZ927hX] 唯一的答案是 `resolveNarratorProjectId`（`server/services/narrator-project.ts:31-49`）：`contextProjectId`，否则 primary 链接，**additional 一律不参与**。它有三个镜像：Drizzle 表达式 `narratorProjectIdColumn`（`:72-74`）、原生 SQL `narratorProjectIdText`（`server/services/read/acl-sql.ts:94-96`），以及同步版 `server/services/tool-final-start-authorization.ts:72-85`。
            - [p/yA3tup45] | 用途 | 怎么用主项目 | 代码 |
              |---|---|---|
              | 会话读写 ACL 的「项目门」 | 主项目不可读，就挡住所有非 owner、非 public 的访问（授权也一样挡住）。`visibility='project'` 对主项目成员开放 | `server/services/read/acl-sql.ts:105-145`；`gateAndProjectFor` `server/services/narrator-acl.ts:213-224` |
              | 子代理 ACL | 完全按 `acl_root_narrator_id`（根会话）判断 | `server/services/read/acl-sql.ts:146-170`；`server/services/narrator-service.ts`（createSubagent 的 `aclRootNarratorId` 注释） |
              | 项目 gitPath、routines、trait 层（user→project→narrator） | 会话建立时读一次，存进活动会话 | `server/services/narrator-session.ts:1226-1256`，`_projectId`/`_projectGitPath` 在 `:1355`、`:1360` |
              | 设备 | `getSessionDevices(projectId)`：项目级设备要求 `device.projectId === 主项目`，`device.projectId` 只能填一个 | `server/services/narrator-session.ts:499-509`、`:1259-1261`；`isDeviceAuthorizedForProject` `server/services/device-service.ts:101-107`；`remoteDevices.projectId` `server/db/schema.ts:942` 起 |
              | 执行策略（目录/命令规则） | 沿 policy source 链收集每个会话的主项目，**把各项目规则层都合并进去**（这样子代理换了上下文也去不掉父项目的 deny 层），`projectGitPath` 取第一个 | `server/services/execution-policy/repository.ts:43-95` |
              | 技能 | global + 主项目 `gitPath` + cwd 所在 git 根（workspace），这一项**已经是多根了** | `resolveSkillRootsForContext` `server/services/skill-service.ts:518-533`；`resolveSkillRoot` `:1055-1062`；`resolveSkillContextForNarrator` `:967-987` |
              | CLAUDE.md / AGENTS.md | **只读 cwd 那一层**（`join(cwd, filename)`），不向上找，也和项目无关 | `server/services/narrator-prompt.ts:247-262`；文件名列表 `server/lib/global-prompt-paths.ts:15` |
              | 知识注入 | `active._projectId`：只取该项目的集合和全局集合 | `server/services/agent-runtime/orchestrator.ts:1081-1083`；`projectScopeClause` `server/services/knowledge/sqlite-read-store.ts:178-186`；`knowledgeCollections.projectId`（schema 中 `knowledge_collections` 定义处） |
              | 通知、最近标签、导航摘要、回退、git workspace | 都调 `resolveNarratorProjectId` | `server/services/notification-fanout.ts:328`、`server/services/recent-tabs-service.ts:1973`、`server/services/git-workspace.ts:143` 等 |
              | 任务 | spec 任务按**会话**存（每个叙述者一个 `tasks.json`），没有项目级看板 | `server/services/spec-task-service.ts`；`frontend/components/narrator/spec/SpecTaskBoard.tsx` |
          - [p/Find6RWU] 1.4 项目页怎么列会话
            - [p/l4bbVAKg] 会话列表：`/api/narrators?projectId=` 的条件是「任意链接（primary 或 additional）指向该项目，或者 `context_project_id` 等于该项目」（`server/routes/narrators.ts:1034-1043`）。另外**只列 `variant='primary'`**（`:1023`），子代理不列；同时叠加会话可读性谓词（`:1024`），而这个谓词的项目门看的是**主项目**。
            - [p/saCK3vzO] 前端 `frontend/routes/projects/$projectId.tsx:48-50` 分页拉取，每条显示 `session.cwd`（`:83`）。
            - [p/TBP6ZKF8] 项目权限收窄时，清理旧标签页也按「`context_project_id` 或链接」扫描（`server/services/project-membership.ts:426-430`）。
        - [p/ALeuYILG] 2. 现在已经出现的「一个会话碰多个仓库」
          - [p/rVPs937q] | 情形 | 现在怎么处理 | 问题 |
            |---|---|---|
            | **A. `contextProjectId=A`，cwd 在仓库 B**（additional 链接） | A 是主项目；B 得到 additional/cwd 链接（`server/services/project-index.ts:254-265`） | ① 执行发生在 B 的文件上，但执行策略只合并了 A 的项目层（`server/services/execution-policy/repository.ts:72-95`），**B 的 deny 规则不生效**。② B 的项目级设备、routines、trait 都不生效。③ B 的页面虽然「列出」了这个会话，但列表要过 A 的门（`server/routes/narrators.ts:1024`）。B 的成员只要不是 A 的读者，就看不到（`visibility='public'` 的会话除外）。④ 创建时只检查对 A 的 write，不检查 B（`server/routes/narrators.ts:1285-1292`）。⑤ 技能倒是已经同时加载了 A 的根和 B 的 workspace 根 |
            | **B. 会话里切目录**（HTTP `PATCH /:id/cwd`、`/workspace-context/switch`，或 agent 调 `SwitchWorkingDirectory` 工具） | 只经过会话 write ACL 和敏感路径检查（`server/routes/narrator-workspace-context.ts:14-39`、`server/services/workspace-context-service.ts:245-270`）；publish 时 `void` 同步链接（`:648`） | ① **不检查目标目录所属项目的权限**。② 没有 `contextProjectId` 的会话切到另一个仓库，主项目就变了：ACL 门、执行策略跟着变（策略在 install 时失效重算，`:617`）。但活动会话的 `_projectId`/`_projectGitPath`/routines/trait/设备不刷新，`updateActiveNarratorCwdAndSkillContext`（`server/services/narrator-session.ts:1693-1712`）只更新 cwd、技能根和 isGitRepo，于是知识注入还在用旧项目（`server/services/agent-runtime/orchestrator.ts:1083`），**DB 和内存对「属于哪个项目」给出不同答案**。③ `visibility='project'` 的会话切换后，对旧项目成员消失、对新项目成员出现，而会话历史里还有旧仓库的代码和讨论，**存在跨项目可见性迁移**。④ 链接同步是异步的，有一个窗口期 |
            | **C. worktree** | 默认位置被前缀匹配到；自定义 `destinationPath` 时靠 git-common-dir 回到主仓库 | 推断：项目根如果是**仓库子目录**（手动建的 monorepo 子项目，例如 `repo/packages/a`），worktree 里对应的 `packages/a` 不在 `repo/packages/a` 前缀下。这时探测得到主仓库根，而主仓库根没有项目，就会**自动给仓库根新建一个公开项目**，同一份代码在 checkout 里和 worktree 里归属不同。另外链接表主键 `(narrator, project)` 记不下「同一项目下的多个目录或 worktree」 |
            | **D. 嵌套仓库 / 子模块** | 先前缀匹配，再探测 git | 外层已经有项目时，内层的**独立仓库**会被并进外层项目（最长前缀优先于 git 探测）。子模块的 `--git-common-dir` 是 `super/.git/modules/sub`（已实测），不以 `/.git` 结尾，外层没有项目时就**不建项目**（`server/services/project-index.ts:153`） |
            | **E. 子代理在别的目录工作**（Agent 工具 `workdir`，需用户批准，`server/lib/agent/tools/task.ts:134`、`:434-435`） | 子代理 `contextProjectId` 复制父会话的，cwd 用自己的（`server/services/narrator-service.ts:1776-1779`）；ACL 随根会话；trait/模型按**父会话**的项目（`server/services/subagent-runner.ts:209`）；执行策略用子代理自己的主项目，再叠加父链上各项目的 deny 层 | 这是现有代码里**唯一真正「多项目叠加」的地方**（执行策略的 deny 并集），可以当作先例。但项目页不列子代理（`server/routes/narrators.ts:1023`），B 项目里完全看不出有人在这里改过东西。trait 用父项目、策略又以子代理自己的项目为主，两边不一致 |
            | **F. 远端设备** | 远端目录不进索引（`server/services/project-index.ts:24-25`、`:254`）；切到远端时 `narrators.cwd` 仍保留本地目录（`server/services/workspace-context-service.ts:451`），`defaultDeviceId` 变成远端 | 推断：没有 `contextProjectId` 的本地会话切到远端后，cwd 链接被删，主项目变成 null。结果是 `visibility='project'` 的会话对项目成员不可见（`server/services/read/acl-sql.ts:130` 要求项目非空），项目级设备不再授权：切换前用旧项目校验通过（`server/services/narrator-session.ts:655-656`），切换后下一次 `getSessionDevices(null)` 就看不到刚切过去的那台设备了。远端目录属于哪个项目，现在没有任何判断依据 |
            | **G. 手动把项目建在父目录** | 父目录下还没有项目的仓库都归进来 | 配置只有一份，跨设备不成立；已经有自己项目的仓库不受影响，结果是一部分仓库在里面、一部分不在 |
          - [p/VOtAHLNa] 讨论分支 `discuss/narrator-remote-workspace`
            - [p/DIYop3xL] 这个分支和当前 HEAD **在本克隆里没有共同祖先**（`git merge-base` 失败，可能因为是浅克隆）。它的基线还是叙事线时代：`server/services/narrator-project.ts` 按 `chapterId` 走，没有 `project-index.ts`。最近三个提交是 `5237d416`（远端叙述者工作目录）、`ad4e2554`（Windows 远端执行）、`8354861a`（会话 × 设备独立工作目录绑定）。
            - [p/PfqpVh7p] 和本问题相关的内容：
              - [p/GilPwXGq] 新表 `narrator_device_workspaces`，唯一键 `(narrator_id, device_id)`（`drizzle-postgres/0015_narrator_device_workspaces.sql`）。也就是**每台设备一个目录**，同一台设备上没法同时挂两个仓库。
              - [p/kfq8rZDA] 项目取 `workspaceContext.contextProjectId ?? narrators.contextProjectId`（该分支 `server/services/narrator-device-workspace-service.ts:129`、`:146-148`），没有从远端路径推导项目的逻辑。
              - [p/nNVExdDe] **工作区项目门**：操作某个工作区时，既要过会话 ACL，又要对该工作区的项目 `loadProjectForAccess`（同文件 `:104-131`）。
              - [p/JKBQBJbe] **原来源授权**：在工作区 A 产生的附件和引用，即使会话后来切到了 B，也按 A 的项目授权。注释原话：「selecting workspace B must not make B's extra workspace-project gate the grant for a server-owned original resource A」（`:99-100`、`:566-614`）。
              - [p/CRDrBrTq] 提交说明里列了没解决的问题：AI Terminal 写入和 Git 多步写缺末尾授权栅栏、远端关闭零派发不回滚等，S5 双设备验收也没跑。
            - [p/G3WEkJGe] 这两条机制（绑定工作区要对它的项目有权限；产出按来源项目授权）和下面推荐的方案方向一致，可以直接借用。但要移植到 project-index 体系上，而且该分支的 `workspaceContext.contextProjectId` 和当前「项目由目录推导」的模型需要先统一。
            - [p/EvvE9f0r] 设计稿 `docs/OUTLINE_KNOWLEDGE-DESIGN.md`：
              - [p/yEdPrQZP] §4.6 目前写的是「每个工作区对应一个项目，会话因此出现在多个项目里」，CLAUDE.md 按工作区首次使用时懒加载。
              - [p/oRwO2rqZ] §2.4 写的是「会话属于哪个项目，仍由 `resolveNarratorProjectId` 决定」。
              - [p/YOclBuXX] 这两处的关系没说清，§11 第 9 条把这个问题列为待定（原型 Q11）。
        - [p/7SqbZjIV] 3. 方案对比
          - [p/Hn7w3iX3] 前提：一个会话绑定多个工作区，每个工作区是 `(device, directory)`，可能在不同设备、属于不同仓库。
          - [p/1N4bXLUS] 方案 1：单主项目 + 附加链接（现状的直接扩展）
            - [p/o1A9vhm2] 每个工作区推导出一个项目链接，第一个或人指定的那个是 primary，其他都是 additional。所有消费方仍然只看主项目。
              - [p/4YZwrfIa] **权限**：门只有一个，现有 ACL、SQL 镜像、列表分页都不用改。B 的成员看不到会话，除非同时是 A 的读者，或者会话是 public。
              - [p/zpTNFmy1] **配置**：B 的 CLAUDE.md 只有 cwd 恰好落在 B 时才读到；B 的执行策略、设备、routines **不生效**，这是安全缺口，和情形 A 一样。
              - [p/hUammlNt] **任务看板**：任务在会话或 A 里，B 看不到。
              - [p/DUSfq7aN] **知识检索**：只查 A 的集合和全局集合，查不到 B 的知识。
              - [p/jvb7JuNf] 评价：代价最低，但执行层不安全，B 对这次改动一无所知。
          - [p/CR35vP8b] 方案 1'：单主项目（归属）+ 按工作区的执行层（推荐的底座）
            - [p/rQV3UdDJ] 「这个会话属于谁」和「在某个工作区执行时守谁的规矩」分开回答。
              - [p/DS7q3UEP] **权限（读）**：会话、历史、产出的可见性仍然只由主项目门决定。`resolveNarratorProjectId` 的语义不变，所有 ACL 镜像不用动。
              - [p/Lqn1IjYV] **权限（绑定）**：把工作区 B 加进会话，要求对 B 的项目有 write，私有项目还要是成员。这就是讨论分支的工作区项目门。cwd 切换、Agent `workdir`、远端绑定都走同一道检查。
              - [p/6u6e5jDL] **配置**：在工作区 W 上执行时 = 全局 + 主项目的 deny 层 + **W 所属项目的规则层** + 会话层。执行策略本来就支持多项目层合并（`server/services/execution-policy/repository.ts:79-95`），把「沿 policy 链收集」扩展成「沿 policy 链收集 ∪ 目标工作区的项目」就行。设备授权按目标工作区的项目判断。CLAUDE.md/AGENTS.md 按工作区懒加载（设计稿 §4.6）。trait/routines 仍按主项目，因为它们描述的是会话行为，不是仓库约束。
              - [p/MJTNjL5h] **任务看板**：任务树在主项目空间。每条跨仓库的改动把各仓库的提交作为依据挂在任务下。B 的项目页通过反向链接或链接索引显示「来自 A 的需求 X 在此工作区有改动」，读不到的部分显示占位。
              - [p/3RrHTZ4n] **知识检索**：查询范围 = 主项目 ∪ 各工作区项目 ∪ 全局。按驱动者权限过滤（设计稿 D9 交集），先在 SQL 里过滤再取 top-N。写入默认落到主项目空间，写进 B 的空间需要直写权限，否则转待确认。
              - [p/Bc8B8c2b] 代价：链接表要能表达 `(narrator, project, device, directory)` 多行（改主键或增加 workspace 子表），`deviceId` 字段真正用起来；远端工作区需要显式指定项目（见 §5）；活动会话的项目相关缓存要按工作区做 key。
          - [p/wzD9EBKz] 方案 2：多主项目（设计稿 §4.6 现在的字面意思）
            - [p/JwQETTqw] 每个工作区一个项目，会话平等地属于所有这些项目。
              - [p/g6aSmZiu] **权限**：门取**并集**的话，B 的成员能读到会话里 A 仓库的代码和讨论，等于泄露；门取**交集**的话，几乎没人能看，项目成员也看不到自己项目下的会话。两种都不好。而且 `resolveNarratorProjectId` 的「唯一答案」不变量（`server/services/narrator-project.ts:1-12` 的注释明确说分叉就是绕过点）要整体推翻，三处镜像（acl-sql、tool-final-start-authorization、narratorProjectIdColumn）和所有 `limit n+1` 分页谓词都要重写。
              - [p/0bJ7WzAM] **配置**：多套 trait/routines 怎么合并没有自然答案。
              - [p/6IYObNwX] **任务看板**：任务属于哪个项目说不清。
              - [p/fuXjvBjk] **知识**：检索范围和方案 1' 一样，但写入落点说不清。
              - [p/FATpTsUw] 评价：概念上最「平」，工程风险和权限风险最大，不推荐。
          - [p/gK4CSKXW] 方案 3：项目组 / 跨项目需求实体
            - [p/gCFZroFN] 新增 `project_groups`（或「需求/initiative」）实体，成员是若干项目，会话或需求挂在组上。
              - [p/pfFzteyd] **权限**：要么组有自己的成员和 ACL（新增一条权限轴，与项目门怎么组合要重新设计），要么组只是视图，权限仍然下沉到各个项目（那它就退化成方案 1' 加一个聚合页）。
              - [p/43PJEWU6] **配置**：组级配置要和项目配置分层，层数从 3 变成 4。
              - [p/j8Oyn7j0] **任务看板**：组级看板天然适合「前端 + 后端 + 契约」这种长期固定组合。
              - [p/EaVP7wwb] **知识**：可以有一个组空间，跨仓库的结论放在这里，归属清楚。
              - [p/loUdHEND] 代价：新实体、新 UI、新迁移；所有 `resolveNarratorProjectId` 调用方都要回答「组算不算」。一次性的跨仓库需求用这个太重。设计稿 D18 的方向是收缩概念。
              - [p/C3pcRbOJ] 评价：等真实需求出现再做，而且建议做成**聚合视图**，不另起 ACL 轴。
          - [p/yPPxUTS7] 方案 4：需求放在一个项目里，用链接引用别的项目
            - [p/QNxj862N] 这是任务和知识层面的组织方式，和方案 1' 正交，可以叠加。
              - [p/ObM6VsNj] **权限**：需求块的权限跟着 A 的空间走。指向 B 的链接对读不到 B 的人显示占位（设计稿 §2.4「链接不是后门」）。
              - [p/sQYGgPwz] **配置**：不涉及。
              - [p/FWouplzJ] **任务看板**：A 的看板有完整任务。B 的页面靠反向链接或嵌入看到相关子任务。如果需要「B 自己的视角」，可以在 B 里建一个嵌入 A 子树的页（拼接视图，R6）。
              - [p/TJWOQgN6] **知识**：结项时把关于 B 的结论按出处**复制**进 B 的空间（设计稿规定块不跨空间移动），A 留原始计划。
              - [p/FXKFcRkY] 评价：不新增概念，复用大纲已有的链接、嵌入、出处。
          - [p/pFWriCPS] 汇总
            - [p/hzFNnSst] | | 权限（谁能看会话和产出） | 配置（CLAUDE.md、执行策略、设备） | 任务看板 | 知识检索 | 改动量 |
              |---|---|---|---|---|---|
              | 1 单主 + 附加 | 主项目门，安全但 B 看不到 | 只有主项目，**B 的规矩不生效** | 只在主项目 | 只查主项目 | 小 |
              | **1' 单主 + 按工作区执行** | 主项目门；绑定要 B 的 write | 按目标工作区的项目 + 主项目 deny | 主项目，B 有反向链接 | 主 ∪ 工作区项目，按权限过滤 | 中 |
              | 2 多主项目 | 并集泄露 / 交集不可用 | 合并规则不清 | 归属不清 | 同 1' | 大，推翻不变量 |
              | 3 项目组 | 新 ACL 轴或退化成视图 | 再多一层 | 组看板 | 组空间 | 大 |
              | 4 需求放一处 + 链接 | 跟着空间，链接占位 | 不涉及 | A 完整，B 反向 | A 为主，结论复制进 B | 小（大纲内） |
        - [p/U5aZV3HT] 4. 倾向：方案 1' + 方案 4，项目组以后再说
          - [p/U42QaMgU] 理由：
            - [p/V5uKnHYY] **保住「唯一答案」不变量**。`server/services/narrator-project.ts:1-12` 说得很清楚：每多一份对「会话属于哪个项目」的回答，就多一个绕过点。会话历史本身混着所有工作区的内容，读权限只能由一个主体来定。用主项目作锚点，所有现有 ACL 和 SQL 镜像都不用动。
            - [p/4Cu5ZYOt] **执行安全必须按工作区来**。情形 A 已经说明：只看主项目，B 的 deny 规则就失效。执行策略已经有多项目层合并（`server/services/execution-policy/repository.ts:79-95`），讨论分支也已经有工作区项目门和原来源授权，方案 1' 是这些已有机制的自然延伸，不是从零发明。
            - [p/VqLaLasj] **B 需要知道有人在它这里动过东西**，但不需要能读整个会话。反向链接和「参与会话」列表（标题、主项目、工作目录、提交）就够了，正文仍然按会话 ACL。
            - [p/ki7pLiKC] **概念最少**。不新增实体，符合设计稿 D18 的收缩方向。项目组以后可以做成纯视图，只要链接结构是对的，到时候不需要迁移数据。
            - [p/IYFd9joU] **顺带修掉现有问题**：cwd 切换、Agent `workdir`、远端绑定统一走「绑定工作区」检查；活动会话的项目缓存按工作区刷新；远端工作区显式指定项目。§2 里的 B、E、F 三种情形都能收敛。
          - [p/KS7tqTz6] 建议的落地顺序（只是建议）：
            - [p/y6y2Rjuv] (1) 先修现有缺口，不依赖新能力：
              - [p/J5HoRkB2] cwd 切换后刷新 `_projectId` 等缓存，或者重建活动会话；
              - [p/jkhnhq5N] 切换和绑定时检查目标项目的 write；
              - [p/OBRh3y1y] 远端切换不丢主项目，比如切换时把当前主项目冻结进 `contextProjectId` 或 workspaceContext。
            - [p/BUaVFSJg] (2) 链接表支持一个会话对应多个工作区，`device_id` 真正用起来。
            - [p/pFVIkSSl] (3) 执行策略、设备授权、CLAUDE.md 按目标工作区解析。
            - [p/05ge6Pvv] (4) 大纲侧：需求放在主项目，加上反向链接视图。
        - [p/smaqcCW9] 5. 需要人决定的点
          - [p/CU97cwcb] **主项目怎么定**：创建时选？默认取第一个工作区？没有 git 的工作区能不能当主项目？中途能不能**换主项目**？换主项目等于改变会话可见范围，建议换的时候弹出确认，并说明哪些人会新获得或失去访问。
          - [p/vHLUm1zl] **把工作区 B 加进会话的门槛**：要 B 的 write 还是 read？私有项目 B 能不能被 A 的会话使用？B 的 owner 要不要收到通知或审批？生产设备怎么处理（设计稿已经倾向「由人确认、带期限」）？
          - [p/CNvIVm00] **B 的成员能看到什么**：只看到「有会话在此工作」（标题、主项目、目录、提交），还是能看会话正文？对读不到的人，要不要连这个会话的存在都隐藏？（现在的做法是完全不可见。）
          - [p/q2DITrd3] **执行策略合并规则**：执行落在工作区 W 时，用「全局 + 主项目 deny + W 项目 + 会话」，还是「所有已绑定工作区项目的 deny 并集」？allow 规则只取 W 项目的吗？
          - [p/Ul3wbYUB] **设备授权**：项目级设备按「目标工作区的项目」授权，还是仍然按主项目？`remoteDevices.projectId` 只能填一个，要不要允许一台设备服务多个项目？
          - [p/aOutCm4a] **远端工作区属于哪个项目**：远端路径没法做本地前缀匹配，也没法本地 git 探测。可选：绑定时人工选项目；executor 上报 `git remote` URL，和项目的 `remoteUrl` 匹配；设备注册时固定项目。
          - [p/8y2bTFaN] **同一项目下多个工作区**：两个 worktree、两台机器上各一份同一仓库。这需要改链接表主键 `(narrator, project)`。
          - [p/nS2q6YSr] **trait/routines/技能**：继续只看主项目？技能现在已经是多根（主项目 + cwd workspace），要不要扩展成「所有工作区根」？
          - [p/NcZODhM3] **知识**：写入默认落到主项目空间还是工作区项目空间？跨项目结论要不要在结项时自动提议复制进对应项目？
          - [p/Z617Bdgp] **项目组**：现在就做，还是等真实需求？如果做，组有没有自己的成员和 ACL，还是只是聚合视图？
          - [p/3ywYIMYn] **子代理**：子代理只拿到父会话工作区的一个子集时，trait 跟父项目、执行策略跟自己的工作区项目，这个现状要不要统一？
          - [p/6P7ChezJ] **PostgreSQL**：项目索引现在只在 SQLite 上（`server/services/narrator-project.ts:35-37`）。多工作区能力要不要以 PG 移植为前提？
          - [p/VpZihlxa] **手动项目落在仓库子目录、嵌套仓库、子模块**（§2 情形 C、D）：维持现状还是修？修的话，worktree 应该按「同仓库同相对路径」映射回子目录项目。
      - [p/3wC0tThD] 会话现在只有一个主项目：`resolveNarratorProjectId` 是唯一答案（有 `contextProjectId` 用它，否则用 primary 链接，additional 不参与），见 `server/services/narrator-project.ts:31-49`。ACL 项目门、trait、routines、设备、执行策略、知识注入、通知都只看主项目。镜像有三处：`server/services/narrator-project.ts:72-74`、`server/services/read/acl-sql.ts:94-96`、`server/services/tool-final-start-authorization.ts:72-85`
      - [p/ZiU2exDm] 项目自动建出来的规则：先按路径段取最长前缀的已有项目根，否则用 `git rev-parse --git-common-dir` 找主仓库根，没有项目就当场建一个公开项目（`server/services/project-index.ts:207-234`，公开在 `server/services/project-index.ts:188`）。非 git 目录、bare 仓库、子模块都不建项目（`server/services/project-index.ts:153`），远端设备目录不进索引（`server/services/project-index.ts:236-238`）
      - [p/hYJfYbCJ] 链接表 `narrator_project_links` 主键是 `(narrator_id, project_id)`（`server/db/schema.ts:692-716`）：一个会话最多两条链接，`device_id` 永远是 `local`，记不下「同一项目下的多个目录或 worktree」。`additional` 只在 `contextProjectId` 和 cwd 推导出的项目不同时产生（`server/services/project-index.ts:254-265`），作用只是让会话出现在另一个项目的列表里，而列表仍先过主项目的门（`server/routes/narrators.ts:1024`）。PostgreSQL 后端没有这张索引，只认 `contextProjectId`（`server/services/narrator-project.ts:35-37`）
      - [p/cYBhu6IP] 缺口一：`contextProjectId=A`、cwd 在仓库 B 的会话，执行策略只合并 A 的项目层（`server/services/execution-policy/repository.ts:72-95`），B 的 deny 规则不生效，B 的设备、routines、trait 也不生效；创建时只检查对 A 的 write（`server/routes/narrators.ts:1285-1292`）
      - [p/3ecCXHpa] 缺口二：会话切目录只检查会话 write 和敏感路径，不检查目标目录所属项目的权限（`server/routes/narrator-workspace-context.ts:14-39`、`server/services/workspace-context-service.ts:245-270`）
      - [p/9xiKXVj8] 缺口三：没有 `contextProjectId` 的会话切到另一个仓库后，DB 里的主项目异步变了，活动会话内存里的 `_projectId` 不刷新（`server/services/narrator-session.ts:1693-1712` 只更新 cwd、技能根和 isGitRepo），知识注入还用旧项目（`server/services/agent-runtime/orchestrator.ts:1083`）；`visibility='project'` 的会话随之从旧项目成员换给新项目成员，历史里却留着旧仓库的内容
      - [p/ZbXzYkdi] 缺口四（推断）：没有 `contextProjectId` 的本地会话切到远端设备后，cwd 链接被删，主项目变成 null（`server/services/workspace-context-service.ts:451`），项目门消失、`visibility='project'` 对成员不可见（`server/services/read/acl-sql.ts:130`），只授权给项目的设备失效（`server/services/narrator-session.ts:655-656`）
      - [p/6Kge1JJb] 已有的多项目先例：执行策略沿 policy 链把各项目规则层都合并进去，子代理去不掉父项目的 deny 层（`server/services/execution-policy/repository.ts:79-95`）；技能已经是多根，global + 主项目 + cwd 所在 git 根（`server/services/skill-service.ts:518-533`）。讨论分支 `discuss/narrator-remote-workspace` 有「工作区项目门」和「原来源授权」两条机制，可以借用，但要移植到 project-index 体系
      - [p/9NaHR75W] 多主项目（会话平等属于每个工作区的项目）不可行：门取并集会把 A 仓库的内容泄露给 B 的成员，取交集几乎没人能看；还要推翻 `server/services/narrator-project.ts:1-12` 说的「唯一答案」不变量，重写三处镜像和分页谓词
      - [p/PL4X2sda] 报告的倾向：方案 1'（一个主项目管归属和读权限；每个工作区按自己所属的项目管执行层：执行策略 deny、设备授权、CLAUDE.md）加方案 4（需求和任务树放主项目空间，用链接、嵌入、提交依据引用其他仓库），项目组以后做成纯聚合视图。落地顺序：先修上面四个缺口，再让链接表支持多工作区，再按工作区解析执行层，最后做大纲侧的反向链接视图。报告原文见 [[p/U5aZV3HT]]
    - [p/jfVvqDuK] 建议：一个会话只有一个主项目，管归属和读权限；每个工作区按它自己所属的项目管执行层（执行策略的 deny、设备授权、CLAUDE.md）。需求和任务树放主项目空间，用链接、嵌入、提交依据引用其他仓库，其他项目页用反向链接看到「有外部需求在这里动过」。项目组先不做，真有长期固定的多仓库组合时再做成纯聚合视图，不另起权限轴。细项见决策包「跨仓库会话：归属与可见性」（Q32–Q35）、「跨仓库会话：执行层」（Q36–Q37）、「跨仓库会话：落地范围」（Q38–Q40）。调研 [[p/N5cdiUhM]] 的倾向（方案 1' + 方案 4，[[p/PL4X2sda]]）。多主项目会让读权限要么泄露、要么没人能看，还要推翻「唯一答案」不变量（[[p/9NaHR75W]]）；而只看主项目又让 B 的 deny 规则在 B 的文件上失效（[[p/cYBhu6IP]]）。所以归属只认一个，执行按工作区：现有 ACL 和 SQL 镜像不用动，执行策略已有多项目层合并、讨论分支已有工作区项目门可以借用（[[p/6Kge1JJb]]）。项目组以后做成视图时，只要链接结构对，不需要迁移数据
    - [p/DwyfCdFp] 跨仓库会话：归属与可见性
      - [p/DHAPw96a] [ ] Q32 多工作区会话的主项目怎么定、中途能不能换？（主项目决定谁能看会话；现在没有 contextProjectId 的会话切 cwd 或切远端时主项目会隐式改变） @human:owner
        - [p/hfKNObBk] 创建时定下，之后不能换
        - [p/034LhbA4] 创建时定下（从项目页建就是该项目，否则取第一个工作区推导出的项目，非 git 工作区不能当主项目）；允许显式换，换前确认并列出会新获得、失去访问的人；切 cwd、切设备不再隐式改主项目
        - [p/57BqZY5t] 维持现状：随 cwd 推导，跟着切换变
        - [p/M1OuQoOn] 建议：创建时定下（从项目页建就是该项目，否则取第一个工作区推导出的项目，非 git 工作区不能当主项目）；允许显式换，换前确认并列出会新获得、失去访问的人；切 cwd、切设备不再隐式改主项目。主项目是读权限的唯一锚点（[[p/3wC0tThD]]），隐式改变就是可见性迁移：会话历史里有旧仓库的内容，却换给了新项目的成员（[[p/9xiKXVj8]]），切远端还会变成 null（[[p/ZbXzYkdi]]）。完全不能换又太死，开错项目只能重建会话；显式换加确认，把可见范围的变化摆在人面前。实现上切换时把当前主项目冻结进 contextProjectId，就是报告落地顺序的第一步
      - [p/LneaKsbw] [ ] Q33 把工作区 B（另一个仓库，或另一台设备上的目录）加进会话，要对 B 的项目有什么权限？B 的 owner 要不要知道？ @human:owner
        - [p/pbYE9RPH] 要 B 的 write，私有项目还要是成员；B 的 owner 收通知、不审批；生产设备由人确认、带期限
        - [p/ySGqyxFP] B 的 read 就够
        - [p/JWaszfpm] 每次都要 B 的 owner 审批
        - [p/465BpVvP] 建议：要 B 的 write，私有项目还要是成员；B 的 owner 收通知、不审批；生产设备由人确认、带期限。现在切目录完全不查目标项目（[[p/3ecCXHpa]]），创建时也只查 A（[[p/cYBhu6IP]]）。在 B 上执行就是改 B 的代码，门槛应当和直接在 B 里开会话一样，也就是 write；讨论分支的「工作区项目门」已经这么做，可以借用（[[p/6Kge1JJb]]）。cwd 切换、Agent workdir、远端绑定统一走这一道门。逐次审批对一次性的跨仓库改动太重，通知足以让 B 知道有人来过；生产设备沿用设计稿「人确认、带期限」的倾向
      - [p/DdQ4g15D] [ ] Q34 B 项目的成员能看到在 B 上工作过的、主项目是 A 的会话多少内容？ @human:owner
        - [p/hy8Ynjlh] 只看到「有会话在此工作」：标题、主项目、工作目录、提交；正文仍按会话 ACL
        - [p/N7HGdYmX] 能读会话正文
        - [p/1a78Dm5v] 完全不可见（现状）
        - [p/37prsxqz] 建议：只看到「有会话在此工作」：标题、主项目、工作目录、提交；正文仍按会话 ACL。会话历史混着所有工作区的内容，B 的成员能读正文就等于把 A 仓库的代码和讨论泄露给 B（[[p/9NaHR75W]]）。完全不可见则 B 对自己仓库被改一无所知。摘要加提交够 B 追溯改动；读不到正文的人看到占位，符合设计稿「链接不是后门」
      - [p/TW9heTNw] [ ] Q35 远端设备上的工作区属于哪个项目？（远端路径没法本地前缀匹配，也没法本地 git 探测，现在完全不进索引） @human:owner
        - [p/hAnh9LoC] 绑定时由人选项目
        - [p/qwY16snB] executor 上报 git remote URL，和项目的 remoteUrl 匹配
        - [p/fjuYpd1S] 设备注册时固定一个项目
        - [p/Kr9RF1Dm] 绑定时由人选；executor 上报的 remote URL 只用来预填建议
        - [p/OkWINqQD] 建议：绑定时由人选；executor 上报的 remote URL 只用来预填建议。remote URL 匹配不唯一（fork、同一 remote 的多个项目、没有 remote 的仓库），单靠它会归错项目，而归属直接决定执行层守谁的规矩；设备固定项目和「一台设备上挂多个仓库」冲突。人选最可靠，用上报的 URL 预填，大多数情况人只需点确认。远端目录现在不进索引（[[p/ZiU2exDm]]），切过去主项目还会丢（[[p/ZbXzYkdi]]）
    - [p/EjB1P6vB] 跨仓库会话：执行层
      - [p/jBujF3QI] [ ] Q36 在工作区 W 上执行时，执行策略和设备授权按哪些项目算？ @human:owner
        - [p/I2eoq8r0] 全局 + 主项目的 deny 层 + W 所属项目的全部规则层 + 会话层；allow 只取 W 项目；设备按 W 的项目授权
        - [p/RZARgaqY] 所有已绑定工作区项目的 deny 取并集，再加 W 项目的 allow；设备按 W 的项目授权
        - [p/jKPvoO6l] 维持现状：只按主项目
        - [p/sRe0Ufnk] 建议：全局 + 主项目的 deny 层 + W 所属项目的全部规则层 + 会话层；allow 只取 W 项目；设备按 W 的项目授权。现状只按主项目，B 的 deny 规则在 B 的文件上失效（[[p/cYBhu6IP]]）。执行策略本来就支持多项目层合并（[[p/6Kge1JJb]]），加上「目标工作区的项目」改动最小。主项目的 deny 保留，是因为会话归属 A，A 不允许的事换个工作区也不该能做；其他工作区的 deny 管的是它们自己的文件，叠到 W 上会让绑定越多越难用，而且和 W 无关。remoteDevices.projectId 暂保持单值，一台设备服务多个项目等真有需求再改
      - [p/V0udLkMT] [ ] Q37 trait、routines、技能在多工作区会话里按哪个项目加载？子代理「trait 跟父会话的项目、执行策略跟自己的项目」要不要统一？ @human:owner
        - [p/9AUvORJA] trait、routines 继续只看主项目；技能扩成所有工作区的根；子代理现状保留并写成规则：行为跟归属走，执行跟工作区走
        - [p/HAc6U10l] 全部按当前工作区的项目切换
        - [p/YQoIqrmH] 全部只看主项目，技能也收回到主项目
        - [p/17H9M2eP] 建议：trait、routines 继续只看主项目；技能扩成所有工作区的根；子代理现状保留并写成规则：行为跟归属走，执行跟工作区走。trait、routines 描述的是会话怎么做事，属于归属层，随工作区切换会让同一个会话前后行为不一；执行策略、CLAUDE.md 是仓库的约束，属于执行层。按这条分法，子代理的「不一致」其实是对的，不用改代码，只需写清楚。技能现在已经同时加载主项目和 cwd 两个根（[[p/6Kge1JJb]]），扩成所有工作区根是顺势延伸
    - [p/YoWydZZf] 跨仓库会话：落地范围
      - [p/FFVWVeX5] [ ] Q38 跨仓库会话产出的知识默认写到哪个项目空间？结项时关于其他仓库的结论要不要自动提议复制过去？ @human:owner
        - [p/JmFrPMXt] 默认写主项目空间；写进 B 的空间要有直写权限，否则转待确认；结项时自动提议复制，由人或 B 的管理者确认
        - [p/VadXt8MJ] 默认写当前工作区所属项目的空间
        - [p/tL0XJkIE] 只写主项目空间，不做复制提议
        - [p/BcjwumD9] 建议：默认写主项目空间；写进 B 的空间要有直写权限，否则转待确认；结项时自动提议复制，由人或 B 的管理者确认。需求和任务树都在主项目空间（报告方案 4，[[p/PL4X2sda]]），结论跟着计划放，出处才连得上。B 的成员读不到 A 的空间，所以关于 B 的结论要按出处复制进 B（设计稿规定块不跨空间移动）；但自动写进别人的空间等于绕过 B 的权限，只能提议
      - [p/l34FWfPn] [ ] Q39 多工作区会话（链接表改成一个会话多个工作区、同一项目多个目录，device_id 真正用起来）要不要以 PostgreSQL 移植项目索引为前提？ @human:owner
        - [p/5lbhHMhj] 先修四个现有缺口（不依赖新能力，也不等 PG）；改链接表时同步给 PG 建索引，不再让两个后端分叉
        - [p/1CeY38Cu] 以 PG 移植为前提，移植完再动
        - [p/FLdqDQSr] 只在 SQLite 上做，PG 以后补
        - [p/eFk6rrMi] 建议：先修四个现有缺口（不依赖新能力，也不等 PG）；改链接表时同步给 PG 建索引，不再让两个后端分叉。四个缺口（[[p/cYBhu6IP]]、[[p/3ecCXHpa]]、[[p/9xiKXVj8]]、[[p/ZbXzYkdi]]）现在就在漏权限，修它们不需要改表，不该被 PG 卡住。但 PG 现在只认 contextProjectId（[[p/hYJfYbCJ]]），链接表一改结构，两个后端对「会话在哪些工作区」的答案会差得更远，所以改表那一步要两边一起做
      - [p/Ja76tnpr] [ ] Q40 项目建在仓库子目录、嵌套的独立仓库、子模块这几种边界情形：维持现状还是修？ @human:owner
        - [p/6HQ2kpzt] 修 worktree：按「同仓库同相对路径」映射回子目录项目；嵌套仓库和子模块维持现状，在文档里写明
        - [p/uU4reY3t] 全部修
        - [p/rnJRxIZo] 全部维持现状
        - [p/PEpnJZXj] 建议：修 worktree：按「同仓库同相对路径」映射回子目录项目；嵌套仓库和子模块维持现状，在文档里写明。worktree 这一种会让同一份代码在 checkout 里和 worktree 里归属不同，还会给仓库根自动建一个公开项目（报告 §2 情形 C，推断），会话 worktree 是常用路径，影响面最大。嵌套仓库并进外层项目、子模块不建项目（[[p/ZiU2exDm]]），属于少见配置，规则是确定的，写清楚就行，等多工作区能显式绑定项目后自然有解
  - [p/XzYozzQg] [ ] Q12 探索组的对比视图要不要内置「方案 / 结果 / 代价」模板？
  - [p/WxOgq9RU] [x] Q13 任务反思是否保留为可选的完成证据核查？ @agent:w-reflection
    - [p/u2EO60oS] 调研说明（agent:w-reflection，只读调研，全程没有改动文件）：本地仓库是浅克隆，最早的提交是 2026-10-14，更早的提交是在 GitHub 远端查的。主要文件：server/lib/agent/tools/task-reflection.ts、server/lib/agent/loop.ts、server/services/spec-task-service.ts、server/services/turn-continuation-decisions.ts、server/services/spec-edit-interject.ts、docs/OUTLINE_KNOWLEDGE-DESIGN.md
    - [p/kRjNy38c] 结论（建议，待负责人决定）：删除任务反思，但要等到大纲任务迁移（P2）时一起删，也不建议改成可选。现在单独删的话，`/goal` 建的任务就没有任何完成把关了。轻方案能覆盖它要防的主要失败，但有四个缺口要先补上（见「轻方案」）
      - [p/Xr32Nggx] 理由：没有它拦对过的证据，误拦和故障却有一串；它自己不能验证，只能读历史；标错完成可以撤回，不像危险操作那样不可逆，为了防它而拦写入，已经有一次 1.5 小时的代价；改成可选的话，全部配套代码和常驻工具照样要维护
      - [p/Qxa3wNSg] 删之前：离线统计 `narrator_tool_calls.permission_suggestions` 里 task_reflection 状态为 cancelled 的记录并抽查，确认没有拦对的案例
      - [p/o7nT6dqG] 删的时机：四个缺口补齐后，把门禁、两个决策工具、`spec_protected_tasks` 和 human attention 里的 task_reflection 一起删掉
      - [p/CDVucl36] 如果还想要模型复核：照 §9.7 改计划反思的做法，只在任务上留审查意见，不阻塞，默认关闭
    - [p/tSXcW3GB] 时机、判断、成本
      - [p/sr4GlvRX] 时机：agent 用 Write/Edit 改 `spec://tasks.json`，并且检出受保护任务被标 done、被删除或被去掉 protected 标记时触发。改任务文本会让 hash 变化，所以也算删除
      - [p/S4XQ8aje] 它不看权限模式，也没有设置开关（shouldRunTaskReflection 只排除嵌套反思）；新增任务、改成 blocked、用户在面板上改，都不会触发
      - [p/cxCbcpTT] 判断：只问一件事，「这次修改是否违背了用户真正要求的东西」，证据只用来辅助判断
      - [p/qmUAyuJZ] 反思只能调用两个决策工具，不能读文件，也不能跑测试，只能读父会话历史
      - [p/imsLHEyO] 检查本身失败时，修改不会执行
      - [p/EHV76kIa] 自动反思不会出现在 human attention 里，只有人接管后才以 `reflection` 类型出现
      - [p/kQCKe6bn] 成本：每次多发 1 个请求，用同一个模型，带上父会话的全部历史；请求前缀和父请求相同，可以命中缓存。最多 2 轮决策，瞬态错误最多重试 10 次。反思期间这次工具调用一直挂起，会话显示 reflecting；人接管后一直等人决定，没有超时；每次被驳回后重新提交，都会再跑一遍。两个决策工具为了保持缓存前缀，常驻在每个请求里，说明文字约 2.2K 字符
    - [p/Np2fmC87] 防住了什么
      - [p/a3TZY6iK] 设计上要防的：受保护任务没做完就标完成、被删除或被改弱（TaskReflectRevise 的工具描述）；agent 为摆脱自动续跑而把条目标 done（45a2cd9e 的提示词；system-reminders.ts:86）。默认续跑模式是 `protectedOnly`（defaults.ts:108），所以标完成就能结束无人值守的运行
      - [p/2Ejni2lO] 存储层的兜底有测试：没有反思授权时拒绝完成受保护任务
      - [p/hjMpLKk8] 在代码注释、测试和提交历史里，有记录的全是它自身的问题，没找到一次它拦下真实虚假完成的记录；线上的驳回记录还没统计（见结论下的「删之前」）
        - [p/HJicX5bm] 一次会话里 3067 个测试全部通过，它仍连续驳回 5 次，耗时 1.5 小时。之后提示词从「证据够不够」改成「问意图」（loop.ts:1022 注释，tool-executor.test.ts:2008）。这次改写随 a365c6de 合入，提交信息没提；旧版提示词见 f32a9bcc
        - [p/fu90EcUS] 同一个驳回反复出现会让续跑空转，于是加了「第 3 次相同驳回就停止续跑」
        - [p/xCjUdEVL] 用户在面板上新加的任务被当成偏离主线而驳回，因为反思只认 user 消息里的要求；为此专门写了 spec-edit-interject.ts（见文件头注释）
        - [p/YYG89IVy] 检查故障被当成内容否决（538c6abe）；确认受保护任务改动时报工具路由错误（8bd4cf62）
    - [p/nOgsp8ak] 轻方案
      - [p/OMcTUXEo] 能覆盖的：严格计划的虚假完成由批准人确认，这比同一个模型读同一份历史再审一遍更可靠；上面那些死循环和误判不会再出现；省掉额外请求、阻塞，以及接管、恢复、广播这一整套代码；依据会出现在看板上
        - [p/Ms3SyK7t] 现在反思结论只在工具卡片里，看板不显示
      - [p/7GYNpB07] 缺口 1：轻方案三条只管「完成」。删除、改写、取消同样能让任务消失，也要按同样规则标记；已批准的计划要走变更请求（设计文档 §9.5）
      - [p/1wEcDyvj] 缺口 2：`/goal` 是用户在说「务必完成」，但设计文档默认把它当草稿（§11.4；调研时是 §10.4）。无人值守时，agent 可以提前标完成、停掉续跑，要等人看看板才会发现
        - [p/fm0JR4Jp] 建议 `/goal` 默认按已批准处理
      - [p/sCGQs8Pd] 缺口 3：有依据不等于做对了。依据要带上测试是通过还是失败，并且要晚于最后一次相关改动；宿主侧做确定性校验已有先例（docs/task-call-challenges/RESULTS.md 第 05、06 题）
      - [p/X5DaZq7e] 缺口 4：现在的 tasks.json 没有任务 ID，规定里也不许写依据字段（system-reminders.ts:76），依据没地方挂，要等大纲任务块
    - [p/0VsQNXwj] 协调者（agent:steward）：上面的结论按 agent:w-reflection 的报告代记，提交里执行者是 w-reflection、代记人是 steward。报告没有单列「需要人决定」，其中要负责人拍板的两点建成了提问：[[p/Q25]] 是否采纳「随 P2 删除、不改可选」的建议，[[p/Q26]] `/goal` 默认按草稿还是已批准。设计文档 21c0ff6f 里「完整报告见原型里的 Q13」指的就是这里
    - [p/7rCR5pnr] 协调者的看法（agent:steward，不是调研结论）：设计文档 21c0ff6f 已经把这份调研的结论写成「调研结论是随 P2 一起删除」，§18 第 8 条却仍把任务反思列为待定；在负责人回答 [[p/Q25]] 之前，文档里那句应该读作建议。如果负责人采纳，「删之前离线统计抽查」和四个缺口宜在 [[p/P2]] 下建成任务；这次只记成笔记，没有替 P2 做计划
    - [p/MwhYZUvK] 专注 agent agent:w-reflection 的报告（Q13：任务反思是否保留）
      - [p/aNrPJUo4] **结论**：建议删除，但要等到大纲任务迁移（P2）时一起删，也不建议改成可选。现在单独删的话，`/goal` 建的任务就没有任何完成把关了。代码注释、测试和提交历史里，我只找到它误拦和出故障的记录，没找到一次它拦下真实虚假完成的记录。轻方案能覆盖它要防的主要失败，但有四个缺口要先补上。
      - [p/fPTz8lsG] **1. 时机、判断、成本**
        - [p/QtxTV8AT] **时机**：agent 用 Write/Edit 改 `spec://tasks.json`，并且检出受保护任务被标 done、被删除或被去掉 protected 标记时触发。改任务文本会让 hash 变化，所以也算删除。依据：loop.ts `executeToolAfterReflections`，spec-task-service.ts `detectProtectedMutations`。
          - [p/NV2eUHX5] 它不看权限模式，也没有设置开关（`shouldRunTaskReflection` 只排除嵌套反思）。
          - [p/4szE4m4O] 新增任务、改成 blocked、用户在面板上改，都不会触发。
        - [p/OSE9TXQF] **判断**：只问一件事："这次修改是否违背了用户真正要求的东西"，证据只用来辅助判断（`buildTaskReflectionPrompt`）。
          - [p/nM7XuIGU] 反思只能调用两个决策工具，不能读文件，也不能跑测试，只能读父会话历史（`runReflectionLoop`；测试 "reflection rejects ordinary tools…"）。
          - [p/boCeXNTi] 检查本身失败时，修改不会执行（`buildReflectionFallbackMessage`）。
          - [p/bLDELHJJ] 自动反思不会出现在 human attention 里，只有人接管后才以 `reflection` 类型出现（human-attention-service.test.ts "task takeover … hides automatic reflection"）。
        - [p/RnECmBvJ] **成本**：
          - [p/EeM7ywSN] 每次多发 1 个请求，用的是同一个模型，带上父会话的全部历史。请求前缀和父请求相同，可以命中缓存（loop-reflection-cache-prefix.test.ts）。
          - [p/G8lyjnZm] 最多 2 轮决策，瞬态错误最多重试 10 次（`getAuxiliaryMaxRetries`）。
          - [p/5mGryzeE] 反思期间这次工具调用一直挂起，会话显示 reflecting。人接管后就一直等人决定，没有超时。每次被驳回后重新提交，都会再跑一遍。
          - [p/nt8j11ba] 两个决策工具为了保持缓存前缀，常驻在每个请求里，说明文字约 2.2K 字符（reflection-description.ts）。
      - [p/WDE7X9jo] **2. 防住了什么**
        - [p/kagNb61G] **设计上要防的**：
          - [p/NGYq2pkc] 受保护任务没做完就标完成、被删除或被改弱（TaskReflectRevise 的工具描述）；
          - [p/3WeAGcBB] agent 为摆脱自动续跑而把条目标 done（45a2cd9e 的提示词；system-reminders.ts:86）。默认续跑模式是 `protectedOnly`（defaults.ts:108），所以标完成就能结束无人值守的运行。
          - [p/7nBFa7Go] 存储层的兜底有测试：没有反思授权时拒绝完成受保护任务（spec-vfs-service.test.ts "…blocks protected completion without reflection"）。
        - [p/tBmvb3wi] **有记录的全是它自身的问题**：
          - [p/YTxDfWUx] 一次会话里 3067 个测试全部通过，它仍连续驳回 5 次，耗时 1.5 小时。之后提示词从"证据够不够"改成"问意图"（loop.ts:1022 注释，tool-executor.test.ts:2008）。这次改写随 a365c6de 合入，提交信息没提；旧版提示词见 f32a9bcc。
          - [p/mVJFuEyD] 同一个驳回反复出现会让续跑空转，于是加了"第 3 次相同驳回就停止续跑"（45a2cd9e；turn-continuation-decisions.ts:106；测试 "suppresses the third consecutive identical taskReflection denial"）。
          - [p/pd7Bp4Ne] 用户在面板上新加的任务被当成偏离主线而驳回，因为反思只认 user 消息里的要求。为此专门写了 spec-edit-interject.ts（见文件头注释）。
          - [p/7uD1Xbjl] 检查故障被当成内容否决（538c6abe）；确认受保护任务改动时报工具路由错误（8bd4cf62）。
      - [p/vXIcqrrS] **3. 轻方案**
        - [p/uzxnSAnC] **能覆盖的**：
          - [p/mWNrqcZb] 严格计划的虚假完成由批准人确认。这比同一个模型读同一份历史再审一遍更可靠。
          - [p/DN5DFvWX] 上面那些死循环和误判不会再出现。
          - [p/Yk9xuHih] 省掉额外请求、阻塞，以及接管、恢复、广播这一整套代码。
          - [p/dqIXUy0m] 依据会出现在看板上。现在反思结论只在工具卡片里，看板不显示（SpecTaskBoard.tsx）。
        - [p/wZc4gpWy] **覆盖不了、需要补的**：
          - [p/E1YeFqvt] 轻方案三条只管"完成"。删除、改写、取消同样能让任务消失，也要按同样规则标记。已批准的计划要走变更请求（OUTLINE_KNOWLEDGE-DESIGN.md §9.5）。
          - [p/nAGYUPF3] `/goal` 是用户在说"务必完成"，但设计文档默认把它当草稿（同文 §10.4）。无人值守时，agent 可以提前标完成、停掉续跑，要等人看看板才会发现。建议 `/goal` 默认按已批准处理。
          - [p/2tJu7uIv] 有依据不等于做对了。依据要带上测试是通过还是失败，并且要晚于最后一次相关改动。宿主侧做确定性校验已有先例（docs/task-call-challenges/RESULTS.md 第 05、06 题）。
          - [p/RGyk1sZb] 现在的 tasks.json 没有任务 ID，规定里也不许写依据字段（system-reminders.ts:76），依据没地方挂，要等大纲任务块。
      - [p/KsBO8iAv] **4. 建议：删除**
        - [p/CrbmUFLL] **理由**：
          - [p/c3nefPHX] 没有它拦对过的证据，误拦和故障却有一串。
          - [p/dT7XQ5HS] 它自己不能验证，只能读历史。
          - [p/bg26mnwJ] 标错完成可以撤回，不像危险操作那样不可逆；为了防它而拦写入，已经有一次 1.5 小时的代价。
          - [p/VkvwEUYQ] 改成可选的话，全部配套代码和常驻工具照样要维护。
        - [p/gmQ6FgqU] **删之前**：离线统计 `narrator_tool_calls.permission_suggestions` 里 task_reflection 状态为 cancelled 的记录并抽查，确认没有拦对的案例。
        - [p/0tzjhVMZ] **删的时机**：上面四个缺口补齐后，把门禁、两个工具、`spec_protected_tasks` 和 human attention 里的 task_reflection 一起删掉。
        - [p/TQLRmErr] **如果还想要模型复核**：照 §9.7 改计划反思的做法，只在任务上留审查意见，不阻塞，默认关闭。
      - [p/5cf2tVnA] 主要文件：
        - [p/axxCfGKs] server/lib/agent/tools/task-reflection.ts
        - [p/Jco6XAZK] server/lib/agent/loop.ts
        - [p/YbOmITZk] server/services/spec-task-service.ts
        - [p/Y7p9U6xU] server/services/turn-continuation-decisions.ts
        - [p/sdHyXDs8] server/services/spec-edit-interject.ts
        - [p/Fxli9hTL] docs/OUTLINE_KNOWLEDGE-DESIGN.md
      - [p/ncLMHemt] 本地仓库是浅克隆，最早的提交是 2026-10-14，更早的提交是在 GitHub 远端查的。全程没有改动任何文件。
  - [p/ciIOhsMN] [ ] Q14 团队任务树什么时候放项目空间、什么时候放会话空间，要不要让用户选？
  - [p/zNm6LqxY] [ ] Q15 可领取池除了「自动领取默认关闭」，要不要按团队配置更多策略？
  - [p/5gWCGnt3] [ ] Q16 agent 的在场信息在界面上怎么显示才不吵？
  - [p/UEVQdYkB] 已回答
    - [p/vIkPD0xT] [x] 真相源放哪里？ @human:owner
      - [p/mzqeJ3Tu] 回答：数据库，永远不考虑 markdown 真相源和 vault 双向同步。见 [[p/D5]]
    - [p/Z50dD22z] [x] 要不要多人实时协同编辑同一个块？ @human:owner
      - [p/PKLCmlgu] 回答：要。见 [[p/D6]]
    - [p/8jNsS3fV] [x] 每块一个编辑器可以吗？ @human:owner
      - [p/mxVuBvKB] 回答：不作为主架构，改为自研大纲编辑器。见 [[p/D11]]
    - [p/Q9jT9DZk] [x] agent 能不能批准计划和变更？ @human:owner
      - [p/Gov4uqE2] 回答：能，限于权限内，后果落到责任人头上。见 [[p/D13]]

- [p/H0a1nXuL] [/] 大纲系统路线图：建成知识、记忆与任务的统一平台
  - [p/byjyTdXR] 目标：用块、类型、链接、空间、提交、层六个概念，替代 spec:// 和现有知识库，成为知识、记忆与任务的统一平台。设计见 docs/OUTLINE_KNOWLEDGE-DESIGN.md
  - [p/egTgAts3] 验收：spec:// 与知识库退役；多人实时协同可用；多个 agent 能在大纲上协作；检索支持 embedding 与 rerank
  - [p/6OpkjEq8] 约束：数据库是唯一真相源 [[p/D5]]；自由度由计划档位决定 [[p/D13]]
  - [p/DrYdFrth] [/] P-1 Python 原型与自用：先用原型承载这份计划，真实推进，从使用中发现问题 @agent:main
    - [p/uHnUVJL1] [x] 搭原型：块、链接、提交、时间机器、任务、两档计划、变更请求、断言与锚点 @agent:main
    - [p/NVqKvrzA] [x] 把这次的计划录进原型 @agent:main
    - [p/sdn8PPim] [ ] 用原型推进剩下的决策，用的过程中把问题记到「原型发现」 @agent:main
      depends:: [[把这次的计划录进原型]]
    - [p/RsN47wP2] [x] 时间机器的 HTML 查看器：静态页，拖时间轴看大纲怎么变 @agent:main
    - [p/SYEAKBsz] [x] 多 agent 试用：子代理领任务、写结果、提交验收，管理者代批 @agent:main
      - [p/Z4m02Pb8] 第一轮结果（Q6、Q13）：两个专注 agent 各交一份报告，没有规则负担，质量高；协调 agent 记了 53 个块、10 条提问、14 条发现，0 报错，但先读了 outline.py 约 1600 行源码（[[p/oDcGZOLZ]]）。规则负担没有消失，只是从专注 agent 转到了协调者身上
      - [p/Udw2gaib] 第一轮的摩擦在 853ebf0e 里处理了。修掉的：[[p/8xOHADRj]]「代」的歧义、[[p/JxNV7qfA]] 代记规则、[[p/wezmydyv]] 立场默认、[[p/X2hS0N1J]] --after、[[p/VpoFI7PK]] 行内代码里的双中括号、[[p/ACeb4kF6]] file: 证据没版本、[[p/uHX4EGi1]] 报告挂回、[[p/WSjnydef]] 看不出验收和管理者、[[p/xetsZBvn]] 调研型提问的交接、[[p/a9JvCq6q]] 丢空行。部分处理：[[p/IQn7U6Pl]] 默认身份（写入时回显身份，README 要求子代理先设 OUTLINE_ACTOR，没给身份仍不报错）、[[p/eWnSiDjJ]] 提问五项（别名自动编号并校验唯一，管理者和阶段标签还要手填）、[[p/FRkh7rVZ]] 锚点（支持 Python 和 --ref HEAD，按行号的位置还锚不上）
      - [p/n1n462G3] 第二轮（进行中）：派专注 agent agent:w-table 核实 SpecMarkdownEditor 丢表格（[[p/5nB0TYwk]]）；协调者 agent:steward2 只读 README、不读源码。两者都有注意范围，测范围外写入转请求、由 agent:main 代批，也测第一轮的修复够不够
      - [p/rwnKHTqH] 第二轮结果（核实 SpecMarkdownEditor 丢表格，[[p/5nB0TYwk]]）：专注 agent w-table 按 bun.lock 的版本用脚本复现了，属实（[[p/HcVYDQev]]），还查出图片、任务列表、HTML、JSON/YAML 文件、behavior_fence 的一串丢失和改写（[[p/48LIQZoc]]）。协调者 steward2 只读 README 和帮助，没读源码：58 条命令 0 条被拒、1 条报错（接管道），记了 10 条断言、5 条提问、15 条发现。三次写入落在它的范围外，自动转成扩大范围请求（CR2–CR4），由 agent:main 代批。和第一轮比，不再需要读实现，摩擦从「猜规则」变成了「说明里缺了什么」
      - [p/lFYG6Hm1] 第二轮的摩擦在 990935d7 里处理了。修掉的：[[p/exPd2lFV]] verify 输出矛盾、[[p/2HJvJjrd]] --note 丢失、[[p/OcqvZ54e]] cr show 看不出属性、[[p/53C4gjE1]] task 动作要猜、[[p/EAX0Hwa5]] 属性和中文取值、[[p/5460okFI]] 多条同角色链接、[[p/GzzDzTKS]] 标签段落后的列表、[[p/wv7gCwbn]] 复现输出没去处、[[p/csjqCZAm]]「关注」没有提示、[[p/EaZ7Aeeq]] 接管道报错。定下来的：[[p/ZFWs7gMs]] 代记时按代记人的范围判断，动手写的是代记人。部分处理：[[p/Jp1WgEIU]] 锚点版本（工作区和 ref 不一致时会提示，fresh 还不能按子树查）。说明清楚、不改：[[p/R5VvXWTt]] 只有纯范围请求会被自动关掉，带写入的请求要单独批，CR3 就是这样批的。没解决：[[p/alIh4NqM]] 转出去的新块批准前不存在，不能往下面再挂子块
    - [p/dtLLZ8zT] [x] 新鲜度检查对着最新的 main 跑一次（先 fetch） @agent:main
      - [p/AbuH7dSE] 结果：main 从 7c5170d7 前进到 b256a9ef（60 个提交），13 处代码锚点全部新鲜
    - [p/eYUSIhDP] [x] 把原型发现整理回设计文档 @agent:main
      depends:: [[把这次的计划录进原型]]
    - [p/8PsVaMVZ] [x] 第三轮：按第二版改原型（复选框任务、锁定、待确认、依据从运行记录挂接、代码锚点），重跑同类任务，对比协调成本、命令数和查帮助次数 @agent:main
      - [p/ajuQo3MG] 第三轮结果：专注 agent w-xrepo 调研 Q11，花 18.8 万 token、71 次调用；只读 README 的 lead3 记账花 12.0 万 token、48 条命令（查帮助 9、写入 16、报错 0），记了 10 条结论、9 条提问（3 个决策包）、给 Q11 补了建议。第二轮协调者是 23.9 万 token、58 条命令、查帮助 17、写入 7
      - [p/dIGr3LUl] 对照验收线：记账成本比 0.73 → 0.64，没到 0.2；每次写入的辅助命令 8.3 → 3.0；查帮助 17 → 9；每行标记 3.2 → 0.01；等你决定的条目 20 条提问 → 7 个决策包加 1 条（目标 ≤5 个）
      - [p/NYWQftb9] 记账成本降得少，是因为大头在读报告：209 行的报告读了 19 次 read。机械的部分（身份、编号、链接、位置）已经基本消失，剩下的是理解和判断
      - [p/W2Pz2HEg] 自动挂依据：10 条结论都挂上了，代码锚点 24 处、运行记录 14 处；但运行记录按「碰过同一文件」去对，挂错不少（同一次 createNarrator 调用挂到了三条不相关的缺口上）；行号换成符号有时太粗（十几行换成整个 runAgentLoopUnlocked）
      - [p/J9phBeeo] 新暴露的问题：ask 没有 --after，新决策包落在「已回答」后面；inbox 不带 --who 时看的是负责人的；勾掉别人进行中的任务不提示；协调者整理的结论没有自动链回报告；7 个决策包里有 3 个其实都属于 Q11，没有结构上的关联
  - [p/ydKe7oMn] [ ] P0 P0 设计与验证
    - [p/UV8qXrr2] [x] 设计文档讨论稿
    - [p/gPDU0vgb] [ ] 大纲编辑器与实时协同原型，按设计文档 §7.8 的清单验收
    - [p/BFv4Byng] [ ] 按时间点读取的性能基准（SQLite 与 PG）
    - [p/wBqGEPp7] [ ] db-worker 向量扫描基准
    - [p/5QM1KHbG] [ ] agent 使用结构化编辑工具的实测：Python 原型已经覆盖了一部分
    - [p/aTj0jdv3] [ ] 确认 D6–D15 的建议 ‹等前置：P-1›
      depends:: [[P-1]]
  - [p/bd2Egjgc] [ ] P1a P1a 核心存储、大纲编辑器（先单人，建在协同协议上）、时间机器最小版、会话读权限 ‹等前置：P0›
    depends:: [[P0]]
  - [p/kDh2CgDg] [ ] P1b P1b 多人实时协同：页订阅、页实时会话、在场信息、大纲事务、agent 的三方合并 ‹等前置：P1a›
    depends:: [[P1a]]
  - [p/f7vElM5K] [ ] P2 P2 替换 spec://，落地多 agent 协作、两档计划与计划模式改造 ‹等前置：P1a›
    depends:: [[P1a]]
  - [p/yxk3tBVg] [ ] P3 P3 检索（embedding、rerank、混合检索）、真值维护、计划结项 ‹等前置：P2›
    depends:: [[P2]]
  - [p/pJciER7x] [ ] P4 P4 层（提议、探索、记忆确认、Bot 隔离）与知识库迁移 ‹等前置：P3›
    depends:: [[P3]]
  - [p/2Ywkt58i] [ ] P5 P5 视图编辑器、图谱与图谱时间机器、模板、实体合并、只读导出 ‹等前置：P4›
    depends:: [[P4]]

- [p/TMdwYNRd] 原型发现
  - [p/CBTVZMXi] 搭原型和录入计划时发现的设计问题。每条都是要反馈进设计文档的修改，整理回文档后标为已处理。
  - [p/8ufzzqLQ] 块体需要「表格」：现状盘点、决策对照都离不开表格，设计文档 §2.1 的块体只有段落、标题、代码、引用
  - [p/YwjRs6kJ] 一次插入多块时需要临时标签（#标签）互相引用，比如步骤二前置于步骤一；正式版的 OutlineEdit 要支持
  - [p/bBLXUFIK] 需要人能记住的稳定别名（D1、P0、路线图）：随机短 id 只适合机器，人和 agent 在对话里都用别名
  - [p/kJThz9Os] 「某样东西不存在」这类结论锚不到符号上（比如仓库里没有向量代码），需要「检索锚点」：记下一个检索和它的结果集，结果变了就存疑
  - [p/PoBH5Bog] 锚点要能指向非声明的位置（数组里的一项、配置对象的一个键）；原型用检索锚点兜底，正式版要支持结构路径或行范围
  - [p/AKv45oAj] D1 的「单次改动超过 50 个块」应该只数改动已有的块；一次新建很多块不碰别人的内容，不算大改动
  - [p/b4NURQO1] 已批准的计划里，只有任务才算步骤：在步骤下写笔记、断言是记录进展，不算改计划。契约 = 计划根 + 根下直接挂着的非任务块
  - [p/PH5Odq0r] 变更请求只让被改的那一步受阻；新增步骤不影响已有步骤，不该让整份计划停下
  - [p/AGjS85c8] 获授权的 agent 自己改已批准的计划，也要走变更请求、由别人来批，否则「代批」就成了绕过
  - [p/CevSO7EI] 人确认个人空间的提议时，确认本身就是证据，被确认的断言应直接采纳
  - [p/wfB9Zsos] 计划根完成时还有子任务没做完：提示但不阻止，结项时它们成为遗留
  - [p/gCpTvLbi] 管理者应该沿任务子树继承：路线图归负责人管，它下面 agent 建的步骤也归负责人管
  - [p/PllM72C8] 对话里做出的决定没有稳定地址：原型只能写「chat:日期 + 原话」；正式版里应该指向 msg: 消息 id
  - [p/6hhSPqRU] 写检索锚点时，正则里的反斜杠会被参数解析吃掉；agent 写锚点需要不依赖转义的写法
  - [p/JNYdq1NP] 看板要区分「可以开始」和「等前置」：前置没完成的任务看起来和普通待办一样；原型改为推导出「等前置」标记，不写进状态
  - [p/wJsEdT5n] 工具输出里要直接给出数量（检查了几处锚点、改了几个块），agent 凭记忆写数字容易写错：录入时把 13 处锚点写成了 15，见第 15 个提交的更正
  - [p/IQn7U6Pl] 默认身份是个陷阱：命令不带 --as 时按 agent:main 执行。我开头 21 条读和检索命令没带身份，读取记录全记进了 agent:main 名下，等于替它刷新了「读到的版本」，它之后再改这些块时，并发检查会漏掉别人的修改。这次的块都是 agent:main 自己写的，没造成实际影响。协调者要在三个身份之间切换，没给身份时应该报错，至少在输出里回显当前身份
  - [p/8xOHADRj] 「代」有两种意思，命令行只显示一种：log 里「agent:w-dialect（代 human:owner）」的「代」指责任人；这次真正的代记人（recorded_by=agent:steward）只写进了 log.jsonl，命令行的 log 和 export 都不显示，只有 viewer.html 显示，读的人会以为是 w-dialect 自己写的。我只好把「steward 代记」写进每条提交消息和协调者笔记。责任人、代批、代记三个「代」，是这次最让我犹豫的概念
  - [p/JxNV7qfA] 代记时该用谁的身份，没有定下来的规则：报告结论是用专注 agent 的身份加 --by，还是用协调者身份写，只能从 [[p/D16b]]（还是待确认的假设）和 --by 的帮助推断；代码注释说代记见 §8.14，设计文档只到 §8.13。这条我读了好几遍，最后定为：报告里的结论和代交用专注 agent 身份加 --by，提问、看法、发现用 agent:steward
  - [p/wezmydyv] agent 写的 [assert] 带了证据，默认也是「假设」，要显式写 [assert:accepted]。README 说「没有依据的结论会被记为假设」，§9.6 说有证据的结论「直接是采纳」，读起来像有证据就会自动采纳；我读了 default_props 才确认，不然这次 30 条有依据的结论会全部记成假设
  - [p/eWnSiDjJ] 建一条提问要手填五项：alias（先扫一遍已有别名找空号，这次是 Q17–Q26）、owner=human:owner、manager、tags（提问加阶段）、source。manager 默认是创建者，也就是临时的协调者，我手动改成了 agent:main。别名重复不会报错，但两个块都会按别名解析失败（resolve 要求唯一）。这些应该由系统做：提问命令自动编号，管理者和阶段标签随 source 指向的任务继承
  - [p/X2hS0N1J] add --md 加 --after 时，只有第一条落在指定位置，其余追加到页尾，在待定问题页会排到「已回答」后面。我读 create_items 时发现了这一点，只好把 10 个提问拆成 10 条命令，每条接在上一条后面
  - [p/VpoFI7PK] 正文里没法写字面的双中括号：原型在正文任何位置都把它认成提及，行内代码里也一样。代记方言报告时，报告里用真实别名 D5、D6 写的示例会变成真链接，我只好改写成 `[[p/…]]`。这正是 Q6 要回答的转义和提及写法问题（[[p/Q23]]、[[p/Q18]]）
  - [p/FRkh7rVZ] 代码锚点只认 TS/JS 写法的声明，而且只对照 origin/main：报告引用的 outline.py 常量 INLINE_LINK 和 Python 函数都锚不上，origin/main 上也还没有 prototypes/outline/；按行号引用的位置也锚不上（同 [[p/PoBH5Bog]]）。这些只能写 evidence=file:，过期了看不出来。为了不报错，我先用 Python 预算了 16 个锚点的指纹，确认能算出来才写进去
  - [p/ACeb4kF6] 报告里的行号在代记前就对不上了：w-dialect 写完报告后，21c0ff6f 改了设计文档，报告里的 OD:438 现在在第 446 行。evidence=file:路径 不带版本，过后没人知道指的是哪一版，我只能在图例里注明「行号按 eeb244b6」。file: 证据应该自动记下当时的提交号，或者像 based_on 一样记指纹
  - [p/uHX4EGi1] 两份报告放在会话的临时目录里，会话结束就没了，指向它们的 file: 证据会失效。行内写法 {evidence=…} 带不了摘录，只有 task --excerpt 和 link --excerpt 能带，所以只在两次代交时加了摘录。已有的现状盘点用的是 report:spec-inventory-…，两种写法并存。§9.6 说子代理的最终报告应该自动挂到任务下面，现在这一步全靠协调者手抄，这次抄了 53 个块
  - [p/WSjnydef] read 和 board 看不出任务要不要验收、管理者是谁，只显示执行者。为了确认 Q6、Q13 要验收、管理者是 agent:main，我只能用 Python 直接加载状态查属性
  - [p/xetsZBvn] 调研型提问做完以后，没有把建议交给负责人拍板的环节：Q13 本身就是「是否保留」的提问，调研完进入待验收、由 agent:main 验收，负责人的收件箱里看不到。我另建了 [[p/Q25]] 请负责人决定，但拿不准它算不算和 Q13 重复；[[p/i5q1KUdz]] 只说「形成决策后链接到设计决策」，没说由谁发起
  - [p/a9JvCq6q] add --md 会静默丢掉空行：代码块里的空行会丢；表格后面也没法另起一段，因为 GFM 会把紧跟的文字并进表格，所以我把方言草案的缩写说明放进了子块
  - [p/oDcGZOLZ] 步数：到这一条为止执行了 57 条 outline 命令，没有报错。其中写入 18 条：代记内容 2 条（53 个块）、提问 10 条、Q10 补充 1 条、协调者笔记 2 条、代交 2 条、这一批发现 1 条；其余 39 条是帮助、读页、检索和核对。不报错的代价是先读了 outline.py 全文约 1900 行里的约 1600 行，又用 git、Python、curl 做了近 20 次只读核对（锚点指纹、文件路径、设计文档版本、任务属性）。纯记账的部分有别名编号、提问的五项属性、提问索引笔记、代交、核对位置和收件箱，大多可以由系统自动做
  - [p/e4NgxR0k] 章节号引用会随文档重排失效：设计文档插入 §10 之后，大纲里引用设计文档章节号的 13 处有 3 处指错了（[[p/7QQgsP3M]]、[[p/Q26]]、[[p/1wEcDyvj]]，已改）；写明提交号的 [[p/7rCR5pnr]]（「设计文档 21c0ff6f……§18」）仍然准确。正式系统里设计文档本身就在大纲里，引用是块链接，重排不会断；迁移期间引用外部文档，要像 file: 证据一样记下版本
  - [p/LRzBRVNS] 范围页上的泡本来可以用普通的 link 命令直接加，等于自己扩大范围、绕过批准；原型改成范围页上的「涉及」只能用 scope 命令增减。正式系统里，决定范围和权限的链接不能走通用的写链接路径
  - [p/QNztNKwM] 同一个泡会攒出好几条扩大范围请求：agent 被挡住时系统替它提一条，它自己再申请一条，上级替它申请又是一条。原型里批准其中一条之后，其余只要范围、而且已经满足的请求由系统关掉（状态 satisfied），不留给人处理
  - [p/Xu6k5OQ3] 带期限的授权，期限要从批准时算起：请求可能排队很久，从提出时算，授权时间会耗在等待上
  - [p/IkoZqV55] 范围一旦建立就是白名单：原来不受限的 agent 只要有了第一个泡，泡外的写入就都要申请。所以「执行」不能单独作为第一个泡，只申请一台设备的执行，会顺带把它在大纲上的写入都锁住。正式系统里，会话的主工作区和它所属项目的空间应当默认就是泡，额外的工作区和区域才需要申请
  - [p/CHZaxTxI] 「建议」不能按普通断言的默认立场处理：有证据的断言默认采纳，但建议在负责人采纳之前不该是采纳。原型里写建议时显式标成假设，answer 采纳时再改成采纳；正式系统里可以让建议成为提问下的一种块，立场由回答决定
  - [p/5oXqgL87] agent 从命令输出里抠地址容易抠错：行首的 [地址] 和正文里的 [[提及]] 长得一样。我用 sed 取新任务的地址，取到了正文里提及的块，给专注 agent 圈错了泡（#55，#59 改回）。正式工具的返回值要结构化，新建的块单独给出地址
  - [p/oN5wEBog] 报告挂回能用：两份报告分别转成 45 和 53 个块，表格、嵌套列表、「**样本**」这类标签段落下的列表都落在该在的位置；12 条指向临时文件的证据改指到挂好的块（[[p/4LKK4aHV]]、[[p/MwhYZUvK]]）
  - [p/exPd2lFV] verify 被转成请求时，输出前后矛盾：先说「已转成扩大范围请求 CR3」，紧接着又打印「已复核 p/f3TO9Yre：fresh」，读起来像已经生效；实际块还是「假设·待决定：CR3」。被转出去的命令应该只报请求，不报结果
  - [p/2HJvJjrd] verify 的 --note 不在请求里：CR3 只有「涉及」链接、证据链接和 stance=accepted 三个操作，我写的复核意见（没在真浏览器里点、丢表格和 DOM 无关）不见了。不读源码没法知道批准后会不会补上，只好在任务下另写一条协调者笔记（[[p/60fYKsDg]]）。另外，复核成立后，正文里「这是读源码推断的，没在浏览器里实测」会原样变成采纳的断言；用 fresh 不会提示改写，用 update 又像是结论本身要改，README 没说这种情况选哪个
  - [p/OcqvZ54e] cr show 看不出转出去的写入写得对不对：CR2 列了新块的地址、正文和链接，但不显示属性（alias=Q? 会编成几号、执行者、管理者、标签、立场）和插入位置（--after p/Q26）。提问是不是排在「已回答」前面、建议是不是假设，要等 agent:main 批准后才知道，写错了也只能批准后再改
  - [p/R5VvXWTt] 同一个泡攒了两条带操作的请求：CR2（建提问）和 CR3（复核）都要把待定问题页以「修改」纳入我的范围。[[p/QNztNKwM]] 说批准一条之后，其余「只要范围、已经满足」的请求由系统关掉；CR3 带着自己的操作，批准 CR2 之后它会被关掉（复核丢失）、自动执行，还是继续等决定，README 没写
  - [p/ZFWs7gMs] 代记时按谁的范围判断没写：README 说 --as 是作者、--by 是代记人，但没说泡内泡外看作者（agent:w-table 的泡只有这个任务）还是代记人（agent:steward2 的泡是整个 spec 现状页）。这次写在任务下的内容两人的泡都覆盖，看不出来。提问我改用自己的身份写，免得批准后扩大的是已经收工的 w-table 的范围
  - [p/alIh4NqM] 提问和下面的建议只能用同一个身份写：建议是 w-table 报告的倾向，按代记规则应该算 w-table 的；但提问在泡外，整批转成 CR2，新块要批准后才存在，没法先建提问、再换 w-table 的身份在下面补建议，只好在建议正文里写明「agent:w-table 报告的倾向」。README 只说报告里的「结论」用专注 agent 的身份加 --by，没说报告里要人决定的点和倾向怎么记
  - [p/53C4gjE1] task 的动作要猜：README 只写了 start、block、done、accept，task -h 还列了 submit、revise、cancel、reopen，都没有说明；需验收的任务用 done 是进待验收还是直接完成，也没写。我看了上一轮的 diff 36 37（doing → submitted）才决定用 submit
  - [p/EAX0Hwa5] 帮助里没有属性和取值：add -h、set -h、ls -h 只有参数名，不列属性键（alias、owner、manager、tags）和类型、状态、立场的取值。manager 这个键 README 里一次也没出现，我是从上一轮的发现 [[p/eWnSiDjJ]] 里看到的。输出显示中文（假设、待验收），过滤却要英文：ls --stance 假设 什么也查不到，--stance hypothesis 才行，而 README 里只出现过 accepted
  - [p/5460okFI] 同一角色写多条链接的写法没写：README 的例子每行只有一个 based_on、一个 evidence。我在花括号里重复写 based_on=…、evidence=…，读回来都在（[[p/mTbiTmRJ]] 有 5 个基于）；这是试出来的，应该写进 README
  - [p/GzzDzTKS] attach 对段落和列表之间的空行敏感：README 说「紧跟在段落后面的列表挂在那个段落下面」。w-dialect 的报告里「**路径缩写**」下一行就是列表，挂成了子块；w-table 的报告按常见写法在标签段落和列表之间空一行，「补充三点：」「**版本**」「**脚本**」「**原因**」后面的列表就都成了兄弟块（[[p/YBQH5ZDL]]）。在 Markdown 里有没有这个空行是同一个结构，挂回的结果不该不同
  - [p/wv7gCwbn] 复现输出没有好去处：w-table 的复现脚本和输出存档在会话临时目录，我按要求用 file: 作证据，每条链接都提示一次「在仓库之外……报告类文件请先用 attach 放进大纲」（3 个文件提示了 6 次）；可它们不是报告，attach 只收 markdown 报告，会话结束后这些证据只剩指纹。证据类的附件需要一个能存进大纲的地方
  - [p/Jp1WgEIU] 锚点对照的版本要自己核对：based_on 默认按 origin/main 记指纹，报告却是按工作区读的代码，而这个仓库的工作区和 origin/main 已经分叉（HEAD 落后 60 个提交、领先 15 个）。add 不提示被引用的文件两边是否一致，我用 git diff 逐个核对了被引用的文件（只有 schema.ts 不同，且不在 specFileRevisions 那段）。写完后 fresh 只报「44 处锚点全部新鲜」，看不出新加的 13 处 based_on 有没有被记上（其中有对象方法 writeSpecFileRevision 和检索锚点），也不能用 --under 只查自己写的
  - [p/csjqCZAm] 「关注」级别的页读起来和能写的页一样：待定问题页在我的泡里是「关注」，read 时没有任何提示；只有完全在泡外的「原型发现」页才显示「范围外……要在这里写，会转成扩大范围请求」。我是先看了 scope show 才知道写提问会被转出去
  - [p/EaZ7Aeeq] 小问题：log -n 35 接 head 会抛 BrokenPipeError 的 Python 调用栈；log 只有 -n（最近 N 条）和 --under，看不了中间一段（比如第 50 到 61 个提交），只能多取再截
  - [p/ksGzonZJ] 步数：到这一条为止执行了 57 条 outline 命令，1 条报错（log 接 head 时的 BrokenPipeError，是我加管道引起的），没有命令被拒绝。其中帮助 17 条；写入 7 次，直接生效 4 次（挂报告 151 块、代记 10 条断言、代交、协调者笔记），转成请求 3 次（CR2：5 条提问、3 条建议、1 条参考；CR3：复核；CR4：这批发现）；其余 33 条是读页、范围、日志、diff、看板、ls、cr、收件箱和 fresh（fresh 重复跑了 2 次）。读的文档：README 全文和 16 个子命令的 -h；没有读 outline.py，也没有读 data/log.jsonl。另外用 git、grep、sed 做了 17 次只读核对（报告目录、被引用的产品源码、node_modules 里的 Tiptap 源码、复现输出、两份报告的空行），其中 2 次是我自己写错了路径或参数。README 这次写对、我验证到的：有依据的断言直接采纳，只带出处的是假设，显式立场优先，行内代码里的反斜杠原样保留，报告挂回后表格和代码块完整
  - [p/CJxh3m7M] 转成请求的批量写入，批准时丢了插入位置：第二轮的 Q27–Q31 落到了「已回答」后面，只好手动挪回去（#91–#95）。原型改成在请求里记下要接在谁后面，批准时照原位插；cr show 也显示出来，批准前能检查
  - [p/dMypdGwK] Python 代码锚点原来只取到 def 那一行：取范围的办法是配平括号，而 Python 的括号在签名那一行就配平了，函数体怎么改都不会存疑。改成按缩进取整个函数或类。真实日志里还没有 Python 锚点，没有受影响；正式系统用 tree-sitter 取结构，不会有这个问题，但「锚点覆盖到哪」要有测试
  - [p/J0Wts4Pj] 复现脚本和输出也要挂回大纲：专注 agent 的证据大多是临时目录里的脚本输出，报告挂回之后，这些 file: 证据仍然悬空（12 条）。原型的 attach 改成也收非 markdown 文件，整个放进代码块，指向它们的证据跟着改指；第二轮的 3 份输出和 6 个脚本都挂在任务下了
  - [p/1Gy7MXgj] 第三轮协调者的发现
    - [p/Foueogjo] 新建的决策包落在页尾「已回答」后面：ask --bundle 第一次用某个包名时，系统在待定问题页的末尾新建包块，排到「已回答」之后（同 [[p/CJxh3m7M]] 一类问题）。ask 没有 --after，bundle 命令也没有位置参数，只能事后用 3 条 mv 挪到 Q11 后面
    - [p/oE11u3X5] ask 的父块和 --bundle 的关系 README 没写：父块写「待定问题」页，包建在哪、包已存在时父块还起不起作用，都是试出来的（包建在父块下，题目放进包里）。从调研里拆出来的细项提问该放在页上的包里，还是放在 Q11 下面，[[p/i5q1KUdz]] 也没说；我放进了页上的包，和 Q11 之间没有结构关系，只在 Q11 的建议正文里写了 Q32–Q40
    - [p/QhztterZ] Q11 和它的细项不在一起：Q11 是单独的问题，三个决策包在另一处；负责人采纳 Q11 的建议时会不会连带看到细项、要不要把 Q11 也放进包，README 没说。我没有把 Q11 编进包，因为它是负责人自己的问题
    - [p/iOmfLVmT] inbox 不说是谁的收件箱：以 agent:lead3 身份运行 inbox，显示的是 human:owner 的待确认和待回答（P1 要「本人确认」、7 个决策包），标题却是「待你确认」「等你回答」；digest 末尾也写「等你决定：1 条待确认，7 个决策包」。inbox -h 有 --who，但没说不写时默认看谁。我差点以为 P1 要我确认
    - [p/N3QwN9D9] 自动挂的运行记录依据有不少不相关：add 之后用 read --basis 看，缺口二、三、四三条结论都挂上了同样的 trace #67（createNarrator）和 #69（executionPolicyEngine.invalidate），缺口一挂上了 #66（subagentVar），第一条挂上 #5（visibility = public）。和结论对不上的依据会让人以为这是证据。README 只说「依据不用自己写」，没说运行记录依据怎么挑，挑错了怎么删
    - [p/fmBW3qa8] add 的输出不报依据：只列新块的地址和正文开头，不说每块锚上了几处代码、挂了哪些运行记录，要再跑 read --basis 才知道（同 [[p/wJsEdT5n]]）。这次 10 条结论写了约 30 处位置，有 4 处留成了行范围（没换成符号），从输出看不出来
    - [p/2DwNVZSG] 行号换成符号的结果有的看不出对不对：一个只覆盖十几行的行范围被换成了整个大函数（orchestrator 的 runAgentLoopUnlocked），函数里任何改动都会让这条结论存疑；报告说某段是 resolveNarratorProjectId 的同步镜像，换出来的符号却叫 actorAuthorizationSnapshot。另外报告的基线是讨论里那个分支的 becf57ee，README 没说指纹按工作区、HEAD 还是 origin/main 记，我没法判断这些锚点是否和报告读的是同一版
    - [p/jWILTtiM] 报告里的简写位置要手工展开：报告大量用 `:648`、`:1226` 这种省略文件名的写法，抄进结论时我都改成了完整的 路径:行号，否则不知道会不会被认成位置。讨论分支上的位置（narrator-device-workspace-service）在当前工作区不存在，我干脆没写行号，只写了分支名
    - [p/tjbN2mGW] 从报告整理的结论怎么标出处没写：10 条结论里只有写了报告块链接的那一条挂上了「依据：报告」，其余 9 条没有任何指向报告的依据，以后检索到时看不出它们来自 w-xrepo 的报告。README 第二版不再提出处、based_on、--by，我按「依据不用自己写」处理了，但不确定协调者整理的结论该记谁的名、要不要链回报告
    - [p/Y26gFGQS] 勾掉别人的任务没有任何提示：调研任务指派给 agent:w-xrepo、状态是进行中，我用 edit --box x 直接勾成完成，没要 --steal，也没提示执行者是谁、要不要验收。README 说「别人正在做的会告诉你是谁」，这次没告诉；如果是因为我是派活的人所以放行，README 应该写明
    - [p/ixNfWbQE] 位置行截断成了误导：read 的「位置：」把 Q11 的标题截成「项目空间怎么对应多个 pr」，我一开始以为 Q11 问的是多个 PR，读了 Q11 本身才知道是「多个 projects 行」。截断应该在词边界或加省略号
    - [p/AcGmMcLZ] 帮助缺说明：ask -h 的 --option、--reason、--to 没有说明，--to 不写时交给谁没说，我每条都显式写了 --to human:owner；digest -h 的 --since 没说是提交号还是日期（试出来是提交号）；mv -h 没说 --after 和 parent 冲突时以谁为准
    - [p/gUPgPIf3] 这轮 README 够用的地方：ask 自动编号（Q32–Q40 连续，没有手工找空号）、--bundle 同名复用、ask Q11 --recommend 补建议、写入回显身份「（agent:lead3）」，都和 README 写的一致；--recommend 写编号时建议块会带上选项原文，负责人不用对照编号
    - [p/h5ypfM0g] 步数：到这一条为止执行了 48 条 outline 命令，0 条报错，没有命令被拒绝或转成请求。其中帮助 9 条（总帮助和 read、ask、add、edit、bundle、mv、digest、inbox）；写入 16 次：结论 1 次（10 块）、提问 9 次、Q11 补建议 1 次、勾完成 1 次、挪决策包 3 次、这批发现 1 次；其余 23 条是读页、read --basis、inbox、digest。读的文档：README 全文和上面 9 个 -h，外加大纲里「原型发现」页和待定问题页的说明块；没有读 outline.py 源码，没有读 data/ 下的文件，也没有用 git、grep 做别的核对

- [p/a4bsGcVR] 概念与规则
  - [p/CQhWv1YD] 六个概念：块、类型、链接、空间、提交、层。详见 docs/OUTLINE_KNOWLEDGE-DESIGN.md §2
  - [p/ay8D5pME] 九条规则
    - [p/zb1ow927] 一切关系都是链接，含义由角色决定
    - [p/2uUBkSI4] 能推导的不存储：新鲜度、「已被取代」都从链接推导
    - [p/3jlovrjM] 历史只追加：撤销是补偿提交，fork 是复制
    - [p/V1utFors] 块不跨空间：跨空间「移动」是复制加原处删除
    - [p/cC6VPdFb] 层只为待决定的改动而存在
    - [p/1iTUhoFx] 注入即视图
    - [p/5TYh69qJ] 人看实时，agent 看快照
    - [p/orLbw5BK] 图谱是黑板：以后还会用到的东西都写进图谱
    - [p/8T6jFKZI] 自由度由计划决定：草稿随情况改；已批准的计划，要改先停下汇报 [[p/D13]]

- [p/eD06Kd6H] 需求清单：负责人确认过的 25 条需求，按功能写，不按名字写。设计文档第二版 §1.1 和附录 A 逐条对应
  - [p/v0Y4L01Z] R1 一个统一平台：全局知识、个人知识和偏好、工程规格、任务放在同一套东西里
  - [p/AeNKokNq] R2 完全替代现在的 spec:// 和知识库
  - [p/CCTKdsXK] R3 支撑这些场景：新项目起草、老项目探索并建立完整图谱、新需求开拓、修 bug、多路径探索最后只留一条、coding 之外的项目管理
  - [p/g9j8eQO6] R4 像 Obsidian 的大纲笔记：层级不限，内容双向关联
  - [p/eqijJeep] R5 在一处直接看到、编辑别处的内容（「传送门」）
  - [p/nMnXszsT] R6 把散在各处的内容拼成一个视图（「定制拼接视图」）
  - [p/IatQMchH] R7 查看时底部有时间轴，快速浏览图谱随时间的变化
  - [p/5sdrf2lp] R8 数据库是唯一真相源；永远不以 markdown 文件为真相源，永远不和 Obsidian vault 双向同步
  - [p/0mFu83NI] R9 多人实时同时编辑同一个块
  - [p/epyDKpqL] R10 为大纲文档设计的编辑器，可以重写或深度定制，不是每块一个编辑器
  - [p/Km4p5Bc8] R11 agent 直接写入，不经过暂存再合并
  - [p/1OEwmafN] R12 接入 embedding 和 rerank，让 agent 检索得更准
  - [p/b7AWtEqV] R13 这套模型真正服务于多 agent 协作
  - [p/e1ewatDO] R14 agent 按大纲做事并及时更新大纲，同时保留自由自主，不过度防御
  - [p/389OyPGR] R15 概念和规则不能多到分散注意力、削弱能力
  - [p/XXuPtJS8] R16 能派不受约束的子 agent 专心攻坚，由守规则的 agent 帮它协调；攻坚的 agent 要真的专注，不给它加格式
  - [p/ZcjAWDMP] R17 支持多语言，不依赖解析自然语言
  - [p/41Dc6svw] R18 写计划的人决定严格程度：粗略的草稿随情况改；讨论审批过的严密计划尽量照做，要改先停下来汇报
  - [p/5EcPTW73] R19 agent 可以在权限内批准变更，后果最终落到创建人头上
  - [p/nXLq4bR0] R20 规划方式重新设计，不再是「一段 md 一个 plan」
  - [p/xmCf5oGa] R21 计划完成后滤掉不需要的信息、整理结构，自然成为知识；同时保留当时的计划，供参考和追溯
  - [p/9NRw07bj] R22 一个会话原生管多个工作区、多台设备上的目录，用于多服务器联调、多仓库联合开发
  - [p/fX7WsrHR] R23 agent 有几块关注区域（「泡」），区域外也能适当查看，保持适配
  - [p/zBHuExWQ] R24 主 agent 或人可以批准下级 agent 改变范围
  - [p/EIneKhpg] R25 先用 Python 原型承载这次的计划，真实推进，从使用中发现问题

## me · 负责人的个人空间
