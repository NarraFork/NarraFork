# 知识库（Knowledge Base）设计

状态：**大部分已实现**（集合/条目/版本/标签/密级/双轴授权/条目链接/FTS 检索/关键词注入/个人版本→提交→审核→合入/ACL 审计 均已落地）。
两项**未实现、仅设计保留**：正文内联链接（3.8）与条件内容块 block（3.9）—— 两节顶部各有明确标注，请勿据其做任何假设。
协作写入链路（个人版本、发布请求、状态机、通知、审计）见 **6.7**；已知缺口集中在 **第 10 节**。
适用范围：NarraFork 通用能力

> 知识库是 NarraFork 的**通用平台能力**，不是为某个具体业务（如机器人远程诊断）定制的功能。它让"可被 AI 叙述者按需检索、引用的结构化知识"成为项目/全局的一等资源。机器人诊断的经验库（错误码、FAQ、历史案例）只是它的**首批消费场景之一**，文档中相关示例仅作说明，不应让业务概念渗入通用设计。

---

## 1. 目标与动机

### 1.1 要解决什么

当前 NarraFork 已有的"知识"承载方式只有 **skills**（`.claude/skills/<name>/SKILL.md` + 伴随文件，见 `server/services/skill-service.ts`）。skills 适合"工具型知识"——一段可被 `Skill` 工具按名加载的操作指令 + 脚本。但它有局限：

- 基于文件、按项目 git 目录扫描，**不可结构化检索**（只能按 name 精确加载）。
- 无标签分类、无全文搜索、无版本管理、无细粒度权限。
- 不便于程序化读写，外部系统难以贡献/消费知识。

知识库要补上这些：**可分类、可搜索、可引用、可版本化、可授权、可经 API 读写**的结构化知识资源。

### 1.2 设计原则

1. **通用优先**：表结构与 API 不绑定任何业务领域；领域差异用 tag / 命名空间 / metadata 表达。
2. **与 skills 互补而非替代**：skills 继续承载"工具型知识"；知识库承载"资料型知识"。两者可互相引用。
3. **检索增强（RAG-ready）**：知识条目可被叙述者在对话中按关键词/标签/全文检索命中并注入上下文。
4. **写时复制 + 版本管理**：内容引用与正文分离，修改产生新版本，引用可锁定到具体版本。
5. **权限可控**：部分知识仅限授权用户发起的叙述者可检索（见第 6 节）。
6. **沿用现有工程范式**：Drizzle schema + nanoid id + ISO 时间戳 + FTS5（在 `server/db/fts.ts`）+ Zod 校验 + Hono 路由。

---

## 2. 概念模型

```
KnowledgeCollection（知识集合 / 命名空间）
   │  1 ── N
   ▼
KnowledgeEntry（知识条目，逻辑实体 + 元数据）
   │  1 ── N（写时复制版本）
   ▼
KnowledgeRevision（知识版本，不可变正文快照）

KnowledgeEntry ── N:N ──> KnowledgeEntry（条目链接 EntryLink：有向带类型；scope=entry 整体关联 / scope=inline 正文位置内联引用）
KnowledgeEntry ── N:N ── Tag（标签：分类/筛选/关键词注入；其中"受控标签"= 访问分区 compartment）
KnowledgeEntry ── 1 ── ClassificationLevel（密级：纵向分级）
Principal ── Clearance（密级许可）+ Grant（受控标签授权）
```

| 概念 | 说明 |
|------|------|
| **Collection（集合）** | 知识的命名空间/分组，如"机器人诊断经验""平台使用手册"。承载默认密级、所有者。 |
| **Entry（条目）** | 一条知识的稳定标识 + 当前指针 + 分类/密级/标签等元数据。 |
| **Revision（版本）** | 条目正文的不可变快照（写时复制）。每次编辑生成新 revision，entry 的 `currentRevisionId` 指向最新。 |
| **Block（条件内容块）** | 正文内用 `::: when <条件> :::` 包裹的段落，读取时按 `viewContext`（如产品版本/受众）裁剪展示。让同一条目对不同上下文呈现不同内容（如旧版本客户看旧描述），无需拆成多条。详见第 3.9 节。**是内容适配，不是访问控制**（见 6.6）。 |
| **EntryLink（条目链接）** | **条目↔条目**之间的有向关系（如"参见/扩展/取代/父子/依赖"），构成知识图谱。链接有两种范围：**条目级**（A 整体↔B 整体）与**内容级（inline）**（A 某版本正文的具体位置内联引用 B，类似 wiki `[[...]]`）。详见第 3.7、3.8 节。与下面的"外部引用"是不同概念。 |
| **Tag（标签）** | 普通标签用于分类筛选 + 关键词注入命中（见第 5 节）；**受控标签（controlled tag）** 额外承担"访问分区（compartment）"职责，见第 6 节。 |
| **ClassificationLevel（密级）** | 条目的纵向分级，如 `public < internal < confidential < secret`。是访问控制的**等级轴**。 |
| **Clearance / Grant（许可 / 授权）** | principal（用户 / 角色 / 发起 agent 的用户）持有的密级许可（clearance）与受控标签授权（grant），是访问控制的**主体侧凭据**。 |
| **外部引用（External Reference）** | 知识库**之外**的实体（某条叙述者消息、某次任务）对知识条目的引用，锁定到 `revisionId`（写时复制保证引用稳定）。注意区别于"条目链接"：前者是外部→知识，后者是知识↔知识。 |

> 内容引用分离 = "entry（指针/元数据）" 与 "revision（不可变正文）" 分表。消费方引用 revision，编辑只追加 revision，旧引用不受影响。

### 访问控制是"分级 + 分 tag"双轴（先建立直觉）

借鉴多级安全（MLS）模型，知识的可访问性由**两条正交的轴**共同决定，**两轴都满足才放行（AND）**：

```
        纵向：密级分级（level / clearance）
        ▲
secret  │   ■ 需要 clearance ≥ secret
conf.   │   ■
internal│   ■
public  │   ■ 任何人可读
        └──────────────────────────────▶  横向：受控标签分区（compartment / grant）
            (无)   tagA   tagB   tagA+tagB
                   ↑ 带受控标签的条目，principal 必须持有对应标签授权

可读 ⇔  principal.clearance ≥ entry.level   且   entry 的每个受控标签 ⊆ principal.grantedTags
```

- **等级轴**解决"密级够不够"：高密级内容只对持有足够 clearance 的主体可见。
- **分区轴**解决"是否属于这个领域分区"：带受控标签（如 `product:X`、`team:售后`）的内容，只对被授予该标签的主体可见——即使其密级 clearance 足够。
- 二者是 AND：**密级达标 且 受控标签全部被授权**，才可访问。普通标签（非受控）只用于分类筛选，不参与鉴权。

---

## 3. 数据库 Schema（新增表）

放在 `server/db/schema.ts`，沿用现有风格（`sqliteTable` + `text("id").primaryKey()` 用 nanoid + ISO 字符串时间戳 + `{ mode: "json" }` + `{ mode: "boolean" }`）。

### 3.1 knowledge_collections

```typescript
export const knowledgeCollections = sqliteTable(
	"knowledge_collections",
	{
		id: text("id").primaryKey(), // nanoid
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		// 归属：项目级（projectId 非空）或全局（projectId 为空）
		projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
		// 集合默认密级（等级轴）：条目未单独指定密级时继承此值
		// 取值为 knowledge_levels.name；public 表示无密级门槛
		defaultLevel: text("default_level").notNull().default("public"),
		// 视图维度声明（条件块 / viewContext 的"参数约定"，见 3.9.1）：
		// 声明本集合允许的 view 维度（key/类型/比较规则/可选值），写条件块与传 viewContext 据此校验。
		// JSON: ViewDimension[]；为空表示本集合不使用条件块。
		viewDimensionsJson: text("view_dimensions_json", { mode: "json" }),
		// 缺省 key 策略：viewContext 未提供某维度时，引用该维度的条件块如何处理
		// hide（默认，保守不展示版本特定内容）| show
		missingKeyPolicy: text("missing_key_policy", { enum: ["hide", "show"] })
			.notNull()
			.default("hide"),
		ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_kc_project_slug").on(table.projectId, table.slug),
		index("idx_kc_project").on(table.projectId),
	],
);
```

### 3.2 knowledge_entries

```typescript
export const knowledgeEntries = sqliteTable(
	"knowledge_entries",
	{
		id: text("id").primaryKey(),
		collectionId: text("collection_id")
			.notNull()
			.references(() => knowledgeCollections.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		slug: text("slug").notNull(),
		// 指向当前生效版本（写时复制）
		currentRevisionId: text("current_revision_id"),
		// 密级（等级轴）：取值为 knowledge_levels.name；null = 继承集合 defaultLevel
		// 横向轴（受控标签）通过 knowledge_entry_tags 关联的 controlled tag 表达，不在此列
		classificationLevel: text("classification_level"),
		// 自由结构元数据：领域差异（如 error_code、product、severity）放这里，保持表通用
		metadataJson: text("metadata_json", { mode: "json" }),
		// 关键词自动注入命中词（与 tags 互补，见第 5 节）。JSON string[]。
		keywordsJson: text("keywords_json", { mode: "json" }),
		status: text("status", { enum: ["active", "archived"] })
			.notNull()
			.default("active"),
		ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_ke_collection_slug").on(table.collectionId, table.slug),
		index("idx_ke_collection").on(table.collectionId),
		index("idx_ke_status").on(table.status),
	],
);
```

### 3.3 knowledge_revisions（写时复制，不可变）

```typescript
export const knowledgeRevisions = sqliteTable(
	"knowledge_revisions",
	{
		id: text("id").primaryKey(),
		entryId: text("entry_id")
			.notNull()
			.references(() => knowledgeEntries.id, { onDelete: "cascade" }),
		// 单调递增版本号（应用层在事务内 max+1）
		version: integer("version").notNull(),
		// 正文 + 格式（markdown / text / json）
		format: text("format", { enum: ["markdown", "text", "json"] })
			.notNull()
			.default("markdown"),
		content: text("content").notNull(),
		// 内容哈希，用于去重/引用完整性校验
		contentHash: text("content_hash").notNull(),
		// 变更说明 + 作者（用户或程序化 agent）
		changeNote: text("change_note"),
		authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
		authorNarratorId: text("author_narrator_id"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_kr_entry_version").on(table.entryId, table.version),
		index("idx_kr_entry").on(table.entryId),
	],
);
```

> `currentRevisionId` 与 `knowledgeRevisions` 互为引用，沿用 schema.ts 已有的 forward-reference 写法（参考 `narrators.forkMessageId` 用 `(): any =>`）。

### 3.4 knowledge_levels（密级定义，等级轴）

把密级做成可配置、可排序的表，而非写死的 enum——不同部署/集合可定义自己的密级阶梯。`rank` 越大密级越高，比较时按 `rank` 判定 `dominates`。

```typescript
export const knowledgeLevels = sqliteTable(
	"knowledge_levels",
	{
		id: text("id").primaryKey(),
		// 密级名，全局唯一；条目/集合用 name 引用（如 public/internal/confidential/secret）
		name: text("name").notNull().unique(),
		// 等级排序：数值越大密级越高。public 通常为 0
		rank: integer("rank").notNull(),
		label: text("label"), // 展示名
		createdAt: text("created_at").notNull(),
	},
	(table) => [uniqueIndex("idx_klevel_rank").on(table.rank)],
);
```

> 内置种子：`public(0) < internal(10) < confidential(20) < secret(30)`，部署可改。`classificationLevel`/`defaultLevel` 存的是 `name`，比较时查 `rank`。`public`（rank 0）= 无密级门槛。

### 3.5 标签：knowledge_tags + knowledge_entry_tags

```typescript
export const knowledgeTags = sqliteTable(
	"knowledge_tags",
	{
		id: text("id").primaryKey(),
		// 标签归属集合，避免全局命名冲突；也允许 collectionId 为空表示全局标签
		collectionId: text("collection_id").references(() => knowledgeCollections.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		// 是否为"受控标签"（compartment / 横向分区轴）。
		// false（默认）= 普通分类标签，仅用于筛选与关键词注入，不参与鉴权。
		// true = 受控标签：带此标签的条目，principal 必须被授予该标签（knowledge_grants）才可访问。
		controlled: integer("controlled", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_ktag_collection_name").on(table.collectionId, table.name),
		index("idx_ktag_controlled").on(table.controlled),
	],
);

export const knowledgeEntryTags = sqliteTable(
	"knowledge_entry_tags",
	{
		entryId: text("entry_id")
			.notNull()
			.references(() => knowledgeEntries.id, { onDelete: "cascade" }),
		tagId: text("tag_id")
			.notNull()
			.references(() => knowledgeTags.id, { onDelete: "cascade" }),
	},
	(table) => [
		primaryKey({ columns: [table.entryId, table.tagId] }),
		index("idx_ket_tag").on(table.tagId),
	],
);
```

> 注意：这是 schema.ts 中第一个**复合主键**表（现有表都是单 `id` 主键）。需在 `server/db/schema.ts` 顶部的 drizzle import 追加 `primaryKey`（当前只 import 了 `index, integer, real, sqliteTable, text, uniqueIndex`）。若想完全贴合现有"单 id 主键"先例，也可改为 `id: text("id").primaryKey()` + `uniqueIndex` 约束 `(entryId, tagId)`——二选一在实现阶段定。

### 3.6 权限授权：knowledge_grants

ACL 不再是"主体 × 对象"的可见性条目，而是**授予 principal 的两类凭据**，对应访问控制的两条轴：

- **密级许可（clearance）**：授予某 principal 一个最高可读密级（等级轴）。
- **受控标签授权（compartment grant）**：授予某 principal 某个受控标签（横向分区轴）。

> ### ⚠️ 与实现的差异（本节下面的 schema 是设计稿，非现状）
>
> | 字段 | 本节设计 | 实际实现（`server/db/schema.ts` `knowledgeGrants`） |
> |------|---------|------|
> | `principalType` | `user \| role \| owner_user` | **只有 `user \| role`** —— **`owner_user` 未实现** |
> | `grantType` | `clearance \| tag` | `clearance \| tag \| review`（多了 `review`，审核授权轴） |
>
> `owner_user` 之所以没有落地：owner 语义已由 `knowledge_entries.ownerUserId` / `knowledge_collections.ownerUserId` 上的**短路判定**实现（见 `knowledge-acl.ts` 的 `canRead` / `canWriteCollection` / `canReview` / `isEntryOwnerOrAdmin`），不需要再发一条 grant 行。因此"给某人授 owner 身份"的正确做法是**转移所有权**（`POST /api/knowledge/{entries,collections}/:id/transfer-owner`），不是插 grant。校验层同样只接受两种取值（`server/lib/validators/knowledge.ts` 的 `createKnowledgeGrantSchema`）。

```typescript
export const knowledgeGrants = sqliteTable(
	"knowledge_grants",
	{
		id: text("id").primaryKey(),
		// 授权作用域：全局（都为空）/ 集合级（collectionId）。
		// 不做条目级 grant —— 条目通过"密级 + 受控标签"自动归类，授权只针对轴本身，避免逐条维护。
		collectionId: text("collection_id").references(() => knowledgeCollections.id, {
			onDelete: "cascade",
		}),
		// 主体：用户 / 角色 / 发起 agent 的用户（程序化会话）
		principalType: text("principal_type", { enum: ["user", "role", "owner_user"] }).notNull(),
		// principalType=user|owner_user → users.id；role → "admin"/"user"
		principalId: text("principal_id").notNull(),
		// 授权类型：clearance（等级轴）| tag（分区轴）
		grantType: text("grant_type", { enum: ["clearance", "tag"] }).notNull(),
		// grantType=clearance：授予的最高密级（knowledge_levels.name），principal 可读 rank ≤ 此值的内容
		clearanceLevel: text("clearance_level"),
		// grantType=tag：授予的受控标签（knowledge_tags.id，必须 controlled=true）
		tagId: text("tag_id").references(() => knowledgeTags.id, { onDelete: "cascade" }),
		// 写权限：是否允许对命中范围写入/新增版本（默认只读）
		canWrite: integer("can_write", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_kgrant_principal").on(table.principalType, table.principalId),
		index("idx_kgrant_collection").on(table.collectionId),
		index("idx_kgrant_tag").on(table.tagId),
	],
);
```

**两轴授权语义**：

| grantType | 字段 | 含义 |
|-----------|------|------|
| `clearance` | `clearanceLevel` | principal 的密级许可：可读 `rank ≤ clearanceLevel.rank` 的条目（等级轴）。无此 grant 时默认许可为 `public`。 |
| `tag` | `tagId` | principal 获得某个受控标签：可访问带该受控标签的条目（分区轴）。每个受控标签需单独授予。 |

- **admin 角色**视为拥有最高 clearance + 所有受控标签（实现层短路，不必逐条 grant）。
- **owner**（条目/集合 `ownerUserId`）对自己拥有的内容拥有完整访问 + 写权限。
- 默认：未授予任何 grant 的 principal 拥有 `public` clearance、无任何受控标签——即只能读 `public` 密级且不带受控标签的条目。

### 3.7 条目链接：knowledge_entry_links（知识图谱 + 内容级内联链接）

支持**条目↔条目**互相引用，且引用可以**锚定到正文里的具体位置**（内容级内联链接，类似 wiki 的 `[[...]]` 内链），而不只是"条目整体 ↔ 条目整体"的关联。

链接分两种 `scope`：

- **`entry`（条目级）**：A 整体与 B 整体的关系（参见 / 取代 / 父子 / 依赖），由人/agent 显式声明，与正文位置无关。
- **`inline`（内容级）**：A 的**某个版本正文的某个位置**引用 B（如正文中写到某错误码时内联链到该错误码条目）。锚定到 `fromRevisionId` + `anchor`，随正文版本变化而重建。

```typescript
export const knowledgeEntryLinks = sqliteTable(
	"knowledge_entry_links",
	{
		id: text("id").primaryKey(),
		// 源条目 → 目标条目（有向）
		fromEntryId: text("from_entry_id")
			.notNull()
			.references(() => knowledgeEntries.id, { onDelete: "cascade" }),
		toEntryId: text("to_entry_id")
			.notNull()
			.references(() => knowledgeEntries.id, { onDelete: "cascade" }),
		// 链接范围：entry=条目整体关联（人工声明）；inline=源正文某位置的内联引用（解析自正文）
		scope: text("scope", { enum: ["entry", "inline"] }).notNull().default("entry"),
		// 关系类型（通用、领域无关）：
		//   related     — 参见 / 相关（弱关联，常成对出现，建议双向各建一条或视为无向）
		//   expands     — 展开 / 详述（from 是概述，to 是细节）
		//   supersedes  — 取代（from 取代 to，标记旧条目过时）
		//   depends_on  — 依赖（理解/应用 from 需先看 to）
		//   parent      — 父子 / 归属（from 的父条目是 to）
		//   mention     — 内联提及（inline 链接的默认类型：正文里就地引用）
		//   custom      — 其它，配合 label
		linkType: text("link_type", {
			enum: ["related", "expands", "supersedes", "depends_on", "parent", "mention", "custom"],
		}).notNull(),
		// 自定义关系名（linkType=custom 时使用）或补充说明
		label: text("label"),

		// === 内容级锚定（仅 scope=inline 使用；scope=entry 时均为 null）===
		// 锚点所在的源版本：inline 链接绑定到具体不可变 revision（正文版本化，写时复制）
		fromRevisionId: text("from_revision_id").references(() => knowledgeRevisions.id, {
			onDelete: "cascade",
		}),
		// 正文内的锚点定位：稳定锚 id（推荐）。解析正文内联标记时生成/提取，
		// 渲染时据此高亮/跳转；正文出新版本会重新解析并重建该版本的 inline 链接。
		anchorKey: text("anchor_key"),
		// 锚点处的原始引用文本（如 [[...|显示文本]] 的显示文本），用于展示与回溯
		anchorText: text("anchor_text"),
		// 锚点在该版本正文中的字符偏移（可选，便于精确定位/高亮；偏移随版本而变，故绑 fromRevisionId）
		anchorStart: integer("anchor_start"),
		anchorEnd: integer("anchor_end"),

		// 可选：把链接锁定到目标的某个版本（引用稳定；null = 始终跟随 current）
		toRevisionId: text("to_revision_id").references(() => knowledgeRevisions.id, {
			onDelete: "set null",
		}),
		// 创建者（用户或程序化 agent）。inline 链接由正文解析生成时可记系统/作者
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		// entry 级：同一对条目的同一关系类型不重复（仅约束 scope=entry，inline 可在正文多处引用同一目标）
		uniqueIndex("idx_kelink_entry_from_to_type")
			.on(table.fromEntryId, table.toEntryId, table.linkType)
			.where(sql`scope = 'entry'`),
		index("idx_kelink_from").on(table.fromEntryId), // 正向：from 的出链
		index("idx_kelink_to").on(table.toEntryId), // 反向：to 的入链（"哪些条目引用了我"）
		index("idx_kelink_from_rev").on(table.fromRevisionId), // 按源版本取该版本的 inline 链接
	],
);
```

设计要点：

- **两种范围统一存表**：`scope=entry` 是条目整体关联（人工声明）；`scope=inline` 是正文位置引用（从正文解析）。同表便于"出链/入链/图遍历"一致查询。
- **inline 锚定到版本**：正文是不可变 revision（写时复制），inline 链接绑定 `fromRevisionId` + `anchorKey`/偏移。**编辑出新版本时重新解析正文、为新版本重建 inline 链接**（旧版本的 inline 链接保留，与其版本一起冻结）——保证"某版本正文里的内联引用"始终可还原。
- **反向引用更精细**：查 B 的入链时，`scope=inline` 的入链能告诉你"B 被哪些条目、在正文什么位置（anchorText）提及"，而不只是"A 关联了 B"。
- **inline 默认 `mention`**：正文就地引用默认关系类型为 `mention`；也可在内联语法里指定其它类型。
- **唯一约束只管 entry 级**：`scope=inline` 允许同一源对同一目标在正文多处引用（多个锚点 → 多条 inline 记录）；`scope=entry` 仍按 (from,to,type) 去重（用部分索引 `WHERE scope='entry'`）。
- **版本锁定可选**：`toRevisionId` 非空时指向目标固定版本（适合"取代/依赖"）；为空则跟随目标 `currentRevision`（适合"参见"/一般 mention）。
- **跨集合允许**、**删除级联**（条目删 → 其链接清除；`fromRevisionId` 所在版本删 → 该版本 inline 链接随之清除）。
- **不在链接上单独建密级**：可见性取决于两端条目的双轴权限（见 6.5），inline 同理。
- **环路**：图允许成环；遍历/展开按深度上限 + visited 防递归。

### 3.8 正文内联语法与解析同步

> ## ⚠️ 状态：**未实现（设计保留）**
>
> 本节描述的内联引用语法（`[[entryId]]` / `knowledge:` 协议链接）、`addRevision` 解析回填、`anchorKey`/`anchorStart/End` 锚定、悬挂引用提示、inline→entry 派生关联**全部没有实现代码**。已核实：`server/` 中 `anchorKey`、`anchorStart`、`renderContent` 零命中；`knowledge_entry_links` 表**只有条目级（entry scope）**，没有 `scope` / `fromRevisionId` / anchor 列（见 `server/db/schema.ts` 的 `knowledgeEntryLinks` 注释"Inline (body position) references — scope=inline in the design — are not implemented yet"）。
>
> 已实现的是**条目级链接**（3.7）：`POST/GET /api/knowledge/entries/:id/links`、`DELETE /api/knowledge/links/:id`、`GET /api/knowledge/entries/:id/graph`。正文里写 `[[...]]` 目前只是普通文本，不会建链、不会渲染成内链。
>
> 请勿按本节做任何假设（例如"引用会自动同步"或"存在 anchor 定位"）。若要落地，需要新增 schema 列 + 迁移 + 解析器 + 前端渲染，属独立立项。下列 3.5/3.7 中涉及 `scope=inline` / 部分索引 `WHERE scope='entry'` / `view.*` / `renderContent` 的叙述均为**设计稿**，当前 `knowledge_entry_links` 无 scope 列、无该部分索引。

内容级（inline）链接的来源是**正文里的内联引用标记**。约定一套与 markdown 兼容的语法，在保存版本时解析、回填 `knowledge_entry_links`（scope=inline）。

**内联语法**（wiki 风格，最终语法在实现期定，下为建议）：

```
[[entryId]]                      内联引用某条目（默认 linkType=mention，显示目标当前标题）
[[entryId|显示文本]]              指定显示文本
[[entryId@revId]]                锁定到目标某版本（回填 toRevisionId）
[[slug:collectionSlug/entrySlug]] 用人类可读 slug 引用（解析期解析为 entryId）
[[entryId#related]]              指定关系类型（related/expands/depends_on/...）
```

- 也可同时支持标准 markdown 链接到内部 URL（如 `[文本](knowledge:entryId)`），解析期识别 `knowledge:` 协议同样回填 inline 链接。两种写法择一或并存，实现期定。

**解析与同步流程**（发生在 `addRevision`，即每次写正文）：

```
addRevision(entryId, { content, ... }):
  1. 事务内插入新 revision（不可变），切换 entry.currentRevisionId
  2. 解析 content 中的内联标记 → 得到 [{ toEntryId|slug, linkType, displayText, toRevId?, start, end }]
     - slug → entryId 解析；目标不存在 → 标记为“悬挂引用”（见下）
  3. 为该新 revision 重建 inline 链接：
       - 删除 from_revision_id = <新版本> 的旧 inline 记录（同版本重存时）
       - 为每个内联标记插入一条 knowledge_entry_links(scope=inline,
           fromEntryId, fromRevisionId=<新版本>, toEntryId, linkType, anchorKey, anchorText, anchorStart/End, toRevisionId?)
  4. 旧版本的 inline 链接保持不变（与其 revision 一起冻结）
  5. 建链同样受权限约束：对无权 read 的目标，拒绝/降级为悬挂（见 6.5）
```

- **anchorKey 稳定性**：解析时为每个内联引用生成稳定锚 id（如基于"目标 + 出现序号"或正文标记自带的 id），供渲染高亮、滚动定位、回链跳转；字符偏移 `anchorStart/End` 作为辅助精确定位，随版本变化故绑定到 `fromRevisionId`。
- **悬挂引用（dangling）**：正文引用了不存在/已删除/无权的目标 → 不插链接记录，但在校验结果里提示作者（UI 标红"引用失效"）。不阻断保存。
- **渲染**：读取条目时，前端按 `fromRevisionId=currentRevisionId` 的 inline 链接，把正文里的标记渲染为可点击内链（显示目标当前标题/anchorText），点击跳转目标条目（受权限：无权目标不渲染为可跳转，避免存在性泄露）。
- **与 entry 级关系的协同**：可选策略——若正文 inline 提及了某目标，可自动维护一条 `scope=entry, linkType=related` 的"派生关联"用于图谱概览；是否派生在集合级配置，默认不自动派生，保持 inline 与 entry 两层清晰。

### 3.9 条件内容块（block）与按查询参数裁剪

> ## ⚠️ 状态：**未实现（设计保留）**
>
> 本节描述的 `::: when` 条件块语法、`knowledge_collections.viewDimensionsJson` 视图维度声明、读取时按 `viewContext` 裁剪正文**全部没有实现代码**。已核实：`server/` 中 `viewContext`、`viewDimensions`、`renderContent` 零命中；`knowledge_collections` 表没有 `viewDimensionsJson` 列。
>
> 当前行为：正文按原文整体返回（`getEntry` / `KnowledgeRead` 只做长度截断），`::: when` 会被当作普通文本原样显示。同一条知识若需对不同上下文呈现不同内容，目前只能拆成多个条目或多个集合。
>
> 请勿按本节做任何假设（例如"传 viewContext 会裁剪"或"集合有维度 schema"）。若要落地，需要新增列 + 迁移 + 解析/裁剪层 + API 参数 + 前端筛选器，属独立立项。**注意**：如 6.6 所述，block 是**内容适配而非访问控制**（先过 ACL 再裁剪），实现时不得把它当权限手段。

**动机**：同一条知识常需对不同"读者上下文"展示不同内容——最典型的是**产品版本**：旧版本客户应看到旧版本对应的描述。与其把条目按版本拆成多份（维护分裂、易漂移），不如**在同一条目正文内用条件块标记**，读取时按查询参数（view context）裁剪展示。

> 把"版本"泛化为**任意 view 维度**：`version` / `product` / `audience`（终端用户 vs 工程师）/ `lang` 等都只是 context 的一个 key。这保持了 NarraFork 的通用性——block 机制本身不含"版本""机器人"等领域语义。

#### 3.9.1 视图维度声明（参数怎么约定）

平台**不预定义**任何业务维度（不硬编码 version/product…），而是由**集合声明自己的 view 维度 schema**（存 `knowledge_collections.viewDimensionsJson`）。这是条件块 key 与 viewContext 的"单一约定来源"：写条件块、传 viewContext、UI 渲染筛选器、保存校验全都依据它。

```jsonc
// knowledge_collections.viewDimensionsJson —— ViewDimension[]
[
  {
    "key": "version",          // 维度名（条件块/viewContext 用的 key）
    "type": "version",         // version | enum | string | number | boolean
    "label": "产品版本",        // UI 展示名
    "compare": "semver",       // 仅 type=version：semver | numeric（默认 semver）
    "required": false          // 该集合的条目读取时是否要求 viewContext 提供此维度
  },
  {
    "key": "product",
    "type": "enum",
    "label": "产品线",
    "values": ["M20", "CD1", "X30"]   // enum 必填：合法取值集合
  },
  {
    "key": "audience",
    "type": "enum",
    "label": "受众",
    "values": ["user", "engineer"],
    "default": "user"          // 可选：viewContext 缺该 key 时的兜底值
  }
]
```

类型与比较规则：

| type | 合法运算 | 比较语义 |
|------|---------|---------|
| `version` | `== != < <= > >=` | 按 `compare`：`semver`（`1.9 < 1.18`）或 `numeric` |
| `enum` | `== != in` | 取值必须 ∈ `values`；否则保存时告警 |
| `string` | `== != in` | 字符串相等/包含 |
| `number` | `== != < <= > >=` | 数值比较 |
| `boolean` | `== !=` | 真假 |

要点：

- **维度集中声明**：条件块里能用的 key、能比的运算、合法取值，全部来自这份声明。改维度只改集合配置，不动平台代码——通用性由此保证。
- **缺省 key 策略**：viewContext 未提供某维度时，引用它的条件块按集合的 `missingKeyPolicy`（默认 `hide`）处理；若维度声明了 `default`，则先用 default 兜底再判定。
- **`required` 维度**：声明 `required:true` 的维度，读取该集合条目时 viewContext 必须提供（否则按 missingKeyPolicy 或报参数缺失，集合级定）。适合"必须知道版本才能正确展示"的集合。
- **跨集合链接**：条件块只能用**本条目所属集合**声明的维度；inline 链接到其它集合的条目时，目标按其自己集合的维度裁剪（各集合维度独立）。
- **演进友好**：维度是声明式 JSON，可增删；删维度时已有条件块引用它会变成"未声明 key"，按 3.9.5 的保存校验提示。

#### 3.9.2 正文块标记语法

在 markdown 正文里用条件块包裹"仅在满足条件时展示"的段落（最终语法实现期定，下为建议）：

```
::: when version >= 1.18
1.18 及以上：充电流程为 A → B → C。
:::

::: when version < 1.18
1.18 以前：充电流程为 A → C（无 B 阶段）。
:::

::: when product == "M20" && audience == "engineer"
（仅 M20 工程师可见的内部细节）
:::

行内形式：标准段落默认始终展示；只有被 ::: when ... ::: 包裹的块才受条件控制。
```

条件表达式是一个**小型只读 DSL**（无副作用、可安全求值）：

- 操作数：**已声明的维度 key**（见 3.9.1）与字面量（字符串/数字/布尔）。
- 运算符：`==` `!=` `<` `<=` `>` `>=` `in [..]` `&&` `||` `!` `()`（具体某 key 能用哪些运算由其 `type` 决定）。
- **版本比较**：`type=version` 的维度按其 `compare`（默认 semver）比较（`1.9 < 1.18`），而非字符串比较。
- 未提供的维度 key：按集合 `missingKeyPolicy`（默认"条件不满足/不展示"）处理，或先用维度 `default` 兜底。

#### 3.9.3 view context 与裁剪流程

读取/检索时传入 `viewContext`（如 `{ version: "1.16", product: "M20", audience: "user" }`），服务层按集合维度声明解析、求值、裁剪：

```
renderContent(revisionContent, viewContext, collection.viewDimensions, missingKeyPolicy):
  1. 按维度声明规整 viewContext：类型转换（version→版本对象/number→数值）、enum 取值校验、应用 default
  2. 解析正文为段落 + 条件块（块携带其 when 表达式）
  3. 对每个条件块：用规整后的 viewContext 求值表达式
       - 命中 → 保留块内内容
       - 未命中 → 整块剔除（不进入返回正文）
       - 引用未提供且无 default 的维度 → 按 missingKeyPolicy
  4. 普通段落始终保留
  5. 返回裁剪后的正文（+ 可选：被裁剪块计数，仅供管理视图，不给最终读者）
```

- 裁剪是**幂等的纯函数**，输入（不可变 revision 正文 + viewContext + 维度声明）相同则输出相同。
- 客户端拿到的是**已裁剪正文**；条件块的原始标记与未命中内容不下发给最终读者（避免泄露其它版本/受众的内容）。

#### 3.9.4 与 revision、检索、注入的关系

- **不单独版本化 block**：条件块是正文的一部分，随写时复制进入新 revision。编辑出新版本时块标记一并固化；查历史版本即查那一版的条件块。**block 解决"一份正文按 context 裁剪"，revision 解决"正文的编辑历史"，两者正交。**
- **检索**：`search` / 关键词注入可带 `viewContext`，对命中条目**先裁剪再返回摘要**，使旧版本客户的会话只看到适配其版本的内容。FTS 索引默认仍针对完整正文（保证可被搜到），命中后在返回层裁剪；若需要"按版本隔离搜索结果"可作为集合级可选项（成本更高，非默认）。
- **元数据辅助**：条目可在 `metadataJson` 标注其**整体适用范围**（如 `appliesTo: { version: ">=1.10" }`）用于粗筛；细粒度差异交给正文条件块。两者配合：metadata 决定"这条是否相关"，block 决定"这条里哪些段落对你展示"。

#### 3.9.5 保存时校验（警告不阻断）

`addRevision` 解析正文条件块时，对照集合维度声明校验，**有问题只告警、不阻断保存**（保留作者灵活性，渐进收敛）：

- **未声明 key**：条件块用了集合未声明的维度 → 告警"未知维度 `xxx`"（UI 标黄），该块在裁剪时按 missingKeyPolicy 处理。
- **非法取值**：`enum` 维度比对了不在 `values` 里的值，或 `version` 维度比对了非法版本串 → 告警。
- **类型/运算不匹配**：对 `enum` 用 `<`、对 `version` 用未定义比较等 → 告警。
- **语法错误**：`when` 表达式无法解析 → 告警，该块降级为"始终展示"或"始终隐藏"（集合级定，默认始终展示，避免误吞内容）。

校验结果随保存响应返回（`warnings: [...]`），供编辑 UI 即时提示。不因告警拒绝写入。

#### 3.9.6 配置落点汇总

| 配置 | 落点 | 说明 |
|------|------|------|
| 维度声明 | `knowledge_collections.viewDimensionsJson` | 本集合允许的 view 维度（key/type/compare/values/default/required），见 3.9.1 |
| 缺省 key 策略 | `knowledge_collections.missingKeyPolicy` | viewContext 缺维度时 `hide`（默认）/ `show` |
| 兜底 viewContext | 维度声明里各维度的 `default` | 未显式传该维度时用其 default；无 default 则走 missingKeyPolicy |
| 全局开关/上限 | settings 的 `knowledge` 段 | 如注入是否带 viewContext、语法错误块降级策略等跨集合默认值 |

> block 是**内容适配/裁剪**机制，**不是访问控制**。屏蔽某段不等于鉴权——任何"是否有权读这条知识"的判断永远由第 6 章双轴 ACL 负责，且**先 ACL 判定、后 block 裁剪**。详见 6.6。

### 3.10 全文搜索（FTS5）

不在 schema.ts，而在 `server/db/fts.ts` 追加（与 `chapters_fts`/`narrator_messages_fts`/`narrators_fts` 同样的 trigram tokenizer + 外部内容表 + 同步触发器模式）。

现有 FTS 表用 `content='<基表>', content_rowid=rowid`（SQLite 隐式整型 rowid）+ AFTER INSERT/UPDATE/DELETE 触发器同步（见 `fts.ts` 第 47-131 行）。知识库沿用同一模式：

- 新增虚拟表 `knowledge_entries_fts`，索引当前生效内容的 `title + content`（content 取自 entry 的 `currentRevisionId` 对应正文）：
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_entries_fts USING fts5(
    title, content, content='knowledge_entries', content_rowid=rowid, tokenize='trigram'
  )
  ```
- tokenizer：`trigram`（支持 CJK，查询词 ≥ 3 字符；短查询降级 LIKE，与现有约定一致）。
- 同步触发器：`knowledge_entries` 的 title 变更直接同步；正文随 `knowledge_revisions` 变化——当 `addRevision` 切换 `currentRevisionId` 时，在服务层显式 `UPDATE knowledge_entries SET updated_at=...`（或冗余一个 `current_content` 列）触发 FTS 重建该行，避免在 revisions 表上挂复杂触发器。
- rebuild：沿用 `fts.ts` 末尾（第 133 行起）的非正常关机 / tokenizer 迁移后自动 rebuild 机制，把新表名加入检测列表。

> 之所以把 FTS 挂在 `knowledge_entries`（而非 revisions）：搜索只针对"当前版本"，挂在 entry 上用其隐式 rowid 最贴合现有外部内容表模式；历史版本不进全文索引。实现上可在 entry 增一个由服务层维护的 `current_content` 镜像列供 FTS 取值。

---

## 4. 服务层与路由

### 4.1 服务 `server/services/knowledge-service.ts`

封装业务逻辑（沿用 `skill-service.ts` 的导出对象风格）：

```
knowledgeService = {
  // 集合
  listCollections(scope), createCollection(...), updateCollection(...), deleteCollection(...),
  // 条目
  listEntries(collectionId, { tags, status, cursor }),
  getEntry(entryId, { withContent, viewContext }),  // viewContext 命中时返回按条件块裁剪后的正文（见 3.9）
  createEntry(...),            // 创建条目 + 首个 revision（含 classificationLevel、tags）
  updateEntryMeta(...),        // 改 title/slug/tags/classificationLevel/metadata（不改正文）
  // 版本（写时复制）；addRevision 内部会解析正文内联标记重建 inline 链接（3.8），并对照集合维度声明校验条件块、返回 warnings（3.9.5，不阻断）
  addRevision(entryId, { content, format, changeNote, author }),  // 追加版本 + 切换 current + 重建 inline 链接 + 条件块校验
  listRevisions(entryId), getRevision(revisionId),
  // 条件内容块裁剪（见 3.9）：纯函数，先 ACL 后裁剪；collectionConfig 含 viewDimensions + missingKeyPolicy
  renderContent(revisionContent, viewContext, collectionConfig),  // 解析条件块 + 按维度声明求值裁剪
  // 检索（结果已按双轴权限过滤，见第 6 节；带 viewContext 时返回裁剪后的摘要）
  search({ principal, scope, query, tags, limit, viewContext }),  // FTS5 + tag 过滤 + canRead 过滤 + block 裁剪
  resolveKeywords(principal, scope, text, viewContext),  // 第 5 节关键词注入命中（含权限过滤 + block 裁剪）
  // 条目链接（知识图谱 + 内容级内联，见 3.7/3.8）
  addEntryLink(principal, { fromEntryId, toEntryId, linkType, label?, toRevisionId? }), // scope=entry 显式声明
  removeLink(principal, linkId),
  listLinks(principal, entryId, { direction, scope }), // direction: out|in|both；scope: entry|inline|all；两端按 canRead 过滤
  listInlineLinks(principal, revisionId),  // 某版本正文的 inline 链接（含 anchorKey/偏移，供渲染）
  parseAndSyncInlineLinks(revisionId, content),  // 解析正文内联标记 → 重建该版本 inline 链接（addRevision 内部调用）
  getGraph(principal, entryId, { depth, linkTypes?, scope? }), // 受限广度遍历，含 visited 防环 + 权限过滤
  // 权限（分级 + 分 tag 双轴）
  resolvePrincipalCaps(principal),     // 聚合 clearance(rank) + grantedTagIds
  canRead(principal, entry),           // 双轴 AND（dominates），见 6.1
  canWrite(principal, entry),
  // 授权管理（grant CRUD）
  listGrants(scope), grantClearance(principal, level, scope), grantTag(principal, tagId, scope),
  revokeGrant(grantId),
  // 密级与受控标签定义
  listLevels(), upsertLevel(...), setTagControlled(tagId, controlled),
}
```

### 4.2 路由 `server/routes/knowledge.ts`

沿用 settings.ts 套路（`new Hono()` + `requireAuth` + Zod `safeParse` + `AppError`），挂载 `app.route("/api/knowledge", knowledgeRoutes)`：

```
GET    /api/knowledge/collections?projectId=        列出集合（按双轴权限过滤）
POST   /api/knowledge/collections                   创建集合
PATCH  /api/knowledge/collections/:id
DELETE /api/knowledge/collections/:id

GET    /api/knowledge/entries?collectionId=&tags=&q=&view.version=&view.product= 列出/筛选条目（q 触发 FTS；结果按权限过滤；view.* 传 viewContext 裁剪正文/摘要）
POST   /api/knowledge/entries                        创建条目（含首版本、密级、标签）
GET    /api/knowledge/entries/:id?view.version=&view.audience=  读取条目（默认 current 正文；带 view.* 时返回按条件块裁剪后的正文）
PATCH  /api/knowledge/entries/:id                    改元数据（标题/标签/密级/metadata）
DELETE /api/knowledge/entries/:id                    归档/删除

POST   /api/knowledge/entries/:id/revisions          追加新版本（写时复制）
GET    /api/knowledge/entries/:id/revisions          版本历史
GET    /api/knowledge/revisions/:revId?raw=1          读取指定版本（raw=1 取未裁剪原文，供编辑/管理；默认按 view 裁剪）

# 条目链接（知识图谱 + 内容级内联，见 3.7/3.8；两端按权限过滤）
GET    /api/knowledge/entries/:id/links?direction=out|in|both&scope=entry|inline|all  列出链接（含反向引用）
POST   /api/knowledge/entries/:id/links               新建条目级链接 { toEntryId, linkType, label?, toRevisionId? }（scope=entry）
DELETE /api/knowledge/links/:linkId                   删除链接（仅 scope=entry 可手动删；inline 由正文解析维护）
GET    /api/knowledge/revisions/:revId/inline-links    某版本正文的内联链接（anchorKey/偏移，供渲染高亮跳转）
GET    /api/knowledge/entries/:id/graph?depth=2&linkTypes=&scope=  受限图遍历（防环 + 权限过滤）

GET    /api/knowledge/search?scope=&q=&tags=&limit=&view.version=  全文 + 标签检索（按权限过滤；view.* 裁剪命中摘要）
GET    /api/knowledge/tags?collectionId=              标签列表（标注 controlled）
GET    /api/knowledge/levels                          密级阶梯定义

# 授权管理（仅 owner/admin 可操作）
GET    /api/knowledge/grants?scope=&principal=         列出授权（clearance + tag）
POST   /api/knowledge/grants                           授予 clearance 或 tag
DELETE /api/knowledge/grants/:id                       撤销授权
```

> 开放 API（API token 鉴权、外部读写）见 `OPEN_API.md`；本文件只定义资源本身与内部（JWT）接口。两者复用同一 `knowledgeService`。

### 4.3 校验 `server/lib/validators/`

`validators` 是按资源拆分的目录（如 `validators/narrators.ts`，统一从 `validators/index.ts` 汇出）。新增 `validators/knowledge.ts`，定义 `createKnowledgeCollectionSchema`（含 `viewDimensions`（`ViewDimension[]`，校验 `type`/`compare`/`enum values` 自洽，见 3.9.1）、`missingKeyPolicy`）/ `updateKnowledgeCollectionSchema` / `createKnowledgeEntrySchema`（含 `classificationLevel`、`tags`）/ `updateKnowledgeEntrySchema` / `addKnowledgeRevisionSchema`（`content` 正文，内联链接与条件块在服务层从 content 解析、无需单独校验）/ `knowledgeSearchQuerySchema` / `createKnowledgeGrantSchema`（`grantType` + `clearanceLevel`/`tagId`）/ `upsertKnowledgeLevelSchema` / `createKnowledgeLinkSchema`（**仅条目级 scope=entry**：`toEntryId` + `linkType` enum + 可选 `label`/`toRevisionId`，并校验 `fromEntryId != toEntryId` 防自链；inline 链接不经此端点，由正文解析生成）/ `knowledgeGraphQuerySchema`（`depth` 用 `z.coerce.number()` 且设上限）/ `viewContextSchema`（把 `view.*` 查询参数解析为 `Record<string,string>` 的 viewContext，供 entries/search 复用，见 3.9；具体维度合法性在服务层对照集合 `viewDimensions` 校验，schema 层只做基础形状），沿用现有约定，并在 `index.ts` 汇出。

---

## 5. 关键词自动注入（检索增强）

让叙述者在对话中"自动"用上相关知识，而不必显式调 `Skill`。

### 5.1 机制

```
用户消息 / 任务描述
   │
   ▼
resolveKeywords(principal, scope, text)
   │   ① 在 entry.keywords + tags 里做匹配（精确/包含）
   │   ② 命中的 entry 取 current revision 摘要
   ▼
按双轴权限（第 6 节：密级 clearance + 受控标签 grant）过滤命中结果
   ▼
将命中的知识摘要 + 引用（entryId@version）注入叙述者上下文
```

- **命中来源**：`knowledge_entries.keywordsJson` 显式关键词 + 标签名；可选叠加 FTS 召回。
- **注入形式**：作为 system/context 片段注入，附 `entryId@version` 引用，便于追溯与"按需展开全文"。
- **与 skills 对照**：skills 的 `Skill` 工具是"模型主动按 name 加载"；知识库关键词注入是"系统按命中被动提供"。两者可并存。

### 5.2 注入策略（可配置）

放入 settings（`agent` 或新增 `knowledge` 段，沿用 `server/lib/settings/index.ts` 的接口扩展方式）：

- `maxInjectedEntries`：单轮最多注入条目数（防上下文膨胀）。
- `injectMode`：`summary`（默认，注入摘要+引用）| `off`（关闭自动注入，仅显式检索）。
- `minKeywordLen`：最短命中词长度（与 trigram ≥ 3 对齐）。
- `linkExpandDepth`：是否顺条目链接（3.7）扩展命中。`0`（默认）= 不扩展；`1` = 把命中条目经 `expands`/`related` 等链接带出的直接邻居一并作为候选。扩展邻居同样受 `maxInjectedEntries` 限额与双轴权限过滤（无权邻居不注入），并按链接类型加权排序（如 `expands` 优先于 `related`）。
- `viewContext`：注入前对命中条目正文按条件块裁剪（见 3.9）。当叙述者会话已知所服务的产品版本/受众（如经 `metadata` 或对话上下文得知客户用 1.16），注入的就是适配该版本的段落，避免把不适用版本的内容喂给模型。viewContext 仅影响裁剪，不影响权限（见 6.6）。

> UI/上下文中只呈现对用户有用的知识摘要与来源，不暴露内部匹配细节与评分。

---

## 6. 权限模型（分级 + 分 tag 双轴）

需求：知识库访问控制要**分级（密级 / 等级轴）+ 分 tag（受控标签 / 分区轴）**，两轴同时满足才放行。这同时覆盖"部分知识仅限部分用户发起的 agent 可调用"——把这些知识设较高密级或打上受控标签，只授权给特定 principal 即可。

### 6.1 双轴判定（dominates）

```
canRead(principal, entry):
  # 解析条目的两轴属性
  level      = entry.classificationLevel ?? collection.defaultLevel        # 等级轴
  ctrlTags   = entry 关联标签中 controlled=true 的集合                      # 分区轴

  # 解析 principal 的凭据（聚合其所有 grant）
  clearance  = max(rank of principal 的所有 clearance grant) or rank(public)
  grantedTags= principal 的所有 tag grant 的标签集合
  if principal 是 admin: 直接放行
  if principal 是该 entry/collection 的 owner: 直接放行

  # 两轴 AND
  levelOK = clearance >= rank(level)                  # ① 密级达标
  tagOK   = ctrlTags ⊆ grantedTags                    # ② 持有全部受控标签
  return levelOK AND tagOK

canWrite(principal, entry):
  canRead(...) AND (owner / admin / 命中范围内 canWrite=true 的 grant)
```

要点：
- **两轴是 AND**：密级够但缺受控标签 → 拒；持有标签但密级不够 → 拒。
- **受控标签是"全部满足"**：条目带多个受控标签时，principal 必须持有其中**每一个**（合取 compartment，最严格语义；如需"任一即可"可在集合级配置，留作实现选项）。
- **普通标签不参与**：只有 `controlled=true` 的标签进入 `ctrlTags`；普通标签仅用于筛选/注入。
- **public + 无受控标签** = 项目内任何 principal 可读（等价旧的 public 可见性）。

### 6.2 一个直观例子

```
条目 A：level=confidential，受控标签 = {product:M20, team:售后}
principal P：clearance=secret，grantedTags={product:M20}

判定：
  levelOK = rank(secret) >= rank(confidential)   → true
  tagOK   = {product:M20, team:售后} ⊆ {product:M20} → false（缺 team:售后）
  结果：拒绝（密级够，但分区不全）

给 P 增加 team:售后 的 tag grant 后 → tagOK=true → 放行
```

### 6.3 principal 身份来源

叙述者（narrator）检索时需要知道"它代表谁"，凭据据此聚合：

- **JWT 发起**（交互式）：principal = 当前登录用户（user + role）。
- **程序化发起**（开放 API）：principal = **API token 绑定的用户**（owner_user）+ 其角色；narrator 的 `metadata` 可携带额外的会话级标注，但**授权只认绑定用户的 grant**，metadata 不能自行提权（见 `OPEN_API.md`）。

检索调用统一传 `principalContext = { userId, role, source: "jwt" | "api_token" }`，由 `knowledgeService` 聚合其 clearance 与 grantedTags 后按 6.1 裁决。

### 6.4 命中过滤发生在返回/注入之前

- 检索（FTS / tag / metadata）先召回候选，再按 6.1 逐条 `canRead` 过滤，**未通过的条目既不返回也不计数**，避免通过结果数量/标题泄露存在性（侧信道）。
- 关键词自动注入（第 5 节）同样在注入前过滤：principal 看不到无权访问的条目摘要。
- 受控标签本身的存在（如"有个 team:售后 分区"）不向无权 principal 暴露。

### 6.5 条目链接的权限处理

条目链接（3.7）可能指向 principal 无权访问的条目，遍历时必须按双轴权限处理：

- **链接两端都过 `canRead`**：`listLinks` / `getGraph` 返回前，对每条链接的 `from` 和 `to` 两端都做 `canRead`；任一端无权，该链接整体**不返回**（既不暴露目标条目，也不暴露"存在这样一条链接"）。
- **建链需要两端可读 + 源可写**：`addLink` 要求 principal 对 `fromEntryId` 有 `canWrite`、对 `toEntryId` 有 `canRead`——不能把无权看到的条目链接进来，也不能凭链接把高密级目标"暴露"给低权限读者。
- **图遍历有界**：`getGraph` 设深度上限 + `visited` 集合防环；权限过滤在每一跳进行，无权的条目直接作为遍历边界截断（不继续展开其邻居）。
- **内联链接同理**：正文渲染时，`scope=inline` 链接指向无权目标的，内联标记**降级为纯文本**（保留 anchorText，但不渲染为可跳转、不显示目标标题），既保正文可读又不泄露目标存在性。
- **不经链接提权**：链接不改变目标条目的密级/受控标签判定；顺链接到达的条目仍按其自身两轴属性裁决。

> 即"链接不是后门"：能否看到被链接的条目，永远由该条目自身的密级 + 受控标签决定，与是否存在指向它的链接无关。

> 设计取舍：授权按"轴"（密级 + 受控标签）而非"逐条目"维护，运维成本低且语义清晰——给一个售后账号授 `confidential` clearance + `team:售后` 标签，它就自动获得所有"≤confidential 且仅含已授标签"的条目访问权，新增条目无需再配权限。

### 6.6 条件内容块（block）不是安全边界

条件块（3.9）按 `viewContext` 裁剪正文，与访问控制是**两件正交的事**，绝不能混用：

| | 访问控制（第 6 章 ACL） | 条件块裁剪（3.9 block） |
|---|---|---|
| 目的 | 谁**有权**读这条知识 | 同一条知识给不同**上下文**展示哪些段落 |
| 依据 | principal 的 clearance + 受控标签授权（**可信、服务端裁决**） | viewContext（version/product/audience，**调用方提供、不可信**） |
| 失败后果 | 越权读取 = 安全事故 | 看到了不适用版本的段落 = 信息不准，但非越权 |

**强制执行顺序：先 ACL，后裁剪。**

```
1. canRead(principal, entry)  —— 不通过直接拒，连存在性都不暴露（6.4）
2. 通过后，取 current revision 正文
3. renderContent(正文, viewContext, 配置)  —— 按条件块裁剪展示
```

铁律：

- **不得用 block 承载机密**。"仅工程师可见的内部细节"若属于**安全敏感**，必须用密级/受控标签（把该内容拆成独立的高密级条目或受控标签条目），**而不是**写成 `::: when audience=="engineer"` 的块——因为 viewContext 由调用方传入、可伪造，block 只决定"展示与否"，挡不住有权读条目者拿到原文。
- **viewContext 不能提权**：它只影响裁剪，不参与 `canRead`/`canWrite` 判定；传任何 view 值都不会让 principal 看到本无权访问的条目。
- **原文获取受控**：`?raw=1`（取未裁剪原文，供编辑/管理）同样先过 ACL，且建议要求对该条目有写权限或管理角色——避免普通读者绕过裁剪拿到其它版本/受众段落。
- **审计**：block 裁剪不计入安全审计（它不是授权决策）；ACL 判定才记审计。

---

## 6.7 个人版本 → 提交 → 审核 → 合入（已实现）

> 本章描述**已落地**的协作写入链路。它是 1.2 节"写时复制 + 版本管理"在多用户下的具体形态：全局条目（main）始终是评审后的结果，个人可以自由编辑自己的副本，两者通过"发布请求（submission）"衔接。
>
> 相关实现：`server/services/knowledge-branch-service.ts`、表 `knowledge_drafts` / `knowledge_submissions`、路由 `server/routes/knowledge.ts`、agent 工具 `KnowledgeEdit` / `KnowledgeReview`。

### 6.7.1 个人条目（personal entry）的两种形态

个人条目存在 `knowledge_drafts`（表名保留了早期"draft"命名，实体语义是"我的个人版本"）：

| 形态 | `entryId` | `baseRevisionId` | 标题/目标集合 | 发布语义 |
|------|-----------|------------------|---------------|----------|
| **linked（关联）** | 指向全局条目 | fork 时的 main 版本，作为三方合并基准 | 继承全局条目 | 合并进已有条目，产生新 revision |
| **standalone（独立）** | NULL | NULL | 自带 `title` + `targetCollectionId`（发布前必填） | 批准时**新建**全局条目 |

- linked 条目由 `createDraft(entryId)` 创建，**幂等**：同一用户对同一条目已有 active 副本时返回原副本。
- standalone 条目由 `createStandalone()` 创建，**不做幂等**（同名可重复创建，属已知取舍）。
- 个人条目自身只有 `active` / `archived` 两态；发布请求的生命周期完全在 `knowledge_submissions` 上，两者正交。
- 个人版本参与**搜索遮蔽**：检索时（`draftUserId`）自己的 active 副本会遮蔽全局版本，命中标记 `(personal)`，落后时标记 `(personal ⚠ behind main)`。

### 6.7.2 drift 与 rebase

**drift（漂移）** ⟺ `draft.baseRevisionId !== entry.currentRevisionId`，即自你 fork 之后 main 又前进了。

- 单条检测 `getDraftDrift(entryId)` 返回 `drifted` / `versionsBehind` 与三方内容（base / current / draft），供渲染 diff。
- 批量检测 `findDriftedDraftIds(rows)` 一次查询判定一页，`GET /personal-entries` 用它给每行回填 `drifted`，避免逐条调用 drift 接口（那会返回 N×3 份正文）。
- **rebase 策略**：`merge`（默认，三方合并；冲突则返回双方内容且**不写入**）、`theirs`（放弃本地改动、直接采用 main，永不冲突）。
- rebase 成功会把 `pending` 提交置为 `superseded`（提案内容已变），但**不动 `conflict` 提交**（见 6.7.4）。
- **提交时会检测 drift**：`submitForReview` 若发现基线过时，仍然提交成功，但在返回值上附 `driftWarning: { versionsBehind, baseRevisionId, currentRevisionId }`。设计取舍：不硬失败（过时基线多数可合并，硬失败会卡住 rebase 冲突的作者），但必须**当场告知作者**——否则冲突要等审核者点批准时才暴露，那时唯一知道改动意图的人已不在场。

### 6.7.3 submission 状态机

```
                    submitForReview
                          │
                          ▼
                     ┌─────────┐   review(approve) 且三方合并成功
                     │ pending │ ─────────────────────────────▶ approved（终态，已合入 main）
                     └─────────┘
                       │  │  │  │
     review(approve)   │  │  │  └── updateDraft / rebaseDraft ──▶ superseded（终态，非审核结论）
     但合并失败         │  │  │
                       ▼  │  └───── withdrawSubmission ────────▶ withdrawn（终态）
                  ┌──────────┐
                  │ conflict │ ── resolveConflict（审核者给出合并内容）──▶ approved
                  └──────────┘ ── withdrawSubmission ─────────────────▶ withdrawn
                       │
     review(request_changes)
                       ▼
            ┌───────────────────┐ ── resubmit ──▶（新的 pending，带 round + previousSubmissionId）
            │ changes_requested │ ── withdrawSubmission ──▶ withdrawn（作者决定放弃）
            └───────────────────┘

     review(reject) ──▶ rejected（终态；不接 resubmit，个人条目保留可另起新提交）
```

**verdict 与 status 的对应**：

| verdict | 结果 status | 是否可再提交 | 语义 |
|---------|-------------|--------------|------|
| `approve` | `approved`（或合并失败 → `conflict`） | — | 合并/发布进 main |
| `request_changes` | `changes_requested` | ✅ `resubmit` | 退回作者，期待修改后再来 |
| `reject` | `rejected` | ❌ **终态** | 彻底拒绝该请求；**这正是它与 `request_changes` 的区别** |
| `comment_only` | 不变 | — | 只记录审核意见，不改变状态 |

**非审核结论的两种关闭**（不写 `verdict`，避免在作者的历史里显示成"被审核者拒绝"）：

- `superseded` — 作者编辑/rebase 了个人条目，提案内容已不再描述任何东西（自动）。
- `withdrawn` — 作者主动撤回，或作者删除了个人条目而顺带关闭（`CLOSED_ON_DELETE_STATUSES`）。

**可撤回状态**：`pending` / `conflict` / `changes_requested`。把 `changes_requested` 纳入是因为它的唯一出口原本只有 `resubmit`——决定不改的作者会让请求永远挂在双方列表里。

**删除个人条目时**会关闭上述三种未合入状态的提交（置 `withdrawn`）。注意 `changes_requested` 的关闭**保留** reviewer 的 `verdict` 与 reviewer id：审核者确实要求过修改，"要求修改后作者retire了条目"才是准确的历史，只有 status 反映是谁关闭的。

### 6.7.4 冲突（conflict）的处理边界

- **产生**：`approve` 时以 `sub.baseRevisionId` 为基准做三方合并（`createPatch` + `applyPatch`），patch 无法应用 → 转 `conflict`。若基准恰好等于当前 main，走快速路径直接采用提案。
- **谁能解**：只有**审核者**（`resolveConflict` 提供最终合并正文）。作者本人被拒绝（admin 例外）。
- **为何编辑不自动关闭 conflict**：`SUPERSEDABLE_STATUSES` 刻意只含 `pending`。冲突意味着 main 与提案真实分歧、需要人来决定合并结果，编辑就静默丢弃它会**隐藏未解决的分歧**。
- **作者的出路**：撤回 → rebase → 重新编辑 → 重新提交。（`submitForReview` 遇到已有 conflict 提交时会在报错里指明这条路径。）

### 6.7.5 审核授权

`canReview(caps, entry)` 三条路径任一即可：

1. **admin** — 短路放行。
2. **entry owner** — 短路放行（这是第三条轴，`getMyReviewScope` 会以 `ownedEntryCount` 报告它）。
3. **持有条目的全部 review tag** — `entry.reviewTagsJson ⊆ caps.reviewTagIds`（合取，与受控标签同样是"全部满足"）。

标准链路的完整判定：

- **linked 提交** → 目标条目的集合可读（`canReadCollection`）**且** `canReview(entry)`。
- **standalone 提交** → 目标集合可读**且**可写（`canWriteCollection`）——因为批准会在该集合里新建条目。
- **禁止自审**：`sub.submitterUserId === principal.userId` 一律拒绝（admin 例外）。`listSubmissions` 与 `countReviewInbox` 都据此排除自己的提交，所以作者要看自己的发布进度只能走 `listSubmissionsForDraft` / `listMyOpenSubmissions`。

> ⚠️ **`reviewTags` 为空是 fail-closed**：条目没有任何 review tag 时 `canReview` 返回 false，即**只有 owner 与 admin 能审**。这是有意的安全默认（不设标签不等于人人可审），但对管理员不直观——前端 `EntryAclPanel` 会在 reviewTags 为空时给出提示。

### 6.7.6 通知

事件在**事务提交之后**发出（`at most once`：提交后进程崩溃会丢通知，对非关键提醒可接受），经 `knowledge-notify.ts` 转成按用户的 WS 推送。

铁律：**推送只带 id，不带标题/正文**，客户端再走 ACL 检查过的 HTTP 端点回取。所以推送本身永远不可能把高密级条目泄露给无权用户。

| 事件 | 通知对象 | 触发 |
|------|----------|------|
| `submission_created` | 候选审核者（排除提交者） | 提交发布请求 |
| `submission_reviewed` | 提交者 + 候选审核者 | 任一 verdict |
| `submission_invalidated` | 提交者 + 候选审核者 | superseded / withdrawn / 条目被删 |
| `entry_published` | 提交者 | 批准并合入 |
| `entry_drifted` | 持有该条目个人版本的**其他**用户 | 任何 main 写入（直接改 revision、批准发布、解决冲突） |
| `acl_changed` | 授权发生变化的用户 | grant 增删、批量授权、`setUserAcl` |
| `owner_transferred` | 原 owner + 新 owner | 条目/集合所有权转移 |

后三类走 `knowledge:library_changed`（读者视角的变化，与审核队列无关）；前四类走 `knowledge:review_inbox_changed`。drift 与 ACL 的通知都有**上限**（各 200 用户），避免一次写入引发无界扇出。

### 6.7.7 ACL 审计

所有**授权变更**写入 append-only 的 `knowledge_acl_events`（`server/services/knowledge-audit.ts`），回答"谁在何时给谁授了什么权"：

- 事件类型：`grant_added` / `grant_removed` / `grants_bulk_added` / `user_acl_replaced` / `entry_acl_updated` / `collection_acl_updated` / `entry_owner_transferred` / `collection_owner_transferred`。
- 记录 actor（谁操作）+ subject（谁的权限变了）+ target（在什么对象上）+ `detailJson`。
- **`detailJson` 按构造脱敏**：只存密级**名**、tag **id**、布尔标记与 before/after 快照，**绝不存条目标题或正文**——否则审计日志本身会变成绕过 ACL 读内容的通道。
- 无外键：审计行必须在其描述的 user/entry/collection 被删除后继续存在。
- 写入是 fire-and-forget 且吞掉异常：磁盘写满不应把一次授权编辑变成 500。取舍是显式的——**审计缺一条 优于 破坏 ACL 操作本身**。
- 读取 `GET /api/knowledge/acl-events`（**仅 admin**，keyset 分页，无 OFFSET/COUNT(*)）。日志本身含密级与分区信息，所以它自己也是安全敏感资源。
- 一次批量授权只写**一行**（列出受影响用户），而不是 N 行——否则真正的管理动作会被噪声淹没。

> 注意：`block` 裁剪（3.9）不进审计，它不是授权决策（见 6.6）。

---

## 7. 与 skills 的关系

| 维度 | skills（现有） | 知识库（新增） |
|------|---------------|---------------|
| 载体 | `.claude/skills/<name>/SKILL.md` + 文件 | DB 表（entry/revision/tag/level/grant/link） |
| 加载 | `Skill` 工具按 name 主动加载 | 关键词注入被动命中 + 检索 API 主动查 |
| 结构化检索 | 否（仅按 name） | 是（FTS5 + tag + metadata） |
| 条目关系 | 无（各 skill 独立） | 有向带类型的条目链接，构成知识图谱（3.7） |
| 内容适配 | 无（整文件加载） | 条件内容块按 viewContext（产品版本/受众）裁剪同一条目（3.9，**设计未实现**） |
| 版本管理 | 靠 git | 写时复制 revision |
| 权限 | 跟随项目文件可见性 | 分级（密级）+ 分 tag（受控标签）双轴授权 |
| 适合 | 工具型/操作型知识 | 资料型/可检索/可互联知识 |
| 互通 | 知识 entry 可引用某 skill；skill 文档可登记为 entry | 同 |

二者不互斥：一个项目可以同时有 skills（操作手册 + 脚本）和知识库条目（错误码表、FAQ、历史案例）。

---

## 8. 迁移与落地步骤（历史设计步骤）

> 本节是设计期的落地清单。表结构与服务此后继续扩容（现有 14 张 `knowledge_*` 表，含 drafts/submissions/links/injection/audit/packs 等）。下列步骤中涉及 3.8/3.9 的部分**尚未实现**，其余已落地。

沿用 CLAUDE.md 的数据库迁移规则（改 `schema.ts` → `bun run db:generate` → `bun run db:migrate`，**禁止手改 drizzle/**）：

1. `schema.ts` 新增核心表：collections / entries / revisions / levels / tags / entry_tags / grants / entry_links（后续另增 drafts、submissions、tag_types、acl_events、injection_events、packs 等）。`entry_links` 当前仅条目级（无 scope 列）；复合主键表（entry_tags）需 import `primaryKey`（见 3.5 注）。
2. `bun run db:generate` 生成迁移；可附种子脚本写入默认密级（public/internal/confidential/secret）。
3. `server/db/fts.ts` 追加 `knowledge_entries_fts` 虚拟表 + 触发器 + rebuild（加入检测列表）。
4. `validators/knowledge.ts` 增 Zod schema 并在 `validators/index.ts` 汇出。
5. `server/services/knowledge-service.ts` 实现（含双轴 `canRead`/`canWrite` + grant 聚合 + 条目级链接 CRUD/图遍历的权限过滤 + ~~`addRevision` 内的正文内联解析与 inline 链接重建 + 对照集合 `viewDimensions` 的条件块校验/warnings + `renderContent` 条件块裁剪~~（**3.8/3.9，未实现**））。
6. `server/routes/knowledge.ts` + `app.route` 挂载（JWT 内部接口，含 grants/levels/links 管理端点）。
7. 前端：知识库管理页（集合/条目/标签筛选/版本历史/编辑 + 密级标记 + 受控标签 + 授权管理 + 条目链接与反向引用/图视图）——按 frontend 现有 Mantine + TanStack 模式。~~正文内联引用编辑辅助、条件块编辑/预览~~（**3.8/3.9，未实现**）。
8. 开放 API 部分见 `OPEN_API.md`。

---

## 9. 首批消费场景示例（仅说明，不进通用设计）

机器人远程诊断（见 `robot_assistant_next/docs/remote_diagnosis/`）可这样用知识库：

- 建集合"机器人诊断经验"，把 error-codes、FAQ、历史案例作为 entry 导入，普通 tag 按产品/模块/严重性分类。
- 诊断叙述者在分析日志时，命中错误码关键词 → 自动注入对应 entry 摘要。
- **按客户产品版本裁剪**：同一条"充电流程"知识用条件块写多版本差异（`::: when version < 1.18 ... :::`）；客户用旧版本时，会话带 `viewContext={ version: "1.16", product: "M20" }`，注入/展示的就是该版本对应的描述，无需为每个版本拆条目。
- 敏感案例设较高密级（如 `confidential`）并打受控标签（如 `team:售后`）；只给售后/研发账号授对应 clearance + 标签 grant，其发起的 agent 才能检索到，其余 agent 连存在性都看不到。

> 再次强调：以上是消费示例。知识库表/接口本身不含任何"诊断""机器人"等领域字段，领域信息一律走 `metadataJson`、tag 与条件块的 view key；密级阶梯、受控标签、版本 key 都由部署方自定义。
>
> 注意：上面示例中的**条件块按版本裁剪目前不可用**（见 3.9 的未实现标注）。现阶段多版本差异只能拆条目或拆集合。

---

## 10. 已知待办（未立项）

本节记录已确认存在、但**不在当前修复范围**的缺口，避免被重复"发现"。除已在 3.8 / 3.9 顶部标注的两项未实现特性外：

### 10.1 知识包（knowledge packs）无前端界面

`server/routes/knowledge-packs.ts` 的 9 个端点前端**零调用**。目前只能通过：

- HTTP API 直接调用，或
- agent 可选工具 `PackList` / `PackActivate` / `PackDeactivate`（需 `/load` 显式加载）。

性质：**功能缺口**，不是流程断点——导入/激活/停用链路本身是通的，agent 侧可用。要补的是管理界面（包列表、导入上传、激活状态与冲突提示）。

### 10.2 archived personal entry（draft）无清理策略

个人条目发布成功或被删除后置为 `archived` 并**永久保留**，没有过期、归档压缩或清理机制，长期堆积。

阻塞原因：**需要保留策略决策**，不能由实现方替用户定。至少要定：

- 保留期（永久 / N 天 / 仅保留最近 N 条）；
- 是否区分"发布成功后归档"（有全局对应物，可安全丢弃正文）与"作者主动删除"（可能是唯一副本）；
- 清理是硬删除还是只清正文保留元数据（`knowledge_submissions.draftId` 有 FK cascade，硬删会连带删除发布历史 —— 审计影响需确认）。

定了策略后再实现后台清理 job（不得放主线程业务路径，见 CLAUDE.md 主线程性能规则）。

### 10.3 审核状态机的其余边界

完整状态机见 **6.7.3**。已闭环：`withdrawn`（作者撤回，覆盖 `pending`/`conflict`/`changes_requested`）、`superseded`（编辑取代，非审核结论）、`changes_requested → resubmit`（带 `round` / `previousSubmissionId`）、`reject → rejected`（终态，不接 resubmit）、`rebase?strategy=theirs`（放弃本地改动）、提交时的 drift 警告。

仍未做（有意保留的取舍）：`conflict` 提交只能由**审核者** `resolve` 提供合并内容，作者无法自己就地编辑合并结果后交还 —— 作者当前的可行路径是撤回 + rebase + 重新提交（`submitForReview` 的报错会指明这条路）。要让作者直接解冲突，需要新增"作者提交合并结果、审核者仅确认"的中间态，属独立立项。

### 10.4 知识库前端的其余缺口

- **知识图谱无可视化**：`useEntryGraph` hook 与 `GET /entries/:id/graph` 都已就绪，缺 React Flow 之类的图视图组件。
- **条目筛选**：`GET /entries` 支持 `tag`，但前端无标签筛选控件；按密级筛选前后端都没有。
- **ACL 审计无界面**：`GET /api/knowledge/acl-events`（6.7.7）目前只有 API，没有管理页。
- **知识库事件尚未进站内通知中心**：平台已有应用内通知中心（`notifications` 表 + NotificationBell/Drawer），但知识库通知仍走 WS 推送 + React Query 失效（6.7.6），未写入通知中心的未读列表。`notification-service` 另有钉钉/飞书 webhook。要把知识库审核/发布等事件接入通知中心，需先解决"通知带不带标题"的矛盾：带则可能泄露密级，不带则通知可读性差。
