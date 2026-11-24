---
id: security.acl
title: 访问控制
summary: 叙述者与项目的读写授权、可见范围与受众、共享，以及终端访问控制。
anchors:
  - server/services/acl/
  - server/services/narrator-acl.ts
  - server/services/narrator-sharing.ts
  - server/services/project-acl.ts
  - shared/narrator-access.ts
  - server/services/terminal-access.ts
  - server/websocket/terminal-ws.ts
  - server/routes/terminals.ts
  - frontend/hooks/useNarratorAccess.ts
  - frontend/hooks/useProjectAccess.ts
  - server/lib/narrator-access.ts
  - server/lib/narrator-audiences.ts
  - server/lib/project-access.ts
  - server/routes/admin.ts
keywords:
  - acl_grants
  - acl_events
  - 共享设置
  - 可见性
  - 写受众
  - visibility
  - writeAudience
  - narrator_access_changed
  - /api/narrators/:id/grants
  - /api/narrators/:id/visibility
  - /api/narrators/:id/write-audience
  - /api/narrators/:id/transfer-owner
  - agent.defaultNarratorVisibility
  - agent.defaultNarratorWriteAudience
  - terminalAccessAllowed
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 访问控制

项目、叙述者、知识库共用一套授权内核（`acl_grants` 表），在其上各有自己的领域规则。叙述者的读写判断在 `narrator-acl.ts`，改共享设置在 `narrator-sharing.ts`。

## 关键规则
- 内核只回答「这个主体在这个范围持有什么」；范围类型为 global/project/narrator/knowledge_collection/knowledge_entry（`acl/acl-scope.ts:ACL_SCOPE_TYPES`），能力为 read/write/manage（`acl/acl-core.ts:ACL_CAPABILITIES`）。
- 授权是并集：用户授权与角色授权直接合并，没有优先级也没有 deny 规则（`acl-core.ts:loadGrants`）。
- 祖先链只是「门」，必要不充分：`ScopeCaps` 把 `gate` 与 `own` 分开，`manage` 只存在于 `own`。所以项目的 read 成员过了项目门，仍要满足叙述者自己的 owner/可见范围/授权，别人的 private 会话因此对项目成员不可见。
- 一切含糊情形按无权限处理：匿名、缺失行、未知枚举值（`acl-core.ts:anonymousCaps`，`narrator-acl.ts` 文件头）。
- 管理员对所有轴短路放行（`acl-core.ts:adminCaps`，`canReadNarrator`，`canManageNarratorAcl`）。
- 叙述者读权限来源依次为：管理员、owner（`narrators.owner_user_id`）、`visibility` 为 public、通过项目门后 `visibility=project`、叙述者自身的 read 或 write 授权（`narrator-acl.ts:readVerdict`）。write 授权蕴含 read。
- 写权限（发消息、审批权限请求、改设置等）由 owner、通过项目门后的 `writeAudience` 或 write 授权给出，不看 `visibility`（`writeVerdict`）。项目门同样适用于写。
- `visibility`（private/project/public）与 `writeAudience`（owner/project/public）是两列，必须嵌套合法：private 只能 owner，project 可到 project，public 可到 public（`shared/narrator-access.ts:WRITE_AUDIENCE_BY_VISIBILITY`）。改 `visibility` 时同一条 UPDATE 里把越界的 `writeAudience` 收窄并单独审计（`narrator-sharing.ts:setNarratorVisibility`）。新建叙述者默认取该可见性允许的最宽写受众（`defaultWriteAudienceForNarrator`）。
- 子代理没有自己的受众，判断委托给根叙述者（`acl_root_narrator_id`，`resolveJudgedRow`）；根无法确定则拒绝。
- 项目 ACL 是最外层的门：管理员、owner、`public` 可见、或项目范围的授权（`project-acl.ts:canReadProject`）。
- 只有 owner 和管理员能改共享（`canManageNarratorAcl`）：write 授权不含再分享权。每次改动后通知客户端并断开已失去权限的 WebSocket 订阅（`narrator-sharing.ts` 文件头 `announceAccessChange`）。
- 列表过滤下推到 SQL（`narratorReadableWhere`/`narratorReadableSqlFragment`），不在取出的页上过滤，以保持 `LIMIT n+1` 与总数正确。
- 授权变更审计只写 id、布尔、角色名和计数，不写标题与内容；写入失败只记日志、不使被审计操作失败，并在事务提交之后调用（`acl/acl-audit.ts`）。
- 路由层桥接：`lib/narrator-access.ts`（`requireNarratorAccess`、`getAuthorizedNarrator` 等）与 `lib/project-access.ts`（`requireProjectAccess`）把 Hono 上下文转成主体再调 ACL，新端点用它们表达「需要 read/write」，不要自己拼主体。
- 创建时的受众解析（`lib/narrator-audiences.ts:resolveNarratorAudiences`）：显式值优先；`agent.defaultNarratorVisibility`/`defaultNarratorWriteAudience` 为 `auto` 时，从项目页打开的会话取 project，其余取 private，写受众取该可见性允许的最宽值；只有全局写默认会被收窄，显式的越界组合报校验错。`narrator-service.ts` 创建根叙述者时传入的项目页参数为 null。
- 前端：`useNarratorAccess`/`useProjectAccess` 读 `/access` 并按 WebSocket 帧 `narrator_access_changed` 失效（该帧按用户而非按订阅广播，不带授权细节，收到只能重读，同时刷新叙述者列表）。
- 单主体与批量判断共用 `readVerdict`/`writeVerdict`，有一致性测试 `services/__tests__/narrator-acl-batch-parity.test.ts`。
- 终端权限（`services/terminal-access.ts`）：叙述者的终端跟随该叙述者 ACL，子代理用其根叙述者；`read` 只看元数据，`write` 覆盖开启、看输出和滚动缓冲、输入、改名、关闭、读进程列表，因为终端等同于在会话工作区的 shell。
- 无叙述者的独立终端只属于创建者加管理员；创建者只记在内存里（上限 1000 条，超出丢最旧），重启后只有管理员可用。未知 id 与被拒绝给同样答案，防止探测 id。
- REST（`routes/terminals.ts`）与终端 WebSocket（`websocket/terminal-ws.ts`）都调 `terminalAccessAllowed`；WebSocket 在连接期间还会重新校验。

## 从哪读起
- `server/services/acl/acl-core.ts:resolveCaps`：内核。
- `server/services/narrator-acl.ts:canReadNarrator`、`canWriteNarrator`。
- `server/services/narrator-sharing.ts`：可见性、受众、授权、转让 owner。
- `server/services/terminal-access.ts:terminalAccessAllowed`：终端访问判断。
- `server/routes/narrators.ts`（`/:id/access`、`/visibility`、`/write-audience`、`/grants`、`/transfer-owner`）与 `routes/projects.ts`（`/:id/access`、`/visibility`、`/transfer-owner`）：共享设置的 HTTP 入口。
- `server/routes/admin.ts`：删除用户时调 `purgeNarratorGrantsForUser` 清掉其叙述者授权。

## 改它时
- 加一种授权范围或能力：改 `acl/acl-scope.ts`/`acl-core.ts` 的枚举，审计类型进 `acl/acl-audit.ts:ACL_EVENT_TYPES`；`acl_grants`/`acl_events` 是表，改结构走 schema 与迁移；这两张表目前不在 `db/snapshot-protocol.ts:SNAPSHOT_TABLES` 里（导入导出不带授权）。
- 改叙述者读/写规则只动 `readVerdict`/`writeVerdict`，让单主体与 SQL 批量路径共用；会失败的测试：`services/__tests__/narrator-acl-batch-parity.test.ts`、`narrator-acl.test.ts`、`narrator-access-nesting.test.ts`、`project-acl.test.ts`。
- 新增改共享的入口：要经 `narrator-sharing.ts`（写审计、`announceAccessChange`、断开失权订阅），否则客户端不会刷新；改 `visibility` 要保持 `writeAudience` 嵌套合法（`WRITE_AUDIENCE_BY_VISIBILITY`）。
- 不变量：未知情形无权限；没有 deny 规则；项目门必要不充分；列表过滤在 SQL 侧做。
- 终端新增入口必须调 `terminalAccessAllowed`，REST 与 WebSocket 两处都要有。

## 相关
- [登录与会话令牌](auth/index.md)
- [外部进程加固](hardening.md)：git 执行加固与子进程封装。
- [终端运行时](../platform/terminal.md)：终端的创建、PTY 与缓冲。
- [工具调用审批](tool-permissions/index.md)：审批权限请求需要叙述者写权限。
