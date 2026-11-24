---
id: collaboration.teams.overlap
title: 重叠与独占路径
summary: 工作项的改动路径、跨团队重叠提醒、独占路径锁与强制释放。
anchors:
  - server/services/teams/team-overlap.ts
  - server/services/teams/__tests__/team-overlap.test.ts
keywords:
  - team-overlaps
  - team-locks/release
  - exclusive_key
  - uq_team_work_items_exclusive
  - TEAM_EXCLUSIVE_LOCK_HELD
  - TEAM_CHANGED_PATHS_UNAVAILABLE
  - 独占路径
  - 改动路径
  - 重叠提醒
  - chapterSettings
  - work.exclusive_released
status: draft
verified_at: 776dbf07e
---
# 重叠与独占路径

同一项目里多个团队、多个工作项可能改同一批文件。这一块算出每个活动工作项相对基线的改动路径，比较重叠，并允许项目把一些路径设为「同时只能有一个工作项持有」。

## 关键规则
改动路径与重叠（`teams/team-overlap.ts`）：
- 后台每两分钟分批（每批 50 项）刷新活动工作项相对基线的改动路径，按项目比较重叠；卡住的项会被跳过若干轮。
- 每项上限 2000 条或 128KiB，超出退化为顶层目录（目录以 `/` 结尾）。
- 读路径只经 `team-git.ts` 的两提交比较，不读工作区。

独占路径与锁：
- 独占路径来自项目设置（`projects.chapterSettings` 里的独占路径 glob）。
  - 最多 50 条，每条 ≤200 字符；
  - 不接受匹配全部的 glob。
- 工作项 `ready` 时若改动命中，就在该项上记 `exclusive_key`。唯一部分索引 `uq_team_work_items_exclusive` 保证项目内同时只有一个持有者。
- 别的项再要 ready 会得到 409 `TEAM_EXCLUSIVE_LOCK_HELD`。
- 路径无法读出且项目设有独占路径时，`work.ready` 拒绝（409 `TEAM_CHANGED_PATHS_UNAVAILABLE`）。
- 释放有两条路：工作项进入 merged/cancelled 时同事务释放（记 `work.exclusive_released`）；或项目 manage 权限者强制释放（`POST /api/projects/:projectId/team-locks/release`）。
- 重叠查询走 `GET /api/projects/:projectId/team-overlaps`（`server/routes/project-teams.ts`）；二者与团队路由一样在 PG 上返回 503 `POSTGRES_UNSUPPORTED`。

## 从哪读起
- `server/services/teams/team-overlap.ts`：刷新循环、重叠比较、独占锁判定。
- `__tests__/team-overlap.test.ts`：行为的守卫测试。
- 重叠结果如何进入协调者历史，见 [协调者](coordinator.md) 的 `team_status`。

## 改它时
- 改独占路径的数量/长度上限或 glob 规则：同步项目设置的校验与前端设置界面，`team-overlap.test.ts` 会拦。
- 改改动路径的上限或退化规则：注意 `team_status` 与团队页显示的是退化后的路径。
- 释放锁的逻辑在 `work-items.ts` 的终态转换里，也在强制释放路由里，两处要一致（见 [工作项](work-items.md)）。
- 刷新必须保持分批与跳过卡住项，不能在主线程做长同步 git 工作。

## 相关
- [工作项](work-items.md)：`work.ready` 与终态转换。
