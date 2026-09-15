# 知识库（Knowledge Base）实施交接文档

> 本文件给接力实施的 AI 代理阅读。记录当前已完成状态、关键约定、踩过的坑、剩余工作的分块划分，以及**多代理并行的协调协议**。
> 实施前请先完整读本文件，再读引用到的设计文档与现有代码。

更新时间：交接时刻

---

## 0. 一句话背景

NarraFork（Bun + Hono + SQLite/Drizzle 后端，React19 + Mantine v7 + TanStack Router/Query 前端）新增「知识库」通用能力：结构化条目 + 写时复制版本 + **个人草稿→提交→审核→三方合并** 工作流 + **双轴 ACL（密级 clearance + 受控标签 compartment）**。后端与基础前端已完成并通过端到端验证。本轮做**剩余增强**。

完整设计见：
- `docs/KNOWLEDGE_BASE.md` — 知识库总设计（密级/标签/授权/草稿/审核/链接/inline/block/FTS，**注意：链接、inline 引用、条件块 block 这三项仍是设计稿，未实现**）
- `docs/OPEN_API.md` — 开放 API 设计（API token + 程序化 narrator，**未实现，本轮可选**）

---

## 1. 已完成（不要重复做，可依赖）

### 后端（全部已实现 + 端到端验证通过）
- `server/db/schema.ts`：8 张表 —— `knowledge_collections` / `knowledge_entries` / `knowledge_revisions` / `knowledge_drafts` / `knowledge_submissions` / `knowledge_levels` / `knowledge_tags` / `knowledge_grants`。迁移已生成并应用（`0001_*.sql`）。
- `server/db/fts.ts`：`knowledge_entries_fts`（trigram，索引 `title + current_content`）+ 触发器 + rebuild。
- `server/services/knowledge-service.ts`：集合/条目/版本 CRUD、`addRevision`（直写主线，**已收口**：仅 admin/owner/写授权可用）、FTS 搜索、`filterReadable`（ACL 后置过滤）、`updateEntryAcl`。
- `server/services/knowledge-acl.ts`：双轴判定 `resolvePrincipalCaps`/`canRead`/`canWriteMain`/`canReview` + levels/tags/grants 管理 CRUD。
- `server/services/knowledge-branch-service.ts`：草稿 fork/编辑/diff、提交、审核（approve/request_changes/comment_only）、**三方合并**（`createPatch`+`applyPatch`，冲突返回 base/yours/theirs）、冲突人工解决。
- `server/routes/knowledge.ts`：全部 REST 端点（见下）。已在 `server/app.ts` 注册 `/api/knowledge`（继承全局 `requireAuth`）。
- `server/lib/validators/knowledge.ts` + `validators/index.ts` 汇出。

### 前端（已实现 + build 通过）
- `frontend/lib/api/knowledge.ts` + `knowledge-types.ts`，已在 `lib/api/index.ts` 注册 `knowledgeApi` 并导出类型。
- `frontend/hooks/useKnowledge.ts`：全套 React Query hooks。
- `frontend/routes/knowledge/index.tsx`：主页（浏览/审核中心/ACL admin 三 Tab + 新建集合/条目 Modal）。
- `frontend/routes/knowledge/$entryId.tsx`：条目详情（正文直编 / 版本历史对比 / 我的草稿+实时diff+提交 / 提交审核面板）。
- `frontend/components/knowledge/SubmissionReviewPanel.tsx`、`AclAdminPanel.tsx`。
- 复用 `frontend/components/narrator/diff/DiffView.tsx`（props：`oldStr` / `newStr` / `language` / `maxHeight` / `wordWrap`）。
- i18n：`frontend/lib/i18n.ts` 已注册 `knowledge` 命名空间 + 路由映射；`locales/{en,zh-CN}/knowledge.json` 已建；`nav.json` 已加 `knowledge` 键。
- 导航：`AppRootLayout.tsx` 已加「知识库」NavLink（`IconDatabase`，指向 `/knowledge`）。

### 现有 REST 端点（`/api/knowledge`，全部需 JWT）
```
集合:   GET/POST /collections, PATCH/DELETE /collections/:id
条目:   GET /entries?collectionId=&tag=&q=, POST /entries,
        GET/PATCH/DELETE /entries/:id, PATCH /entries/:id/acl (admin)
版本:   POST /entries/:id/revisions(直写,收口), GET /entries/:id/revisions, GET /revisions/:id
草稿:   POST /entries/:id/drafts, GET /entries/:id/drafts/mine,
        PATCH /drafts/:id, GET /drafts/:id/diff, POST /drafts/:id/submit
审核:   GET /submissions?entryId=&status=, GET /submissions/:id,
        POST /submissions/:id/review, POST /submissions/:id/resolve
ACL:    GET/POST/DELETE /levels|/tags|/grants (写操作 admin)
搜索:   GET /search?q=&collectionId=&tag=&limit=
```

---

## 2. 关键约定与踩过的坑（务必遵守）

1. **不碰用户正在运行的实例**：用户在 `~/.narrafork` 跑着正式实例（进程 pid 可能变）。**所有起服务/迁移测试必须用隔离临时 HOME**：`TEST_HOME=$(mktemp -d) && HOME=$TEST_HOME PORT=<非7779/非7799> bun server/index.ts`。用完 `kill` + `rm -rf` 临时目录。**绝不动默认 DB**。
2. **数据库迁移**：改 `server/db/schema.ts` 后跑 `bun run db:generate`（生成全量快照迁移到 gitignored 的 `drizzle/`）→ 用临时 HOME `bun run db:migrate` 验证。**禁止手改 `drizzle/`**。⚠️ **`db:generate` 是全局单一操作，多代理不能同时改 schema + 各自 generate**（见第 4 节协调协议）。
3. **类型检查**：`bunx tsc --noEmit`（全量；过滤自己文件）。**已知预存错误**：缺 `server/generated/*`（构建时生成）的 2 个错误与你无关；前端若 routeTree 未含新路由会报 `to=` 类型错误——build 后自动消失。
4. **代码风格**：`bunx @biomejs/biome check --write <file>`。tab 缩进、100 行宽。**禁止数组 index 作 React key**（用稳定 id，如 `crypto.randomUUID()`）。
5. **依赖**：缺包用代理装 `HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 bun add ...`。⚠️ 已知：`@tanstack/router-plugin` 必须 ≥ `1.168.18`（旧版 router-generator 与 zod4 不兼容，会让 `bun run build` 报 `z.function().returns`）。**本轮已升级修复，不要降级。**
6. **路由自动注册**：`frontend/routes/` 新增文件由 vite TanStack 插件自动生成 `routeTree.gen.ts`。新增路由后必须 `bun run build`（或 dev）触发生成，否则 `to=` 类型不通过。**`routeTree.gen.ts` 是自动生成文件，禁止手改。**
7. **ACL 安全铁律**：读取/检索结果必须经 `canRead` 过滤，无权条目当 404（不泄露存在性）。审核权限 `canReview` = admin / owner / 持有该条目 `reviewTagsJson` 全部对应的 review grant。主线写入只走 `canWriteMain`。
8. **后端性能铁律**（CLAUDE.md）：列表/搜索禁止读大字段、要分页/限流；SQLite 只做小快查询；子进程有超时上限。
9. **i18n**：新增文案同时加 `locales/en/knowledge.json` 和 `zh-CN/knowledge.json`，key 一一对应。
10. **API 路径**：前端 `request<T>(path)` 的 path **不带** `/api` 前缀（`BASE="/api"` 自动拼）。

---

## 3. 剩余工作划分（三个低耦合部分）

> 划分原则：尽量让各部分改不同文件，减少冲突。**共享文件的改动集中由"集成者"或按串行顺序处理**（见第 4 节）。

### 【Part A】条目元数据 + ACL 设置 UI（前端为主，纯新增/低冲突）
目标：补齐条目的元数据编辑与 ACL 配置入口（后端 API 已存在，仅缺 UI）。
- 在 `frontend/routes/knowledge/$entryId.tsx` 增加「设置」Tab（或在标题区加编辑入口）：
  - 编辑标题、tags、status（调 `useUpdateKnowledgeEntryMeta`）
  - admin 可见的 ACL 面板：设密级（下拉选 `useKnowledgeLevels`）、受控标签、审核标签、owner（调 `useUpdateKnowledgeEntryAcl`）
- 新建 `frontend/components/knowledge/EntryAclPanel.tsx` 与 `EntryMetaPanel.tsx`（或合一）。
- 文案加进 `knowledge.json`（en+zh-CN），key 已部分预留（`entryAcl`/`controlledTags`/`reviewTags`/`saveAcl` 等，见现有文件）。
- **只改/新增**：`frontend/components/knowledge/*`（新文件）、`$entryId.tsx`、`knowledge.json`(en+zh)。
- 验收：build 通过 + tsc/biome 干净 + 隔离 HOME 起服务，admin 能设密级/标签、普通用户看不到 ACL 面板。

### 【Part B】条目链接（entry links）后端 + 前端（设计已存在，未实现）
目标：实现 `docs/KNOWLEDGE_BASE.md` 第 3.7 节的**条目间链接**（scope=entry 的有向带类型关联；inline/正文内联可留作后续）。
- 后端：
  - `schema.ts` 新增 `knowledge_entry_links` 表（参考设计 3.7，先只做 `scope=entry`：id/fromEntryId/toEntryId/linkType/label/createdByUserId/createdAt + 索引）。**不引入 `sql`/`primaryKey` 新 import**（用普通 `uniqueIndex`/`index`）。
  - `bun run db:generate` + 临时 HOME migrate（**见第 4 节：schema 改动需与 Part C/集成者串行**）。
  - `knowledge-branch-service.ts` 或新建 `knowledge-link-service.ts`：addLink/removeLink/listLinks（direction=out|in|both）/getGraph(depth 上限)；**两端都过 canRead**（无权链接不返回，见设计 6.5）。
  - `routes/knowledge.ts` 加端点：`GET /entries/:id/links`、`POST /entries/:id/links`、`DELETE /links/:id`、`GET /entries/:id/graph`。
  - `validators/knowledge.ts` 加 `createKnowledgeLinkSchema`（防自链）+ index 汇出。
- 前端：
  - `lib/api/knowledge.ts` + types + `useKnowledge.ts` 加链接相关方法/hooks。
  - `$entryId.tsx` 加「关联」Tab：出链/入链列表 + 新建链接（选目标条目 + 类型）+ 反向引用展示。
- **会改的共享文件**：`schema.ts`、`validators/index.ts`、`routes/knowledge.ts`、`lib/api/index.ts`、`$entryId.tsx`（与 Part A 都改 `$entryId.tsx`，需协调）。
- 验收：建两条目互链、列出出/入链、无权目标不可见；build/tsc/biome 干净。

### 【Part C】审核中心增强 + 通知/计数（前端为主 + 少量后端）
目标：把"审核中心"做成真正可用的待办聚合 + 集合管理增强。
- 后端（可选小改）：`listSubmissions` 已按 canReview 过滤；可加 `GET /submissions/count`（待我审核数）用于导航 badge。若加则改 `routes/knowledge.ts` + service。
- 前端：
  - 主页「审核中心」Tab 增强：按 entry 分组、状态筛选（pending/conflict）、点击直达条目审核 Tab 并自动选中该 submission（用 search param 或 state）。
  - 集合管理增强：集合编辑（改名/描述，`useUpdateKnowledgeCollection` 已存在但 UI 未接）、集合详情展示条目数。
  - 可选：导航「知识库」入口加待审核数 badge（需 Part C 后端 count 端点）。
- **只改/新增**：`frontend/routes/knowledge/index.tsx`、新组件、`knowledge.json`；（可选）`routes/knowledge.ts` + service 的 count 端点。
- 验收：审核中心可筛选/分组/跳转；集合可编辑；build/tsc/biome 干净。

---

## 4. ⚠️ 多代理并行协调协议（必读，防止互相破坏）

**根本约束**：以下是**共享资源/串行点**，多代理同时改会冲突或损坏：
- `server/db/schema.ts` + `bun run db:generate`：全局单一迁移快照。**只有 Part B 改 schema**。若未来多个部分都要改 schema，必须串行：一个改完 generate+migrate 验证通过，另一个再基于其结果改。本轮只有 **Part B** 动 schema，A/C 不动。
- `server/lib/validators/index.ts`、`server/routes/knowledge.ts`、`server/app.ts`、`frontend/lib/api/index.ts`：barrel/注册文件。**只有 Part B 改这些后端共享文件**；A/C 尽量不碰。
- `frontend/routes/knowledge/$entryId.tsx`：**Part A 和 Part B 都要改它**（A 加设置 Tab，B 加关联 Tab）。→ 协议：**A 先改并验证通过，B 在 A 的结果上加**；或两者都只用 Edit 精确插入各自的 Tab，避免重写整文件。
- `frontend/routes/knowledge/index.tsx`：**只有 Part C 改**。
- `frontend/locales/{en,zh-CN}/knowledge.json`：三方都加文案。→ 协议：各自用 Edit 在文件**末尾对象内追加**自己的 key（不同 key 前缀：A 用 `acl*`/`meta*`，B 用 `link*`，C 用 `reviewCenter*`/`collectionEdit*`），降低冲突；冲突时以"合并所有 key"为准。

**执行顺序建议**（若并行）：
1. 三个代理可同时起步**探索 + 写各自独立新文件**（新组件、新 service）。
2. **schema/migration（Part B）必须独占执行**：Part B 改 schema + generate + migrate 时，其他代理不要同时 generate。
3. 共享文件（`$entryId.tsx`、各 index/barrel、`knowledge.json`）的写入，**用最小 Edit 精确插入**，不要整文件重写。
4. 每个代理完成后各自跑：`bunx tsc --noEmit`（过滤自己文件）+ `bunx @biomejs/biome check --write 自己的文件`。
5. **最终集成与 build 由主控（启动者）统一执行一次**：`bun run build` + 隔离 HOME 端到端验证。各代理**不要各自跑 `bun run build`**（routeTree 生成是全局的，并发会互相覆盖）。

**每个代理交付物**：列出自己改/新增的文件清单 + 自己验证结果（tsc/biome），**不要执行全局 build**，把 build + 集成验证留给主控。

---

## 5. 验证命令速查
```bash
# 类型（过滤自己文件）
bunx tsc --noEmit 2>&1 | grep -E "<你的文件路径片段>"
# 代码风格（单文件）
bunx @biomejs/biome check --write <file>
# 迁移（仅 Part B，隔离 HOME）
bun run db:generate
TH=$(mktemp -d) && HOME=$TH bun run db:migrate && rm -rf "$TH"
# 端到端（仅主控，隔离 HOME，端口避开 7779/7799）
TH=$(mktemp -d) && HOME=$TH PORT=7801 NODE_ENV=production bun server/index.ts
```

---

## 6. 设计文档交叉引用
- 链接（Part B）：`docs/KNOWLEDGE_BASE.md` §3.7（表结构、linkType 枚举、6.5 权限处理）
- 双轴 ACL 语义：`docs/KNOWLEDGE_BASE.md` §6
- block/inline（本轮不做，未来）：§3.8、§3.9
- 开放 API（本轮不做）：`docs/OPEN_API.md`
