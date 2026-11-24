---
id: security.acl
title: 访问控制
summary: 叙述者与项目的读写授权、可见范围与受众、共享。
anchors:
  - server/services/acl/
  - server/services/narrator-acl.ts
  - server/services/narrator-sharing.ts
  - server/services/project-acl.ts
  - shared/narrator-access.ts
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
- 单主体与批量判断共用 `readVerdict`/`writeVerdict`，有一致性测试 `services/__tests__/narrator-acl-batch-parity.test.ts`。

## 从哪读起
- `server/services/acl/acl-core.ts:resolveCaps`：内核。
- `server/services/narrator-acl.ts:canReadNarrator`、`canWriteNarrator`。
- `server/services/narrator-sharing.ts`：可见性、受众、授权、转让 owner。

## 相关
- [登录与会话令牌](auth/index.md)
- [工具调用审批](tool-permissions.md)：审批权限请求需要叙述者写权限。
