---
id: data.portability
title: 数据导入导出
summary: SNAPSHOT_TABLES、导入合并的表、schema 变更时的兼容要求。
anchors:
  - server/services/data-portability.ts
  - server/services/data-portability-keys.ts
  - server/db/alias-selector-backfill.ts
  - server/db/snapshot-protocol.ts
  - server/db/snapshot-build.ts
  - server/routes/storage-transfer.ts
  - server/services/__tests__/data-portability.test.ts
  - frontend/components/settings/DataPortabilityCard.tsx
  - frontend/lib/api/storage-transfer.ts
  - server/db/snapshot-builder-worker.ts
  - shared/storage-transfer.ts
keywords:
  - 导入导出
  - 数据导入
  - 数据导出
  - 清空数据
  - /api/storage/export
  - /api/storage/import
  - /api/storage/clear
  - SNAPSHOT_TABLES
  - applyImport
  - copyTable
  - clearData
  - TransferSelection
  - IMPORT_VERSION_TOO_NEW
  - snapshot.db
  - providers.json
  - manifest.json
  - MAX_IMPORT_BYTES
  - 4 GB
status: draft
verified_at: e56588dfd8a9b0692681489929ede9d31b363429
---
# 数据导入导出

跨机迁移请求历史、会话和供应商配置：导出成 ZIP，导入时用 SQLite `ATTACH` 加纯 SQL 合并进当前库，不把表数据搬进 JS 逐行写。只覆盖 SQLite 主库（见下）。

## 关键规则
- 选择粒度是 `requests / sessions / providers` 三类（`TransferSelection`，`data-portability.ts:ALL_DATA_KINDS`）。ZIP 含 `snapshot.db`、`providers.json`、`manifest.json`；只选 providers 时不建快照。
- 导出的表固定写在 `server/db/snapshot-protocol.ts:SNAPSHOT_TABLES`：requests=`api_requests`；sessions=`narrators`、`narrator_messages`、`narrator_message_refs`、`narrator_tool_calls`、`narrator_blocks`、`narrator_text_snapshots`、`recent_tab_archive_marks`、`folder_git_identity_bindings`、`narrator_communication_nodes`、`narrator_communication_peers`。新表不会自动进入，必须手工加。
- 快照在子进程里构建（`snapshot-build.ts`，默认超时 5 分钟），不占主线程；子进程只读源库、只写目标库。
- 导入只合并 `applyImport` 显式处理的表；普通表由 `copyTable` 用「两库列交集」做 `INSERT OR IGNORE ... SELECT`。因此只在快照有的列不会导入，目标库新增的 NOT NULL 无默认值列会让旧快照导入失败。通讯节点与 peer 由 `restoreImportedCommunication` 单独校验并恢复。
- 会话 id 冲突在预览阶段联查检出，由调用方选 `overwrite` / `skip`（`ConflictDecision`）；跳过的会话连同其消息、引用、工具调用、块一起不导入（`copyTable` 的 `excludeNarrators`）。
- 版本：manifest `version` 1=无密钥、3=带 sealed 密钥；高于导入端支持版本抛 `IMPORT_VERSION_TOO_NEW`（`assertVersion`）。供应商密钥不进 `providers.json`，用口令封进 `provider-keys.sealed.json`（`data-portability-keys.ts`）。
- `clearData`（requests / sessions / providers / all）在一个事务内执行；清 sessions 要先断开 terminals、benchmark 结果等对会话的引用，并先删 team 三表（它们不导出）。清空前由路由校验当前用户密码（`storage-transfer.ts` 的 `/clear`）。
- 不导出的会话附属表：`outline_spec_imports`、`outline_spec_loss_*`、team 三表；导入后 `reconcileImportedTeamTraits` 按本机有无 team 行修正 `team` trait。
- 会话拷贝之后、导入事务提交前，新增和覆盖的会话按最终 title 与 traits 重算 `title_slug` / `alias_selector`（`recomputeNarratorAliasSelectors`），不采用快照里的派生值。跳过的行不参与重算；`backfillNarratorAliasSelectors` 只补仍为 NULL 且需要索引的旧值。两列可空，缺列的旧快照仍可导入。
- 通讯节点保留本机已有记录，包括手动拆组留下的显式 NULL 父边；缺端点或未授权的入站父边被拆开，环或超深的可恢复结构则使导入事务回滚。旧快照缺表时导入为独立根节点，不按历史委派接回。清空会话也清理通讯节点与 peer。
- 通讯关系不会授予 ACL：已认证路由传入 `importingUserId`，不从 JSON 或归档读取。已认证身份无权写入已有冲突会话时跳过覆盖，不用归档里的 ACL 反向获得权限。恢复关系仍须当前两端写权限；无身份时不恢复关系。`ImportResult.communication` 返回恢复、保留、跳过与安全拆分计数。每条恢复的 peer 在本机重新分配符合断连路由语法的关系 ID，不沿用归档的 ID 或 generation；旧断连请求不能删除重连后的新关系。
- 导入大小上限 `MAX_IMPORT_BYTES`=4GB（预览与执行都按它流式累计校验），快照解压后上限 `MAX_SNAPSHOT_UNCOMPRESSED_BYTES`=16GB，常量在 `shared/storage-transfer.ts`；前端用同一常量本地预检。
- 路由全部 `requireAdmin`（导出含供应商时 `GET` 直接拒绝 `STEP_UP_REQUIRED`，要走 `POST` 带 `stepUpToken` 和封存口令）：`GET/POST /api/storage/export`、`POST /export/ticket`、`POST /import/preview`、`POST /import`、`POST /clear`；票据下载 `GET /api/storage/export/download` 不走 `requireAdmin`（凭票据）。
- 无 File System Access API 的浏览器走短期导出票据：2 分钟 TTL、一次有效、最多 32 张（`EXPORT_TICKET_TTL_MS`、`consumeExportTicket`）。

## 从哪读起
- `server/services/data-portability.ts`：导出、预览、`applyImport`、`clearData`。
- `server/db/snapshot-protocol.ts`：`SNAPSHOT_TABLES`。
- `server/routes/storage-transfer.ts`：admin 路由 export / import / clear。
- `frontend/components/settings/DataPortabilityCard.tsx`（设置·存储页的导出/导入/清空 UI：导入先预检再选覆盖/跳过，清空要输入密码）与 `frontend/lib/api/storage-transfer.ts`。
- `server/db/snapshot-builder-worker.ts`：快照子进程入口，只读打开主库、不复制索引与触发器（避免导入时重复写 FTS）。
- 改 schema 后跑 `bun test --isolate server/services/__tests__/data-portability*.test.ts`。

## 改它时
- 新增需要迁移的表：加进 `snapshot-protocol.ts:SNAPSHOT_TABLES`，并在 `applyImport` 补 `copyTable`；要清空的在 `clearData` 处理；子进程 `snapshot-builder-worker.ts` 按 `SNAPSHOT_TABLES` 复制，不用另改。
- 新增 NOT NULL 且无默认值的列：旧快照缺列，导入会失败；给默认值或拒绝旧版本（`copyTable` 只拷两库列交集）。
- 会拦你的测试：`server/services/__tests__/data-portability*.test.ts`（含 teams / spec-import / staging / keys / prefix 等分支）、`server/db/snapshot-build.test.ts`（断言子进程把 `SNAPSHOT_TABLES` 里每张表的行都拷进快照；`data-portability.test.ts` 还断言 `workspaces` 不在 sessions 里、`folder_git_identity_bindings` 在）。
- 改导入体积上限只改 `shared/storage-transfer.ts`：前端预检、`data-portability.ts` 流式累计、`server/main.ts` 的 `maxRequestBodySize` 读同一个常量；其它请求仍按 `MAX_ORDINARY_BODY_BYTES`（128MB）在 `http-dispatcher.ts` 被拒。
- 不能破：快照构建留在子进程（只读源库）；不为导出/导入加主线程回退。

## 相关
- [表结构与 Drizzle](schema.md)
- [PostgreSQL 后端](postgres.md)：导入与清空直接使用 `sqlite` 句柄（`data-portability.ts` 引自 `../db`），PG 模式下该句柄是访问即抛错的代理，所以这些操作只适用于 SQLite；导出读 `getDbPath()` 的 SQLite 文件，PG 下是否有意义未核实。
