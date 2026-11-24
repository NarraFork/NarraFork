---
id: narrator.session-interchange
title: 会话导入导出
summary: 把会话转换成 Claude Code / Codex 的会话文件，或从它们导入。
anchors:
  - frontend/lib/api/session-interchange.ts
  - server/lib/validators/session-interchange.ts
  - server/routes/session-interchange.ts
  - server/services/session-interchange/
  - shared/session-interchange/
keywords:
  - 导入会话
  - 导出会话
  - Claude Code
  - Codex
  - rollout
  - InterchangeSession
  - /api/session-interchange
  - /api/narrators/:id/session-export
  - /api/narrators/:id/session-export-to
  - SESSION_IMPORT_BUSY
  - SESSION_TOO_LARGE
  - SESSION_IMPORT_EMPTY
  - POSTGRES_UNSUPPORTED
  - imported trait
  - _originalToolName
  - dropAllReasoning
  - codexModelProvider
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 会话导入导出

把 NarraFork 会话转换成 Claude Code / Codex 能 `--resume` 的会话文件，或把这两个 CLI 的会话文件导入成 NarraFork 叙述者。所有转换经过一个与格式无关的中间表示 `InterchangeSession`，两个 CLI 的线格式各在一侧，所以 CC → NarraFork → Codex 往返共用同一套规则。

## 关键规则
- 中间表示 `shared/session-interchange/model.ts` 是纯数据（无 IO、无数据库类型）：消息角色 user / assistant / tool_result / compact，块类型 text / image / reasoning / tool_use；推理签名只记来源（`provider`、`officialAnthropic`），能否回放由目的端决定——只有官方 Anthropic API 签发的签名才会被写进 Claude Code 会话，中转/网关签发的签名会被官方 API 以 400 拒绝（`export.ts` 判定来源，`dropAllReasoning` 可整体丢弃推理）。
- 格式解析与序列化：`shared/session-interchange/claude-code/{parse,serialize,paths}.ts`、`codex/{parse,serialize,paths}.ts`；导入时第一批行判格式（Codex 以 `session_meta` / `response_item` / `event_msg` 开头，Claude Code 带 `uuid` / `sessionId`）（`routes/session-interchange.ts:sniffFormat`）。
- 工具名映射（`tool-mapping.ts`）：Claude Code 旧名 `Task` 改写为 `Agent`，Codex 的工具改写为 NarraFork 同义工具；原名保存在输入的 `_originalToolName` 键里供界面与再导出使用；没有对应的保留原名。
- 导入落库（`import.ts`）：直接插入行而不走 `narratorPersistence` 的流式写入辅助（避免成百上千次广播），新建一个 standalone 叙述者并带 `imported` trait；每 200 条消息或 4 MiB 一个事务并让出事件循环；单个工具输出 > 512 KiB、单块 > 1 MiB 截断并标 `[truncated on import]`；压缩落成 `role:"system"` 的 compact 标记（引用 `isCompact=1`）；子代理落成 `type:"subagent"` 叙述者，挂在父 Agent 调用的 `tool_use` 下。导入的工具调用记为历史而非执行（`executionIdentityVersion: 0`、`executionAttempt: 0`），没有文件变更证据，回退与归因把它们当未追踪的旧行；唯一例外是拥有子代理的 Agent 调用须是已验证的 attempt-1 行。没有消息报 422 `SESSION_IMPORT_EMPTY`。
- 导入预算：单文件解压后 ≤ 64 MiB，一次导入所有文件合计 ≤ 128 MiB（共享 `DecodeBudget`，防压缩炸弹），单行 > 8 MiB 跳过并告警，子代理文件 ≤ 200；解码按 8ms 时间片让出事件循环；zstd 解压输出以剩余预算封顶（`jsonl.ts`、`scan.ts`）。每个用户同时只能有一个导入，否则 429 `SESSION_IMPORT_BUSY`；上传超限 413 `SESSION_TOO_LARGE`；PostgreSQL 后端整体拒绝，503 `POSTGRES_UNSUPPORTED`（在读请求体之前）。
- 导出（`export.ts`）：经 `iterateNarratorTranscript` 只读分页读取（懒分叉历史不物化）；可恢复会话不能是节选，所以整份转录有硬上限 `SESSION_EXPORT_MAX_CHARS` = 32 MiB，超过就失败而不是产出中间缺一段的文件；工具输出按调用截到 512 KiB 并记 `truncated_output` 告警；子代理最多 200 个，图片最多 200 张、单张 ≤ 20 MiB；没有对话或没有工作目录都报错。
- 写出（`sinks.ts`）：每个文件都新建、从不覆盖，中途失败会删掉本次已创建的文件，避免 CLI 列出缺子线程的会话；目标工作目录不存在照写但告警 `target_cwd_missing`；Codex 的共享索引只在支持原子追加的文件系统上追加，否则告警 `session_index_skipped`；路径全部由导出器算出，不接受客户端给的目的路径。
- 位置与权限（`locations.ts`）：`server` 目标仅管理员（`~/.claude`、`~/.codex` 属于服务进程的 OS 账号，含所有人的会话）；`device` 目标要求调用者既能管理该设备（登记者或管理员）又被授权使用它，未知设备与不属于调用者的设备一律报 NotFound，防探测设备 ID。设备文件 RPC 每次 30 秒超时（`device-port.ts`）；`session-fs.ts` 的读写都有条目数/字节上限，本地遍历不跟随符号链接出树，相对路径段只许 `[A-Za-z0-9._-]`。
- 扫描（`scan.ts`）：只提供 CLI 自己会加载的文件（Claude Code 的 `<root>/projects/<dir>/<uuid>.jsonl`，Codex 的 `sessions/**` 与 `archived_sessions/**`），按 mtime 新到旧分页（每页 ≤ 50），遍历最多 20000 个文件，标题/cwd/时间只读文件首尾各 64 KiB；导入时把客户端回传的路径用 `resolveSessionFile` 按同样规则重新校验，不信任它来自列表。
- 接口：`GET /api/session-interchange/scan`、`POST /import/path`（≤ 64 KiB JSON）、`POST /import/upload`（multipart，`format` 可为 `auto`）；导出在叙述者路由上：`GET /api/narrators/:id/session-export`（下载，警告走响应头）与 `POST /:id/session-export-to`（写到某台机器的 CLI 配置目录）。

## 从哪读起
- `shared/session-interchange/model.ts`：中间表示与告警类型。
- `server/services/session-interchange/import.ts`、`export.ts`：两个方向的主流程。
- `server/routes/session-interchange.ts`：扫描/导入路由与预算；导出路由在 `server/routes/narrators.ts` 的 `session-export*`。
- 前端：`frontend/lib/api/session-interchange.ts`，界面在 `frontend/components/narrator/session-interchange/`。
- 测试：`session-interchange/import.test.ts`、`export.test.ts`、`scan-sinks.test.ts`、`device-port.test.ts`，`shared/session-interchange/model.test.ts`、`claude-code/claude-code.test.ts`、`codex/codex.test.ts`。

## 改它时
- 新增外部格式：加 `shared/session-interchange/<fmt>/{parse,serialize,paths}.ts`，扩 `InterchangeFormat`（`model.ts`）、`validators/session-interchange.ts` 的 format 枚举、`scan.ts` 的候选规则、`sinks.formatConfigDirName`、前端选择项；每个解析器要有无数据库的单测。
- 新增中间表示字段或告警种类：`model.ts` 的 `InterchangeWarningKind`、两端 parse/serialize、`SessionWarningsList` 展示一起改；`model.test.ts` 与两个格式的测试会失败。
- 改导入落库：保持“小事务 + 让出事件循环 + 导入工具调用不伪造执行证据”；`import.test.ts` 覆盖；新增列要考虑 `data-portability`。
- 任何读外部文件的新路径：必须走 `SessionFs` 的有界接口与 `DecodeBudget`，并按 `locations.ts` 的权限矩阵放行。
- 不变量：导出不得静默节选；导入失败不得留下半个叙述者（失败路径在 `import.ts` 清理）；写出不得覆盖现有文件。

## 相关
- [消息存储](messages/index.md)：导出与 Markdown/JSON 导出共用的只读分页
- [Bot](bot.md)、[会话特性层](traits.md)：`imported` 等 trait
