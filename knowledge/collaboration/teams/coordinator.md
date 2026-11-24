---
id: collaboration.teams.coordinator
title: 协调者
summary: 协调者的软限制、保存的输出、团队状态行与提示词。
anchors:
  - server/services/teams/coordinator-limits.ts
  - server/services/teams/coordinator-outputs.ts
  - server/services/teams/coordinator-maintenance.ts
  - server/services/teams/team-status.ts
  - server/lib/coordinator-outputs-path.ts
  - server/lib/prompts/team-coordinator-notes.ts
  - server/services/teams/__tests__/coordinator-limits.test.ts
  - server/services/teams/__tests__/coordinator-outputs.test.ts
  - server/services/teams/__tests__/team-status.test.ts
keywords:
  - team_status
  - TEAM_STATUS_SOURCE
  - TEAM_STATUS_LIMITS
  - DEFAULT_COORDINATOR_LIMITS
  - coordinator.overrun
  - coordinator-outputs
  - COORDINATOR_OUTPUT_LIMITS
  - 软限制
  - 团队状态
  - 团队简介
  - brief
  - sweepOrphanCoordinatorOutputs
status: draft
verified_at: 776dbf07e
---
# 协调者

协调者是带 `team` trait 的主叙述者，只统筹、不亲手大量读写。本节点讲对它的软约束、超大输出的落盘、以及注入它历史的团队状态行。

## 关键规则
软限制（`coordinator-limits.ts`）：
- 默认值：编辑行数 30、新文件 60、每轮文件数 3、读 300 行、搜索 100 行、Bash 输出 8KB（`DEFAULT_COORDINATOR_LIMITS`，可被团队设置覆盖）。
- 超出只给结果追加提醒行并写 `coordinator.overrun.*` 事件，不拒绝；提醒文案在 `lib/prompts/team-coordinator-notes.ts`。
- 每次运行的记账有上界：记住的不同改动文件 500 个、超限事件行 100 条，之后提醒继续但不再写行（`COORDINATOR_LIMIT_BOUNDS`）。
- 只对协调者本身（主叙述者且有 team trait）生效，子代理不受影响。

保存的输出（`coordinator-outputs.ts`、`lib/coordinator-outputs-path.ts`）：
- 读/搜索/Bash 的超大输出整份存到 `~/.narrafork/coordinator-outputs/<narratorId>/`，内容哈希命名、按部分分块。
- 每个协调者 200MB，旧文件先淘汰；单部分约 9 万字符，超过 64 部分的文本不保存，改为返回全文。
- 路径助手只做路径判断：读自己保存的输出被自动允许，别的叙述者的目录没有这种待遇。
- 叙述者删除时一并清掉其保存输出与内存记账；启动时后台分批扫掉已无叙述者的目录（`coordinator-maintenance.ts`）。

团队状态（`team-status.ts`）：
- 系统在运行开始、压缩/清空上下文后、长运行的工具边界（至少相隔 10 分钟且文本有变）把一行 `team_status` 系统行写进协调者历史，不进系统提示词。
- 文本确定、≤6KB。内容：团队简介（≤4KB，子代理也会拿到）、本周超限计数、待批准调用、工作项、成员（最多列 12 人）、重叠与独占锁、最近决策。

## 从哪读起
- `coordinator-limits.ts`：超限判定与提醒；`coordinator-outputs.ts`：存取与淘汰；`coordinator-maintenance.ts`：生命周期清理。
- `team-status.ts`：`renderTeamStatus` 渲染、`writeTeamStatusAtPass`/`AtBoundary` 写入时机。
- 测试：`coordinator-limits.test.ts`、`coordinator-outputs.test.ts`、`team-status.test.ts`。

## 改它时
- 加一种超限类型：`coordinator-limits.ts`、`shared/project-teams.ts` 的事件种类、提醒文案（`team-coordinator-notes.ts` 中英文）、`team-status.ts` 本周计数。
- 改状态行内容：保持确定性与 6KB/4KB 上限，`team-status.test.ts` 会拦；前端对事件种类的文案在 `team-page-model.ts`。
- 保存输出的目录必须经 `coordinatorOutputsDir`（校验 narrator id）；不要在别处拼路径。

## 相关
- [工作项](work-items.md)、[重叠与独占路径](overlap.md)：状态行里的数据来源。
- [团队页与审批](page.md)：超限事件在活动里的展示。
