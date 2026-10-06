# 知识库交互断点修复计划

本文件是知识库（`server/services/knowledge-*.ts` + `frontend/routes/knowledge/`）交互层断点的修复方案。断点清单来自代码调查，每条都有文件:行号依据。

修复拆成 5 个工作包（WP1–WP5），按文件边界切分以便并行实施。WP1 是其它包的依赖基础，需先落地共享契约。

## 边界与铁律

- **禁止重启运行中的 NarraFork 进程**：不得 `kill`/`pkill`/`systemctl restart` 承载当前 agent loop 的进程。验证只用单元测试、`bunx tsgo --noEmit`、`bunx @biomejs/biome check`。
- **数据库迁移**：只改 `server/db/schema.ts`，然后 `bun run db:generate`。禁止手改 `drizzle/`，禁止删数据库文件。
- **主线程性能**：新增查询必须有索引、有 `LIMIT`；列表接口不得返回 `content`/`proposedContent` 等大字段（只返回长度或摘要）。
- **ACL 不可绕过**：任何新增读取路径必须先过 `knowledgeAcl.canRead`，再做展示层处理。无权条目不返回、不计数（防存在性泄露）。
- 本计划不实现 `docs/KNOWLEDGE_BASE.md` 3.8/3.9 的 inline 链接解析与条件内容块（`::: when` / viewContext）。这两节目前**无任何实现代码**（`grep viewContext|viewDimensions|renderContent|anchorKey` 在 `server/` 无相关命中），属于独立特性而非交互断点，另行立项。WP5 收尾时在 `KNOWLEDGE_BASE.md` 标注其未实现状态。

---

## WP1 — 事件总线接入与站内通知

**问题**：`knowledge-branch-service.ts` / `knowledge-service.ts` 里 `notification`、`eventBus`、`emit(`、`broadcast` 全部零匹配。知识库是全系统唯一未接事件总线的大型子系统。后果：

- 审核者不知道有待审提交（`frontend/routes/knowledge/index.tsx:88` 的审核 tab 无 badge、无未读数）。
- 提交者不知道 publish 结果，只能反复查 `/submissions`。
- `updateDraft` 会把该 draft 的所有 pending/conflict submission 静默置为 rejected（`knowledge-branch-service.ts:299-307`），提交者收不到任何提示。

**现有可复用设施**（已核实）：

- `server/lib/event-bus.ts:9` 的 `NarraForkEvent` 联合类型 + `eventBus` 单例（`:445`）。
- `server/websocket/narrator-ws.ts:607` 的 `broadcastToUser(userId, data)`，按 userId 定向推送，连接注册表 `connectionsByUserId`。
- `server/services/notification-service.ts` 是叙述者专用 IM webhook（钉钉/飞书），监听 `narrator:attention`。**没有通用站内通知表**，`/api/notifications` 只有两个 webhook 测试端点（`server/routes/notifications.ts`）。

**方案**：不新建通知表。走"事件 → WS 定向推送 → 前端 query 失效 + 角标"的轻量路径。

### 改动

1. `server/lib/event-bus.ts`：在 `NarraForkEvent` 联合类型中新增知识库事件（与既有 `review:*` 风格一致，字段只放 id 与判定所需标量，不放正文）：
   - `knowledge:submission_created` — `{ submissionId, entryId: string | null, collectionId: string | null, submitterUserId }`
   - `knowledge:submission_reviewed` — `{ submissionId, status, submitterUserId, reviewerUserId }`
   - `knowledge:submission_invalidated` — `{ submissionId, submitterUserId, reason: "draft_updated" }`
   - `knowledge:entry_published` — `{ entryId, submissionId, submitterUserId }`
2. `server/services/knowledge-branch-service.ts`：在 `submitForReview`、`review`、`approveAndMerge`/`commitMergedRevision`、`approveStandalone`、以及 `updateDraft` 的自动 reject 分支（`:299-307`）**事务提交之后**发事件。事件发射不得放在事务内（避免监听器回调延长事务持有时间）。
3. 新增 `server/services/knowledge-notify.ts`：`eventBus.on` 上述事件 →
   - 给 `submitterUserId` 推送审核结果 / 失效通知；
   - 解析该提交的**可审核者集合**并推送待审提醒。可审核者解析必须复用 `knowledge-acl` 的既有判定（关联条目走 `canReview` 比对 `reviewTagsJson`，独立条目走目标集合 `canWriteCollection`，见 `knowledge-branch-service.ts:632-639` 与 `:680-698`），并排除 submitter 自己（自审禁止，`:643`）。**必须有上限**（如最多解析 200 个用户，超出则只推给 admin），避免大规模用户表全扫。
   - 推送通道用 `broadcastToUser`。新增消息类型加到 `server/websocket/narrator-ws-types.ts` 的 `NarratorServerMessage`。
4. 新增 `GET /api/knowledge/review-inbox/count`：返回当前用户可审核的 pending + conflict 提交数。用于前端角标。实现必须走 `LIMIT`（如 `LIMIT 101` 后返回 `100+`），禁止无界 `COUNT(*)` 扫全表。
5. 前端：
   - `frontend/hooks/useKnowledge.ts` 加 `useReviewInboxCount()`。
   - `frontend/routes/knowledge/index.tsx:88` 审核 tab 加 Mantine `Badge`/`Indicator` 显示数量。
   - 新 WS 消息接入现有知识库 query 失效逻辑（沿用其它 hook 的 `queryClient.invalidateQueries` 模式）。
   - 全局导航 `frontend/components/nav/nav-items.tsx` 的知识库项加未读角标。
6. i18n：`frontend/locales/{en,zh-CN}/knowledge.json` 补键。

### 验收

- 新增单测：`server/services/__tests__/knowledge-notify.test.ts` — 提交/批准/打回/draft 更新致失效四条路径各断言事件发射与目标用户集合正确；断言 submitter 不在待审推送目标里；断言可审核者解析有上限。
- `bunx tsgo --noEmit` 通过。

---

## WP2 — 个人库独立条目的 UI 闭环

**问题**：独立个人条目（`knowledge_drafts.entryId = null`，即还没有全局对应物的新知识）在 UI 上是死卡片：

- `frontend/routes/knowledge/index.tsx:719-724`：卡片 `cursor: p.entryId ? "pointer" : "default"`，`onClick` 对独立条目返回 `undefined`。点不开、正文改不了、无发布按钮。
- 编辑/提交 hook（`useUpdateKnowledgeDraft`、`useSubmitKnowledgeDraft`，`frontend/hooks/useKnowledge.ts:207,297`）只在 `frontend/routes/knowledge/$entryId.tsx:490-492` 被调用 —— 只有**关联型**条目能编辑和提交。
- 这恰恰是 `KnowledgeCreate` 的默认产物（`server/lib/agent/tools/knowledge-edit.ts:163-169`）：**agent 帮用户建的个人条目，用户在界面上进不去**。这是"agent 填充 + 人审核"主线断掉的第一环。
- `updatePersonalEntryMetaSchema` 只允许改 title/targetCollectionId/keywords（`server/lib/validators/knowledge.ts:93-97`）；改正文必须走 `PATCH /drafts/:id`。后端两条路都有，UI 没给独立条目开。
- 无 draft 删除端点（`server/routes/knowledge.ts` 无 `DELETE /drafts/:id`），用户无法丢弃写坏的个人条目。
- archived draft 无清理/过期机制，永久堆积。

**方案**：新增独立个人条目详情页，并补 draft 删除端点。

### 改动

1. 后端 `server/routes/knowledge.ts` + `server/services/knowledge-branch-service.ts`：
   - 新增 `DELETE /personal-entries/:id`（软删：置 `status = "archived"`；作者本人或 admin）。若该 draft 有 open submission（pending/conflict），先在同一事务内把 submission 置为 rejected 并发 WP1 的 `submission_invalidated` 事件。
   - 复用现有 `updateDraft` 支持独立条目改正文（确认 `loadOwnDraft` 的作者校验已覆盖，见 `:165-173`）。
2. 新增前端路由 `frontend/routes/knowledge/personal/$personalEntryId.tsx`：
   - 正文编辑（Textarea + 保存，调 `useUpdateKnowledgeDraft`）。
   - 元数据编辑（title / targetCollectionId / keywords，调 `useUpdatePersonalEntryMeta`）。
   - 发布按钮：未设 targetCollectionId 时禁用并提示"先选择目标集合"（对应后端 publish 前置校验）。
   - 该条目的提交历史与状态（复用 `useKnowledgeSubmissions({ entryId })` 的等价查询；独立条目按 draftId 过滤，若后端不支持则加查询参数）。
   - 删除按钮（二次确认）。
3. `frontend/routes/knowledge/index.tsx` 的 `MyLibraryTab`：
   - 独立条目卡片改为可点击，跳新路由。
   - 卡片上显示提交状态徽标（pending / changes_requested / conflict / 无），让用户不进详情页也知道进度。
4. i18n 补键。

### 验收

- 新增测试覆盖 `DELETE /personal-entries/:id` 的作者校验、open submission 连带失效。
- 前端类型检查通过（`bunx tsgo --noEmit`）。
- 手动核对：`KnowledgeCreate` 产出的独立条目能在 UI 打开、改正文、设目标集合、发布。

---

## WP3 — 集合 ACL 管理界面与批量授权

**问题**：

- **集合级 ACL 无 UI**。集合有独立的 `classificationLevel` + `controlledTagsJson`（`server/db/schema.ts:2113-2116`），且 `canRead` 是**先查集合再查条目**（`server/services/knowledge-acl.ts:264-270`）—— 集合门控是第一道门、比条目门控更强，却是唯一没有管理界面的一层。端点 `PATCH /collections/:id/acl`（`server/routes/knowledge.ts:71`）只能靠 API 或 agent 工具 `set_collection_acl` 调用。admin 在界面上无法排查"为什么这个条目谁都看不到"。
- **授权只能逐用户逐次点**。`setUserAcl` 是单用户操作，`principalType` 只有 `user | role`（`server/db/schema.ts:2421`），无用户组、无批量授权。新建一个受控标签后授给 10 个人 = 10 次操作。
- **tagType 改名无 UI**：`PATCH /tag-types/:id`（`server/routes/knowledge.ts:413`）存在，`AclAdminPanel.tsx` 的 TagTypesModal 只有创建和删除。
- **所有权转移无 UI**：`POST /entries/:id/transfer-owner`、`POST /collections/:id/transfer-owner`（`:78`、`:153`）前端零调用。
- **条目删除无 UI 入口**：`useDeleteKnowledgeEntry`（`frontend/hooks/useKnowledge.ts:95`）存在但无触发点。

### 改动

1. 后端 `server/routes/knowledge.ts` + `server/services/knowledge-acl.ts`：
   - 新增 `POST /api/knowledge/grants/bulk`（requireAdmin）：一次给多个 userId 授同一 clearance 或同一 tag。请求体加**数量上限**（如 ≤ 200 个 userId），单事务写入，返回逐条结果。
   - 新增 `GET /api/knowledge/collections/:id/acl`：返回该集合的 level / controlledTags / owner（admin），供 UI 回显。
2. 前端 `frontend/components/knowledge/`：
   - 新增 `CollectionAclPanel.tsx`：集合密级、受控标签多选、owner 设置。挂到 `frontend/routes/knowledge/index.tsx` 集合列表的每个集合（admin 可见，参考 `:304` 现有集合操作按钮位置）。
   - `AclAdminPanel.tsx` UsersTab 加"批量授权"：多选用户 + 选 clearance/tag → 调 bulk 端点。
   - TagTypesModal 补重命名（调 `useUpdateKnowledgeTagType`，hook 已存在于 `useKnowledge.ts:482`）。
   - 新增 `TransferOwnerModal.tsx`：条目详情页与集合列表各挂一个入口（admin 或当前 owner 可见，权限判定后端已实现，见 `server/routes/knowledge.ts:78,153` 注释"NOT requireAdmin"）。
   - 条目详情页 `frontend/routes/knowledge/$entryId.tsx` 加删除入口（二次确认，接 `useDeleteKnowledgeEntry`）。
3. 前端 API 层 `frontend/lib/api/knowledge.ts` + hooks 补对应方法。
4. i18n 补键。

### 验收

- 新增测试：bulk grant 的上限校验、事务性（部分失败不留半状态）、admin 门禁。
- 断言集合 ACL 面板改动后 `canRead` 行为随之变化（可在 `knowledge-collection-acl.test.ts` 追加用例）。

---

## WP4 — agent 工具补齐与静默降级消除

**问题**：

- **写入工具默认不可见**。`KnowledgeCreate`/`KnowledgeEdit`/`KnowledgeReview`/`KnowledgeAdmin` 全在 `OPTIONAL_TOOLS`（`server/lib/agent/tools/index.ts:62-65`），只有 Knowledge Steward 类型叙述者预装前三个（`server/lib/agent/tools/knowledge-kind.ts:17-21`），admin 再补第四个。只读工具 `KnowledgeSearch`/`KnowledgeRead` 在 core provider（`index.ts:123-124`）。默认状态是"所有 agent 都能读，没有 agent 能写"，而普通叙述者不知道存在可 `/load` 的写入工具。
- **direct 写入静默降级**。`KnowledgeCreate` 传 `direct:true` 但无集合写权限时直接 fall through 建个人条目（`server/lib/agent/tools/knowledge-edit.ts:136-161`），返回文案只有一句 "personal entry"。system prompt 专门写规则要求 agent 自己发现并上报（`server/lib/prompts/knowledge-steward.ts:28,49`）—— 用提示词补工具语义漏洞。
- **agent 拿不到集合清单**。`list_collections` 只在 admin-only 的 `KnowledgeAdmin` 里（`server/lib/agent/tools/knowledge-admin.ts:194-203`）。非 admin agent 想写知识必须由用户口头告知 collectionId。
- **agent 看不到自己的个人库**。`GET /personal-entries`（`server/routes/knowledge.ts:239`）有端点无工具。agent 上一轮建的草稿这一轮找不回来。
- **agent 改不了受控标签/密级**。`KnowledgeEdit.update_meta` 只覆盖 title/tags/keywords/status（`server/lib/agent/tools/knowledge-edit.ts:228-239`），定密要走 admin-only 的 `set_entry_acl`。建条目和定密被切成两个权限等级，普通贡献者建完必须找 admin 补定密，且无提醒机制。
- **level 更新无 agent action**：`KNOWLEDGE_ADMIN_WRITE_ACTIONS`（`server/lib/agent/tools/knowledge-actions.ts:28-45`）有 `create_level`/`delete_level`，无 `update_level`，而 HTTP 有 `PATCH /levels/:id`。

**注意**：`transfer_collection_owner` 已存在于 `KnowledgeEdit`（`knowledge-actions.ts:63`），不要重复添加。

### 改动

1. `server/lib/agent/tools/knowledge.ts`（core，所有 agent 可见）：
   - 新增 `KnowledgeCollections` 工具或给 `KnowledgeSearch` 加 `listCollections` 能力：返回当前 principal 可读的集合列表（id/name/slug + 是否可写）。走 `knowledgeService.listCollections(projectId, principal)`，已按 ACL 过滤。
   - 新增列出"我的个人条目"能力（可作为同一工具的 action 或 `KnowledgeRead` 的一个模式）：调 `knowledgeBranchService.listMine`，返回 id/title/是否关联/目标集合/是否 drifted/open submission 状态。**只返回摘要标量，不返回正文**。
2. `server/lib/agent/tools/knowledge-edit.ts`：
   - `direct:true` 失败不再静默降级。改为：默认返回**显式错误**说明缺少集合写权限、未创建任何东西；仅当调用方另传 `fallbackToPersonal: true` 时才降级，且返回文案与 metadata 都标 `downgraded: true`。同步更新工具 description。
   - `update_meta` 支持 `controlledTags` / `reviewTags` / `classificationLevel`，但**仅在 principal 有权时生效**：无权时返回明确错误（提示需要 admin 或 owner），不静默忽略。权限判定复用 `knowledgeAcl`，不得在工具层新写一套判定。
3. `server/lib/agent/tools/knowledge-actions.ts` + `knowledge-admin.ts`：补 `update_level` action，接 `knowledgeAcl.updateLevel`。
4. `server/lib/prompts/knowledge-steward.ts`：删掉因 WP4-2 已由工具层保证的"不静默降级"提示（工具现在会显式报错），保留导入纪律与定密纪律。
5. 让普通叙述者可发现写入工具：在知识库只读工具的返回文案里加一句可发现性提示（如搜索结果末尾提示"如需创建/编辑知识，可加载 KnowledgeCreate / KnowledgeEdit"）。不改默认启用状态（保持写入工具需显式加载的安全默认）。

### 验收

- 更新 `server/services/__tests__/knowledge-agent-tools.test.ts`：原先断言"静默降级"的用例（约 `:349-365`）改为断言显式错误 + `fallbackToPersonal` 显式降级两条路径。
- 新增用例：非 admin 能列出可读集合与自己的个人条目；无权改密级时 `update_meta` 报错而非静默忽略。
- `server/lib/agent/__tests__/tool-executor.test.ts` 若涉及工具名清单需同步。

---

## WP5 — 审核状态机闭环与文档校正

**问题**：

- **`changes_requested` 之后没有闭环**。状态机 `pending → approved / rejected / changes_requested / conflict`（`server/db/schema.ts:2334-2336`）。被打回后 draft 保持 active，用户改完要新建 submission；而 `updateDraft` 会自动把该 draft 的所有 pending/conflict submission 置为 rejected（`server/services/knowledge-branch-service.ts:299-307`）—— "改草稿"会静默作废排队中的提交。
- **submission 无法撤回**。无 cancel/withdraw 端点。想撤回只能去改草稿触发上面那条自动 reject —— 用副作用当功能。
- **rebase 冲突只能重来**。冲突时返回两份内容但不写库（`:458-520`），无"接受对方版本"或"就地编辑合并结果"路径，用户得把内容抄回去重存。
- **drifted 个人版本仍参与搜索遮蔽**。`KnowledgeSearch` 默认 `useDraft=true`，落后主线的个人版本会顶替全局版本被 agent 读到，只在文案加 `(personal ⚠ behind main — rebase needed)`（`server/lib/agent/tools/knowledge.ts:66`）。提示到位，但 agent 可能一路基于过期内容作答。
- **用户不知道自己有没有审核权**。前端靠后端返回的 `canReview` 反推（`frontend/routes/knowledge/index.tsx:1078`），无"你是 X 标签审核人"的身份说明。
- **archived draft 无清理机制**。
- **知识包无 UI**：`server/routes/knowledge-packs.ts` 9 个端点前端零调用，只能 API 或 `PackList`/`PackActivate`/`PackDeactivate` 三个 optional 工具。

### 改动

1. 后端 `server/routes/knowledge.ts` + `server/services/knowledge-branch-service.ts`：
   - 新增 `POST /submissions/:id/withdraw`：submitter 本人撤回自己的 pending/conflict 提交，置为新状态 `withdrawn`（加入 schema 枚举 → `bun run db:generate`）。发 WP1 事件。
   - 新增 `POST /submissions/:id/resubmit`：从 `changes_requested` 状态的提交上直接再提交（用 draft 当前内容新建一个 submission 并关联前一次的 id，便于审核者看到修改轮次）。若不加关联字段则至少复用 `changeNote` 说明这是第几轮。
   - `updateDraft` 的自动 reject 改为：仅作废 `pending`；对 `conflict` 保留（冲突需要显式解决而非被编辑掩盖）。作废时状态用新增的 `superseded` 而非 `rejected`，区分"被新编辑取代"与"审核者驳回"。同步发 WP1 事件。
   - rebase 冲突新增"采用主线版本"出口：`POST /drafts/:id/rebase?strategy=theirs`（把 draft 内容替换为当前 main 并更新 `baseRevisionId`），供用户放弃本地改动而不必手工复制。
2. 前端：
   - `frontend/routes/knowledge/$entryId.tsx` 提交列表加撤回、重新提交按钮（按状态与身份显示）。
   - drift banner（`:559-579`）加"采用主线版本"按钮。
   - 审核 tab 顶部显示当前用户的审核范围说明（持有哪些 review tag / 对哪些集合有写权限），数据来自新增的 `GET /api/knowledge/my-review-scope`。
3. `server/lib/agent/tools/knowledge.ts`：drifted 个人版本仍可遮蔽，但把提示从文案升级为 metadata 上的显式 `drifted: true`（已有）+ 在输出里明确建议"读取前先 rebase 或传 useDraft:false 对照全局版本"。不改默认行为（默认遮蔽是有意设计）。
4. 文档校正 `docs/KNOWLEDGE_BASE.md`：在 3.8（inline 链接解析）与 3.9（条件内容块 / viewContext）两节顶部加醒目状态标注"**未实现（设计保留）**"，避免后续按文档做假设。同时把 `principalType` 缺 `owner_user`（设计 3.6 列三种，schema 只有 `user | role`）标注为差异。
5. 知识包 UI 与 archived draft 清理**不在本次范围**，在 `docs/KNOWLEDGE_BASE.md` 末尾记为待办（知识包已有 agent 工具可用，属功能缺口而非流程断点；draft 清理需要保留策略决策，需用户定）。

### 验收

- 新增测试：withdraw 的身份校验与状态校验；resubmit 从 `changes_requested` 走通；`updateDraft` 对 conflict 提交不再自动作废；`rebase?strategy=theirs` 正确替换内容与 base。
- schema 改动后运行 `bun run db:generate`（不手改 drizzle/）。

---

## 并行与依赖

- **WP1 先行**：其它包要发的事件类型、WS 消息类型都在 WP1 定义。WP1 落地 `event-bus.ts` 与 `narrator-ws-types.ts` 的新增类型后，WP2/WP5 才能引用。
- **文件冲突面**：
  - `server/routes/knowledge.ts`：WP2/WP3/WP5 都要加端点 → 各自只在自己的分区末尾追加，不重排既有代码。
  - `frontend/hooks/useKnowledge.ts` 与 `frontend/lib/api/knowledge.ts`：WP1/WP2/WP3/WP5 都要加 → 同样只追加。
  - `frontend/routes/knowledge/index.tsx`：WP1（角标）、WP2（卡片可点击）、WP3（集合 ACL 入口）都要改 → 三处改动在不同函数内（`KnowledgeIndex` tab 定义 / `MyLibraryTab` / 集合列表），冲突可控。
  - `frontend/locales/{en,zh-CN}/knowledge.json`：全包都要加键 → 各包用自己的键前缀（`wp1.*` 不用，直接用语义键但避免重名）。
- **收尾**：全部合并后统一跑 `bunx tsgo --noEmit`、`bunx @biomejs/biome check .`、知识库测试套件。schema 有改动时最后统一 `bun run db:generate` 一次。
