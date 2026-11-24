---
id: narrator.lifecycle
title: 会话生命周期
summary: 创建、运行、停止、归档；narrator-service 的拆分（session/executor/subagent/context/prompt/title/recovery/event-handler）。
anchors:
  - server/services/narrator-service.ts
  - server/services/narrator-session.ts
  - server/services/narrator-executor.ts
keywords:
  - narrators
  - narrators.status
  - idle working waiting archived
  - 会话生命周期
  - ActiveNarrator
status: draft
verified_at: 776dbf07e
---
# 会话生命周期

叙述者在 `narrators` 表里一行；状态只有四种：`idle / working / waiting / archived`（`server/db/schema.ts` narrators.status 枚举）。生命周期代码按职责拆在 `server/services/narrator-*.ts`：

- `narrator-service`：创建（`prepareNarratorCreation` + `createPreparedNarratorInTransaction`）、CRUD 与状态写入。
- `narrator-session`：运行一轮的入口（`acceptUserMessage` → `feedMessageUnlocked`），内存中的 `ActiveNarrator` 由 `ensureNarrator` 懒创建。
- `narrator-executor` + `narrator-event-handler`：一次 agent loop 的事件消费与落库、广播，把结果归类后交回 session 层。
- `narrator-control` / `narrator-archive`：叙述者之间的 stop/steer/archive 授权，以及成组归档。
- `narrator-title`、`narrator-fast-mode`、`narrator-draft-service`、`narrator-panel-state` 等：会话的外观与输入侧状态。
- `workspace-context-service` 与 `narrator-cwd`：会话在哪个目录、哪台设备上执行。

## 怎么配合（按时间顺序）
1. 创建：`narratorService.create` 组装并插入一行（状态 idle），提交后才发创建事件。
2. 用户消息到达：`acceptUserMessage` 先把输入放进缓冲邮箱；空闲则认领并开跑，忙则按 `queueMode` 排队。开跑时状态置 `working`。
3. 一轮执行：`executeAgentLoop` 消费 agent loop 事件，经 `processEvent` 落库、广播；结果归类后由 session 层决定重试、压缩或收尾。权限请求使状态进入 `waiting`。
4. 收尾或失败：回到 `idle`；异常中断的会话带 `substatus: ["error"]` 回到 `idle`。
5. 停止/归档：人走普通写 ACL，agent 间调用走 `authorizeAgentControl`；归档成组、事务提交后才发事件。

## 读哪个子节点
- 创建、启动一轮、事件落库时机、中断排空、控制授权、归档 → [运行与停止](run-control.md)。
- 标题、`@handle`、快速模式、草稿与撰写文档、面板状态、导航摘要、手动后台任务/浏览器会话 → [会话外观与状态](session-surface.md)。
- `cwd` 怎么解析、设备目录映射、`WORKSPACE_CONTEXT_CONFLICT/BUSY`、切换接口 → [执行工作区](workspace-context.md)。

## 改它时
- 先读 `server/services/__tests__/narrator-session-loop.test.ts` 与 `narrator-executor.test.ts`，它们覆盖整条运行主线；细则见各子节点的「改它时」。

## 相关
- [消息存储](../messages/index.md)
- [中断与恢复](../recovery.md)
- [提示词与注入](../prompts.md)
- [会话运行时](../runtime/index.md)：`agent-runtime/` 的调度、收件箱、发布与模型历史

## 下面有什么

- [运行与停止](run-control.md)：创建会话、启动一次运行、停止与中断、归档与删除；narrator-service 各部分的分工。
- [会话外观与状态](session-surface.md)：标题、别名、快捷模式、草稿与输入框文档、面板状态、手动资源。
- [执行工作区](workspace-context.md)：会话在哪个目录、哪台设备上执行：工作目录与设备目录上下文、切换。
