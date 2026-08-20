# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指导。

## 项目概述

NarraFork 是一个以"叙事分叉"为隐喻的 AI 协作编程平台。软件开发被建模为分支故事网络，每个工作分支（章节/Chapter）拥有独立的 AI 叙述者（Claude Code 会话），运行在隔离的 git worktree 中，可选配 Podman 容器环境。面向小团队私有化部署，支持共享项目数据。

**核心领域概念：**
- **章节（Chapter）** — 工作单元 = git worktree + AI 会话，状态包括：active/dormant/merged/abandoned/frozen，角色（role）包括：trunk/branch/exploration/review
- **叙述者（Narrator）** — 绑定到章节（或独立运行）的 AI 会话，支持流式输出和权限控制，类型分为 primary（主叙述者）和 subagent（子代理）
- **子代理（Subagent）** — 叙述者派生的子任务代理，分为 explore（只读探索）、plan（架构规划）、general（通用写入）、review（代码评审）四种类型
- **故事网络（Story Network）** — 所有章节 fork/merge/dependency/cherry_pick 关系构成的有向图，是项目的主界面
- **探索组（Exploration Group）** — 将多个探索分支组织为一个实验组，用于技术方案对比
- **章节边（Chapter Edge）** — 章节间的显式关系，类型包括：fork/merge/dependency/cherry_pick
- **技能（Skill）** — 项目级技能库，为叙述者提供领域特定指令和知识
- **例程（Routine）** — 内置和自定义的自动化例程

## 常用命令

| 命令 | 用途 |
|------|------|
| `bun run dev` | 后端：运行数据库迁移 + 热重载服务器（端口 7779） |
| `bun run dev:frontend` | 前端：Vite 开发服务器（端口 7778，代理 /api 和 /ws 到 7779） |
| `bun run build` | 构建前端到 `dist/frontend/` |
| `bun run start` | 生产环境：运行数据库迁移 + 启动后端 + 静态前端 |
| `bun run db:generate` | 生成 Drizzle 迁移 SQL 文件 |
| `bun run db:migrate` | 执行 `./drizzle/` 中的迁移 |
| `bunx @biomejs/biome check .` | Biome 代码检查 + 格式检查（白名单命令，无需用户批准） |
| `bunx tsgo --noEmit` | TypeScript 类型检查（白名单命令，无需用户批准） |
| `bunx @biomejs/biome check --write <file>` | Biome 代码检查 + 格式化（白名单命令，无需用户批准，建议单文件执行） |

**开发需要两个进程：** `bun run dev`（后端）和 `bun run dev:frontend`（前端）。

**运行中 NarraFork 进程铁律（最高优先级）：**
- **永远不要停止、杀死、重启或接管由 `bun run start:dev` 启动的 NarraFork 进程。** 该进程承载当前 agent loop；一旦停止，所有会话都会中断，当前 agent 也可能无法重启并继续修复。
- 修改代码后不得通过 `kill`、`pkill`、`systemctl restart` 或其他方式主动终止/重启上述进程来加载变更。优先使用不影响运行会话的单元测试、静态检查和代码审查；需要重载时只能由用户自行操作。

**Bash 工具注意事项：** 当命令输出很大时，系统会自动将完整输出存放到一个你有权限读取的临时文件中，请使用 Read 工具读取该文件获取完整内容。**禁止手动将输出重定向或 `cat` 到 `/tmp`**，这会导致路径超出工作目录范围，需要额外的用户批准。

**数据库迁移规则（严格遵守）：**
- **禁止手动修改 `drizzle/` 目录下的任何文件**（包括 SQL 迁移文件和 `meta/` 下的 journal/snapshot）
- 修改数据库结构的唯一正确流程：先修改 `server/db/schema.ts`，然后运行 `bun run db:generate` 自动生成迁移文件
- **代码评审特殊规则：** 如果评审中的改动修改了 `server/db/schema.ts` 但尚未生成对应迁移，**不要**把“未生成迁移”列为阻塞项或必须修复项；最多作为非阻塞提醒说明“合并/发布前需要生成迁移”。评审应优先确认 schema 设计和业务逻辑正确，迁移可在评审通过后再生成。
- **⚠️ 禁止自行删除数据库文件（`~/.narrafork/narrafork.db*`）或 `drizzle/` 目录** — 数据库包含用户数据，删除不可逆。迁移失败时应先尝试修复（如关闭外键检查、调整迁移顺序等），必须由用户明确授权后才能执行删除操作
- 如用户明确要求全新迁移：删除 `drizzle/` 目录和数据库文件（`~/.narrafork/narrafork.db*`），再运行 `bun run db:generate` + `bun run db:migrate`

**后端主线程性能规则（严格遵守）：**
- Bun HTTP/WS、`bun:sqlite`、JSON 序列化、同步 FS/crypto/zlib 都可能占用同一个 JS 主线程；任何长时间同步工作都会表现为“所有请求无响应”。
- 主线程 SQLite 只做“小、快、有索引、有限制”的 CRUD。禁止在普通业务请求路径中运行 FTS rebuild、`integrity_check`、全库 `dbstat`/存储扫描、大范围聚合、大事务或无上限 `.all()`；这些必须做成后台 job/worker/subprocess。管理员显式确认触发的 `/api/storage/database/vacuum` 是受控维护窗口例外：它可以同步执行并暂时暂停普通 HTTP/WS/Agent 活动，不得被当作普通 CRUD 或自动清理路径调用。
- SQLite `busy_timeout` 不能设置为多秒级；遇到锁冲突应快速失败或短等待，并在应用层用 async retry/backoff/写队列处理，避免主线程在 SQLite busy handler 中阻塞。
- 列表页/API 摘要禁止读取大字段（如 `raw_dump_json`、`output_json`、`content_json`、文件快照内容）；只返回 `has*`、长度、摘要或计数，详情接口再按需读取完整内容。
- 分页/增量同步优先使用 cursor + `LIMIT n + 1` 判断是否还有更多，避免先跑大范围 `COUNT(*)`。
- 子进程调用必须有输出上限和超时；禁止先完整收集巨大 stdout/stderr 再截断。Git diff/log、容器日志、benchmark 输出等必须从源头限流或落盘分页读取。
- WebSocket 高频输出必须合并、节流并处理 backpressure；终端输出、bash 工具输出、叙述者流式事件不得每个 chunk 广播越来越大的完整累计字符串。
- 文件预览/分享/工具读取必须有大小上限或流式读取；HTML sanitize、压缩/解压、哈希大文件应放 worker/subprocess 或设置硬限制。
- 新增可能处理大数据的功能时，必须同时设计：最大输入/输出字节数、超时、取消、分页/流式策略、慢操作日志和对事件循环的影响。

**API request dump 溢写到文件（requestDumps）：**

request dump 回答的是「我们到底发了什么、上游回了什么」，所以它必须完整——但完整就意味着大（含重放历史和内联图片时动辄数 MB），而上一节禁止让 SQLite 行无上限增长。两个要求只在「dump 存在数据库里」时冲突，因此按大小分流：

- **行内只留有界的头部 + 指针。** `server/lib/api-request-dump-store.ts` 的 `RAW_DUMP_INLINE_MAX_BYTES`（当前 512KiB）是**行预算**，与 `agent.requestDumpMaxSize`（运维想保留多少 dump）是两件事；早期把两者混为一谈，导致 5MB 的 dump 在 32MB 默认值下从不溢写、整块进了 `raw_dump_json`。超过行预算时行里只保留可读的 head 和 `RawDumpSpillPointer`（带 `inlineTruncated`，让前端能说明「这是头部，完整内容需下载」）。
- **完整 dump 落到 `~/.narrafork/request-dumps/`**（目录名即 `REQUEST_DUMP_SPILL_DIR`），文件名含时间戳 + requestId + 随机短 id（同毫秒两次写入不能互相覆盖，那正好毁掉别人在收集的证据）。写入有硬字节上限、失败清理和有界重试；具体数值以代码为准，不要在别处复制。
- **该目录可以安全删除，运行时不会读回。** 产品逻辑不依赖这些文件，删除只损失「下载较早 dump 的完整内容」这一项能力。溢写文件数量本身也有上限（`MAX_REQUEST_DUMP_SPILL_FILES`），旧文件按 mtime 淘汰。
- **下载路由 `GET /api/usage-history/:id/raw-dump`** 在行里有 spill 指针时直接流式返回文件（不在主线程解析再重新包装）；**文件被裁剪或手工删除时回落到行内 head 而不是 404**——用户至少拿到残存部分和解释缺失原因的指针。任何走「返回行而非文件」的分支都会先剥掉指针里的绝对路径（路径含宿主 OS 账号名，而 dump 会被转发给协助排查的人）。
- **存储扫描含 `requestDumps` 分类**（`server/services/storage-service.ts`），与 shares、worktrees、treeSnapshots 并列。
- **隐私定位：** dump 是请求的逐字副本，凭据已由 `sanitizeHeaders` 掩码，但消息正文是**故意保留**的（不看正文无法诊断被拒的请求）。按会话数据对待，不要当普通日志。

**Changelog 与发布工作流：**

项目使用 `changelogs/` 目录持久化每个版本的双语更新日志，构建时嵌入二进制。

1. **生成 Changelog：** 使用 `/generate-changelog` 技能（或手动创建），输出到 `changelogs/v{version}.json`：
   ```json
   {
     "version": "0.2.0",
     "date": "2026-04-01",
     "en": "## New Features\n\n- ...",
     "zh-CN": "## 新功能\n\n- ..."
   }
   ```
2. **发布新版本：** `bun scripts/release.ts <version>` — 自动从 `changelogs/v{version}.json` 读取 changelog（也可 `--changelog=<file>` 手动指定），执行版本 bump → git tag → 跨平台编译 → 上传更新服务器。
3. **构建嵌入：** `scripts/build-cross-platform.ts` 会扫描 `changelogs/*.json` 生成 `server/generated/embedded-changelog.ts`，编译二进制后无需文件系统即可读取。
4. **运行时读取：** `server/lib/changelog.ts` 双模式 — 开发时读文件系统，编译二进制读嵌入数据。API 端点 `GET /api/changelog`（公开，无需认证）。
5. **前端查看：** 设置页 About 区域有「查看更新日志」链接，跳转到 `/changelog` 页面（Timeline 组件，按版本倒序，根据语言切换内容）。

**第三方开源协议页面（`/licenses`）：**

页面覆盖**所有随发布产物分发的第三方组件**（当前约 1180 条），而非仅 `package.json` 里的直接依赖。分组依据是"是否随产物分发"，不是 `dependencies` / `devDependencies` 的位置：

- **`bundled`** — 不在 `node_modules` 里、但被编译进发布产物的组件。**由人工在 `licenses/extra/entries.json` 声明**，协议全文放同目录 `.txt`。当前包含：Bun 运行时（含其静态链接的 JavaScriptCore，**LGPL-2**，附带 relink 说明）、`vendor/zstd` 静态二进制（**BSD-3-Clause OR GPL-2.0，已选定 BSD-3**）、静态链接的 musl libc、Go 标准库 + `remote-executor/go.mod` 的 4 个模块、`@parcel/watcher` 的 8 个平台原生 `.node`（由 `scripts/download-parcel-watcher.ts` 直接从 npm 下载，**绕过 node_modules，扫描器看不到**）。
- **`runtime`** — 从 `dependencies` 递归可达的包（含 `optionalDependencies`），全部随二进制分发。
- **`development`** — 仅 `devDependencies` 可达，不分发，列出以求完整。

**⚠️ 新增非 npm 二进制依赖时必须在 `licenses/extra/entries.json` 登记**，否则页面不会提及它，构成 attribution 缺口。

实现要点：

1. **扫描器** `server/lib/licenses/scan.ts` — 递归依赖树 + `readdir` 正则匹配协议文件（`/^(licen[cs]e|copying)([._-].*)?$/i`，比固定候选名多命中 23 个包）+ NOTICE 单独采集（Apache-2.0 §4(d)）+ 按 sha256 去重全文（1052 份 → 563 份唯一）。
2. **双许可选定** `server/lib/licenses/dual-license.ts` — `"A OR B"` 必须人工声明采用哪个分支并写明理由；**未声明的 disjunction 会报 error 阻断构建**，不会静默显示原始 `"A OR B"`（那看起来像答案，却隐藏了没人做过选择的事实，MPL 分支还带源码披露义务）。同文件还有 `khroma` 这类"无 license 字段"的人工 override。
3. **缺协议原文回落** `server/lib/licenses/spdx-templates.ts` — 38 个包声明了 SPDX 但没随包提供协议文件（monorepo 只在仓库根放一份）。回落到标准协议全文，条目标 `textSource: "spdx-template"`，**UI 明确提示"这是标准文本，不是该包自行提供的措辞"并给出上游链接**。所有模板均从 `node_modules` 中已安装的规范副本逐字复制（模板注释里标注了来源包），有测试逐字对比；**禁止凭记忆手写或改写协议文本**。
4. **构建嵌入** `scripts/build-cross-platform.ts` Step 5c → `server/generated/embedded-licenses.ts`。**`problems` 中有 `error` 级会 `exit(1)` 阻断构建**（取代旧实现的静默 `catch {}`，正是它让 785 个包无声消失）。嵌入内容以 JSON 字符串 + `JSON.parse` 形式生成，与 `embedded-migrations-data.ts` 同理：1179 条对象字面量会让 TS 推断出过复杂 union 而报 TS2590。
5. **运行时读取** `server/lib/licenses/manifest.ts` 双模式 — 开发扫 `node_modules`（约 130ms，进程内缓存），二进制读嵌入数据。API：`GET /api/licenses`（摘要，**不含全文**）+ `GET /api/licenses/text/:id`（按内容哈希取单份全文）。两者均公开无需认证，因为 attribution 必须对软件接收者可得，且 `/licenses` 从登录页可直达。
6. **前端** `frontend/routes/licenses.tsx` — 运行时加载，展开行才拉取对应全文。改造前是构建期把 1.7MB 全文内联进 bundle（`__LICENSE_DATA__`），现在 licenses chunk 仅 7.6KB。

**正式版（stable）直达增量包：**

构建只会生成「紧邻上一个版本 → 当前版本」这一条 patch，这对逐版本跟进的 beta 用户是对的，但正式版用户只跟 stable，中间隔着一堆 beta 版本时会被迫连续应用多个 patch。因此**一个版本成为正式版时，额外生成并上传「上一个正式版 → 该版本」的直达 patch**：

- **以 stable 身份发布**（版本号形如 `x.y.0`）：`bun scripts/release.ts <version>` 上传完成后自动补齐。
- **beta 晋升为 stable**：`bun scripts/promote-release.ts <version>` 改完 channel 后自动补齐。
- 实现位于 `scripts/lib/stable-baseline-patch.ts`（基线选择为纯函数，便于测试），patch 生成走 `generateZstdPatchToFile`（文件到文件，不把 ~140MB 二进制读进 JS 堆）。
- 直达包**追加**存储为 `.from-<version>.zstd-patch`，不会覆盖已有的 patch，原有升级路径保持可用。
- 上传前校验本地目标二进制与基线二进制的 size+sha512 必须与服务器已发布的完全一致，避免用被改动过的本地文件生成 patch。
- 补包失败或缺少本地二进制时**只告警不中断**（多步 patch chain 仍然可用）；要跳过这一步用 `--skip-stable-patch`。
- 前提：`dist/` 里需要有上一个正式版和当前版本**两个平台二进制**，且与线上发布版本字节一致。

**发布目标服务器（生产 vs 个人测试）：**

- **正常发布（生产）：** `bun scripts/release.ts <version>` 默认读取 `~/.narrafork/update-server.json`，上传到生产更新服务器 `https://narrafork-update.b.domexie.cn`。这是所有正式版本的发布路径，**不要改动**。
- **个人测试发布：** 用于只给自己测试的版本，走独立的测试更新服务器，不影响生产。发布时通过环境变量覆盖服务器地址和令牌：
  ```bash
  # 令牌明文存于 ~/.narrafork/update-server-test.json（权限 600，不提交仓库）
  NF_UPDATE_SERVER=https://nfupdatetest.domexie.cn \
  NF_UPDATE_TOKEN=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.narrafork/update-server-test.json","utf8")).token)') \
  bun scripts/release.ts <version> --platform=windows-x64
  ```
  说明：`--platform=windows-x64` 按需选择平台；`--dry-run` 只构建不上传；`--upload-only` 复用现有 `dist/` 只上传。
- **客户端测试：** 在设置页把「更新服务器」填 `https://nfupdatetest.domexie.cn`，通道选 `beta`（个人测试版本通常发到 beta 通道），即可检查到测试版本。测试完成后记得改回生产服务器。

**个人测试更新服务器（常驻服务）：**

测试更新服务器由 systemd 常驻托管，避免进程被关导致域名 502（历史上用后台任务跑会因超时被杀）。

- **域名：** `https://nfupdatetest.domexie.cn`（宝塔 nginx/openresty 反代到 `127.0.0.1:17780`，vhost 配置 `/www/server/panel/vhost/nginx/nfupdatetest.domexie.cn.conf`，复用 `*.domexie.cn` 泛域名证书）
- **systemd 服务名：** `narrafork-update-test`（系统单元 `/etc/systemd/system/narrafork-update-test.service`，`User=fulcrum`、`Restart=always`、开机自启）
  ```bash
  systemctl status narrafork-update-test      # 查看状态
  sudo systemctl restart narrafork-update-test # 改了数据/配置后重启（release-cache 是内存缓存，需重启重载 meta.json）
  journalctl -u narrafork-update-test -n 50    # 或看 ~/.narrafork/update-test/service.log
  ```
- **数据目录：** `~/.narrafork/update-test/`（`config.json` + `data/products/narrafork/releases/<version>/...`），持久化，不放 `/tmp`
- **令牌：** 测试服务器专用上传令牌明文存于 `~/.narrafork/update-server-test.json`（权限 600，**不提交仓库**）；`config.json` 内只存 sha256 哈希
- **注意：** 该测试服务器与本机（`127.0.0.1:17780`）绑定；直接修改 `data/` 下的 `meta.json` 后必须 `systemctl restart narrafork-update-test` 才会生效（内存缓存）。

## 技术栈

- **运行时：** Bun（≥ 1.2），所有脚本通过 `bun run`/`bunx` 执行
- **禁止使用 `npx`** — 可能解析到错误或缺失的包，始终使用 `bunx` 代替
- **后端：** Hono v4 运行于 Bun.serve()，SQLite 通过 `bun:sqlite`，Drizzle ORM
- **前端：** React 19 + Mantine v7（暗色主题，indigo 主色），TanStack Router（基于文件），TanStack React Query，@xyflow/react（图可视化），xterm.js（终端），react-i18next（国际化）
- **校验：** Zod v4
- **代码规范：** Biome v2（tab 缩进，100 字符行宽，推荐规则集）
- **外部依赖：** git、可选 podman（容器）

## 架构

### 后端（`server/`）

```
server/
  index.ts          — Bun.serve() 入口：HTTP（Hono）+ WS 升级
  app.ts            — Hono 路由注册 + 全局错误处理
  db/
    schema.ts       — Drizzle 表定义（projects、chapters、narrators 等 24 张表）
    relations.ts    — Drizzle 关系定义
    index.ts        — 数据库初始化（WAL 模式、外键、FTS5 虚拟表 + 触发器）
    connection.ts   — 数据库连接管理
    fts.ts          — FTS5 全文搜索设置
    migrate.ts      — 迁移执行
  middleware/auth.ts — requireAuth / requireAdmin JWT 中间件
  lib/
    auth.ts         — JWT 签发/验证（HS256，7 天有效期），bcrypt 注册/登录
    validators.ts   — 所有 API 输入的 Zod schema
    event-bus.ts    — 类型化 EventEmitter，用于服务间解耦
    settings/       — 基于文件的配置（~/.narrafork/settings.json），深度合并默认值
    errors.ts       — AppError 层级（NotFoundError、ValidationError）
    id.ts           — nanoid 生成器（21 字符默认，8 字符短 ID）
    logger.ts       — 日志系统
    constants.ts    — 常量定义
    platform.ts     — 平台检测（WSL、Windows、Linux）
    platform-path.ts — 平台路径处理
    version.ts      — 版本信息
    slug.ts         — URL slug 生成
    spawn.ts        — 子进程管理
    uploads.ts      — 文件上传处理
    shares.ts       — 文件分享管理
    prompt-i18n.ts  — 提示词国际化
    builtin-routines.ts — 内置例程定义
    async-mutex.ts  — 异步互斥锁
    db-resilience.ts — 数据库恢复机制
    blockmap.ts     — 块映射工具
    stream-timeout.ts — 流超时处理
    project-db.ts   — 项目数据库工具
    codex-*.ts      — Codex 认证/管理/使用统计
    agent/          — 自定义 AI Agent 框架（loop、多提供商、工具注册、19 个内置工具）
    mcp/            — MCP 集成（manager、tool-bridge、transports）
  terminal/         — 终端运行时（PTY 抽象层、buffer 管理、dtach 支持）
  routes/           — Hono 路由组，挂载于 /api/*（31 个路由文件）
  services/         — 业务逻辑（40 个服务：章节、叙述者、git、终端、容器、技能、例程、评审、快照等）
  websocket/        — Bun WebSocket 处理器（叙述者事件和终端 I/O）
  generated/        — 自动生成文件（构建信息、嵌入式迁移数据）
```

**关键模式：**
- **事件总线**（`lib/event-bus.ts`）解耦服务 → WebSocket 广播。所有跨服务通信通过类型化事件流转。
- **子代理（Subagent）**：叙述者支持派生子代理（explore/plan/general/review 四种类型），通过 `narrator_messages.parentToolUseId` 关联消息树，子代理有独立的叙述者记录（`type="subagent"`）。
- **Fork 上下文继承**有三种模式：`full`（延迟会话 fork）、`compressed`（Haiku 生成摘要注入 system prompt）、`fresh`（无上下文）。
- **章节拆分（Split at Commit）**：从历史 commit 分叉时，将原章节拆为前序（prefix）和后续（continuation），新分叉成为前序的另一个 fork。前序章节的叙述者只保留拆分点之前的消息。
- **章节角色（Role）**：trunk（主线，接收合并）、branch（工作分支，默认）、exploration（探索分支）、review（代码评审）。角色是视觉和语义标签，不限制操作能力。
- **章节边（Chapter Edges）**：`chapter_edges` 表显式建模五种关系（fork/merge/dependency/cherry_pick/review），与 `parentChapterId`/`mergedIntoChapterId` 冗余字段同步维护。
- **依赖关系**：章节间可声明 dependency 边，系统检测上游变更并提供 rebase/merge 同步。
- **探索组**：将多个 exploration 章节组织为实验组，支持决策（选定方案合并）和放弃。
- **Git worktrees** 每个活跃章节在 `<project.gitPath>/.worktrees/` 下创建。休眠章节移除 worktree 但保留分支。每个项目对应一个 git 仓库，通过项目的 `gitPath` 配置。
- **容器管理**通过 Podman compose 实现，端口从可配置池中分配（默认 10000–20000）。
- **终端管理**通过平台特定的 PTY 实现（`server/terminal/`）：Unix 系统使用 `Bun.Terminal`，Windows 使用 `bun-pty`（Rust portable-pty）。两者实现统一的 `TerminalRuntime` 接口。可选支持 dtach 分离会话模式。终端生命周期与服务器进程绑定，重启后标记为已退出。
- **批量合并**编排多章节合并，支持冲突检测、WebSocket 交互式决策和 AI 辅助冲突解决。
- **故事网络图**是项目的主界面（`/projects/$projectId`），支持两种流程模式：classic（交互式 React Flow 画布，支持节点拖拽、右键菜单、侧边面板、边连接）和 ruler（线性时间轴视图，**已弃用**）。流程模式存于 `projects.flowMode`，可通过项目页工具栏的视图切换随时更改（`PATCH /api/projects/:id` 的 `flowMode` 字段），切换只改视图偏好，不影响章节/分支/worktree 数据。

**Ruler 模式已弃用（deprecated）：**
- Ruler（`frontend/components/ruler/`、`server/routes/ruler.ts`、`/api/ruler`）**不再继续开发**。已知问题不再修复，也不再为其做优化或新增功能。
- 保留原因是不让已有 ruler 项目失效，而非继续投入。新建项目默认且推荐 classic。
- 已知未修复缺陷（不要再投入修复）：Ruler 没有任何滚动驱动的自动分页，`fetchPreviousPage` 唯一入口是画布左上角定位提示里的「加载更早的提交」按钮；对 dependency 边无支持。
- 涉及 Ruler 的改动应限于「不破坏现状」的必要维护；新功能只加在 classic 侧。
- **评审系统**（`server/services/review-service.ts`）：章节级代码评审，支持 review 角色章节和 review 子代理。
- **快照系统**（两条路径，回退时优先 tree、缺失才回落重放）：
  - **工作区 tree 快照（首选）**：`server/services/worktree-tree-snapshot.ts` 在 `~/.narrafork/tree-snapshots/<path-hash>` 维护每个 worktree 的影子裸仓库，用 `git add -A` + `git write-tree` 只写 tree 对象（不产生 commit/分支，不动用户索引）。`narrator-tree-snapshot-hooks.ts` 在每个文件修改工具前后各捕获一次，写入 `narrator_tool_calls.treeHashBefore/After` 与 `narrator_messages.treeHashAfter`（表 `worktree_tree_snapshots` 记录 path+hash）。因为哈希基于真实字节，它能捕获 Bash、外部编辑器、构建脚本的改动，天然二进制安全与编码无关，回退是一次 `read-tree` + `checkout-index`，不存在半应用状态。gitignore 规则通过影子仓库自己的 `info/exclude` 生效，被忽略的文件不进快照也不会被回退动到。
  - **逐文件重放（兼容旧数据 + 中段删除）**：`file-snapshot-service.ts` 记录首次改动前的原文（含 `originalEncoding`/`isBinary`），`file-state-rebuild.ts` 重放 Write/Edit 输入重建内容。重放只能覆盖有工具输入记录的改动，因此仅用于没有 tree 边界的历史，以及"删除时间线中段某个 block"这类 tree 恢复不适用的场景。重放遇到无法应用的步骤会抛 `ReplayDivergedError` 使回退失败，绝不静默写入错误内容。
  - **回退事务**：`snapshot-revert.ts` 统一 capture-then-compensate 语义——先记录当前状态，失败或历史改动失败时还原；`commitSnapshotRevert`（伴随历史变更）/`finalizeSnapshotRevert`（回退本身即终态）/`discardSnapshotRevert`（放弃并还原）三个出口必须调用其一。
  - **磁盘管理**：worktree 被销毁（章节删除、孤儿清理）时同步删除对应影子仓库；`storage-service` 的孤儿清理会跑 `gcAll()` 重打包，存储扫描含 `treeSnapshots` 分类。
- **技能系统**（`server/services/skill-service.ts`）：项目级技能库，为叙述者提供领域特定指令和知识。
- **例程系统**（`server/services/routine-service.ts`）：内置和自定义的自动化例程。
- **通知系统**（`server/services/notification-service.ts`）：通知管理和声音提醒。
- **后台任务**：叙述者支持后台运行模式（`isBackground`/`backgroundStatus`/`backgroundResult` 字段），配合 task（stop 参数）、continue-task 工具管理。
- **叙述者服务拆分**：叙述者逻辑拆分为多个子服务 — narrator-service（核心 CRUD）、narrator-session（会话管理）、narrator-executor（执行器）、narrator-subagent（子代理管理）、narrator-context（上下文管理）、narrator-prompt（提示词生成）、narrator-title（标题生成）、narrator-recovery（恢复机制）、narrator-event-handler（事件处理）。
- **项目数据库同步**（`server/services/project-db-sync.ts`）：项目数据库同步和导入功能。
- **Worktree 监视器**（`server/services/worktree-watcher.ts`）：监视 worktree 文件变化。
- **提交同步**（`server/services/commit-sync-service.ts`）：同步提交信息。
- **合并摘要**（`server/services/merge-summary-service.ts`）：生成合并摘要。
- **输出统计**（`server/services/output-stats.ts`）：叙述者输出统计。
- **更新检查**（`server/services/update-service.ts`）：版本更新检查。

**叙述者消息存储：** 消息通过三层结构管理：
- `narrator_messages` — 存储所有消息（user/assistant/system），`contentJson` 保存完整的 SDK content blocks（text/tool_use/thinking），`parentToolUseId` 关联子 agent 消息树。
- `narrator_message_refs` — 叙述者-消息关联表（junction table），通过 `seq` 字段维护消息顺序，`isCompact` 标记压缩点。消息可被多个叙述者共享（fork 时复制共享前缀）。叙述者通过 `parentNarratorId` 和 `forkMessageId` 追踪 fork 来源。
- `narrator_tool_calls` — 工具调用记录，同时承担权限审批职责（`permissionDecidedBy`/`permissionDecidedAt` 等字段），无独立的 `permission_requests` 表。
- 消息分页基于 `narrator_message_refs.seq` 的游标分页，查询时先通过 junction table 获取叙述者的顶层消息 ID，再加载消息及其子 agent 消息树。
- **Compact 机制**：插入 role=system 的压缩标记消息（`contentJson: [{type: "compact", status: "compacted", summary}]`），在 `narrator_message_refs` 中标记 `isCompact=1`，后续查询从最近的 compact 点之后开始加载。

**数据库：** SQLite 位于 `~/.narrafork/narrafork.db`。所有主键为 nanoid 文本 ID。FTS5 虚拟表（trigram tokenizer，支持 CJK）用于章节、叙述者标题和叙述者消息的全文搜索，通过触发器同步。

**认证：** JWT 通过 `Authorization: Bearer` 头（HTTP）或 `?token=` 查询参数（WebSocket）传递。首个注册用户自动获得管理员权限。JWT 密钥在配置文件中自动生成。

### 前端（`frontend/`）

```
frontend/
  main.tsx            — i18n 初始化 + MantineProvider + QueryClient + RouterProvider
  lib/                — 工具库（api、i18n、ws、ws-status、narrator-ws-manager、notification、notification-sound、format、constants、query-client、status-registry、hmr-guard、pwa、shiki-lang 等 14 个模块）
  locales/            — 翻译 JSON 文件：en/ 和 zh-CN/，每种语言 15 个命名空间
  routes/             — TanStack 基于文件的路由（自动代码分割）
  hooks/              — React Query hooks + WebSocket hooks + UI 状态 hooks（41 个）
  components/         — 按领域分组：chapter/、common/、container/、graph/、narrator/、nav/、project/、providers/、ruler/、settings/、terminal/
  styles/             — 全局样式（React Flow 控件、OLED 主题）
  types/              — TypeScript 类型声明
```


**Vite 开发代理：** `/api/*` → `localhost:7779`，`/ws/*` → `ws://localhost:7779`。

### API 路由

全部位于 `/api/` 下。公开接口：`/api/auth/*`、`/api/health`、`/api/auth/status`。其余均需 JWT。

- `/api/projects` — CRUD + `/:id/graph` + git 操作 + 项目数据库备份/导入
- `/api/chapters` — CRUD + fork、merge、merge-check、ai-resolve、dormant、wake、cleanup、batch-merge、containers
- `/api/chapter-edges` — 章节边关系 CRUD
- `/api/dependencies` — 依赖关系管理
- `/api/narrators` — CRUD + messages（SSE）、interrupt、permission-mode、permissions、approve/deny（独立会话通过 `standalone=true` 查询参数）
- `/api/terminals` — CRUD
- `/api/settings`、`/api/admin`、`/api/search`、`/api/mcp`
- `/api/uploads` — 文件上传
- `/api/favorites` — 收藏管理
- `/api/fs` — 文件系统操作
- `/api/user-preferences` — 用户偏好
- `/api/notifications`、`/api/notification-sounds` — 通知管理
- `/api/skills` — 技能管理
- `/api/routines` — 例程管理
- `/api/reviews` — 代码评审
- `/api/ruler` — Ruler 流程模式
- `/api/shares` — 文件分享
- `/api/update` — 版本更新检查
- `/api/project-db` — 项目数据库同步
- `/api/git`、`/api/graph` — Git 操作和图数据

**WebSocket：** `/ws/narrator?token=`（订阅/取消订阅模型），`/ws/terminal?terminalId=&token=`（stdin/stdout 管道）




### 端点选择：靠网关自报能力，不靠探测


三条方向性约定，每条错了都不会报错、只会静默走另一条链：

- **字段缺失 = 老网关 = 走原生路径。** 这是唯一安全的零值方向：猜「支持」会打到一个不存在的端点。
- **每次拉取目录都会写入 capabilities，包括字段缺失时**（此时清空缓存）。这样把网关镜像回滚后，客户端会停止认为它有该端点。

### 404 回落：复用 Codex 的 rebuild-history 重试


做法是撤回该能力（后续每轮都走原生路径），然后抛 `CodexRebuildHistoryRetryError` 让外层从数据库重建历史再重试——与 Codex 配额切换复用同一机制，理由相同。


### 两处必须在本侧补齐的缺口（不在 wire 上加字段）

选 Anthropic 格式的代价是它并未解决 canonical 方案的前两个缺口，二者都在 `buildAnthropicHistory` 里补：

1. **尾部 `sys` 行必须提到当前轮**（`trailingUserText`）。Dynamic Spec 提醒、目标续跑这类注入若留在历史末尾，模型会当作背景而非「刚被问到的事」。两条路径都会送达该文本，所以做错**只表现为模型重视程度下降**，没有任何错误信号。
   **只在 `officialApi: false` 时提取**：官方 API 路径把 `sys` 映射为 `role:"system"`（Claude Code 的刻意行为，本身已表达「常驻指令」），不可改写。NUG delegate 恒为 `officialApi: false`，正好落在需要提取的一侧。

2. **历史图片的 `imageId` 必须从磁盘还原。** 存储的消息只有 imageId，字节在上传者的目录下。`buildAnthropicHistory` 原本只读 text 块，**历史里的图片全部丢失**——追问一张早前的截图时，模型收到的请求里什么都没有。这是 anthropic 路径的既有缺陷（`openai-provider.ts:2928` 是另一条做对了的路径），修它顺带修好了直连 Anthropic 渠道，所以带了直连回归测试。
   失败一律跳过并记 WARN（文件被清理、读不出、owner 未知）：丢一张图不好，但为一张被清理的旧图让整轮失败更糟。

### 图片去重的形状按 delegate 判定，不按渠道名


### 会话身份必须靠 `X-Conversation-ID` 头带过去


该头默认关闭，因为它是 NUG 私有头，对官方 Anthropic API 和第三方兼容端点都无意义。

**漏掉它不会报错**：网关侧会 fallback 生成一个 UUID，请求照样成功（完整历史每轮都在 body 里，不丢上下文），代价只是失去凭据粘性——同一会话的每一轮可能落到不同上游凭据。这种损失没有任何信号，所以测试断言的是**真实 outgoing 请求的头**，而不是 provider 上的标志位；后者被设置但没序列化时，弱断言仍会通过。

### gateway 事件


`AnthropicProvider` 的 SSE 循环**已有泛化的 gateway 事件短路**（走 `isGatewayEventType`），因此新增两个名字无需改动它；`anthropic-nug-gateway-events.test.ts` 用真实混流验证了这一点，而不是假定。


### 尚未做的事（删除 AWS 代码的两个阻塞前置）




## 代码风格

- **Biome** 强制格式化和代码检查 — 优先使用 `bunx @biomejs/biome check .`（白名单命令，无需用户批准）而非 `bun run check`
- **TypeScript 类型检查** — 使用 `bunx tsgo --noEmit`（白名单命令，无需用户批准）
- 使用 **tab** 缩进，最大行宽 **100** 字符
- 路径别名：`@server/*` → `./server/*`，`@frontend/*` → `./frontend/*`
- 全局使用 ESM（`"type": "module"`）
- `routeTree.gen.ts` 为自动生成文件 — 请勿手动编辑，也无需手动运行 `generate` 命令，开发服务器启动时会自动生成
- ID 生成：使用 `@server/lib/id` 中的 `generateId()`（21 字符）或 `generateShortId()`（8 字符）
- 错误处理：抛出 `@server/lib/errors` 中的 `AppError` 子类 — 全局处理器负责序列化
- 校验：在 `@server/lib/validators.ts` 中定义 Zod schema，在路由处理器中解析
- 配置文件位于 `~/.narrafork/settings.json` — 通过 `@server/lib/settings` 的 `settings` 单例访问

## DESIGN.md

`DESIGN.md` 文件（中文编写）包含完整的项目规格说明，涵盖全部 5 个开发阶段、详细的数据库 schema、API 契约和 UI 线框图。需求和架构决策请参阅该文件。

## 扩展能力设计与接入文档（docs/）

以下文档覆盖通用平台能力的设计基线与已落地接入契约。涉及相关改动时先阅读：

- `docs/KNOWLEDGE_BASE.md` — 知识库：`knowledge_collections`/`knowledge_entries`/`knowledge_revisions`/`knowledge_levels`/`knowledge_tags`/`knowledge_entry_tags`/`knowledge_grants`/`knowledge_entry_links` 表 + `knowledge_entries_fts`（FTS5），写时复制版本、**分级（密级）+ 分 tag（受控标签）双轴授权**、条目间有向链接（条目级关联 + 正文内容级内联引用 `[[...]]`，构成知识图谱）、**条件内容块按 viewContext（如产品版本/受众）裁剪同一条目**（block 是内容适配非访问控制，先 ACL 后裁剪）、关键词自动注入；与现有 skills 机制互补。
- `docs/OPEN_API.md` — 已实现的 OAuth 2.0 + External API v1 接入指南：Authorization Code + PKCE、项目级 grant、canonical scope、grant-owned 设备/叙述者、幂等 provisioning、独立 OAuth WebSocket、即时撤销与限流。

> 这些能力保持领域无关，机器人远程诊断只是首批消费方之一。新增表/路由/校验遵循既有范式：`schema.ts` → `bun run db:generate` → `bun run db:migrate`，FTS5 改 `server/db/fts.ts`，Zod schema 进 `server/lib/validators/`（按资源拆分目录），路由 `new Hono()` + `app.route`。

## 国际化（i18n）

前端国际化使用 `react-i18next` 配合 `i18next-browser-languagedetector`。

- **支持语言：** 英文（默认回退）+ 简体中文（`zh-CN`）
- **配置：** `frontend/lib/i18n.ts` — 同步导入所有语言包，无异步加载
- **检测顺序：** localStorage 键 `narrafork_lang` → 浏览器 navigator → 回退 `en`
- **命名空间：** 每种语言 15 个按功能划分的 JSON 文件，位于 `frontend/locales/{en,zh-CN}/`：chapters、common、containers、dashboard、explorations、git、graph、narrator、narrators、nav、projects、routines、search、settings、terminal
- **语言切换器：** `frontend/components/LanguageSwitcher.tsx` — 应用头部的 Mantine Select 组件
- **使用方式：** 组件中 `const { t } = useTranslation("namespace")`，插值 `t("key", { param })`
- **多命名空间：** `const { t } = useTranslation("chapters"); const { t: tc } = useTranslation("common");`
- **添加字符串：** 同时在 `en/*.json` 和 `zh-CN/*.json` 中添加键值，在 JSX 中使用 `t("key")`
