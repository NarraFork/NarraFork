# 大纲系统实施计划：P1a 与导图原型

> 状态：草案，2026-10-26。对应 `docs/OUTLINE_KNOWLEDGE-DESIGN.md`（下称「设计」）§10 的 P1a，以及当天补充的 R28（大纲 ↔ 导图、快速切换聚焦，D29）。
> 代码位置按 main @ `5937b5b1` 核对。

## 1. 范围

**P1a 要交付的**（设计 §10）：
- 存储：空间、块、版本、提交、链接；项目、个人、会话三种空间。知识库空间放在 P4。
- agent 工具：`OutlineRead`、`OutlineSearch`、`OutlineEdit`，按预算展开；FTS 检索。
- 撤销即补偿提交；时间机器最小版：按时间点读一页、看提交列表。
- 读权限规则，包括会话的读权限交集（D9、D22b）。
- 编辑器：建在页实时会话协议上，多人同时编辑，带在场、对方光标和选区，撤销只撤自己的（D33）；大纲和导图两种视图、聚焦、快速切换（D29）。

**完成标准**：能在新系统里起草一个项目的规格，时间轴能回放；大纲和导图之间切换不丢状态，达到设计 §6.10 的性能目标。

**不在 P1a**：
- agent 写入的三方合并（P1b）。P1a 里 agent 读后被人改过的块整块拒绝，让 agent 重读（PR 6 的做法）。
- 任务行为：领取、锁定、待确认、「进行中」标记、续跑、整理（P2–P3）。P1a 照常解析和存储复选框（状态和指派），读页时按位置滤掉过程，只是没有任务行为。
- embedding、依据与代码锚点（P3）；知识库迁移（P4）。

整个 P1a 在全局开关 `outline.enabled` 后面，默认关。关着时工具不出现、路由返回 404、导航不显示。现有的 spec:// 和知识库照常工作，P2、P4 才替换。

## 2. 已经定下来的

- **D29 导图**：
  - 和大纲是同一个编辑面的两种视图，都能完整编辑。
  - 向右或向下展开，不做左右平衡。
  - 聚焦、折叠、选中、视口锚点两种视图共用。
  - 自绘节点，不用 xyflow。
  - 先做原型，量过再并入 P1a（设计 §6.10）。
- **D30 标签**：标签就是链接到标签页，`tags:: [[标签]]` 存进链接表，不加属性列（设计 §6.8）。
- 设计 §11 里还没定的问题都不挡 P1a：
  - **块选择模式和移动端手势**（Q7）：P1a 先做桌面，移动端随 P1 真机测试。
  - **超长页**（Q8）：P1a 先靠折叠和聚焦，展开上限 2000 块，占位节点视需要再加。
  - 其余属于 P2 以后。

## 3. 代码布局

```text
shared/outline/                 浏览器和服务端共用，不依赖 DOM
  dialect/                      块内方言：分词、解析、序列化、读回核对（移植 prototypes/outline-editor/src/dialect）
  md-outline.ts                 markdown 大纲 ⇄ 块树：OutlineEdit 的输入、OutlineRead 的输出、复制粘贴
  address.ts                    地址：短 id、`空间/短id`、别名、标题
  order-key.ts                  分数排序键（移植 src/model/orderkey.ts）
  layout/                       导图布局（紧凑树，向右/向下）、按预算展开；纯函数
server/services/outline/
  store/                        存储端口 port.ts，sqlite-store.ts、postgres-store.ts
  write.ts                      大纲事务 → 提交：校验、写入不变量、版本、链接抽取
  read.ts                       读页、读子树、按时间点读、按预算渲染、事实过滤
  search.ts                     FTS
  spaces.ts                     空间的建立与解析
  access.ts                     读写权限，含会话的读权限交集
  live/                         页实时会话：按页 Y.Doc、按块 Y.Text、合并广播、落库与恢复
  view-state.ts                 每人每页的折叠和导图方向
server/lib/agent/tools/outline.ts           三个工具
server/routes/outline.ts，server/lib/validators/outline/
server/websocket/outline-page-ws.ts         页订阅
frontend/components/outline/
  editor/                       ProseMirror 投影、键位、输入法推迟、源码映射、剪贴板（移植原型 src/client）
  mindmap/                      导图：节点、连线、手势、节点里的单块编辑
  view-state.ts，transition.ts  两种视图共用的视图状态；FLIP 切换与聚焦动画
  QuickSwitcher.tsx，Breadcrumbs.tsx，Timeline.tsx
frontend/routes/outline/        空间列表；`$spaceId/$blockId` 编辑页（blockId 是聚焦的块）
frontend/lib/api/outline.ts，frontend/hooks/useOutline*.ts，frontend/locales/{en,zh-CN}/outline.json
```

## 4. 存储

### 4.1 P1a 建的表

从设计 §7.1 里取 P1a 用得到的：

| 表 | P1a 用到的列 |
|---|---|
| `outline_spaces` | `id, kind, project_id?, narrator_id?, owner_user_id?, next_seq` |
| `outline_blocks` | `id, space_id, sid, parent_id, order_key, content, alias?, task_json?, page_id, author_kind, author_id, version_seq, deleted` |
| `outline_block_versions` | `block_id, from_seq, to_seq?, commit_id, page_id, parent_id, order_key, content?, task_json?, content_hash, change_flags, deleted` |
| `outline_links` | `id, space_id, from_block_id, kind(link/embed/depends), target_kind, target_ref, from_seq, to_seq?` |
| `outline_commits` | `id, space_id, seq, kind(edit/revert/import), actor_kind, actor_id, responsible_user_id, narrator_id?, message_id?, tool_call_id?, created_at, summary` |
| `outline_live_updates` | `page_block_id, epoch, seq, update_b64, actor_kind, actor_id, created_at` |
| `outline_view_state` | `user_id, page_block_id, collapsed_json, layout, updated_at` |

其余列和表随功能所在的阶段加：
- P2：`gate_json`、`forked_*`、`in_process`、`reviewed_seq`、`invalid_reason`、`outline_pending`、`outline_task_claims`。
- P3：`basis`/`source` 链接、`outline_anchor_state`、`outline_embeddings`、`outline_vector_chunks`、`outline_curation`、`outline_gate_stats`。

每次加都走 `schema.ts` → `bun run db:generate`，PG 走 `bun scripts/generate-postgres-schema.ts` → `bun run db:generate:pg --name <name>`。

### 4.2 仓库里的约束

- **列类型只有 text、integer、real**（`server/db/schema.ts:19-31`）。
  - JSON 用 `text(..., { mode: "json" })`。
  - 时间用 ISO 文本，由服务层填。
  - 没有 BLOB：Y 更新存 base64 文本（列名 `update_b64`）。向量表到 P3 再定。
- **PG 转译把普通 integer 变成 int4**（`scripts/generate-postgres-schema.ts:117-131`）。
  - 每个空间的 `seq` 递增，int4 够用。
  - 字节数、CRDT 时钟不用 integer 存。
- **FTS 不进迁移**：
  - SQLite 在 `server/db/fts.ts` 的 `ensureFts` 里建 trigram 虚表和触发器，照 knowledge_entries 的外部内容表写（`server/db/fts.ts:545-549`、`:721-743`），表名加进 `FTS_INDEX_TABLES`（`:71-77`）。迁移重建表时触发器会丢，要走已有的修复路径（`:588-679`）。
  - PG 在 `server/db/pg-fts.ts` 的 `SHADOW_SPECS`（`:96-135`）加一张影子表。
  - 检索照 `server/services/search/backend.ts:88-94` 按方言选实现。
  - schema 里不要出现 `*_fts` 的名字：方言守卫会拦，drizzle-kit 也会过滤掉。
- **PG 模式下 `db` 和 `sqlite` 访问即抛错**（`server/db/index.ts:96-113`）。所以存储从第一个 PR 起就走端口，照知识库的写法：
  - 选择器：`server/services/knowledge/store.ts:44-79`。
  - SQLite 实现：同步事务，`server/services/knowledge/sqlite-write-store.ts:490`。
  - PG 实现：`withPgRetry`，`server/services/knowledge/postgres-write-store.ts:224`。
  - PG 实现在 `server/services/postgres-composition.ts:52-82` 注入。
  - 新文件登记到 `server/db/sqlite-dialect-inventory.guard.test.ts` 的 `DIALECT_INVENTORY`。
- **序号用计数列**：`outline_spaces.next_seq`，照 `narrators.next_seq`（`server/services/narrator-refs/seq-store.ts:143-154`），不用 MAX+1。
- **读一页不用递归 CTE**：
  - 块行和版本行都冗余 `page_id`，一页的结构一次按索引读出，在内存里建树；聚焦的子树就在这棵树上取。
  - 一页最多 1 万块（设计 §7.2）；PG 上约 1850 块的整页结构读取 1.7 ms（P0 基准）。
  - 仓库里的递归 CTE 只在 SQLite 主线程用过，PG 上还要处理参数类型；P1a 避开它。
- **写入事务必须同步**（`server/db/transaction-atomicity-contract.test.ts`）：Y.Text 合并、方言规范化、链接抽取都在事务外先算好，事务里只写行。
- **大批量工作走分片后台 job**：导入、清除、重建 FTS 都照 `server/services/narrator-block-index.ts` 做——worker 读一片，主线程用短事务写。db-worker 是只读、池化的（`server/lib/db-worker/pool.ts`），适合读切片，不适合常驻状态。

### 4.3 写入

- **一次写入是一个大纲事务**：结构操作加受影响块的正文。服务端校验后在一个同步事务里写：
  - 块的当前行；
  - 版本行，带 `to_seq` 收尾和 `change_flags`；
  - 链接，从正文和 `depends::`、`tags::` 抽取；
  - 提交行，`seq` 从 `next_seq` 取。
- **不变量**（设计 §7.1）：
  - 删一棵子树，给每个后代写墓碑版本。
  - 跨页移动一棵子树，给每个后代写 `page_id` 改变的新版本。
  - 当前版本 `to_seq` 为 NULL，索引 `(page_id, from_seq, to_seq)`。
  - 每条不变量都有单测；再加一个随机测试：随机事务序列之后，按时间点重建的树和逐步应用的树一致。
- **出处**：提交记 `actor_kind/actor_id`、`responsible_user_id`、`narrator_id`、`tool_call_id`。消息 id 不在工具上下文里，用 `ctx.toolCallBinding.toolCallId` 查 `narrator_tool_calls.message_id`（`server/db/schema.ts:1456-1463`）。写法照 `server/lib/agent/tools/ask-user-question.ts:339-407`。
- **撤销即补偿提交**：撤销一个提交，就是写一个把它涉及的块恢复成前一版的新提交（`kind = revert`）。这期间块又被别人改过的，跳过并在结果里列出来。
- **上限**（设计 §7.2）：
  - `OutlineEdit` 一次最多 200 个操作；
  - 单块正文 16 KiB；
  - 导入单页 1 MiB。
  - 「改动超过 50 个别人写的块转待确认」属于 P2，P1a 先直接拒绝并说明原因。

## 5. 权限

- **空间的门**：

  | 空间 | 读 | 写 |
  |---|---|---|
  | 项目空间 | `canReadProject` | `canWriteProject` |
  | 个人空间 | 只有本人 | 只有本人 |
  | 会话空间 | `canReadNarrator` | `canWriteNarrator` |

  项目函数在 `server/services/project-acl.ts:77`、`:95`，会话函数在 `server/services/narrator-acl.ts:290`、`:323`。P1a 不新增 `acl_grants` 的 scope，知识库空间到 P4 再加。
- **HTTP 按人判断**。
- **agent 读按会话判断**：会话能读的 = 所有能读这个会话的人都能读的（D9、D22b）。仓库里没有能列出会话全部读者的函数——`listNarratorAudience`（`server/services/narrator-acl.ts:665`）故意少报，只用于通知。所以做成逐个空间的判断：
  - 会话自己的空间：能读。
  - 公开会话（`visibility = public`，或者有公开分享链接）：只能读公开项目的空间。
  - `visibility = project` 的会话：
    - 主项目的空间能读，因为读者都能读主项目；
    - 别的项目空间，要求主项目的每个成员都能读。
    - 成员数有上限（D22b 说有上限、具体数待定），P1a 先取 50，超过就不读。
  - 私有会话：读者是所有者，加上 narrator 范围授权的用户和角色成员；管理员什么都能读，不影响交集。这些人都能读的空间才能读。
  - 个人空间：只在单人私有会话里能读，也就是读者只有所有者本人。
  - 子代理按根会话判断，和 `resolveJudgedRow`（`server/services/narrator-acl.ts:247`）一致。
  - 结果按轮缓存。`narrator_access_changed`、`project_access_changed` 时清掉缓存。
- **agent 写**：
  - 按本轮执行用户（`ctx.userId`）的写权限直写（D1）。
  - 没有直写权限时，P1a 直接拒绝并说明；转待确认要到 P2。

## 6. agent 工具

### 6.1 输入和输出（草案，PR 评审时定字段名）

- **`OutlineRead { address, view?: "facts" | "all", budget?, asOf? }`**
  - 返回 markdown 大纲，格式见设计 §4.1。
  - `asOf` 取提交序号或时间。
  - metadata 带空间、根块、块数和是否截断。
- **`OutlineSearch { query, spaces?, limit? }`**
  - 返回块的一行摘要和所在位置（标题路径），最多 50 条。
  - 事实排在过程前面（设计 §5.4）。
- **`OutlineEdit { edits[], message? }`**，每项是下列之一：
  - `{ add: 父块, after?, markdown }`：用 markdown 大纲一次写多块；
  - `{ replace: 块, text }`
  - `{ move: 块, to: 父块, after? }`
  - `{ delete: 块 }`
  - `{ set: 块, checkbox?, assignee? }`

  返回每项的结果和新块的地址。方言外的结构按设计 §6.8 拆成子块，并说明拆成了什么。

### 6.2 接进 agent loop

- **写法**：工具形状照 `ToolDefinition`（`server/lib/agent/types.ts:347-376`），一个文件 `server/lib/agent/tools/outline.ts`，照 `server/lib/agent/tools/knowledge.ts` 写。
  - 服务模块在 `execute` 里懒加载。
  - 工具名常量放在叶子模块，照 `tools/knowledge-kind.ts`，避免循环导入。
- **注册**：
  - `OutlineRead`、`OutlineSearch` 进核心工具（`server/lib/agent/tools/index.ts:114-158`）。
  - `OutlineEdit` 在 P1a 放进 `OPTIONAL_TOOLS`（`:64-88`），配一条 `BuiltinRoutine`（`server/lib/builtin-routines.ts`），由开关决定是否常驻。P2 替换 spec:// 时改成核心工具。
- **名单**：
  - `OutlineRead`、`OutlineSearch` 加进：
    - `READ_ONLY_TOOLS`（`server/services/narrator-permission.ts:1272`）
    - `READ_TOOLS`（`server/services/agent-runtime/policy.ts:37`）
    - `PLAN_MODE_ALLOWED_TOOLS`（`server/lib/agent/types.ts:894-919`）
    - `server/lib/agent/disk-safety.ts:15-26`
  - `OutlineEdit` 加进 `GENERAL_TOOLS`。
- **`OutlineEdit` 的权限档位**（负责人 2026-10-26 定，D32）：
  - 默认模式下放行：写入都能撤销（D1）。
  - 只读模式和计划模式下只能写会话空间（规划默认宽松，D25），做法照 tasks.json 在 `server/services/narrator-permission.ts:828` 的处理。
  - bypass 下的危险分类照 Knowledge 写入的先例（`:2956-3021`）。
- **界面**：
  - `frontend/components/narrator/tool-call/tool-display.ts` 加 `outline` 类别、图标和摘要。
  - `shared/pretext-layout/tool-detail.ts` 加 `classifyOutline`，按 markdown 渲染。
- **截断豁免**：只给 `OutlineEdit` 的输入，两处同时改：`server/services/narrator-messages.ts:1988-2003` 和 `server/lib/db-worker/display-page-projection.ts`。
- **知识注入点 B**：现在只跳过 `Knowledge` 开头的工具（`server/lib/agent/loop.ts:3067`），要把 `Outline` 也排除，否则工具会放大自己的结果。
- **提示缓存**：工具描述用静态字符串，不用 `getRawJsonSchema`。可选工具这样才能在历史里交付，不打掉缓存（`server/lib/agent/tool-loading.ts:199-204`）。
- **输出上限**：`OutlineRead` 2000 块或 256 KiB，超出时设 `ToolResult.truncated`；查询 SQL 都有 LIMIT，不做无上限的 `.all()`。
- **要跟着改的名单测试**：
  - `server/services/__tests__/agent-runtime-policy.test.ts`
  - `loop-plan-mode-tools.test.ts`
  - `server/lib/agent/__tests__/tool-executor.test.ts`
  - `shared/pretext-layout/tool-detail.test.ts`
  - `optional-tool-state.test.ts`

## 7. HTTP 与 WebSocket

**路由**（`server/routes/outline.ts`，挂在 `/api/outline`，在 `server/app.ts:365` 的全局鉴权之后）：

| 路由 | 用途 |
|---|---|
| `GET /spaces` | 我能读的空间；个人空间第一次访问时建，项目和会话空间第一次写入时建 |
| `GET /pages/:id?asOf=` | 一页的结构和正文，有块数和字节上限 |
| `GET /blocks/:id` | 一个块和它的子树，聚焦用 |
| `GET /search?q=` | FTS 检索，快速切换器也用它 |
| `GET /pages/:id/commits?cursor=` | 时间轴，每页 200 条，游标分页 |
| `POST /commits/:id/revert` | 补偿提交 |
| `GET/PUT /view-state/:pageId` | 折叠和导图方向 |

编辑走 WebSocket 的页实时会话，不走 HTTP。

**WebSocket**：
- 在 `/ws/narrator` 上加 `outline_page_subscribe` / `outline_page_unsubscribe`。照 `server/websocket/editor-file-ws.ts` 的做法：每个 socket 最多 16 个订阅，积压超过 256 KiB 断开。
- 帧：大纲事务（结构操作加块的 Y 更新）、确认或拒绝、远端更新、提交通知（50 ms 合并）。
- 客户端在 `frontend/lib/narrator-ws-manager.ts` 重连时重新订阅（`:759`、`:1724`）。
- 事件总线加 `outline:*` 事件。`emit` 是同步的，所以按页合并后再发。

## 8. 页实时会话（多人）

负责人 2026-10-27 定（D33）：协议本来就是多人的，PR 8 直接做完整的多人编辑，不做单人版；WebSocket 的流量和开销要专门设计，尽量不浪费。

- **移植原型** `prototypes/outline-editor/src/server`：
  - 按页 Y.Doc，会话开始时给整页的块建 Y.Text（P0 的结论，设计 §6.3）。
  - 客户端 confirmed + pending = visible；大纲事务由服务端排序、校验，被拒只回滚那一个事务。
- **落库**：
  - 50 ms 合并后广播，最迟 1 秒把 Y 更新写进 `outline_live_updates`。
  - 正文按设计 §6.3 规范化后写成提交。
  - 空闲 60 秒关闭会话。
  - 启动时把还没写成提交的更新重放成提交，在后台 job 里做。
- **agent 在页开着时写**：服务端把 agent 的块操作当成远端修改推进实时会话。agent 读取的版本已经落后、这个块又被人改过时，P1a 先拒绝这一块，让 agent 重读；P1b 换成三方合并（设计 §6.5）。
- **原型没做、P1a 要补的**（`prototypes/outline-editor/RESULTS.md`）：
  - 合并广播与背压
  - 增量落库与崩溃恢复
  - 会话关闭
  - 只读订阅
  - 权限
  - 「已被删除」提示
  - 块选择模式
  - HTML 粘贴
  - 三个解析器的一致性模糊测试

## 9. 前端

- **路由**：
  - `/outline`：我能读的空间和最近访问。
  - `/outline/$spaceId/$blockId`：编辑页，`blockId` 是聚焦的块。
  - 导航项加进 `shared/nav-layout.ts:15` 和 `frontend/components/nav/nav-items.tsx:65`。
  - 入口（负责人 2026-10-26 定，D32）：顶层导航项「大纲」列出能读的空间和最近访问；项目页有链接进项目空间；会话面板里能打开这个会话的空间。
  - i18n 命名空间 `outline` 加进 `frontend/lib/i18n.ts:18-38` 和路由映射 `:131-175`。
- **编辑页**：面包屑；视图切换（大纲或导图，导图再选向右或向下）；快速切换器；底部时间轴（选一个时间点，只读看页）；侧栏（反链、历史）。
- **编辑器**：移植原型 `src/client`（`view.ts`、`commands.ts`、`schema.ts`、`convert.ts`、`client.ts`）到 `frontend/components/outline/editor/`，网络层换成真实的 WebSocket。块外框用原生 DOM 的 node view。
- **导图**：见 §10。
- **只读场景**（搜索结果、聊天里的引用）继续用 `MarkdownContent`。
- **移动端**：断点照 `frontend/lib/responsive.ts`；页面放大的拦截照 `frontend/lib/pinch-zoom-guard.ts` 交给导图的捏合手势。

## 10. 导图与聚焦：先做原型

### 10.1 原型做什么

在 `prototypes/outline-editor` 上加：
- **视图状态模块**：聚焦、折叠、选中、视口锚点、布局方向，大纲和导图共用。
- **导图视图**：
  - 紧凑树布局，向右和向下两种；
  - 节点尺寸用 `@chenglou/pretext` 测量，和仓库同一个版本；
  - SVG 连线；
  - 最小版的平移缩放（产品里换成 `PanZoomStage`）；
  - 节点选择；节点里放单块 ProseMirror 编辑；
  - 设计 §6.10 的键位；拖动挂到某块下或在同级间排序。
- **切换动画**：FLIP + WAAPI，向右 ↔ 向下的切换也是。
- **聚焦**：动画、面包屑、前进后退。
- **快速切换器**：原型里用内存索引。
- **两个客户端同时编辑**：一个在导图里编辑时，另一个同时改，确认实时会话和撤销照常。

### 10.2 原型的验收

用无头 Chromium（Playwright）跑，Safari 手动看一遍：
1. **性能**（2000 块）：
   - 导图布局 p95 ≤ 16 ms，首次画出 ≤ 200 ms；
   - 切换动画期间帧时间 p95 ≤ 20 ms，超过 50 ms 的长帧不超过 1 帧；
   - 切换前后，视口锚点块在屏幕上的位置偏差 ≤ 2 px。
2. **状态带过去**：聚焦、折叠、选中、光标所在的块，来回切换 20 次都不变。
3. **导图编辑**：
   - Tab、Enter、Shift-Tab、方向键、Alt+方向键、空格、拖动，产出的大纲事务和在大纲里做同样的操作一致，用块树快照比对；
   - 撤销重做跨视图连续。
4. **节点里的输入法**：用 CDP 模拟组合输入，同时收到远端修改，不丢字（复用 P0 第 1 项的用例）。
5. **聚焦**：Alt+→ / Alt+←、面包屑、浏览器前进后退都对；动画期间连续操作不错乱。
6. **快速切换**：1 万块里按标题、别名、正文都能命中，从按键到聚焦完成 ≤ 150 ms。
7. **reduced motion**：开着时直接切换，没有动画。
8. **触屏**（Playwright 触摸模拟）：拖动、捏合、双击编辑。真机留到 P1 真机测试。

**量不过时的退路**：只给视口里的块做动画、降低导图的可见块上限。还不行就回来问负责人，比如先上只读导图。

**结果**（2026-10-26）：8 项全部通过，数字和由此定下的做法见设计 §6.10「原型结果」和 `prototypes/outline-editor/RESULTS.md`。键位冲突已由负责人定：选中节点时 Enter 加同级、Tab 加子块、Shift+Enter 换行；Alt+方向键沿同级方向移动、沿层级方向聚焦。

### 10.3 并入产品

- 布局算法放进 `shared/outline/layout/`；视图状态和动画放进 `frontend/components/outline/`。
- 折叠和方向存进 `outline_view_state`。
- 原型的验收脚本搬进产品重跑；帧时间在有 GPU 的真机上复核。
- 照原型的经验做：打开页时在 Worker 里预先测量节点尺寸；聚焦时保留整页的编辑视图、另建聚焦视图；隐藏的视图移出视口；一次切换分两帧。
- 页实时会话（PR 8）开始时就给整页的块建 Y.Text：原型测出 Y.Text 没建时打字，重做会把字倒过来。

## 11. PR 拆分

每个 PR 都能单独合入，都在 `outline.enabled` 后面。

| # | 内容 | 依赖 | 验收 | 量级 |
|---|---|---|---|---|
| 1 | 导图与聚焦原型（`prototypes/`，不进产品） | — | §10.2 | 中 |
| 2 | `shared/outline`：方言、markdown 大纲、地址、排序键；三个解析器的一致性模糊测试 | — | 往返测试；原型的 14,000 个随机块体；三解析器一致 | 中 |
| 3 | 存储：表和两种方言的迁移、存储端口和两种实现、写入不变量、提交、链接抽取、FTS 运行时 DDL、全局开关 | 2 | 端口契约测试；不变量的单测和随机测试；方言守卫登记 | 大 |
| 4 | 读取与检索：读页、读子树、按时间点读、按预算渲染、事实过滤、FTS 检索；补偿提交 | 3 | 按时间点读取的 p95 和 P0 基准同量级；按预算展开的快照测试 | 中 |
| 5 | 空间与权限：三种空间的建立与解析、HTTP 权限、会话的读权限交集 | 3 | ACL 对照用例：各种会话可见性 × 各种空间 | 中 |
| 6 | agent 工具：三个工具、权限名单、界面卡片、截断豁免、注入点 B 排除 | 4、5 | 名单测试；工具单测；开发环境里真实会话跑一遍 | 中 |
| 7 | HTTP 路由、WebSocket 页订阅（只读）、前端只读页：空间列表、读页、时间轴、导航、i18n | 4、5 | 打开页、按时间点回放 | 中 |
| 8 | 页实时会话（多人，D33）和大纲编辑器 | 7 | P0 验收清单第 1、3、4、5、7、9 项在产品里重跑；在场与对方光标 | 大 |
| 9 | 导图视图、聚焦、快速切换、`outline_view_state` | 1、8 | §10.2 在产品里重跑 | 大 |

- **可以并行的**：1 和 2–6 互不依赖；4 和 5 都只依赖 3。
- **建议的顺序**：1、2 同时开始，然后 3 → 4、5 → 6、7 → 8 → 9。

## 12. 测试

- **单测**：`bun test --isolate <路径>`。
  - SQLite 用 `tests/preload.ts` 隔离出来的数据库。
  - 要全新空库的用 `tests/sqlite-schema-image.ts` 的 `openSchemaCopyInMemory`。
- **PG**：
  - 用 `tests/db/pg-test-harness.ts` 的 `withPostgres`，要 `PG_INTEGRATION=1`。
  - 默认 CI 不跑，所以 PR 3–5 合并前要手动跑一遍，结果写进 PR 描述。
- **编辑器和导图的端到端测试**：把原型的 Playwright 脚本改写成仓库现有的 `*.browser.test.ts`（bun test 里跑真实 Chromium），跟 CI 现有的 4 个分片跑，不加新 job（负责人 2026-10-27 定，D33）。CI 里只断言功能；耗时、帧时间这类和机器有关的数字在 PR 里本地量，不在 CI 里卡阈值。
- **性能**：把 `prototypes/outline-bench` 的按时间点读取基准改成跑真实的表和存储实现，PR 4 合并前跑一次。
- **全量回归**交给 CI。

## 13. 待评审和风险

- **会话的读权限交集**：角色授权的展开、公开分享链接的认定、成员上限取 50，在 PR 5 评审。
- **`OutlineEdit` 的权限档位**：默认模式下放行，在 PR 6 评审。
- **PG 覆盖**：默认 CI 不跑 PG 集成测试，见 §12。
- **Y 更新的传输和存法**：多人编辑提前到 P1a（D33），base64 比二进制大三分之一左右，传输和落库的格式在 PR 8 量过再定。
- **导图**：原型量不过时的退路见 §10.2。
- **移动端和真实输入法**：桌面先行，真机测试在 P1 内单独安排（设计 §6.9 第 2 项）。
