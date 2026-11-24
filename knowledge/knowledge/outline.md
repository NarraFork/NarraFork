---
id: knowledge.outline
title: 大纲
summary: 块大纲的存储、任务、agent 工具、实时编辑与汇报（默认关闭；定位正在重新考虑）。
anchors:
  - server/services/outline/
  - server/lib/agent/tools/outline.ts
  - server/routes/outline.ts
  - server/routes/outline-digest.ts
  - server/db/schema.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 大纲

大纲是按"空间"组织的块树：每个空间的每次写入都是一次提交，块有完整版本历史；块上可挂任务（勾选、负责人、前置、截止）、问题、锁与待确认变更；页面支持多人 Yjs 实时编辑；agent 通过专用工具读写。整套功能由 `outline.enabled` 总开关控制，默认关闭。**大纲的角色正在被重新考虑**，下面只描述当前代码做了什么。

## 关键规则
- 开关：`settings.outline.enabled` 为 false（默认）时，`/api/outline` 全部返回 404、agent 工具不出现、页面订阅结束；每次请求/帧都重读，关闭立即生效（`outline/feature.ts:isOutlineEnabled`、`server/lib/settings/defaults.ts`）。
- 空间类型：project / personal / session（`outline_spaces.kind`）；读写权限逐人判定：项目空间跟项目 ACL、session 空间跟叙述者 ACL、personal 仅 owner（admin 也不读他人 personal）；孤儿空间 admin 可读、无人可写（`outline/access.ts`，与 `project-acl`/`narrator-acl` 的一致性由 `access-parity.test.ts` 守住）。无权读的空间对外表现为 404，和不存在无异。
- 存储模型（`outline/model.ts` 列出写入不变量）：块表 + 每块版本表（`outline_block_versions`，`from_seq`/`to_seq` 区间，每块恰好一个开放版本）+ 提交表 + 链接表；删除向下闭合（删块即删整棵活子树并为每个后代写墓碑版本）；同级活块顺序键唯一；提交序号 `seq` 来自空间的 `next_seq` 计数器，在同一事务内领取。
- 写入路径（`outline/write.ts`）：先无库校验与规范化 → 按当前状态规划 → `OutlineStore.applyCommit` 以乐观计数器认领并原子写入（别的提交先到则重新规划，几次后 `OutlineBusyError`）→ 提交后发 `outline:committed`。`baseVersionSeq` 不符整笔拒绝并给出冲突块（`OutlineConflictError`）。回退是同一规划器写出的补偿提交（`revert.ts`）。
- 任务认领：开始任务在同一提交里认领，会话与其子代理视为同一持有者，认领有代次 `epoch`；锁定的计划里 agent 的改动变成待确认变更，由锁定人或其指定会话确认，会话不能确认自己的变更（`write.ts`、`pending.ts`、`lease-keeper.ts`）。
- 实时编辑：页面一个 Yjs 会话（每块一个 `Y.Text`），文本更新窄窗口内合并广播，静默后作为编辑者的人类提交落库；结构变更逐笔校验并作为一次提交写入；外部写入（agent、回退）经 `live-barrier.ts` 先冲刷未落盘文本再推入会话；Yjs 更新记入 `outline_live_updates` 以便崩溃后重放（`outline/live/session.ts`）。HTTP 面是只读视图 + 回退/锁/待确认/任务看板/问题/汇报；编辑页面走 WebSocket，不走 HTTP（`routes/outline.ts` 头注释）。
- agent 工具：`OutlineRead`、`OutlineSearch`（核心，只读，跨会话可读的所有空间）、`OutlineEdit`（可选，大纲根会话里为核心）、`Ask`（向人提问，仅大纲根会话）；实现按需加载自 `outline/agent-*.ts`（`lib/agent/tools/outline.ts`、`outline-names.ts`）。
- 委派：`Agent({ task })` 只允许大纲根会话把活的任务交给子代理，先做完所有检查再创建子代理，之后一次系统提交把任务置为进行中并把认领交给子代理，子代理的结果作为汇报挂回任务下（`outline/delegation.ts`）。
- 汇报（digest）：由提交区间而非正文文本推导，仅本人可见（`outline/digest.ts`、`routes/outline-digest.ts`）。
- 旧 Dynamic Spec（`spec://`）会话按 `outline.specImport`（默认 `auto`）导入大纲（`outline/spec-import/`、`routes/admin-outline-spec-import.ts`）。
- 存储端口有 SQLite 与 PG 两种实现，`outline/store/` 下由契约测试覆盖（`__tests__/store-contract.test.ts`）；大文本规范化放在 worker（`edit-text-worker.ts`）。

## 从哪读起
- `server/services/outline/model.ts`：词汇与写入不变量。
- `server/services/outline/write.ts`：写入路径。
- `server/services/outline/access.ts`：访问判定。
- `server/routes/outline.ts`：HTTP 门禁顺序（头注释列出）。
- `server/lib/agent/tools/outline.ts`：工具定义。
- 测试：`server/services/outline/__tests__/`（`access-parity`、`store-contract`、`task-*`、`digest.e2e`）。

## 相关
- [团队知识库](knowledge-base.md)：知识库不受大纲开关影响。
- [项目](../collaboration/projects.md)
