# Pack（资源包）设计

状态：设计草案（待审核）
适用范围：NarraFork 通用平台能力，配合知识库使用

> Pack 是一个**压缩包资源**，内含数据、媒体、脚本、可执行文件等。使用时解压到临时目录、把该目录授予 agent 访问白名单，用于配合知识库执行**固定流程操作**。与知识库 entry 关联的 pack 继承该条目的双轴 ACL。

---

## 1. 动机与定位

知识库目前只承载**文本知识**（markdown 正文 + 版本 + 草稿/评审）。但很多"固定流程操作"需要的不只是文字说明，还需要**配套的数据和可执行物**：诊断脚本、参数模板、固件镜像、校验工具、样例数据集等。

Pack 补上这一层：把"一套流程所需的文件 + 脚本"打包成一个可分发、可版本化、可授权的资源，agent 用的时候解压到隔离目录、获得访问权、按知识库里的流程说明执行。

### Pack vs Skill vs 知识库 entry

| 维度 | 知识库 entry | Skill | **Pack** |
|------|-------------|-------|---------|
| 载体 | DB 正文（markdown） | `SKILL.md` + ≤20 伴随文件 | **压缩包（任意文件/二进制/可执行）** |
| 给 agent 的内容 | 检索/读取文本 | 指令文本 + 文件路径 | **解压目录 + 目录访问白名单** |
| 是否执行 | 否 | 否（仅注入提示） | **是（运行流程脚本）** |
| 是否授权目录 | 否 | 否 | **是（注册 whitelistDir）** |
| 存储 | `knowledge_*` 表 | `<base>/.narrafork/skills/` | `knowledge_packs` 表 + 落盘归档 |
| 生命周期 | 持久 | 持久 | 归档持久；**解压实例临时（绑叙述者）** |
| 权限 | 双轴 ACL | 跟随项目文件 | **关联 entry 时继承其双轴 ACL** |

三者互补：**entry 说"怎么做"（流程/知识），pack 提供"用什么做"（数据+脚本+可执行环境），skill 是轻量的纯指令型知识。**

---

## 2. 核心流程

```
① 上传/创建 pack（管理操作）
   压缩包 → 校验大小/类型 → 落盘 ~/.narrafork/pack-archives/<packId>.<ext>
          → 计算 hash、记录元数据到 knowledge_packs 表
          → 可选：关联到某个 knowledge entry（继承其 ACL）

② agent 发现 pack（PackList 工具）
   按当前用户(triggering user)的双轴 ACL 过滤 → 列出可用 pack（id/名称/描述/大小/关联 entry）

③ agent 激活 pack（PackActivate 工具）
   ACL 校验（关联 entry 时按 entry，否则按 pack 自身）
   → 解压到 ~/.narrafork/packs/<narratorId>/<packId>/
   → 往 narrator_whitelist_dirs 插一行 { path: <解压目录>, accessLevel: readWrite }
   → 返回：解压目录绝对路径 + 文件清单 + PACK.md（若有）说明
   下一次工具调用起，Read/Write/Edit/bash 对该目录自动放行（实时读 DB，无需重启会话）

④ agent 执行流程
   按知识库 entry 里的说明操作目录里的文件
   脚本执行（./x.sh）因 isPathExecution 仍触发用户审批 ← 安全闸门保留

⑤ 清理（PackDeactivate 工具 / 叙述者结束 / 启动清理）
   删除解压目录 + 移除对应 whitelist 行
```

### 2.1 安全模型（关键）

调研结论：NarraFork 的"沙箱"是**权限决策层**，不是文件系统层。文件工具（Read/Write/Edit）本身无路径边界，真正的拦截在 `narrator-permission.ts`。Pack 据此设计：

- **目录访问**：解压目录注册为 `narrator_whitelist_dirs`（`accessLevel: readWrite`）。这让文件工具与"白名单安全"的 bash 命令对该目录的读写**自动放行**（`resolveWhitelistDecision`），无需改任何工具代码。
- **脚本执行仍审批**：`./setup.sh`、`bash script.sh` 等路径执行命中 `bash-analyze.ts` 的 `isPathExecution` → 产生 `dangerousPatterns` → 即使目录在白名单内，bash 分支仍返回 `ask`。**这是有意保留的安全闸门**：pack 作者不能凭"上传一个 pack"就获得在用户机器上静默执行代码的能力，每个脚本执行都要用户点头。
- **不提权**：whitelist 只放宽"目录访问"，blacklist 与 catastrophic 命令检测优先级更高，仍然生效。pack 解压目录的 whitelist 是 `readWrite` 而非 `full`（`full` 才放宽更多 bash 写操作）。
- **解压防护**：tar.gz 用 `safeSpawn` 调系统 tar（带超时 + 输出上限 + 进程树清理）；zip 走进程内 `server/lib/zip-archive.ts`（`node:zlib`，Windows 无 `unzip` 命令）。两者都防 zip-slip（解压路径逃逸校验，见 4.2）。

---

## 3. 数据库 Schema

新增 `server/db/schema.ts`，沿用现有风格（nanoid id + ISO 时间戳 + `{ mode: "json"/"boolean" }`）。

### 3.1 knowledge_packs（pack 一等资源）

```typescript
export const knowledgePacks = sqliteTable(
	"knowledge_packs",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),

		// 归属：项目级（projectId 非空）或全局（null），与 knowledge_collections 一致
		projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),

		// 可选关联到某 knowledge entry：关联后 pack 的访问/激活 ACL 继承该 entry 的双轴属性
		// （classificationLevel + controlledTags）。null = 用 pack 自身的 ACL 字段。
		entryId: text("entry_id").references(() => knowledgeEntries.id, { onDelete: "set null" }),

		// === pack 自身 ACL（仅 entryId 为 null 时生效；语义同 knowledge_entries 的对应字段）===
		classificationLevel: text("classification_level"), // null = public
		controlledTagsJson: text("controlled_tags_json", { mode: "json" }),
		ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),

		// === 归档文件元数据 ===
		archiveFormat: text("archive_format", { enum: ["tar.gz", "zip"] }).notNull(),
		// 落盘文件名（= <id>.<ext>，存在 ~/.narrafork/pack-archives/）。路径由服务层拼，不存绝对路径。
		archiveSize: integer("archive_size").notNull(),
		archiveHash: text("archive_hash").notNull(), // sha256，用于校验/去重/缓存解压
		// 解压后总大小上限校验用（防 zip bomb）；上传时探测，null = 未知
		uncompressedSize: integer("uncompressed_size"),

		// PACK.md（可选）的正文：激活时连同文件清单返回给 agent，作为使用说明
		manifestJson: text("manifest_json", { mode: "json" }), // { entrypoint?, files?, notes? }

		status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("idx_kpack_project_slug").on(table.projectId, table.slug),
		index("idx_kpack_project").on(table.projectId),
		index("idx_kpack_entry").on(table.entryId),
		index("idx_kpack_status").on(table.status),
	],
);
```

### 3.2 knowledge_pack_activations（解压实例，绑叙述者）

记录"哪个叙述者激活了哪个 pack、解压在哪、对应哪条 whitelist"，用于幂等激活、清理和审计。

```typescript
export const knowledgePackActivations = sqliteTable(
	"knowledge_pack_activations",
	{
		id: text("id").primaryKey(),
		packId: text("pack_id")
			.notNull()
			.references(() => knowledgePacks.id, { onDelete: "cascade" }),
		narratorId: text("narrator_id")
			.notNull()
			.references(() => narrators.id, { onDelete: "cascade" }),
		// 解压目录（相对 ~/.narrafork/packs/ 的子路径或绝对路径，二选一，实现期定）
		extractDir: text("extract_dir").notNull(),
		// 对应插入的 narrator_whitelist_dirs.id，便于 deactivate 时精确移除
		whitelistDirId: text("whitelist_dir_id"),
		// 激活时所用归档 hash，校验解压目录是否仍对应当前归档（pack 更新后可提示重新激活）
		archiveHash: text("archive_hash").notNull(),
		status: text("status", { enum: ["active", "released"] }).notNull().default("active"),
		createdAt: text("created_at").notNull(),
		releasedAt: text("released_at"),
	},
	(table) => [
		index("idx_kpackact_narrator").on(table.narratorId),
		index("idx_kpackact_pack").on(table.packId),
		uniqueIndex("idx_kpackact_narrator_pack")
			.on(table.narratorId, table.packId)
			.where(sql`status = 'active'`), // 同一叙述者对同一 pack 至多一个 active 激活
	],
);
```

> `sql` 部分索引需从 `drizzle-orm` import `sql`（schema.ts 已在用，确认即可）。

### 3.3 落盘布局

| 用途 | 路径 | 清理 |
|------|------|------|
| pack 归档（持久） | `~/.narrafork/pack-archives/<packId>.<ext>` | 随 pack 删除而删 |
| 解压实例（临时） | `~/.narrafork/packs/<narratorId>/<packId>/` | deactivate / 叙述者结束 / 启动清理 |

放 `~/.narrafork/` 下而非 `os.tmpdir()`，与 shares/uploads/snapshots 一致，便于授权与清理可控。

---

## 4. 服务层

### 4.1 `server/services/knowledge-pack-service.ts`（CRUD + 归档）

```
knowledgePackService = {
  listPacks({ projectId, entryId }),          // 列出（不含解压）
  getPack(packId, { principal }),             // ACL 校验
  createPack({ name, projectId, entryId?, archive(File), acl?, authorUserId }),
                                              // 校验大小/类型 → 落盘归档 → 探测解压大小 → 入库
  updatePackMeta(packId, {...}, principal),   // 改 name/desc/关联 entry/ACL（不换归档）
  replaceArchive(packId, archive, principal), // 换归档（新 hash；已激活实例标记需重激活）
  deletePack(packId, principal),              // 删归档文件 + 表行（级联清激活记录）
  // ACL 解析：entryId 非空 → 取 entry 的双轴属性；否则用 pack 自身字段
  resolvePackAcl(pack): { level, controlledTags, ownerUserId },
  canActivate(principal, pack),               // 复用 knowledge-acl 的 canRead 语义
}
```

ACL 复用现有 `knowledge-acl.ts` 的 `resolvePrincipalCaps` + `canRead`（把 pack 的 level/controlledTags 包装成 `AclEntry` 形状传入），**不重复实现双轴逻辑**。

### 4.2 `server/services/knowledge-pack-activation-service.ts`（解压 + 授权 + 清理）

```
packActivationService = {
  activate(narratorId, packId, principal): { extractDir, files[], manifest },
  deactivate(narratorId, packId): void,
  listActive(narratorId): Activation[],
  cleanupNarrator(narratorId): void,        // 叙述者结束时调用
  cleanupStalePacks(): void,                // 启动清理（仿 shares.cleanupStaleShares）
}
```

**activate 流程**：
1. `canActivate` ACL 校验（拒绝 → NotFound 不泄露存在性）。
2. 幂等：已有 active 激活且 `archiveHash` 一致 → 直接返回现有目录（不重复解压）。
3. 解压：`extractDir = ~/.narrafork/packs/<narratorId>/<packId>/`，`mkdir -p`，然后
   - tar.gz：`safeSpawn` 调 `tar -xzf <archive> -C <extractDir>`，带 `timeout`、`maxOutputBytes`、`signal`（叙述者 abort）。
   - zip：进程内 `extractZipArchive()`（`server/lib/zip-archive.ts`），不依赖外部 `unzip`（Windows 没有该命令）；解压前先读中央目录校验条目名/大小/符号链接，逐条目流式解压并校验 CRC 与大小上限。
4. **zip-slip 防护**：解压后遍历校验所有文件路径都在 `extractDir` 内（`isInsidePath`），发现逃逸立即清理并报错。也校验解压总大小不超过上限（防 zip bomb）。
5. 注册 whitelist：往 `narrator_whitelist_dirs` 插 `{ narratorId, path: extractDir, accessLevel: "readWrite", enabled: true }`，记下行 id。
6. 写 `knowledge_pack_activations`。
7. 返回目录路径 + 文件清单（限制条数/深度，仿 skill 的 collectFiles）+ manifest 说明。

**deactivate / cleanup**：删 `extractDir`（`rmSync recursive`）+ 删对应 whitelist 行 + 激活记录置 `released`。

**安全约束（遵守 CLAUDE.md 主线程性能规则）**：
- 解压走 `safeSpawn` 子进程，不阻塞主线程；有超时 + 输出上限。
- 文件清单遍历有条数/深度上限。
- 大归档上传、hash 计算放流式或子进程，设硬上限（参考 shares `maxFileSizeMb`，pack 单独配 `settings.knowledge.packMaxSizeMb`）。

---

## 5. Agent 工具（新增 Pack 工具集）

新增 `server/lib/agent/tools/pack.ts`，三个工具，注册进工具表。仿 knowledge 工具用 `ctx.userId` 解析 principal、仿 skill 用动态 description 注入可用 pack 列表。

### 5.1 PackList
- 列出当前用户（triggering user）按 ACL 可见的 pack（id/名称/描述/大小/关联 entry/是否已激活）。
- scope 到 `ctx.projectId`（项目内 + 全局，跨项目隔离，仿 knowledge search）。

### 5.2 PackActivate
- 入参：`packId`。
- 调 `packActivationService.activate`。
- 返回：解压目录绝对路径 + 文件清单 + manifest 说明 + 提示"目录已加入可访问白名单；运行其中脚本仍需你审批"。
- **是否需要权限**：激活本身（解压+授权）建议走 `ctx.requestPermission`（类似 KnowledgeDraft 的受控写），因为它会改变叙述者的访问边界——让用户对"授予某目录访问权"有知情权。实现期可配置（默认需审批）。

### 5.3 PackDeactivate
- 入参：`packId`。释放目录 + 白名单。无需审批（收缩权限，安全方向）。

> 工具描述明确告知模型：pack 解压目录可读写，但**执行其中的脚本/可执行文件会单独请求用户批准**，引导模型在需要执行时向用户说明用途。

---

## 6. 路由 + 校验 + 前端

### 6.1 路由 `server/routes/knowledge-packs.ts`（或并入 knowledge.ts）

```
GET    /api/knowledge/packs?projectId=&entryId=     列出（按 ACL 过滤）
POST   /api/knowledge/packs                         创建（multipart 上传归档）
GET    /api/knowledge/packs/:id                     详情（ACL）
PATCH  /api/knowledge/packs/:id                     改元数据/关联/ACL
PUT    /api/knowledge/packs/:id/archive             替换归档（multipart）
DELETE /api/knowledge/packs/:id                     删除
GET    /api/knowledge/packs/:id/download            下载归档（ACL；人工取用）
# 激活管理（也可只走 agent 工具，UI 仅展示）
GET    /api/knowledge/packs/activations?narratorId= 查看某叙述者的激活
POST   /api/knowledge/packs/:id/deactivate          手动释放
```

ACL 管理端点（设 pack 自身的 level/controlledTags）仿 knowledge 的 `/entries/:id/acl`，admin/owner 限定。

### 6.2 校验 `server/lib/validators/knowledge-packs.ts`
`createPackSchema` / `updatePackSchema`（name/desc/projectId/entryId/acl）/ multipart 文件大小+类型校验（仅 tar.gz/zip）。汇出到 `validators/index.ts`。

### 6.3 前端
- 知识库管理页新增"Packs"区：列表/上传/编辑/关联 entry/删除/下载，仿现有 knowledge entry UI（Mantine + TanStack Query）。
- entry 详情页：展示关联的 pack 列表。
- i18n：en + zh-CN 同步加键。

---

## 7. 生命周期与清理（仿 shares）

- **启动清理** `cleanupStalePacks()`：清空 `~/.narrafork/packs/`（上次遗留的解压实例）+ 把所有 `knowledge_pack_activations.status` 置 `released`。注册到 `server/main.ts` 启动序列（仿 `cleanupStaleShares` 在 main.ts:937 的调用）。
  > 归档目录 `~/.narrafork/pack-archives/` **不清**（持久资源）。
- **叙述者结束**：在叙述者删除/归档路径调 `cleanupNarrator(narratorId)`（删该叙述者所有解压目录 + whitelist 行）。`narrator_whitelist_dirs` 有 `onDelete: cascade`，删叙述者时 DB 行自动清，但磁盘目录需显式删——挂到现有叙述者清理钩子。
- **数据库清理**：把 `knowledge_pack_activations` 加入 `database-cleanup-service.ts` 的孤儿清理列表（仿 `narrator_whitelist_dirs` 条目）。

---

## 8. 迁移与落地步骤（分两阶段）

沿用 CLAUDE.md 迁移规则（改 schema.ts → `bun run db:generate` → `bun run db:migrate`，禁止手改 drizzle/）。

**本次实现 Phase 1（后端，交付后 agent 即可用 pack）；Phase 2（前端 UI）待 Phase 1 验证后再做。**

### Phase 1 — 后端（本次范围）
1. `schema.ts` 新增 2 表：`knowledge_packs` + `knowledge_pack_activations`（部分唯一索引需 `sql`）。`relations.ts` 加关系（narrator ↔ activations、pack ↔ activations、pack ↔ entry）。
2. `bun run db:generate` + `bun run db:migrate`。
3. pack 归档落盘/读取 helper（大小上限、sha256 hash、格式校验：仅 tar.gz/zip）。
4. `server/services/knowledge-pack-service.ts`（CRUD + ACL，复用 `knowledge-acl` 的 canRead，不重复实现双轴）。
5. `server/services/knowledge-pack-activation-service.ts`（解压用 `safeSpawn` + zip-slip/zip-bomb 防护 + whitelist 注册 + 清理）。
6. `server/lib/agent/tools/pack.ts`（PackList/PackActivate/PackDeactivate），注册进工具表 + 接入可选工具机制（`enabledTools` 控制可见性，默认对 primary narrator 开放）。
7. `server/routes/knowledge-packs.ts` + `app.route` 挂载；`validators/knowledge-packs.ts` 并汇出。下载/上传走 multipart。
8. `cleanupStalePacks()` 注册到 main.ts；叙述者清理钩子接 `cleanupNarrator`；`database-cleanup-service.ts` 加 `knowledge_pack_activations` 表。
9. 设置项 `settings.knowledge.packMaxSizeMb`（默认 100）+ `packActivateRequiresPermission`（默认 true）。
10. 测试：ACL 过滤、zip-slip 防护、幂等激活、whitelist 注册/移除、三处清理。
11. 验证：`bunx @biomejs/biome check --write` + `bunx tsgo --noEmit` + `bun test` 相关用例。

### Phase 2 — 前端（后续，不在本次范围）
- 知识库管理页新增 "Packs" 区：列表/上传/编辑/关联 entry/删除/下载（Mantine + TanStack Query）。
- entry 详情页展示关联的 pack 列表。
- i18n：en + zh-CN 同步加键。
- Phase 1 期间可用 API（curl/REST）手动建 pack 验证后端闭环，不阻塞 agent 使用。

---

## 9. 关键设计决策（已与用户确认）

| 决策 | 选择 | 理由 |
|------|------|------|
| pack 存储形态 | 独立一等资源（`knowledge_packs`），可选关联 entry | 比"挂 entry 附件"更灵活；关联时继承 entry 双轴 ACL |
| 脚本执行授权 | 目录注册 whitelistDir（readWrite），脚本执行仍审批 | 安全优先：pack 作者不能静默获得代码执行权 |
| agent 接入 | 新增 Pack 工具集（List/Activate/Deactivate） | 显式、可控，激活会改访问边界，建议激活也需审批 |
| 生命周期 | 绑叙述者，`~/.narrafork/packs/<narratorId>/<packId>/`，启动清理 | 与 shares/uploads 一致，可控可清 |

---

## 10. 安全清单（实现时必须覆盖）

- [ ] **zip-slip**：解压后所有路径必须在 extractDir 内（`isInsidePath` 校验），逃逸即清理报错。
- [ ] **zip bomb**：解压总大小上限（uncompressedSize 探测 + 解压后复核）。
- [ ] **归档大小上限**：上传时 `packMaxSizeMb` 限制。
- [ ] **子进程**：解压走 `safeSpawn`，带 timeout + maxOutputBytes + signal + 进程树清理。
- [ ] **whitelist 是 readWrite 而非 full**：不放宽超出必要的 bash 写操作。
- [ ] **脚本执行审批保留**：不绕过 `isPathExecution` 的 ask 闸门。
- [ ] **ACL 不泄露存在性**：无权访问的 pack 一律 NotFound。
- [ ] **激活幂等**：同叙述者同 pack 不重复解压；archive hash 变化提示重激活。
- [ ] **清理完整**：deactivate/叙述者结束/启动 三处都清磁盘目录 + whitelist 行。
- [ ] **主线程性能**：归档 hash/解压/文件遍历不阻塞事件循环，均有上限。
