# 计划任务重设计方案（SCHEDULED_TASKS_REDESIGN_PLAN）

> 状态：方案已与需求方逐项确认，待实施。
> 分支：`feat/scheduled-tasks-redesign`（基于 `origin/main` `dd11a53e7`），工作树 `.claude/worktrees/scheduled-tasks-redesign`。
> 交付方式：全部改动在本分支完成，提一个 PR。
> 日期：2026-11-14。

本文是"计划任务"（原"定时任务"）重设计的完整方案：七个目标各自的现状、分析、备选方案、选定方案和实现要点，以及数据模型、接口、实施步骤和测试计划。实施时以本文为准；与本文不一致的地方应先改本文。

---

## 目录

1. [背景与现状](#1-背景与现状)
2. [已确认的决策](#2-已确认的决策)
3. [目标逐项方案](#3-目标逐项方案)
   - [3.1 目标 2：统一定时方案](#31-目标-2统一定时方案)
   - [3.2 目标 4：进行中／已结束](#32-目标-4进行中已结束)
   - [3.3 目标 1：叙述者创建与权限控制](#33-目标-1叙述者创建与权限控制)
   - [3.4 目标 3：创建者溯源](#34-目标-3创建者溯源)
   - [3.5 目标 6：执行状态记录](#35-目标-6执行状态记录)
   - [3.6 目标 7：复用叙述者时的模型](#36-目标-7复用叙述者时的模型)
   - [3.7 目标 5：界面重做](#37-目标-5界面重做)
4. [数据模型变更](#4-数据模型变更)
5. [接口变更](#5-接口变更)
6. [叙述者工具变更](#6-叙述者工具变更)
7. [文件清单](#7-文件清单)
8. [实施步骤](#8-实施步骤)
9. [测试计划](#9-测试计划)
10. [风险与待核实项](#10-风险与待核实项)
11. [不在本次范围](#11-不在本次范围)

---

## 1. 背景与现状

计划任务按调度周期性地用预设指令启动一个叙述者。现有实现（以 `origin/main` 为准）：

| 部分 | 位置 | 现状 |
|---|---|---|
| 表结构 | `server/db/schema.ts` 的 `scheduledTasks`、`scheduledTaskRuns` | 调度只有 `cron_expr` + 可空的 `timezone`；任务只有 `enabled` 一个状态；`created_by` 同时充当创建者和运行身份 |
| 服务 | `server/services/scheduled-task-service.ts` | 派发后立即写运行记录，状态只有 `success／failed／skipped`，`success` 仅表示"已派发" |
| 调度器 | `server/services/scheduled-task-scheduler.ts` | 每 30 秒轮询到期任务；启动时把下次执行时间重置到未来，停机期间错过的执行不留记录 |
| 路由 | `server/routes/scheduled-tasks.ts` | 列表、查看、编辑、启停、运行、删除都没有归属校验，只有清理策略限制了创建者或管理员 |
| 叙述者工具 | `server/lib/agent/tools/scheduled-task.ts`、`scheduled-task-admin.ts` | 两个可选工具功能重叠；`ScheduledTask` 的修改类操作在任何权限模式下都要人确认（`narrator-permission.ts` 中位于"全部放行"短路之上） |
| 界面 | `frontend/routes/scheduled-tasks/index.tsx`、`$taskId.tsx` | 列表无筛选；编辑是列表页里的大弹窗；显示原始 cron；无实时更新；不显示创建者 |

调研中确认的关键事实（实现时会用到）：

- **发消息不等循环结束。** `sendMessage` 持久化用户消息并启动循环后即返回；循环正在运行时会抛 "Narrator is already running"。
- **阻塞没有超时。** `AskUserQuestion`（同步形式）和 `ExitPlanMode` 在任何权限模式下都走"询问"；`EnterPlanMode` 在"始终允许"清单里，模型可自行进入计划模式。通用的授权等待没有计时器，调用处也只接了中断信号；只有 `RequestPermissionRule` 这种专用请求有时限。CLAUDE.md 里写的 5 分钟超时在代码中不存在。
- **`scheduled` 标记没有任何特殊处理。** 全仓只有类型定义、fork 排除集和创建处引用它。
- **推送依赖"最近标签页"。** `notification-service.ts` 的钉钉／飞书推送只发给最近标签页里有该会话的人，后台新建的任务会话不在任何人的标签页里。
- **每次运行有持久记录。** `narrator_turns` 表每次运行一行（`running／completed／interrupted／failed` + `stop_reason` + 起止时间 + 步数和用量），`trigger_message_id` 指向触发它的用户消息。
- **临时模型覆盖已存在。** 消息的 `executionIntent.modelOverride`（`temporary／permanent`）由 `applyAcceptedModelOverride` 应用，循环结束时还原 `pendingModelRestore`；`sendMessage` 目前没有暴露这个参数。
- **复用模式有配置漂移。** 任务的模型、权限模式、系统提示只在创建会话时生效，之后改任务配置不影响已复用的会话。
- **croner 10 的能力**（已实测）：支持 ISO 时间作为一次性模式、`startAt／stopAt／maxRuns`、七段带年份的表达式、`L` 和 `#` 修饰符、`previousRuns`。`*/7` 这类步进在整点重置，不是真正的固定间隔。
- **数据导入导出不含计划任务表。** `SNAPSHOT_TABLES` 只有会话相关表；本次不新增表，无需改导入导出。
- **SQLite 方言清单守卫。** `server/db/sqlite-dialect-inventory.guard.test.ts` 要求每处 SQLite 专有 SQL 登记在册，新代码应尽量用 Drizzle 查询构造器。

---

## 2. 已确认的决策

四轮共 16 项，均由需求方选定。

| # | 议题 | 决定 |
|---|---|---|
| 1 | 定时方案 | 日历式规则：指定时间（可多个）／周期重复 + 结束条件／高级 cron |
| 2 | 有限次任务的次数口径 | 按计划次数：错过或失败也占一次 |
| 3 | 停机期间错过的执行 | 一律跳过，只在运行历史里记一条"错过" |
| 4 | 生命周期文案 | 进行中／已结束 |
| 5 | 可见与管理范围 | 所有者 + 项目只读可见 |
| 6 | 叙述者创建的授权 | 会话内审批 + 能力上限 |
| 7 | 升级前旧任务的来源 | 一律视为用户创建 |
| 8 | 所有者账号被删除 | 任务自动转给执行删除的管理员，继续运行 |
| 9 | 完成判定 | 系统状态 + 模型自报 |
| 10 | 无人值守遇阻 | 任务级可选，默认不等人 |
| 11 | 复用叙述者时的模型 | 三态由任务选择：沿用／仅本次临时覆盖／每次同步并保持 |
| 12 | 专属会话标记 | 复用现有 `scheduled` 标记和来源任务 ID，补界面提示，不锁定 |
| 13 | 界面布局 | 列表、详情、编辑各为独立页面 |
| 14 | 筛选能力 | 搜索 + 快速筛选 + 高级筛选 |
| 15 | 中文名称 | 计划任务（英文仍为 Scheduled Tasks，代码和接口命名不变） |
| 16 | 交付方式 | 一个 PR |

### 2.1 未单独询问、由本方案代为采用的默认

这些是实现所需但没有逐项确认的细节。任何一条不合适，改这里即可。

| # | 默认 | 理由 |
|---|---|---|
| a | 末次执行失败的任务仍算"已结束"，带"末次失败"标记并进入"需要关注" | 调度已耗尽是事实；成败是另一条轴 |
| b | 暂停期间不消耗次数；暂停期间经过的"指定时间"记为错过 | 暂停的直觉是冻结；指定时间过了就无法再触发 |
| c | 修改调度规则后次数重新计 | 改规则等于定义了新的执行序列 |
| d | 触发容差 60 秒，超出记为错过 | 仅用于吸收 30 秒轮询的抖动，不是补跑 |
| e | 无人值守的任务会话不能创建或修改别的任务，只能停用或删除自己 | 防止任务自我繁殖 |
| f | 两个工具合并为 `ScheduledTask`；`ScheduledTaskAdmin` 保留一个版本的兼容别名 | 归属权限落地后，管理员工具不再有独立价值 |
| g | 每次运行最长 60 分钟，任务可改（5–1440） | 参照 OpenClaw 的看门狗默认值 |
| h | 失败、阻塞、超时、自动暂停一律通知所有者；成功通知是任务级开关，默认关 | 解决"不知情"；避免成功刷屏 |
| i | 熔断计数落库，真实运行失败计入，阈值仍为 5 | 现在只统计派发失败且重启清零 |
| j | 任务专属会话每次运行前同步权限模式和系统提示，不做开关 | 权限漂移是安全问题；系统提示同属一类缺陷 |
| k | 项目只读成员看不到指令和系统提示正文 | 指令里可能有敏感信息；确认时列出的可见内容不含指令 |
| l | 时区必填：界面默认浏览器时区；叙述者创建未给时区时取服务器时区并在结果里注明 | 留空按服务器时间是现有的易错点 |
| m | 旧任务升级后遇阻策略即为"不等人"；模型策略旧任务为"沿用"、新任务默认"每次同步并保持" | 前者修复挂死（行为变化，需写入更新日志）；后者保持旧任务行为不变 |
| n | 升级前创建者已被删除的遗留任务维持现有运行方式，管理员可在界面接管 | 决策 8 针对的是删除动作发生时；遗留数据没有执行删除的管理员 |
| o | 每个所有者的未结束任务上限 100；重复间隔最短 1 分钟，叙述者创建的最短 5 分钟；均为设置项 | 防失控，参照插件调度器的配额做法 |
| p | 调度预览由服务端计算 | 预览与实际执行用同一份引擎，时区逻辑不进浏览器 |

---

## 3. 目标逐项方案

### 3.1 目标 2：统一定时方案

**需求。** 执行时间范围扩大：可指定具体日期时间；可循环（每日、每周几点几分）；可多次执行（每周一 7:00 执行 3 周；11 月 23 日 8:00 和 12 月 1 日 11:00 各一次）。用一套统一、灵活且尽量简单的方案解决。

**现状问题。**

- 只有 cron；预设只有"每 N 分钟／每小时／每天／每周／自定义"。
- 没有一次性、次数上限、起止时间。
- 时区是可空的自由文本，留空按服务器本地时间。
- 调度一旦不再触发（如带年份的表达式过期），任务仍显示"已启用"，且之后任何编辑都会因 "Invalid cron expression" 失败。

**备选方案。**

| 方案 | 表达 | 优点 | 缺点 |
|---|---|---|---|
| A. Cron + 边界 | cron 为唯一表达，加开始、结束、最多次数 | 改动最小 | 多个指定日期要建多个任务；用户仍要懂 cron；"每 3 天"在 cron 里按月重置 |
| B. 触发器列表 | 一个任务挂多个 at／every／cron 触发器 + 整体限制 | 最灵活 | 概念和界面最复杂；"已结束"难定义 |
| **C. 日历式规则** | 三选一：指定时间／周期重复 + 结束条件／cron | 与日历软件的"重复"一致；需求里的例子都能用一个表单表达；"已结束"有明确定义；结构化 JSON 对叙述者最不易错 | 间隔大于 1 的规则要自己算下次时间 |
| D. 自然语言 | 一句话由模型编译成调度 | 最省事 | 要调模型，有成本和不确定性；可作为 C 之上的后续增强 |

**选定：C。** D 不在本次范围。

#### 数据结构

新增共享模块 `shared/scheduled-task-schedule.ts`，前后端共用类型和纯函数。

```ts
/** 墙上时间，按任务时区解释。格式 "YYYY-MM-DDTHH:mm" */
export type WallDateTime = string;
/** 格式 "HH:mm" */
export type WallTime = string;

export type ScheduleEnd =
	| { type: "never" }
	| { type: "count"; count: number } // 1..10000，按计划次数
	| { type: "until"; until: WallDateTime }; // 含当刻

export type RepeatRule =
	| { unit: "minute"; interval: number } // 每 N 分钟，按锚点等间隔
	| { unit: "hour"; interval: number; minute: number } // 每 N 小时的第 mm 分
	| { unit: "day"; interval: number; times: WallTime[] }
	| { unit: "week"; interval: number; weekdays: number[]; times: WallTime[] } // 0=周日
	| {
			unit: "month";
			interval: number;
			monthDays: Array<number | "last">;
			times: WallTime[];
	  };

export type TaskSchedule =
	| { kind: "at"; times: WallDateTime[] } // 1..50 个指定时间
	| {
			kind: "repeat";
			rule: RepeatRule;
			startAt?: WallDateTime | null;
			end: ScheduleEnd;
			/** 保存时写入的 ISO 时刻，间隔大于 1 的规则以它对齐 */
			anchorAt: string;
	  }
	| { kind: "cron"; expr: string; startAt?: WallDateTime | null; end: ScheduleEnd };
```

时区继续存在 `scheduled_tasks.timezone`。新任务必填；旧任务的空值保持"服务器时区"语义，界面显示为"服务器时区"并可改。

需求里的例子：

| 需求 | 调度 |
|---|---|
| 每天 9:00 | `{kind:"repeat", rule:{unit:"day", interval:1, times:["09:00"]}, end:{type:"never"}}` |
| 每周一 7:00，执行 3 周 | `{kind:"repeat", rule:{unit:"week", interval:1, weekdays:[1], times:["07:00"]}, end:{type:"count", count:3}}` |
| 11 月 23 日 8:00、12 月 1 日 11:00 各一次 | `{kind:"at", times:["2026-11-23T08:00","2026-12-01T11:00"]}` |
| 11 月 20 日到 25 日每天 8:30 | `repeat` + `startAt:"2026-11-20T00:00"` + `end:{type:"until", until:"2026-11-25T23:59"}` |
| 每 90 分钟 | `{kind:"repeat", rule:{unit:"minute", interval:90}, …}` |
| 每月第一个周一 9:00 | `{kind:"cron", expr:"0 9 * * 1#1", …}` |

#### 调度引擎

新增 `server/lib/schedule-engine.ts`，纯函数，不碰数据库。

```ts
nextOccurrence({ schedule, timezone, after, firedCount }): Date | null
previewOccurrences(schedule, timezone, { from?, count, firedCount? })
	: { occurrences: string[]; finite: boolean; total: number | null; endsAt: string | null; exhausted: boolean }
countOccurrencesBetween(schedule, timezone, from, to, cap)
	: { count: number; first: Date | null; last: Date | null; capped: boolean }
validateSchedule(input, timezone)
	: { ok: true; normalized: TaskSchedule } | { ok: false; code: string; path: string }
scheduleFromCron(expr): TaskSchedule // 旧任务：能识别的预设转成 repeat，否则保持 cron
```

各类规则的算法：

| 规则 | 算法 |
|---|---|
| `at` | 取大于 `after` 的最小时间。墙上时间转时刻用 croner 的 ISO 模式（已实测支持时区） |
| `repeat` 分钟／小时（间隔任意） | 按锚点等间隔：`anchor + ceil((after - anchor) / interval) * interval`。绝对时间运算，不受夏令时影响 |
| `repeat` 天／周／月，间隔为 1 | 编译成 cron 交给 croner（处理时区和夏令时）；多个时刻取各模式的最小值 |
| `repeat` 天／周／月，间隔大于 1 | 用间隔为 1 的 cron 逐个取候选，按"与锚点相差的天数／周数／月数能被间隔整除"过滤；迭代有上限 |
| `cron` | 直接交给 croner |
| 边界 | `startAt` 抬高起点；`until` 之后返回空；`count` 用 `firedCount` 判断 |

约束：

- 所有迭代都有上限（单次求下一时间最多 5000 次候选，预览最多 20 条），不在主线程做无界计算。
- 夏令时：落在跳过区间的时刻顺延（croner 行为，已实测）；重复的时刻取第一次。
- 月份没有的日期（如 31 日）在该月不触发；`"last"` 表示当月最后一天。

#### 计数、错过与推进

- `fired_count` 记录本调度序列已消耗的计划次数。派发、跳过（会话忙、无权限）、错过都消耗一次（决策 2）。
- 调度器每 30 秒一轮。到期任务若迟到不超过 60 秒则派发；超过则记一条"错过"并推进到下一次（决策 3，默认 d）。
- 启动时对每个启用且未结束的任务：若下次执行时间已过期，用 `countOccurrencesBetween` 数出错过的次数（上限为剩余次数与 1000 的较小值），写**一条**汇总的"错过"记录（含次数和起止时间），再推进。不逐条写，避免每分钟任务停机一周后写入上万行。
- 手动"立即运行"不消耗次数，不影响调度节奏。
- 修改调度规则（规范化后的 JSON 或时区发生变化）时：`fired_count` 归零，`anchorAt` 重置为当前时刻，重新计算下次执行时间和"已结束"状态。

#### 兼容旧数据

- `cron_expr` 列保留且仍为 NOT NULL，改作兼容字段：调度为 cron 或能编译成单条 cron 时写入编译结果，否则写空串。这样迁移只有加列，不需要重建表。
- 新增可空的 `schedule` 列。启动时的归一化（见 [4.3](#43-迁移与回填)）把旧行的 `cron_expr` 转成 `schedule`；能识别的预设形态转成 `repeat`，这样旧任务在新界面里显示为"每天 09:00"而不是 cron 字符串。
- 接口和工具继续接受 `cronExpr` 作为简写，等价于 `{kind:"cron"}`。

#### 预览

`POST /api/scheduled-tasks/preview-schedule` 返回规范化后的调度、接下来几次执行时间、是否有限、总次数和结束时间。编辑表单、叙述者工具的创建结果、审批卡片都用它，保证"看到的"和"实际执行的"一致。

---

### 3.2 目标 4：进行中／已结束

**需求。** 区分已完成和未完成的任务；有限次任务全部完成后为已完成；无限循环任务始终未完成，除非调度被修改；面板默认只显示未完成的。

**定义。**

| 生命周期 | 条件 | 文案 |
|---|---|---|
| `active` | 已启用，且还有下一次执行，或调度已耗尽但末次执行还在跑 | 进行中 |
| `paused` | 已停用，且调度未耗尽 | 进行中 · 已暂停 |
| `ended` | 调度已耗尽（指定时间用完、次数用完、过了截止时间），且没有执行还在跑 | 已结束 |

实现：

- 新增 `completed_at` 列，为空表示未结束。调度推进后没有下一次，且该任务没有活跃的运行记录时写入；编辑调度后若又有下一次则清空。
- 新增 `pause_reason` 列，区分用户暂停和自动暂停（熔断），界面据此说明原因。
- 接口返回 `lifecycle` 字段，由服务端从 `enabled`、`completed_at`、活跃运行推导。
- 已结束的任务不能直接"启用"，接口返回明确的校验错误，提示先修改调度。
- 文案上，任务层面用"进行中／已暂停／已结束"，单次执行层面用"运行中／成功／失败／阻塞……"，两套词不混用。列表行里把二者放在不同位置。

---

### 3.3 目标 1：叙述者创建与权限控制

**需求。** 允许叙述者创建计划任务；权限控制怎么设计好，能否参考知识库的权限控制。

#### 现状缺口

1. 路由没有归属校验，工具的 `list` 返回所有人的任务。
2. 叙述者创建时可任意指定权限模式（默认"全部放行"）、工作目录、项目，审批卡片只显示原始参数。
3. 不记录由哪个叙述者创建。
4. `created_by` 既是创建者又是运行身份。创建者被删后，独立运行类任务仍以无主身份继续运行。

#### 思考：能否参考知识库的权限控制

知识库的模型是"密级 × 受控标签"：条目有密级和若干受控标签，用户或角色持有管理员授予的凭证（最高密级、标签），二者都满足才可读。

| 方面 | 知识库的做法 | 对计划任务是否适用 |
|---|---|---|
| 密级与受控标签 | 回答"这条内容有多机密、谁能读"，凭证只能由管理员授予 | 不适用。任务要回答"谁能管这个任务、任务能做什么"；照搬会让创建任务前必须先找管理员授权 |
| 叙述者的身份 | 没有独立身份，以"发起本轮对话的用户"的实时权限行事 | 适用。任务工具也应以本轮用户为准，角色实时读取，无人则无权 |
| 叙述者的上限 | 没有。叙述者拥有该用户的全部知识库权限 | 不够。任务会长期无人值守运行，需要上限 |
| 写入审批 | "全部放行"模式下不再询问 | 不应学。`ScheduledTask` 的修改操作始终要人确认，这一点保留 |
| 授权内核 | 与项目、会话共用 `acl_grants` 的"查看／编辑／管理"授权 | 适用。任务的项目可见性直接复用项目的读权限判断 |
| 溯源 | 只记用户，不记叙述者 | 不够。应参照大纲（Outline）功能的完整溯源结构 |

**结论：借鉴身份规则和授权内核，不照搬密级与标签。**

#### 思考：四个可行方案

| 方案 | 做法 | 评价 |
|---|---|---|
| **一、会话内审批 + 能力上限** | 每次创建或修改都要人在对话里确认；审批卡片显示人话版调度、接下来的执行时间、权限模式、目录；任务能力默认不超过创建它的会话 | 改动集中，安全边界清楚；无人值守会话不能建任务 |
| 二、提议待确认 | 叙述者随时可建，但任务以"待确认"保存，所有者在面板确认后生效 | 不阻塞对话，无人值守也能提议；多一步，会积压待确认项 |
| 三、两者结合 | 有人在场走审批，无人可批时转待确认 | 体验最完整，实现量最大 |
| 四、分级授权 | 管理员给用户或角色授予"可免审批创建的最高任务等级"和项目范围 | 最体系化；要新增授权管理界面，概念最多 |

**选定：方案一**（决策 6）。方案二、三可在其上后续增加，数据模型不冲突。

#### 三层设计

**第一层：可见与管理**（决策 5）

| 角色 | 查看 | 暂停／恢复 | 编辑／运行／删除／清理 |
|---|---|---|---|
| 所有者 | 是 | 是 | 是 |
| 管理员 | 是 | 是 | 是 |
| 项目管理者（仅项目任务） | 是 | 是 | 否 |
| 项目成员（仅项目任务，可读该项目） | 是，不含指令正文 | 否 | 否 |
| 其他人 | 否 | 否 | 否 |

- 独立任务只有所有者和管理员可见。
- 任务产生的会话仍按会话自己的权限。
- 不可见的任务返回 404 而不是 403，与项目、会话的约定一致。
- 编辑任务等于"以所有者身份执行编辑者写的指令"，所以编辑只限所有者和管理员。
- 接口为每个任务返回服务端算好的能力位（`canEdit／canPause／canRun／canDelete／canSeePrompt`），前端不自行判断。

新增 `server/services/scheduled-task-acl.ts`：

```ts
canReadTask(task, principal)   // 管理员 || 所有者 || (项目任务 && canReadProject)
canPauseTask(task, principal)  // 管理员 || 所有者 || (项目任务 && canManageProject)
canEditTask(task, principal)   // 管理员 || 所有者
taskReadableWhere(principal)   // 列表查询用的 SQL 条件，复用 projectReadableWhereForColumn
```

**第二层：创建授权**

- `narrator-permission.ts` 中 `ScheduledTask` 分支保持在"全部放行"短路之上；只读和不询问模式仍拒绝修改类操作。
- 审批卡片改为专用渲染：任务名、人话版调度、接下来三次执行时间、运行方式、权限模式、指令预览（可展开）。更新操作显示变更前后的差异。
- 卡片内容来自预览接口，与工具执行时的校验是同一个函数，所见即所得。

**第三层：能力上限**

叙述者创建或修改任务时，由 `resolveNarratorTaskDraft(callerNarrator, input)` 统一处理：

| 项 | 规则 |
|---|---|
| 权限模式 | 未指定时取调用会话当前的有效权限模式。指定值高于调用会话时标记 `elevated`，审批卡片以高危样式单独提示，由人明确批准。等级：只读 < 不询问 = 询问 < 自动批准编辑 < 全部放行 |
| 项目与目录 | 未指定时取调用会话的项目和工作目录。指定了别的项目时，创建时就校验本轮用户对该项目有写权限（现在只在运行时校验），并标记 `outsideScope` 在卡片上提示 |
| 所有者 | 本轮对话的用户（`ctx.userId`）。没有用户时拒绝创建 |
| 配额 | 所有者未结束任务数不超过上限；重复间隔不低于下限（默认 o） |
| 无人值守会话 | 任务专属会话（带来源任务 ID）调用时，只允许读操作，以及对**自己的任务**执行停用或删除，这两项自动放行；其他修改一律拒绝（默认 e） |

#### 所有者

- 新增 `owner_user_id` 列作为运行身份和权限主体，可转移。`created_by` 保留为不可变的创建者记录。
- 运行时的身份解析 `principalForTask` 改读 `owner_user_id`，角色仍实时读取。
- 删除用户时（`DELETE /api/admin/users/:id`），在同一个事务里把该用户名下任务的所有者改为执行删除的管理员，并写入变更记录（决策 8）。删除确认框列出将被接管的任务。
- 管理员可在任务详情页转移所有者（`POST /api/scheduled-tasks/:id/transfer`）。
- 仪表盘的"已启用任务数"改为按可见范围统计，现在它统计的是全实例的任务。

---

### 3.4 目标 3：创建者溯源

**需求。** 追溯创建者：用户创建的显示具体用户；叙述者创建的记录创建者及具体在哪一段创建；考虑用户或叙述者不在的情况，以及原有数据的迁移。

#### 记录内容

参照大纲功能的溯源结构，引用类字段不设外键，被引用对象删除后记录仍在。

| 字段 | 含义 |
|---|---|
| `creator_kind` | `user` 或 `narrator` |
| `created_by` | 负责人。用户创建是本人；叙述者创建是当时驱动那轮对话的用户。保留外键，删除用户时置空 |
| `creator_narrator_id` | 调用工具的叙述者（子代理则是子代理自己） |
| `creator_message_id`、`creator_tool_call_id`、`creator_tool_use_id` | 那次工具调用及其所在消息 |
| `creator_snapshot` | 创建时的用户名、叙述者标题、根叙述者 ID，用于对象被删后的显示 |
| `last_modified_by` | 最近一次修改的操作者（用户或叙述者）、动作和时间 |

工具调用的消息和调用 ID 用 `ToolContext.toolCallBinding`／`currentToolUseId` 查 `narrator_tool_calls` 得到，与 `server/lib/agent/tools/outline.ts` 里的 `callProvenance` 相同，提成共用函数。

#### 显示

- 用户创建：头像 + 用户名。
- 叙述者创建：叙述者头像 + "叙述者「标题」· 代 张三"，旁边是"跳转到创建位置"。链接为 `/narrators/<叙述者ID>#msg-<工具调用ID>`，现有的跳转逻辑能直接落到那张工具卡片上，未加载的历史会自动翻页。
- 接口在任务里内嵌创建者和所有者的显示信息（用户名、头像色、头像图、是否已删除；叙述者标题、是否存在、当前用户能否读），前端不再按 ID 查用户。这是现有惯例。

#### 思考：用户或叙述者不在

| 情况 | 处理 |
|---|---|
| 叙述者被删除 | 用快照显示"叙述者「标题」（已删除）"，链接禁用 |
| 叙述者被归档 | 仍可跳转 |
| 当前用户无权读该叙述者 | 显示"某个会话"，不暴露标题，无链接。与大纲的做法一致 |
| 创建者用户被删除 | `created_by` 置空，用快照显示"张三（账号已删除）"；所有者按决策 8 转给管理员 |
| 工具调用记录被清理 | 链接仍尝试跳转，找不到时落在会话顶部 |

#### 思考：原有数据迁移

三个备选：标为"未记录"、后台扫描工具调用历史回填、一律视为用户创建。回填需要全表扫描 `narrator_tool_calls`（没有按工具名的索引，生产库该表可达数十万行），只能放后台做。

**选定：一律视为用户创建**（决策 7）。`creator_kind` 列默认 `user`，旧行无需处理；`creator_snapshot` 的用户名和 `owner_user_id` 在启动归一化时补上。

---

### 3.5 目标 6：执行状态记录

**需求。** 已知现象：执行结束即为成功，无法判定任务是否真正完成；任务被提问或计划审批阻塞而不知情；模型调用错误导致失败而不知情。思考：更多状态能否解决；模型自行判定是否可行，是否有成功但不改状态的情况；能否参考 OpenClaw。

#### 根因

| 现象 | 根因 |
|---|---|
| 结束即成功 | 运行记录在派发后立即写入，之后不再更新 |
| 阻塞不知情 | 提问和计划审批在任何权限模式下都要人答；等待没有超时；任务记录不变；推送只发给"最近标签页"里有该会话的人 |
| 模型错误不知情 | 循环内部重试耗尽后会话进入错误状态，或因额度、凭证问题停在等待；任务记录不知道 |
| 熔断不可靠 | 只统计派发失败，计数在内存里 |

#### 思考 1：更多状态标记能否解决

能，但要分成两条轴，因为可靠程度不同。

**执行状态**（系统观测，可靠）：

| 值 | 含义 | 终态 |
|---|---|---|
| `running` | 已派发，循环在跑，含后台任务和自动续跑 | 否 |
| `blocked` | 等待人工或等待额度，`block_reason` 说明原因 | 否 |
| `completed` | 这一轮及其续跑链正常结束 | 是 |
| `failed` | 派发失败，或循环以错误结束 | 是 |
| `interrupted` | 被用户中断，或被服务重启打断 | 是 |
| `timed_out` | 超过最长运行时长，或阻塞等待超时 | 是 |
| `skipped` | 未派发：目标会话正忙、无权限、项目或目标缺失 | 是 |
| `missed` | 未派发：停机或迟到超过容差 | 是 |
| `success` | 仅旧记录，表示"已派发"，界面显示为"已派发（旧记录）" | 是 |

`block_reason`：`question`（待回答）、`plan`（待批准计划）、`permission`（待授权）、`provider_wait`（等待额度或模型）。

**任务结果**（模型自报，仅供参考）：`done`（已完成）、`partial`（部分完成）、`blocked`（受阻）、`no_change`（无需处理）、空（未汇报）。

**合成结论**（接口计算，不落库）：

| 结论 | 条件 | 显示 |
|---|---|---|
| 成功 | `completed` 且自报 `done` 或 `no_change` | ✓ 成功 |
| 待确认 | `completed` 且未汇报 | ? 待确认 |
| 未完成 | `completed` 且自报 `partial` 或 `blocked` | ◐ 未完成 |
| 失败 | `failed` 或 `timed_out` | ✗ 失败／超时 |
| 其余 | 与执行状态同名 | 运行中、阻塞、已中断、已跳过、已错过 |

"需要关注"包含：失败、超时、未完成、阻塞、已中断，以及被自动暂停的任务。"待确认"有独立徽标，可在高级筛选里选，但不计入"需要关注"。

三个现象的对应：阻塞和模型错误由执行状态轴解决；"结束即成功"由两轴合成解决。

#### 思考 2：让模型自行判定是否完成

可行，但只能当参考证据。现有代码里没有可复用的"汇报结果"工具（子代理的结果取最终文本，后台任务的状态由服务端标记），需要新增。

| 失效形态 | 能否解决 | 对策 |
|---|---|---|
| 做完了没汇报 | 能缓解 | 提示里附无人值守约定；正常结束却没汇报时自动追问一次；仍没有则标"未汇报"，不算成功也不算失败 |
| 没做完却报完成 | 无法根除 | 汇报必须带摘要；独立验收留作后续增强 |
| 汇报后又出错 | 能 | 以系统执行状态为准，自报内容保留 |
| 中途多次汇报 | 能 | 取最后一次 |
| 没机会汇报（阻塞、超时、崩溃） | 能 | 由执行状态轴兜底 |

**选定：系统状态 + 模型自报**（决策 9）。

#### 思考 3：参考 OpenClaw

| OpenClaw 的做法 | 本方案的对应 |
|---|---|
| "排队成功不等于成功"，运行要等这一轮真正落定 | 运行记录派发时为 `running`，落定后才写终态 |
| 执行状态与完成判定是两个字段；不从模型的文字推断失败，只有运行期错误算失败 | 执行状态与任务结果两条轴 |
| 无人值守约定：告知模型无人在场，最终回复必须是交付物 | 运行提示附约定 |
| `record_result` 工具自报结果和摘要；上次的有效结果带入下次提示 | `ScheduledTaskReport` 工具；上次结果写入约定 |
| 首次回复只是"收到、处理中"时自动追问一次 | 未汇报时追问一次 |
| 看门狗超时，默认 60 分钟 | 每次运行最长时长，默认 60 分钟 |
| 重启后没有终态记录的运行标为中断 | 启动对账 |
| 连续失败自动停用，记录原因并通知所有者；告警有阈值和冷却 | 熔断落库并通知 |
| 任务级模型是"任务主模型"，不抹掉会话保存的模型偏好 | 模型策略的"临时覆盖" |
| 代理创建的任务，工具不超过创建时的范围，不能放宽 | 能力上限 |
| 运行只能管理自己的任务 | 无人值守会话只能停用或删除自己 |

#### 实现：派发与跟踪

**派发**（`scheduled-task-service.ts` 的 `runTask`）：

1. 前置检查：所有者身份、项目权限、目标会话。不通过则直接写终态记录（`skipped` 或 `failed`）。
2. 消耗一次计划次数并推进下次执行时间（手动运行除外）。
3. 解析目标会话（新建或复用），按 [3.6](#36-目标-7复用叙述者时的模型) 同步配置。
4. 写运行记录，状态 `running`，带计划时间、触发方式、模型、截止时间。
5. 在运行登记表里登记，使权限层在循环启动前就能查到遇阻策略。
6. 发送消息（指令 + 无人值守约定），把返回的消息 ID 记为 `trigger_message_id`。
7. 发送抛错则写终态 `failed`（派发失败）并注销。

**跟踪**（新增 `scheduled-task-run-tracker.ts`）：

事件只用来标记"可能有变化"，真正的状态迁移在落定检查里做，这样重启后和事件丢失时都能自愈。

| 信号 | 用途 |
|---|---|
| `narrator:permission_request`、`narrator:attention`（待授权） | 标记阻塞。待授权事件带工具调用 ID，据此得出是提问、计划还是授权 |
| `narrator:attention_resolved` | 回到运行中 |
| `narrator:status_changed` | 进入空闲时安排落定检查；`waiting` + 额度或模型不可用时标记为等待额度 |
| `narrator:error` | 记录错误详情 |

事件语义上的两个坑：错误事件会触发两次（一次状态仍为 `working`，一次为 `idle`），需去重；`waiting` 状态被反思、额度等待等多种情况共用，不能单凭它判定"等人"。

**落定检查**。会话进入空闲后延迟数秒执行，并在每轮调度里兜底执行：

1. 会话没有循环在跑，状态为空闲，没有待处理的后台任务或收件箱工作。若有，保持 `running`。
2. 找到本次运行的那一轮：`narrator_turns` 中 `trigger_message_id` 等于本记录的那一行，以及其后由系统发起的续跑（自动续跑、后台任务唤醒、追问）。其后若出现由人发起的一轮，本次运行的链到此为止。
3. 按链上最后一轮的状态和结束原因、会话的 `substatus` 和 `error_message` 得出终态：正常结束为 `completed`；错误或欠费为 `failed`；用户中断或重启为 `interrupted`；超时为 `timed_out`。
4. 若为 `completed` 且没有自报、也没追问过，则发送一次追问，状态保持 `running`。
5. 写终态、耗时、用量摘要；更新任务的最近执行摘要；必要时写 `completed_at`；累计或清零连续失败数；发通知；广播变更。

`narrator_turns` 的记录是尽力而为的（写入失败不影响运行，PostgreSQL 运行时下可能没有），所以第 3 步在找不到对应行时退回到会话行上的 `last_stop_reason`、`substatus`、`error_message`。

**启动对账**。启动就绪后，把状态为 `running` 或 `blocked` 的记录重新登记。重启恢复机制可能会自动续跑这些会话，所以等待一段宽限时间后再执行落定检查；届时会话既没在跑、也没有完成的那一轮，则标为 `interrupted`（重启）。

**看门狗**。每轮调度检查活跃记录：超过截止时间的，调用 `interruptAndWaitForIdle`（它会先拒绝挂起的授权请求）后标为 `timed_out`；"等我处理"策略下阻塞超过等待时限的同样处理，原因记为阻塞超时。

**熔断**。连续失败数存在任务行上：`failed`、`timed_out` 和前置检查失败时加一，`completed` 时清零；达到 5 次则停用任务，`pause_reason` 记为熔断，并通知所有者。

#### 实现：模型自报

- 新增工具 `ScheduledTaskReport`，参数 `outcome`（`done／partial／blocked／no_change`）和 `summary`（1–2000 字符，`no_change` 可省略）。
- 只在调用会话（或其根会话）有活跃的计划任务运行时有效，否则返回错误。只写调用方自己的运行记录，因此列入"始终允许"，只读模式下也可用。
- 不作为常驻工具（会增加每个会话的工具定义开销）。派发时加入目标会话的已启用工具清单。
- 无人值守约定随运行提示下发，按任务语言生成。中文版大意：

  ```
  这是计划任务「{名称}」的无人值守运行（计划时间 {时间}，第 {n}/{总数} 次）。没有人在场回答问题或审批。
  - 不要提问或等待确认；信息不足时按任务说明自行决定并继续。
  - 不要进入计划模式，直接执行。
  - 结束前调用 ScheduledTaskReport 汇报结果（done／partial／blocked／no_change）并附摘要。
  上次运行：{上次结果} — {上次摘要}
  ```

  下发方式优先用 `docs/INJECTION.md` 里的注入通道（会话记录里指令保持原样，约定显示为系统注入）；该通道不适合时退回为追加在指令末尾。实施时先读该文档再定。

#### 实现：遇阻策略

任务新增 `on_blocked`（`auto` 默认／`wait`）和 `blocked_wait_minutes`（默认 30）（决策 10）。

权限层通过一个无依赖的登记模块 `scheduled-run-registry.ts` 查询：按**根会话**登记，子代理的请求沿根会话解析，这样任务会话派生的子代理也遵循同一策略。

`auto`（不等人）下，在 `handlePermission` 得出"询问"之后、进入等待之前改写决定：

| 请求 | 处理 |
|---|---|
| `AskUserQuestion`（同步） | 拒绝，并告知模型：无人在场，请按任务说明自行决定并继续；确实无法继续则用 `ScheduledTaskReport` 汇报受阻 |
| `EnterPlanMode` | 拒绝，并告知直接执行 |
| `ExitPlanMode`（会话已处于计划模式时） | 自动批准 |
| 其他需要人确认的操作 | 拒绝，说明无人值守运行不能获得交互式批准。与 OAuth 外部会话"无人可答则拒绝"的现有分支同理 |
| 危险操作反思 | 反思照常自动进行；若升级为需人工确认则拒绝 |

每次自动处理都计入该次运行记录（提问、计划、授权各多少次及简要内容）。

`wait`（等我处理）下不改写决定：记录标为 `blocked` 并通知所有者，可从任务详情直接跳去处理；超过等待时限由看门狗中断。

#### 实现：通知

- 通知中心新增 `scheduled_task` 类型，链接指向任务详情（可带运行记录 ID）。收件人是任务所有者。
- 触发：运行失败、超时、阻塞（`wait` 策略）、任务被自动暂停、任务被接管（通知接管的管理员）；成功通知由任务的 `notify_on_success` 控制。
- 钉钉／飞书推送不再依赖"最近标签页"：所有者配置并启用了渠道就推送。同一连续失败序列只推首次和自动暂停，避免刷屏。

---

### 3.6 目标 7：复用叙述者时的模型

**需求。** 复用同一叙述者时，增加任务配置决定发起时是否强制叙述者使用的模型。思考：是否只给计划任务创建的叙述者加特殊标记。

#### 模型作用方式（决策 11）

任务新增 `model_policy`，仅在"复用同一个叙述者"时有意义：

| 值 | 行为 | 实现 |
|---|---|---|
| `follow` 沿用会话当前模型 | 不干预。任务模型只在首次创建会话时生效 | 无 |
| `temporary` 仅本次运行临时覆盖 | 本轮切到任务模型，结束后恢复会话原来的模型 | 发消息时带 `executionIntent.modelOverride = { model, mode: "temporary" }`，走现有的 `applyAcceptedModelOverride` 和循环结束时的还原 |
| `sync` 每次运行前同步并保持 | 派发前把会话模型改为任务模型并保持 | 同一机制，`mode: "permanent"` |

- 任务模型为"跟随默认"时，覆盖值为 `FOLLOW_DEFAULT_MODEL`。
- 新任务默认 `sync`；旧任务迁移后为 `follow`，行为不变（默认 m）。
- `temporary` 的已知限制写进界面说明：恢复发生在本轮结束时，之后由后台任务唤醒的续跑会用回原模型；PostgreSQL 运行时下不执行恢复。
- 需要改动：`sendMessage` 增加一个可选参数把 `executionIntent` 传到 `enqueueBufferedMessage`（该函数已有此形参，目前传的是空）。
- 每次运行实际使用的模型记在运行记录的 `model` 列。

#### 思考：特殊标记（决策 12）

| 方案 | 评价 |
|---|---|
| **复用现有标记，补界面提示** | 任务创建的会话已有 `scheduled` 标记和 `scheduled_task_id`，足以定义"任务专属会话"。缺的是前端使用和说明 |
| 专属会话锁定模型和权限 | 最明确，但人临时想在这个会话里换模型聊几句也不行 |
| 不加标记也不提示 | 改动最少，但人在会话里看不出它受任务控制 |

**选定：第一项。**

- "任务专属会话"定义为 `narrators.scheduled_task_id` 等于该任务的会话。现在复用模式只会复用任务自己创建的会话，所以配置同步只对专属会话生效这一点在数据上已经成立。
- 会话详情接口显式返回 `scheduledTaskId`。会话页顶部显示横幅："由计划任务「名称」托管 · 模型与权限以任务配置为准"，可跳回任务。当前用户看不到该任务时显示不含名称的通用文案。
- 模型选择器不锁定。任务策略为 `sync` 时，手动切换模型后提示"下次按计划运行时会恢复为任务模型"。

#### 权限模式与系统提示的同步（默认 j）

专属会话每次派发前，若会话的权限模式或系统提示与任务配置不同，则同步为任务配置。权限模式走与 `PATCH /api/narrators/:id/permission-mode` 相同的服务路径，保证广播一致。这不是开关：把任务从"全部放行"改成"只读"后，复用的会话必须跟着变。

---

### 3.7 目标 5：界面重做

**需求。** 全面更改界面，自然、美观；区分已完成和未完成、创建者；查看与编辑分开；加入筛选和快速筛选。

#### 路由（决策 13）

| 路由 | 页面 | 文件 |
|---|---|---|
| `/scheduled-tasks` | 列表 | `frontend/routes/scheduled-tasks/index.tsx`（重写） |
| `/scheduled-tasks/new` | 新建 | `frontend/routes/scheduled-tasks/new.tsx` |
| `/scheduled-tasks/$taskId` | 详情，只读 | `frontend/routes/scheduled-tasks/$taskId/index.tsx`（由 `$taskId.tsx` 迁入） |
| `/scheduled-tasks/$taskId/edit` | 编辑 | `frontend/routes/scheduled-tasks/$taskId/edit.tsx` |

与知识库条目页"阅读优先，编辑独立成页"的做法一致。详情和编辑共用一个加载任务的框架组件。

#### 列表（决策 14）

- **搜索框**：按名称和指令搜索，服务端执行。
- **快速筛选**：进行中（默认）／已结束／全部；需要关注；我创建的／叙述者创建。
- **高级筛选**（弹出面板）：项目、创建者、调度类型、最近结果、运行方式。
- **排序**：下次执行、最近执行、创建时间、名称。
- 筛选状态放在地址栏参数里（`validateSearch`），可分享、可后退；默认值不写入地址。解析器放在 `frontend/lib/scheduled-task-search.ts`，仿 `knowledge-browse-search.ts`。
- 区分"还没有任务"和"没有匹配的任务"两种空状态。
- **每行**：名称；人话版调度及进度（如"每周一 07:00 · 剩 2 次"）；下次执行的相对时间；最近一次执行的结论徽标；创建者头像（叙述者创建的带角标）；启停开关；"更多"菜单（立即运行、编辑、复制为新任务、清理会话、删除）。行内不再排一串图标按钮。
- 桌面和移动端各渲染一套筛选控件，沿用叙述者列表的做法。

#### 详情（只读）

| 区块 | 内容 |
|---|---|
| 头部 | 名称、生命周期徽标、下次执行；操作：立即运行、暂停／恢复、编辑、更多 |
| 概览 | 人话版调度、时区、进度（已执行 n／总数）、接下来五次执行时间 |
| 创建者与所有者 | 见 [3.4](#34-目标-3创建者溯源)；管理员可见"转移所有者" |
| 最近一次执行 | 结论、自报摘要、耗时、模型、"打开会话"；阻塞时显示"去处理" |
| 运行记录 | 计划时间、触发方式、结论、摘要、耗时、模型、会话链接；可按结论筛选；游标分页 |
| 配置摘要 | 运行方式、目录、会话方式、模型及作用方式、权限模式、遇阻策略、最长时长、会话保留策略；指令正文仅对有权限者显示 |

操作按钮按接口返回的能力位显示或禁用。

#### 编辑／新建

分节，高级项默认折叠，侧边（窄屏在下方）实时显示接下来的执行时间。

| 节 | 字段 |
|---|---|
| 基本 | 名称、指令 |
| 调度 | 三种模式（指定时间／重复／Cron）、结束条件、时区（可搜索下拉，默认浏览器时区） |
| 运行方式 | 独立／项目、工作目录、每次新建／复用、模型、模型作用方式（仅复用时）、权限模式 |
| 无人值守 | 遇阻策略及等待时限、最长运行时长、成功时通知 |
| 会话保留 | 现有的清理策略 |
| 高级 | 系统提示、语言 |

- "指定时间"用 `@mantine/dates` 的日期时间选择器（本项目首次使用；提供方已在 `CoreProviders.tsx` 配好）。选择器给出的墙上时间按任务时区解释，不做浏览器时区换算。
- "重复"是一句话式的构造器："每 [1] [周] 在 [一 二 三…] 的 [07:00]"，下方是结束条件：永不／执行 N 次／截止到某天。
- 预览调用预览接口，带防抖；校验错误显示在对应字段旁。
- 时区下拉沿用 `OutlineDigestSettingsSection.tsx` 的做法（`Intl.supportedValuesOf("timeZone")`，可搜索，限制显示条数）。

#### 其他界面改动

- **审批卡片**：`frontend/components/narrator/permission/` 下为 `ScheduledTask` 增加专用内容，见 [3.3](#33-目标-1叙述者创建与权限控制)。
- **托管横幅**：见 [3.6](#36-目标-7复用叙述者时的模型)。
- **实时更新**：服务端在任务或运行记录变化时发出事件，WebSocket 合并广播一个不带数据的"有变化"帧；前端收到后令相关查询失效，重连时也失效一次。做法与 `human_attention_changed` 和 `useHumanAttention.ts` 相同。
- **状态配色**：运行结论的颜色和图形沿用 `frontend/lib/status-registry.ts` 的语义（运行中蓝、等待黄、错误红、完成绿）。
- **删除用户确认框**（`frontend/routes/settings/users.tsx`）：列出将被接管的任务。

#### 改名（决策 15）

只改中文文案，把"定时任务"改为"计划任务"：

| 文件 | 键 |
|---|---|
| `frontend/locales/zh-CN/nav.json` | `scheduledTasks` |
| `frontend/locales/zh-CN/scheduledTasks.json` | `title`、`empty`、`triggerScheduled` 等，整份随界面重写 |
| `frontend/locales/zh-CN/common.json` | `recentTabScheduled` |
| `frontend/locales/zh-CN/narrator.json` | 消息来源 `scheduledTask` |
| `frontend/locales/zh-CN/errors.json` | 实体名 `ScheduledTask` |
| `frontend/locales/zh-CN/routines.json` | `tpToolDescScheduledTask` |
| `server/lib/builtin-routines.ts` | 两个工具的 `descriptionZh` |

英文文案、路由、接口、表名、工具名都不变。新增的字符串同时写 `en` 和 `zh-CN`。

---

## 4. 数据模型变更

只加列，不建新表，不重建现有表。所有新列都有默认值或可空，`ensureColumns` 能为历史分叉的数据库补列。`status`、`last_status` 等枚举在库里是无约束的文本列，扩充取值不需要迁移。

### 4.1 `scheduled_tasks` 新增列

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `schedule` | JSON 文本，可空 | 空 | 结构化调度；空表示旧行，读时由 `cron_expr` 推导 |
| `schedule_kind` | 文本，可空 | 空 | `at／repeat／cron`，供筛选，避免在 SQL 里解析 JSON |
| `fired_count` | 整数 | 0 | 本调度序列已消耗的计划次数 |
| `completed_at` | 文本，可空 | 空 | 已结束的时间 |
| `pause_reason` | 文本，可空 | 空 | `user／circuit_breaker` |
| `consecutive_failures` | 整数 | 0 | 熔断计数 |
| `owner_user_id` | 文本，可空，外键 `users`，删除置空 | 空 | 运行身份和权限主体 |
| `creator_kind` | 文本 | `user` | `user／narrator` |
| `creator_narrator_id` | 文本，可空，无外键 | 空 | |
| `creator_message_id` | 文本，可空，无外键 | 空 | |
| `creator_tool_call_id` | 文本，可空，无外键 | 空 | |
| `creator_tool_use_id` | 文本，可空 | 空 | |
| `creator_snapshot` | JSON 文本，可空 | 空 | `{ username?, narratorTitle?, rootNarratorId? }` |
| `last_modified_by` | JSON 文本，可空 | 空 | `{ kind, userId, narratorId?, toolCallId?, action, at }` |
| `model_policy` | 文本 | `follow` | `follow／temporary／sync`；新建时服务层写 `sync` |
| `on_blocked` | 文本 | `auto` | `auto／wait` |
| `blocked_wait_minutes` | 整数 | 30 | |
| `max_run_minutes` | 整数 | 60 | |
| `notify_on_success` | 布尔 | 假 | |
| `last_run_id` | 文本，可空 | 空 | |
| `last_outcome` | 文本，可空 | 空 | 最近一次自报结果 |
| `last_summary` | 文本，可空 | 空 | 最近一次自报摘要，截断到 500 字符 |

新增索引：`idx_scheduled_tasks_owner`（`owner_user_id`）、`idx_scheduled_tasks_completed`（`completed_at`）。

保留并改变含义的列：

- `cron_expr`：兼容字段，见 [3.1](#31-目标-2统一定时方案)。
- `created_by`：不可变的创建者／负责人。
- `last_status`：取值扩充为新的执行状态。

### 4.2 `scheduled_task_runs` 新增列

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `scheduled_for` | 文本，可空 | 空 | 对应的计划时间；手动运行为空 |
| `trigger` | 文本 | `schedule` | `schedule／manual`；原 `manual` 列保留并同步写入 |
| `trigger_message_id` | 文本，可空 | 空 | 注入的指令消息，用于关联 `narrator_turns` 和跳转 |
| `block_reason` | 文本，可空 | 空 | |
| `blocked_at` | 文本，可空 | 空 | |
| `outcome` | 文本，可空 | 空 | |
| `outcome_summary` | 文本，可空 | 空 | 最长 2000 字符 |
| `outcome_reported_at` | 文本，可空 | 空 | |
| `error_kind` | 文本，可空 | 空 | `dispatch／provider／timeout／blocked_timeout／restart／acl／busy／target_missing／user_interrupt` |
| `model` | 文本，可空 | 空 | 本次实际使用的模型 |
| `auto_handled` | JSON 文本，可空 | 空 | 自动处理的提问、计划、授权次数和简要内容 |
| `nudged` | 布尔 | 假 | 是否已追问过 |
| `missed_count` | 整数，可空 | 空 | 汇总的错过次数 |
| `deadline_at` | 文本，可空 | 空 | 看门狗截止时间 |
| `stats` | JSON 文本，可空 | 空 | 步数、工具调用数、用量摘要 |

`status` 取值扩充见 [3.5](#35-目标-6执行状态记录)。新增索引 `idx_scheduled_task_runs_status`（`status`, `created_at`），供活跃记录的巡检使用。

### 4.3 迁移与回填

- **SQLite**：改 `server/db/schema.ts` 后运行 `bun run db:generate`。不手改 `drizzle/` 下任何文件。
- **PostgreSQL**：运行 `bun scripts/generate-postgres-schema.ts`，再运行 `bun run db:generate:pg --name scheduled_tasks_redesign`，最后 `bun run db:check:pg`。
- **数据回填**放在应用代码里，不写进迁移 SQL。在 `scheduledTaskService.recoverOnStartup` 开头做一次幂等的归一化，用 Drizzle 查询构造器分批处理（任务总量有 500 的上限）：
  - `schedule` 为空的行：由 `cron_expr` 生成 `schedule` 和 `schedule_kind`。
  - `owner_user_id` 为空且 `created_by` 非空的行：`owner_user_id = created_by`。
  - `creator_snapshot` 为空且 `created_by` 非空的行：写入当前用户名。
- 归一化失败只记日志，不阻塞启动；读路径对 `schedule` 为空的行有即时推导兜底。
- **数据导入导出**：计划任务表不在快照里，本次不新增表，`data-portability.ts` 无需改动。按仓库规则，改完 schema 仍跑一遍 `bun test --isolate server/services/__tests__/data-portability*.test.ts`。
- **其他类型扩充**（不涉及迁移）：`NotificationKind` 增加 `scheduled_task`，`NotificationLink` 增加对应分支。

---

## 5. 接口变更

全部在 `/api/scheduled-tasks` 下。所有接口先按 [3.3](#33-目标-1叙述者创建与权限控制) 的规则校验，不可见返回 404。

| 方法与路径 | 变化 |
|---|---|
| `GET /` | 加可见范围过滤；支持查询参数 `lifecycle`（默认 `active`）、`attention`、`creator`、`owner`、`projectId`、`kind`、`result`、`runContext`、`q`、`sort`。返回摘要投影：不含指令和系统提示正文，只给预览和长度。仍返回数组，超过上限时带截断响应头 |
| `GET /summary` | 新增。可见范围内的计数：进行中、已结束、需要关注 |
| `GET /:id` | 返回完整任务，内嵌创建者、所有者、能力位、生命周期、进度、接下来五次执行时间；无权看指令时不返回正文 |
| `POST /` | 接受 `schedule`（或旧的 `cronExpr`）及新字段；所有者为当前用户；校验项目写权限和配额 |
| `PUT /:id` | 仅所有者和管理员；调度规则变化时重置计数 |
| `POST /:id/toggle` | 所有者、管理员、项目管理者；已结束的任务拒绝启用 |
| `POST /:id/run` | 仅所有者和管理员 |
| `GET /:id/runs` | 返回新字段和合成结论；支持按结论筛选 |
| `POST /:id/cleanup` | 权限不变 |
| `DELETE /:id` | 仅所有者和管理员 |
| `POST /:id/transfer` | 新增。仅管理员，转移所有者 |
| `POST /preview-schedule` | 新增。校验并预览调度；传入叙述者 ID 时一并返回能力上限的判定结果，供审批卡片使用 |

其他接口：

- `GET /api/narrators/:id`：显式返回 `scheduledTaskId`。
- `GET /api/dashboard/summary`：任务计数改为按可见范围，并只算进行中的。
- `DELETE /api/admin/users/:id`：同一事务内把名下任务转给执行删除的管理员。

WebSocket：新增不带数据的 `scheduled_tasks_changed` 帧；事件总线新增 `scheduled_task:changed`。

---

## 6. 叙述者工具变更

| 工具 | 变化 |
|---|---|
| `ScheduledTask` | 接受结构化 `schedule`（保留 `cronExpr` 简写）和新字段；新增只读动作 `preview`；所有动作按本轮用户的可见范围执行；创建和修改经过能力上限处理；记录创建者和修改者；结果里带人话版调度和接下来的执行时间。动作分类仍在 `scheduled-task-actions.ts`，未登记的动作默认按修改处理 |
| `ScheduledTaskAdmin` | 改为兼容别名，委托给同一服务并保留管理员检查；不再增加功能；描述标注"已由 ScheduledTask 取代"。下一个版本移除 |
| `ScheduledTaskReport` | 新增，见 [3.5](#35-目标-6执行状态记录) |

权限层（`narrator-permission.ts`）的改动点：

1. `ScheduledTask` 分支：任务专属会话只放行读操作和对自己任务的停用、删除。
2. `handlePermission` 得出"询问"后，按遇阻策略改写决定。
3. `EnterPlanMode` 在"不等人"策略下拒绝。
4. `ScheduledTaskReport` 加入始终允许清单，并加入只读能力上限的豁免。

---

## 7. 文件清单

**新增**

| 文件 | 内容 |
|---|---|
| `shared/scheduled-task-schedule.ts` | 调度类型、规范化、描述用的结构化信息、旧 cron 转换 |
| `shared/scheduled-task-status.ts` | 执行状态、任务结果、合成结论、生命周期的类型和推导函数 |
| `server/lib/schedule-engine.ts` | 下次执行时间、预览、区间计数、校验 |
| `server/services/scheduled-task-acl.ts` | 可见与管理判断、列表查询条件 |
| `server/services/scheduled-task-run-service.ts` | 运行记录的创建、状态迁移、自报、终结 |
| `server/services/scheduled-task-run-tracker.ts` | 事件订阅、落定检查、启动对账、看门狗 |
| `server/services/scheduled-run-registry.ts` | 无依赖的内存登记表，供权限层查询遇阻策略 |
| `server/services/scheduled-task-notify.ts` | 应用内通知和渠道推送 |
| `server/lib/agent/tools/scheduled-task-report.ts` | 自报工具 |
| `server/lib/agent/tools/call-provenance.ts` | 由 `outline.ts` 提出的工具调用溯源函数 |
| `frontend/routes/scheduled-tasks/new.tsx`、`$taskId/index.tsx`、`$taskId/edit.tsx` | 三个页面 |
| `frontend/components/scheduled-tasks/*` | 调度编辑器与预览、调度摘要、列表筛选、列表行、创建者展示、运行结论徽标、运行记录、任务表单、托管横幅 |
| `frontend/components/narrator/permission/ScheduledTaskApproval.tsx` | 审批卡片内容 |
| `frontend/lib/scheduled-task-search.ts` | 地址栏筛选参数的解析 |
| 各模块对应的测试文件 | 见 [9](#9-测试计划) |

**修改**

| 文件 | 改动 |
|---|---|
| `server/db/schema.ts`、生成的 `drizzle/`、`server/db/postgres-schema.ts`、`drizzle-postgres/` | 新列和索引 |
| `server/services/scheduled-task-service.ts` | 调度推进、已结束、错过、计数、所有者身份、配置同步、派发流程、启动归一化 |
| `server/services/scheduled-task-scheduler.ts` | 容差判断、调用巡检 |
| `server/services/scheduled-task-cleanup.ts` | 归属判断改用所有者 |
| `server/lib/validators/scheduled-tasks.ts` | 新字段和调度校验 |
| `server/routes/scheduled-tasks.ts` | 权限、筛选、新接口 |
| `server/routes/admin.ts`、`server/services/user-deletion.ts` | 删除用户时接管任务 |
| `server/routes/dashboard.ts` | 按可见范围计数 |
| `server/routes/narrators.ts` | 返回 `scheduledTaskId` |
| `server/services/narrator-session.ts` | `sendMessage` 增加传递 `executionIntent` 的可选参数 |
| `server/services/narrator-permission.ts` | 见 [6](#6-叙述者工具变更) |
| `server/services/narrator-service.ts` | 创建会话时可指定初始启用的工具 |
| `server/lib/agent/tools/scheduled-task.ts`、`scheduled-task-admin.ts`、`scheduled-task-actions.ts`、`index.ts`、`outline.ts` | 见 [6](#6-叙述者工具变更) |
| `server/lib/builtin-routines.ts`、`server/services/tool-load-markers.ts` | 工具描述和加载规则 |
| `server/lib/event-bus.ts`、`server/websocket/narrator-ws.ts`、`narrator-ws-types.ts` | 变更事件和广播帧 |
| `shared/notification-center.ts`、`server/services/notification-fanout.ts` | 新通知类型 |
| `server/lib/settings/*` | 配额和最短间隔的设置项 |
| `frontend/routes/scheduled-tasks/index.tsx` | 重写；删除 `$taskId.tsx` |
| `frontend/hooks/useScheduledTasks.ts`、`frontend/lib/api/scheduled-tasks.ts`、`frontend/lib/cron-presets.ts` | 新接口和类型；预设转换逻辑并入共享模块后删除或瘦身 |
| `frontend/components/narrator/permission/InlinePermission.tsx`、`vlist/render/RenderPermission.tsx` | 接入审批卡片 |
| 会话页头部组件 | 托管横幅和模型切换提示 |
| `frontend/routes/settings/users.tsx` | 删除确认框 |
| `frontend/locales/{en,zh-CN}/*.json` | 见 [3.7](#37-目标-5界面重做) |
| `CLAUDE.md` | "深入文档"里加上本文 |

---

## 8. 实施步骤

一个 PR，按下面的顺序分提交。每一步结束时代码能通过类型检查和相关测试。

**准备。** 工作树里没有依赖：先 `bun install`。类型检查前需要生成路由树（`routeTree.gen.ts` 不入库，由前端构建或开发服务器生成）。不要停止或重启正在运行的 NarraFork 进程。

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | 共享调度类型和调度引擎，纯函数加单元测试 | `bun test --isolate server/lib/__tests__/schedule-engine*`、`shared/__tests__/scheduled-task-*` |
| 2 | Schema 新列和索引；生成 SQLite 和 PostgreSQL 迁移；启动归一化 | `bun run db:generate`、`bun run db:check:pg`、数据导入导出测试 |
| 3 | 服务层：调度推进、已结束、错过、计数；校验器；预览接口 | 服务层新测试；现有 `scheduled-task-*` 测试 |
| 4 | 权限：所有者、可见范围、路由守卫、列表过滤、仪表盘、删除用户接管 | 权限测试；`scheduled-task-principal.test.ts` 调整后通过 |
| 5 | 溯源：创建者字段、工具调用溯源、接口内嵌显示信息 | 工具测试 |
| 6 | 执行跟踪：运行记录生命周期、跟踪器、启动对账、看门狗、熔断落库 | 跟踪器测试（用事件和假时钟） |
| 7 | 无人值守：约定下发、自报工具、追问、遇阻策略 | 权限层相关测试；自报工具测试 |
| 8 | 模型三态；权限模式和系统提示同步 | 派发流程测试 |
| 9 | 叙述者工具：合并、能力上限、配额、审批所需的预览数据 | `scheduled-task.test.ts`、`scheduled-task-admin.test.ts` 更新 |
| 10 | 通知和实时广播 | 通知测试 |
| 11 | 前端：接口类型和 hook → 共享组件 → 列表 → 详情 → 编辑／新建 → 审批卡片 → 托管横幅 → 改名和文案 | 组件测试；`bun run build` |
| 12 | 文档和收尾 | `bunx tsgo --noEmit`、`bunx @biomejs/biome check .` |

每一步都跑 `bunx tsgo --noEmit` 和对改动文件的 `bunx @biomejs/biome check`。本地只跑相关测试，全量回归交给 PR 的 CI。

更新日志需要写明的行为变化：

- 计划任务列表不再对所有登录用户可见。
- 无人值守运行默认不再等待人工回答，旧任务同样生效。
- 运行记录的"成功"含义变化；旧记录显示为"已派发（旧记录）"。
- 中文名称由"定时任务"改为"计划任务"。

---

## 9. 测试计划

| 范围 | 要点 |
|---|---|
| 调度引擎 | 每种规则的下次执行时间；间隔大于 1 的对齐；次数和截止边界；`at` 列表耗尽；夏令时跳过和重复；月末与闰日；时区；迭代上限；旧 cron 的转换往返 |
| 推进与错过 | 容差内派发、容差外记错过；启动时汇总错过并正确扣次数；暂停不扣次数；改规则后计数归零；已结束的写入与清除 |
| 权限 | 可见矩阵的每一格；不可见返回 404；列表过滤；能力位；项目成员看不到指令；删除用户后所有者变更；管理员转移 |
| 溯源 | 用户创建与叙述者创建的字段；子代理调用；快照；对象删除后的显示数据；旧行的默认值 |
| 执行跟踪 | 正常结束、出错、用户中断、超时各自的终态；错误事件去重；后台任务未完时不终结；自动续跑链；人工接话后链的截断；找不到 `narrator_turns` 行时的回退；启动对账；看门狗；熔断计数与自动暂停 |
| 自报 | 结果写入；多次汇报取最后一次；不在运行中时调用报错；未汇报时追问一次且只一次；合成结论的每种组合 |
| 遇阻策略 | `auto` 下提问、进入计划模式、退出计划模式、其他询问各自的处理；子代理沿根会话解析；`wait` 下标记阻塞和超时中断；自动处理的记录 |
| 模型策略 | 三态各自对会话模型的影响；临时覆盖的恢复；任务模型为"跟随默认"；权限模式和系统提示同步 |
| 工具 | 能力上限的默认值和 `elevated／outsideScope` 标记；配额；最短间隔；专属会话只能管理自己；`ScheduledTaskAdmin` 别名行为；动作分类守卫 |
| 前端 | 地址栏参数解析；调度编辑器三种模式的输入输出；调度摘要文案；结论徽标；两种空状态 |
| 既有测试 | `scheduled-task-cleanup`、`scheduled-task-list-cap`、`scheduled-task-principal`、`cron`、数据导入导出、SQLite 方言清单守卫 |

新增或修改 Worker 的地方没有；本次不涉及 Worker。

---

## 10. 风险与待核实项

**风险**

| 风险 | 应对 |
|---|---|
| `narrator-permission.ts` 是核心文件，改动点多 | 改动集中在三处并各有测试；遇阻改写放在得出"询问"之后，不动判定本身 |
| 会话事件语义复杂（错误触发两次、`waiting` 多义） | 事件只触发检查，终态由落定检查读持久状态得出 |
| 运行归属在复用会话里不易界定（人工接话、自动续跑、后台唤醒） | 以触发消息关联的那一轮为起点，按消息来源区分系统续跑和人工接话；专门写测试 |
| 旧任务升级后默认"不等人"是行为变化 | 写入更新日志；任务可改回"等我处理" |
| PostgreSQL 运行时的差异 | 临时模型覆盖不恢复、`narrator_turns` 可能缺失，都有说明或回退 |
| SQLite 方言清单守卫 | 新代码用 Drizzle 查询构造器；用 `schedule_kind` 列避免在 SQL 里解析 JSON |
| 时区和夏令时出错 | 引擎是纯函数，测试覆盖集中在这里 |
| 主线程性能 | 所有查询有上限；错过计数有迭代上限；巡检只扫活跃记录；列表不读大字段 |
| 热重载 | 内存登记表和监听器用 `hotSafe`、`hotOnce`、`hotTimer` |

**实施时待核实**（都不影响方案走向）

1. `runAgentLoop` 之后"待处理工作"的判定函数是否可复用（调研指向 `agent-runtime/orchestrator.ts` 的相应位置），否则在跟踪器里按后台任务和收件箱查询实现。
2. 危险操作反思升级为人工确认的具体路径，以确定"不等人"策略下拒绝的落点。
3. `publicNarratorResponse` 是否已包含 `scheduledTaskId`。
4. 可选工具与 `BUILTIN_ROUTINES` 的关系：`ScheduledTaskReport` 不应出现在用户可切换的例程列表里。复用的会话若仍在内存中，启用工具要同时更新库里的清单和内存中的已启用集合，应走 `tool-loading-service` 而不是直接改列。
5. 无人值守约定用注入通道还是追加在指令末尾，读 `docs/INJECTION.md` 后定。
6. Mantine 9 日期时间选择器的值类型，与墙上时间字符串的转换。
7. 通知中心前端对新通知类型的渲染入口。
8. 重启恢复自动续跑的宽限时间取多少合适。

---

## 11. 不在本次范围

这些在讨论中出现过，方案留了余地，但本次不做：

- 叙述者"提议待确认"和分级授权（[3.3](#33-目标-1叙述者创建与权限控制) 的方案二、三、四）。
- 运行结束后的独立验收（模型复核或检查命令）。
- 把任务单独共享给指定用户或角色。
- 后台回填旧任务的创建来源。
- 用自然语言描述调度。
- 调度器失败后的自动重试（循环内部已有瞬时错误重试）。
- 任务指向任意已有会话（现在只复用任务自己创建的会话）。
- 任务变更的完整审计日志（本次只记最近一次修改者）。
