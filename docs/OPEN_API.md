# 开放 API（Open API）设计

状态：设计草案（未实现）
适用范围：NarraFork 通用能力

> 开放 API 让 **NarraFork 之外的程序**（脚本、移动 App、第三方系统）能以稳定的、可授权的方式驱动 NarraFork：创建并运行叙述者、读写知识库、订阅结果。它是 NarraFork 的**通用平台能力**，不针对任何单一业务。机器人远程诊断只是它的首批调用方之一——其需求（手机 App 远程发起一个诊断会话）正好对应"程序化创建带 metadata 的叙述者 + 拉取结果"，但 API 本身不含任何诊断语义。

---

## 1. 目标与边界

### 1.1 要解决什么

当前 NarraFork 的所有 `/api/*`（除 `/api/auth`、`/api/health`）只接受 **JWT**（`Authorization: Bearer <jwt>`，7 天有效期，见 `server/middleware/auth.ts`）。这适合浏览器内的人类用户，但不适合程序化、长期、可控权限的外部接入：

- JWT 短期、与登录态绑定，不适合后端服务长期持有。
- 无法对单个集成做最小权限授权与独立吊销。
- 没有面向外部的、稳定的"创建会话 / 提交输入 / 拉取产出"契约。

### 1.2 设计原则

1. **通用、领域无关**：API 词汇是"narrator / message / knowledge / metadata"，不是"诊断 / 机器人"。领域信息一律走 `metadata`。
2. **复用而非另起炉灶**：开放 API 复用现有 `narratorService` / `knowledgeService`，只增加**鉴权层**和**少量面向程序化场景的字段/端点**。
3. **最小权限 + 可吊销**：API token 绑定用户、限定 scope、可独立吊销、可设过期。
4. **程序化叙述者可标注**：经 API 创建的 narrator 带 `origin` 与自定义 `metadata`，便于区分、检索、授权与回调。
5. **不扩展 MCP**：本期不动 `/api/mcp`（它面向内部 agent 工具，且当前在 `requireAuth` 之后）。开放能力走 REST。
6. **沿用工程范式**：新增表用 Drizzle，鉴权用中间件，校验用 Zod，路由用 Hono。

### 1.3 明确不做（本期）

- 不做 OAuth/第三方登录。
- 不扩展或对外开放 MCP server。
- 不在通用层引入任何业务专有端点。

---

## 2. 鉴权：API Token

### 2.1 新增表 `api_tokens`

`server/db/schema.ts` 新增（沿用 nanoid id + ISO 时间戳 + `{mode:"json"}` 风格）：

```typescript
export const apiTokens = sqliteTable(
	"api_tokens",
	{
		id: text("id").primaryKey(), // nanoid，作为 token 的公开前缀/标识
		// 仅存哈希，绝不存明文（bcrypt/sha256，与 users.passwordHash 同思路）
		tokenHash: text("token_hash").notNull(),
		name: text("name").notNull(), // 人类可读用途说明
		// 归属用户：token 代表"以该用户身份"调用，权限继承该用户
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// 权限范围：JSON string[]，如 ["narrator:create","narrator:read","knowledge:read"]
		scopesJson: text("scopes_json", { mode: "json" }).notNull(),
		// 可选：限定可操作的项目（JSON string[]，空=不限）
		projectScopeJson: text("project_scope_json", { mode: "json" }),
		lastUsedAt: text("last_used_at"),
		expiresAt: text("expires_at"), // 可空=不过期
		revokedAt: text("revoked_at"), // 非空=已吊销
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_apitokens_user").on(table.userId),
	],
);
```

### 2.2 Token 形态

- 明文形如 `nf_<tokenId>_<secret>`：`tokenId` 用于 O(1) 定位记录，`secret` 校验哈希。
- **只在创建时返回一次明文**，之后只存 `tokenHash`。
- 传递：`Authorization: Bearer nf_...`（与 JWT 同头，靠前缀 `nf_` 区分）。

### 2.3 鉴权中间件改造

当前 `requireAuth` 只认 JWT。改造为"双模式"，保持对现有 JWT 调用方完全兼容：

```
requireAuth(c, next):
  token = 取 Authorization: Bearer
  if token 以 "nf_" 开头:
     → verifyApiToken(token)：定位记录、校验哈希、检查 revoked/expired、更新 lastUsedAt
     → 设置 c.user = { sub: userId, role, source: "api_token", scopes, projectScope }
  else:
     → 现有 JWT 流程（c.user.source = "jwt"）
  next()
```

- **scope 校验**：在需要的路由用一个轻量 `requireScope("narrator:create")` 包装，缺失则 403。JWT 来源默认拥有该用户的全部权限（等价于交互式操作），API token 受 `scopes` 限制。
- **管理端点**：用户在设置页管理自己的 token（创建/列出/吊销）：

```
POST   /api/api-tokens            创建（返回一次性明文）
GET    /api/api-tokens            列出当前用户的 token（不含明文）
DELETE /api/api-tokens/:id        吊销
```

> 这些管理端点本身用 JWT（人在 UI 里管理），与 token 的"使用"区分开。

---

## 3. 程序化叙述者（Programmatic Narrator）

现状：`POST /api/narrators` 已支持创建独立（standalone，`chapterId` 可空）叙述者，用 `createNarratorSchema` 校验（见 `server/routes/narrators.ts`、`server/lib/validators.ts`）。开放 API **不新建一套会话系统**，而是复用它，补两样东西：**来源标注**与**自定义 metadata**。

### 3.1 narrators 表新增字段

```typescript
// 追加到 narrators 表定义
origin: text("origin", { enum: ["interactive", "api"] })
	.notNull()
	.default("interactive"),
// 创建该 narrator 的 api_token（origin=api 时非空），用于审计与回调归属
originTokenId: text("origin_token_id").references(() => apiTokens.id, { onDelete: "set null" }),
// 调用方自定义元数据：领域信息（如外部会话号、设备标识、业务标签）放这里，保持 narrator 通用
metadataJson: text("metadata_json", { mode: "json" }),
```

> 这与知识库 `metadataJson`、`knowledge_entries` 的做法一致：**通用表 + 自定义 metadata 承载领域差异**，绝不把业务字段塞进通用 schema。

### 3.2 创建程序化叙述者

```
POST /api/narrators
Authorization: Bearer nf_...            # 需 scope: narrator:create
Content-Type: application/json

{
  "title": "...",                       # 现有字段
  "model": "...",                       # 现有字段（可选，默认走 settings）
  "systemPrompt": "...",                # 现有字段（可选）
  "cwd": "/path/to/workdir",            # 现有字段（standalone 需要工作目录）
  "permissionMode": "readOnly",         # 现有字段；程序化场景建议明确受限模式
  "metadata": {                         # 新增：调用方自定义，原样存入 metadataJson
    "externalRef": "任意外部标识",
    "labels": ["..."],
    "callbackUrl": "https://..."        # 可选：结果回调（见 4.3）
  }
}
→ 201 { "id": "<narratorId>", "status": "idle", "origin": "api", ... }
```

- `createNarratorSchema` 增加可选 `metadata`（`z.record(z.string(), z.unknown()).optional()`）。
- `origin`/`originTokenId` 由中间件根据鉴权来源在服务层注入，**不接受客户端伪造**。
- 权限模式：程序化叙述者建议默认 `readOnly` 或受限白名单，避免外部无人值守地触发写操作（见 `06` 安全约定，由调用方显式声明）。

### 3.3 输入消息与运行

复用现有发消息接口（`POST /api/narrators/:id/messages`，SSE 流式，见 narrators 路由）。开放 API 调用方有两种消费产出的方式：

- **拉取**：轮询/读取消息列表（游标分页，复用现有 `narrator_message_refs.seq` 机制）。
- **流式**：SSE（现有 messages 流）或 WebSocket（`/ws/narrator?token=`，需让其接受 API token，与 REST 中间件同源判定）。
- **后台模式**：现有 narrators 表已有 `isBackground`/`backgroundStatus`/`backgroundResult` 字段，程序化长任务可直接复用——创建为后台叙述者，完成后读 `backgroundResult`。

### 3.4 metadata 的用途（通用）

`metadataJson` 是开放 API 的"扩展位"，平台只存取、不解释：

- 外部系统用它关联自己的业务实体（会话号、工单号、设备号……）。
- 列表/检索接口支持按 metadata 字段过滤（见 4.2）。
- 知识库双轴授权的 principal 判定（owner_user / 发起 agent 的用户）据 token 绑定用户裁决，metadata 仅作标注、不参与提权（见 `KNOWLEDGE_BASE.md` 第 6 节）。

---

## 4. 开放端点总览

所有开放端点复用现有 service，鉴权走 API token（或 JWT）。新增/调整的对外契约：

### 4.1 叙述者（程序化）

```
POST   /api/narrators                      创建（+metadata）      scope: narrator:create
GET    /api/narrators/:id                  状态/详情              scope: narrator:read
POST   /api/narrators/:id/messages         发送输入（SSE 流）     scope: narrator:write
GET    /api/narrators/:id/messages         拉取消息（游标分页）   scope: narrator:read
POST   /api/narrators/:id/interrupt        中断                   scope: narrator:write
```

### 4.2 按 metadata / origin 过滤列表

```
GET /api/narrators?origin=api&metadata.externalRef=<v>&standalone=true
```

- 复用现有 `GET /api/narrators` 的 standalone 过滤，增加 `origin` 与 `metadata.<key>` 查询过滤（服务层对 `metadataJson` 做等值匹配）。
- 让外部系统能"用自己的标识找回之前创建的叙述者"。

### 4.3 结果回调（可选）

若创建时提供 `metadata.callbackUrl`，叙述者进入终态（`done`/`error`，或后台 `completed`/`failed`）时，平台向该 URL POST 一个通用事件：

```jsonc
{
  "event": "narrator.finished",
  "narratorId": "...",
  "status": "done",
  "origin": "api",
  "metadata": { /* 原样回传调用方的 metadata */ },
  "ts": 1750929000000
}
```

- 通用事件，不含业务语义；调用方据 `metadata` 自行路由。
- 回调失败重试 + 签名（用 token secret 派生 HMAC，供调用方校验来源），细节在实现阶段定。
- 复用现有 `event-bus`（`server/lib/event-bus.ts`）订阅 narrator 终态事件后触发出站回调。

### 4.4 知识库读写

复用 `knowledgeService`（见 `KNOWLEDGE_BASE.md` 第 4 节），开放 token-scoped 访问：

```
GET  /api/knowledge/search?scope=&q=&tags=     scope: knowledge:read
GET  /api/knowledge/entries/:id                scope: knowledge:read
POST /api/knowledge/entries                    scope: knowledge:write
POST /api/knowledge/entries/:id/revisions      scope: knowledge:write
```

- 知识库的双轴授权（密级 clearance + 受控标签 grant）同样作用于 API token：token 的"绑定用户"即 principal，密级或受控标签不达标则检索不到（见 `KNOWLEDGE_BASE.md` 第 6 节）。
- 这让外部系统既能消费知识（检索增强），也能贡献知识（写时复制新增 revision）。

---

## 5. Scope 一览（通用）

| scope | 含义 |
|-------|------|
| `narrator:create` | 创建（程序化）叙述者 |
| `narrator:read` | 读叙述者状态与消息 |
| `narrator:write` | 发送输入 / 中断 |
| `knowledge:read` | 检索/读取知识（受双轴授权约束） |
| `knowledge:write` | 新增条目/版本（受双轴授权约束） |
| `project:read` | 读项目/章节元信息（如需要） |

- token 创建时选定 scope 子集；最小权限。
- 可选 `projectScope` 进一步限定只能操作某些项目。

---

## 6. 安全约定

- **token 只存哈希**，明文仅创建时返回一次；泄露可单独吊销。
- **来源不可伪造**：`origin`/`originTokenId` 由服务端按鉴权上下文写入，忽略客户端传入。
- **程序化写操作收敛**：API 创建的叙述者默认建议 `readOnly`/受限权限模式；要执行写/危险操作须调用方显式声明并由 token scope 授权。
- **审计**：`api_tokens.lastUsedAt` + 叙述者 `originTokenId` 形成"哪个集成、以谁的身份、做了什么"的链路。
- **回调 SSRF 防护**：`callbackUrl` 限定为可配置白名单/出站策略，避免被用作内网探测。
- **限流**：按 token 维度做速率限制（创建叙述者、发消息、知识写入），防滥用。
- **与 JWT 隔离**：API token 不能用于人类管理端点（如创建其他 token、admin 操作），这些仍要求 JWT + 角色。

---

## 7. 落地步骤

沿用 CLAUDE.md 迁移规则（改 schema → `bun run db:generate` → `bun run db:migrate`）：

1. `schema.ts`：新增 `api_tokens` 表；`narrators` 表追加 `origin`/`originTokenId`/`metadataJson`。
2. `bun run db:generate`。
3. `server/lib/auth.ts` / `middleware/auth.ts`：增 `verifyApiToken` + 双模式 `requireAuth` + `requireScope`。
4. `validators/`：新增 `validators/api-tokens.ts`（`createApiTokenSchema`）并在 `validators/index.ts` 汇出；`createNarratorSchema`（`validators/narrators.ts`）增可选 `metadata`。
5. `server/routes/api-tokens.ts`（JWT 管理端点）+ `app.route`。
6. `narratorService`：创建时落 `origin`/`metadata`；列表支持 `origin`/`metadata.*` 过滤。
7. WebSocket 鉴权（`/ws/narrator`）接受 API token（与 REST 同源判定）。
8. 可选：`event-bus` → 出站回调实现 + 白名单/签名/重试。
9. 前端：设置页"API 令牌"管理 UI（创建/列出/吊销，明文一次性展示），沿用 Mantine + TanStack。

---

## 8. 首批消费场景示例（仅说明，不进通用设计）

机器人远程诊断（`robot_assistant_next/docs/remote_diagnosis/`）映射到本通用 API：

| 诊断系统概念 | 通用 API 落地 |
|-------------|--------------|
| 服务器端"诊断会话" | `POST /api/narrators`（standalone + `metadata.externalRef=诊断会话号`，加载诊断 skills 的项目 cwd） |
| 七层诊断编排 / 多轮取数 | 该叙述者的正常 agent loop + `Skill` 工具加载 `.claude/skills` 里的诊断 skill |
| 经验库（错误码/FAQ/案例） | 知识库集合 + 检索增强 + 双轴授权（见 `KNOWLEDGE_BASE.md`） |
| 拉取诊断进展/报告 | `GET /api/narrators/:id/messages` 或 SSE/回调 |
| 区分这是诊断发起的会话 | `origin=api` + `metadata` 标注，按 metadata 过滤检索 |

> 再次强调：API 层只认 narrator / message / knowledge / metadata。"诊断""机器人""会话号"等全部活在调用方传入的 `metadata` 里，平台不解释。这样同一套开放 API 也能服务于其它自动化场景。
