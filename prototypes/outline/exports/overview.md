<!-- 由 prototypes/outline/outline.py export 生成（第 25 个提交）。真相源是 data/log.jsonl，不要手改。 -->

# 大纲总览

## p · NarraFork

- [p/Pa320SYM] 设计决策 ‹决策›
  - [p/7QQgsP3M] 这一页记录大纲系统的设计决策。已确认的决策带着负责人在对话里的原话作为证据；建议还是「假设」，等负责人确认。详细论证见 docs/OUTLINE_KNOWLEDGE-DESIGN.md §16。
  - [p/aQdrRFwd] D1 默认直写：每次写入都带来源、可以撤销；探索 fork 的写入进层 ‹D1·断言·采纳·#决策›
    ↳ 证据：chat:2026-10-24「直写是需要的」
    - [p/cSRo6HMn] 例外（删除或移动团队之外的人写的块、单次改动超过 50 个已有块）自动转成提议，不打断 agent ‹D1a·断言·假设·#决策 #待确认›
  - [p/PeiyVKZE] D2 知识过期默认在读取时复核；批量复核由用户点按钮触发；后台复核默认关闭 ‹D2·断言·采纳·#决策›
    ↳ 证据：chat:2026-10-24「按你的推荐来」
  - [p/OjBAfwCV] D3 共享空间历史永久保留，会话空间历史随会话；管理员可以彻底清除；被引用的版本不能删 ‹D3·断言·采纳·#决策›
    ↳ 证据：chat:2026-10-24「按你的推荐来」
  - [p/iMIREuDd] D4 时间机器按当前权限显示历史 ‹D4·断言·采纳·#决策›
    ↳ 证据：chat:2026-10-24「4可以接受」
  - [p/74dzXAGs] D5 数据库是唯一真相源；永远不以 markdown 文件为真相源，永远不与 Obsidian vault 双向同步 ‹D5·断言·采纳·#决策›
    ↳ 证据：chat:2026-10-24「永远不考虑的，我们的真相源就是数据库」
  - [p/oyRkMECT] D6 支持多人实时协同编辑同一个块 ‹D6·断言·采纳·#决策›
    ↳ 证据：chat:2026-10-24「多人实时协同编辑同一个块是需要考虑上的」
    - [p/NEN9Br1I] 选型：按页建实时会话，一页一个 Y.Doc，块正文是其中的 Y.Text；结构由服务端排序；agent 按读取版本三方合并 ‹D6a·断言·假设·#决策 #待确认›
  - [p/UX1YUbm4] D7 embedding 与 rerank 从模型目录配置，支持 API 与 OpenAI 兼容的本地端点；没配置时退化为 FTS ‹D7·断言·假设·#决策 #待确认›
  - [p/1byjKamb] D8 知识库空间默认走审核（层即提议），可以按空间改成直写 ‹D8·断言·假设·#决策 #待确认›
  - [p/YjEt8WXX] D9 会话的读权限取所有驱动者权限的交集 ‹D9·断言·假设·#决策 #待确认›
  - [p/BG0a5PpL] D10 向量初版存成 BLOB，在 db-worker 里暴力扫描，不引入原生扩展 ‹D10·断言·假设·#决策 #待确认›
  - [p/4Z0d9qlG] D11 自研大纲编辑器，建在 ProseMirror 视图层上；块模型是真相，编辑器文档只是投影 ‹D11·断言·假设·#决策 #待确认›
    - [p/D0h4UHSk] 不用「每块一个编辑器」作为主架构 ‹断言·采纳·#决策›
      ↳ 证据：chat:2026-10-24「每块一个编辑器真的可以吗，我们可能需要重新写或者定制支持大纲文档的编辑器」
  - [p/I6StRgTN] D12 多 agent：图谱是黑板；委派即建任务；角色由任务推导；开始做即领取；验收默认关闭 ‹D12·断言·假设·#决策 #待确认›
  - [p/aYM78wgu] D13 计划分草稿和已批准两档，由写计划的人声明；已批准的计划要改先停下汇报；agent 可以在权限内批准，后果落到责任人头上 ‹D13·断言·采纳·#决策›
    ↳ 证据：chat:2026-10-24「依据人在写计划的时候规定这个计划是简单的粗糙的草稿还是已经经过讨论和审批的严密计划」；chat:2026-10-24「可以支持agent批准权限内的变更。但这个后果要能最终落到创建人头上」
  - [p/YRVOALjs] D14 计划模式重做：计划就是任务子树，审批时选择草稿或已批准，计划文件退役 ‹D14·断言·假设·#决策 #待确认›
    - [p/gUgKSWlV] 计划不再是一段 markdown ‹断言·采纳·#决策›
      ↳ 证据：chat:2026-10-24「总之应该不是现在这种一段md一个plan」
  - [p/4HXBJkws] D15 计划结项：系统分拣、agent 提炼进主题页；计划归档并钉在完成那一刻；用「出处」双向追溯 ‹D15·断言·假设·#决策 #待确认›
  - [p/CZyp6nnF] D16 系统要支持派「没有什么约束」的专注 agent 集中攻坚，由遵循规则的协调 agent 帮它们记账、处理规则 ‹D16·断言·采纳·#决策›
    ↳ 证据：chat:2026-10-24「这套系统需要支持派一些没有什么约束的子agent来集中精力攻坚，由遵循规则的agent来帮忙协调处理」
    - [p/QSWtw144] 专注 agent 只拿到普通语言写的任务说明，不知道大纲、地址、角色和规则；它交一份报告就结束 ‹D16a·断言·假设·#决策 #待确认›
    - [p/oYaXx3vw] 协调 agent 把报告翻译成大纲上的东西：状态、证据、结论、遗留、提议；以专注 agent 的身份代记，并留下自己的名字 ‹D16b·断言·假设·#决策 #待确认›
    - [p/ZZkZIZOE] 「无约束」指不背大纲协议，不是不受安全约束：工具权限、行为边界照旧由系统强制 ‹D16c·断言·假设·#决策 #待确认›

- [p/BUvPjg55] 现状：spec:// ‹现状spec›
  - [p/sqzCCSvC] 2026-10-23 对 main @ 7c5170d7 的盘点。每条结论都锚在代码上，main 变了就会存疑。
  - [p/5SbJBOHq] 每个叙述者一个 spec 命名空间（narrator_id 唯一） ‹断言·采纳›
    ↳ 基于：code:server/db/schema.ts#specNamespaces
    ↳ 证据：report:spec-inventory-2026-10-23
  - [p/nxoITrqe] fork 时子会话的文件指针直接引用父会话的修订行，修订行随父会话的命名空间级联删除；父会话被硬删后，子会话的文件会悄悄消失 ‹断言·采纳·#坑›
    ↳ 基于：code:server/services/knowledge/sqlite-write-store.ts#forkSpecNamespace；code:server/db/schema.ts#specFileRevisions
    ↳ 证据：report:spec-inventory-2026-10-23
  - [p/BYer0yuP] 回退会话时 spec 内容不跟着回退：只把 spec 修订的来源消息置空 ‹断言·采纳›
    ↳ 基于：grep:spec_file_revisions@server/services/revert-history-commit.ts
    ↳ 证据：report:spec-inventory-2026-10-23
  - [p/GGLDhXV9] tasks.json 最多 100 条，任务以正文的 hash 为身份，改一个字就成了删旧建新 ‹断言·采纳›
    ↳ 基于：code:server/services/spec-task-service.ts#TASKS_MAX_ITEMS；code:server/services/spec-task-service.ts#taskTextHash
    ↳ 证据：report:spec-inventory-2026-10-23
  - [p/iZyoacoR] 任务摘要默认每 15 次工具调用注入一次 ‹断言·采纳›
    ↳ 基于：grep:tasksReminderInterval:[[:space:]]*15@server/lib/settings/defaults.ts
    ↳ 证据：report:spec-inventory-2026-10-23
  - [p/CEIo4QC5] spec 上的 Grep 是把全部文件读出来跑正则，没有索引 ‹断言·采纳›
    ↳ 基于：code:server/lib/vfs-grep.ts
    ↳ 证据：report:spec-inventory-2026-10-23

- [p/pMf5hzCG] 现状：知识库 ‹现状知识库›
  - [p/aOYgbhLy] 2026-10-23 对 main @ 7c5170d7 的盘点。
  - [p/sv1MJ4Xo] 搜索先截取前 N 条，再做标签和 ACL 过滤，结果可能变少 ‹断言·采纳·#坑›
    ↳ 基于：code:server/services/knowledge-service.ts#search
    ↳ 证据：report:kb-inventory-2026-10-23
  - [p/KojJGsXl] 知识注入按当轮发起人（_currentUserId）解析权限；但上下文跨轮共享，多人会话里 A 读进来的内容 B 能问出来 ‹断言·采纳·#坑›
    ↳ 基于：grep:resolveInjections[(]actingUserId@server/services/agent-runtime/orchestrator.ts
    ↳ 证据：report:kb-inventory-2026-10-23
  - [p/3NGdju5z] 仓库里没有向量检索代码（sqlite-vec、pgvector） ‹断言·采纳›
    ↳ 基于：grep:sqlite-vec|pgvector@server
    ↳ 证据：report:kb-inventory-2026-10-23
  - [p/ga38jnrJ] human attention 现有五种：异步提问、阻塞提问、权限、计划审批、反思 ‹断言·采纳›
    ↳ 基于：code:shared/human-attention.ts#HumanAttentionKind
    ↳ 证据：report:kb-inventory-2026-10-23
  - [p/Xtj0I8nI] 计划模式提交的是一段 markdown，或 .narrafork/plans/ 下的计划文件 ‹断言·采纳›
    ↳ 基于：code:server/lib/plan-file-path.ts#PLAN_DIR_REL
    ↳ 证据：report:kb-inventory-2026-10-23

- [p/5N6EK3Bl] 待定问题 ‹问题›
  - [p/i5q1KUdz] 要负责人决定的问题指派给 human:owner，会出现在收件箱里；需要先调研的问题指派给 agent。回答写成子块，形成决策后链接到「设计决策」。
  - [p/G8CCrUUY] 「创建人」指 agent 的创建者，还是计划的创建者？ ‹Q1·任务·待办·执行：human:owner·#提问›
  - [p/8NPAfqiW] D1 的例外改成「转成提议、不打断 agent」，可以吗？ ‹Q2·任务·待办·执行：human:owner·#提问›
    - [p/u6vfIWaq] 涉及 [[p/D1a]]
  - [p/t5G1F2nN] 代批授权：只能逐个计划授权，还是允许责任人设一个会话级默认值？ ‹Q3·任务·待办·执行：human:owner·#提问›
  - [p/iGqfdydQ] 规划阶段默认只读（像现在的计划模式），还是默认宽松？ ‹Q4·任务·待办·执行：human:owner·#提问›
  - [p/7XCKKkng] 主题页要不要标准结构（概述、职责、关键决策、坑、不变量、试过的方案），做成内置模板？ ‹Q5·任务·待办·执行：human:owner·#提问›
  - [p/sxbH6X7b] 块内 markdown 方言支持哪些行内语法和块体？规范写法怎么定？ ‹Q6·任务·进行中·执行：agent:w-dialect·#提问 #P0›
    - [p/84a3O52n] 原型发现：表格要能做块体，见「原型发现」页
  - [p/shELx7W7] 块选择模式与移动端手势的交互细节 ‹Q7·任务·待办·#提问 #P0›
  - [p/uBFCt3q3] 超长页：占位节点按需替换够不够，还是只靠折叠与聚焦？以 P0 性能数据为准 ‹Q8·任务·待办·#提问 #P0›
  - [p/OL2RTQbp] 知识库旧修订：迁移时只迁当前状态，旧修订只读保留多久？ ‹Q9·任务·待办·#提问 #P4›
  - [p/3bxAuIFU] 标签：属性里的字符串数组，还是像 Obsidian 一样每个标签对应一页？ ‹Q10·任务·待办·#提问›
  - [p/UMJvCvWQ] 一个需求跨多个仓库时，项目空间怎么对应多个 projects 行？ ‹Q11·任务·待办·#提问›
  - [p/XzYozzQg] 探索组的对比视图要不要内置「方案 / 结果 / 代价」模板？ ‹Q12·任务·待办·#提问 #P4›
  - [p/WxOgq9RU] 任务反思是否保留为可选的完成证据核查？ ‹Q13·任务·进行中·执行：agent:w-reflection·#提问 #P2›
  - [p/ciIOhsMN] 团队任务树什么时候放项目空间、什么时候放会话空间，要不要让用户选？ ‹Q14·任务·待办·#提问 #P2›
  - [p/zNm6LqxY] 可领取池除了「自动领取默认关闭」，要不要按团队配置更多策略？ ‹Q15·任务·待办·#提问 #P2›
  - [p/5gWCGnt3] agent 的在场信息在界面上怎么显示才不吵？ ‹Q16·任务·待办·#提问 #P1b›
  - [p/UEVQdYkB] 已回答
    - [p/vIkPD0xT] 真相源放哪里？ ‹任务·完成·执行：human:owner·#提问›
      ↳ 证据：chat:2026-10-24「我们的真相源就是数据库」
      - [p/mzqeJ3Tu] 回答：数据库，永远不考虑 markdown 真相源和 vault 双向同步。见 [[p/D5]]
    - [p/Z50dD22z] 要不要多人实时协同编辑同一个块？ ‹任务·完成·执行：human:owner·#提问›
      ↳ 证据：chat:2026-10-24「是需要考虑上的」
      - [p/PKLCmlgu] 回答：要。见 [[p/D6]]
    - [p/8jNsS3fV] 每块一个编辑器可以吗？ ‹任务·完成·执行：human:owner·#提问›
      ↳ 证据：chat:2026-10-24「我们可能需要重新写或者定制支持大纲文档的编辑器」
      - [p/mxVuBvKB] 回答：不作为主架构，改为自研大纲编辑器。见 [[p/D11]]
    - [p/Q9jT9DZk] agent 能不能批准计划和变更？ ‹任务·完成·执行：human:owner·#提问›
      ↳ 证据：chat:2026-10-24「可以支持agent批准权限内的变更」
      - [p/Gov4uqE2] 回答：能，限于权限内，后果落到责任人头上。见 [[p/D13]]

- [p/H0a1nXuL] 大纲系统路线图：建成知识、记忆与任务的统一平台 ‹路线图·任务·进行中›
  - [p/byjyTdXR] 目标：用块、类型、链接、空间、提交、层六个概念，替代 spec:// 和现有知识库，成为知识、记忆与任务的统一平台。设计见 docs/OUTLINE_KNOWLEDGE-DESIGN.md
  - [p/egTgAts3] 验收：spec:// 与知识库退役；多人实时协同可用；多个 agent 能在大纲上协作；检索支持 embedding 与 rerank
  - [p/6OpkjEq8] 约束：数据库是唯一真相源 [[p/D5]]；自由度由计划档位决定 [[p/D13]]
  - [p/DrYdFrth] P-1 Python 原型与自用：先用原型承载这份计划，真实推进，从使用中发现问题 ‹P-1·任务·进行中·执行：agent:main›
    - [p/uHnUVJL1] 搭原型：块、链接、提交、时间机器、任务、两档计划、变更请求、断言与锚点 ‹任务·完成·执行：agent:main›
      ↳ 证据：commit:aae9623b
    - [p/NVqKvrzA] 把这次的计划录进原型 ‹任务·完成·执行：agent:main›
      ↳ 证据：file:prototypes/outline/exports/overview.md
    - [p/sdn8PPim] 用原型推进剩下的决策，用的过程中把问题记到「原型发现」 ‹任务·待办·执行：agent:main›
      ↳ 前置：p/NVqKvrzA
    - [p/RsN47wP2] 时间机器的 HTML 查看器：静态页，拖时间轴看大纲怎么变 ‹任务·完成·执行：agent:main›
      ↳ 证据：url:https://claude.ai/artifact/CioFZFhdnfL1uaay4v3qrT；file:prototypes/outline/viewer.html
    - [p/SYEAKBsz] 多 agent 试用：子代理领任务、写结果、提交验收，管理者代批 ‹任务·进行中·执行：agent:main›
    - [p/dtLLZ8zT] 新鲜度检查对着最新的 main 跑一次（先 fetch） ‹任务·完成·执行：agent:main›
      ↳ 证据：tool:outline fresh --fetch @b256a9ef
      - [p/AbuH7dSE] 结果：main 从 7c5170d7 前进到 b256a9ef（60 个提交），13 处代码锚点全部新鲜
    - [p/eYUSIhDP] 把原型发现整理回设计文档 ‹任务·待办›
      ↳ 前置：p/NVqKvrzA
  - [p/ydKe7oMn] P0 设计与验证 ‹P0·任务·待办›
    - [p/UV8qXrr2] 设计文档讨论稿 ‹任务·完成›
      ↳ 证据：commit:9dc0c1ee；commit:eeb244b6
    - [p/gPDU0vgb] 大纲编辑器与实时协同原型，按设计文档 §7.8 的清单验收 ‹任务·待办›
      ↳ 涉及：file:docs/OUTLINE_KNOWLEDGE-DESIGN.md
    - [p/BFv4Byng] 按时间点读取的性能基准（SQLite 与 PG） ‹任务·待办›
    - [p/wBqGEPp7] db-worker 向量扫描基准 ‹任务·待办›
    - [p/5QM1KHbG] agent 使用结构化编辑工具的实测：Python 原型已经覆盖了一部分 ‹任务·待办›
      ↳ 出处：p/DrYdFrth
    - [p/aTj0jdv3] 确认 D6–D15 的建议 ‹任务·待办·等前置：P-1›
      ↳ 前置：p/DrYdFrth
  - [p/bd2Egjgc] P1a 核心存储、大纲编辑器（先单人，建在协同协议上）、时间机器最小版、会话读权限 ‹P1a·任务·待办·等前置：P0›
    ↳ 前置：p/ydKe7oMn
  - [p/kDh2CgDg] P1b 多人实时协同：页订阅、页实时会话、在场信息、大纲事务、agent 的三方合并 ‹P1b·任务·待办·等前置：P1a›
    ↳ 前置：p/bd2Egjgc
  - [p/f7vElM5K] P2 替换 spec://，落地多 agent 协作、两档计划与计划模式改造 ‹P2·任务·待办·等前置：P1a›
    ↳ 前置：p/bd2Egjgc
  - [p/yxk3tBVg] P3 检索（embedding、rerank、混合检索）、真值维护、计划结项 ‹P3·任务·待办·等前置：P2›
    ↳ 前置：p/f7vElM5K
  - [p/pJciER7x] P4 层（提议、探索、记忆确认、Bot 隔离）与知识库迁移 ‹P4·任务·待办·等前置：P3›
    ↳ 前置：p/yxk3tBVg
  - [p/2Ywkt58i] P5 视图编辑器、图谱与图谱时间机器、模板、实体合并、只读导出 ‹P5·任务·待办·等前置：P4›
    ↳ 前置：p/pJciER7x

- [p/TMdwYNRd] 原型发现 ‹发现›
  - [p/CBTVZMXi] 搭原型和录入计划时发现的设计问题。每条都是要反馈进设计文档的修改，整理回文档后标为已处理。
  - [p/8ufzzqLQ] 块体需要「表格」：现状盘点、决策对照都离不开表格，设计文档 §2.1 的块体只有段落、标题、代码、引用 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/YwjRs6kJ] 一次插入多块时需要临时标签（#标签）互相引用，比如步骤二前置于步骤一；正式版的 OutlineEdit 要支持 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/bBLXUFIK] 需要人能记住的稳定别名（D1、P0、路线图）：随机短 id 只适合机器，人和 agent 在对话里都用别名 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/kJThz9Os] 「某样东西不存在」这类结论锚不到符号上（比如仓库里没有向量代码），需要「检索锚点」：记下一个检索和它的结果集，结果变了就存疑 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/PoBH5Bog] 锚点要能指向非声明的位置（数组里的一项、配置对象的一个键）；原型用检索锚点兜底，正式版要支持结构路径或行范围 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/AKv45oAj] D1 的「单次改动超过 50 个块」应该只数改动已有的块；一次新建很多块不碰别人的内容，不算大改动 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/b4NURQO1] 已批准的计划里，只有任务才算步骤：在步骤下写笔记、断言是记录进展，不算改计划。契约 = 计划根 + 根下直接挂着的非任务块 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/PH5Odq0r] 变更请求只让被改的那一步受阻；新增步骤不影响已有步骤，不该让整份计划停下 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/AGjS85c8] 获授权的 agent 自己改已批准的计划，也要走变更请求、由别人来批，否则「代批」就成了绕过 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/CevSO7EI] 人确认个人空间的提议时，确认本身就是证据，被确认的断言应直接采纳 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/wfB9Zsos] 计划根完成时还有子任务没做完：提示但不阻止，结项时它们成为遗留 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/gCpTvLbi] 管理者应该沿任务子树继承：路线图归负责人管，它下面 agent 建的步骤也归负责人管 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/PllM72C8] 对话里做出的决定没有稳定地址：原型只能写「chat:日期 + 原话」；正式版里应该指向 msg: 消息 id ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/6hhSPqRU] 写检索锚点时，正则里的反斜杠会被参数解析吃掉；agent 写锚点需要不依赖转义的写法 ‹断言·采纳·#发现›
    ↳ 证据：commit:aae9623b
  - [p/JNYdq1NP] 看板要区分「可以开始」和「等前置」：前置没完成的任务看起来和普通待办一样；原型改为推导出「等前置」标记，不写进状态 ‹断言·采纳·#发现›
    ↳ 证据：tool:outline-board
  - [p/wJsEdT5n] 工具输出里要直接给出数量（检查了几处锚点、改了几个块），agent 凭记忆写数字容易写错：录入时把 13 处锚点写成了 15，见第 15 个提交的更正 ‹断言·采纳·#发现›
    ↳ 证据：tool:outline-log

- [p/a4bsGcVR] 概念与规则 ‹概念›
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

## me · 负责人的个人空间
