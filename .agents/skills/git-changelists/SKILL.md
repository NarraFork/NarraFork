---
name: git-changelists
description: 按任务管理 NarraFork 动态变更分组；用于初始化、同步、选组、文件或修改块移组、活动组切换与只读 SQLite 查询，以及经明确授权提交或删除组。普通 Git 操作不自动改用分组。
---

# 动态变更分组

每个改动单元只属于一个组，同一文件的不同块可以分组。普通编辑实际触及、需要重建的修改区域进入活动组，未触及旧修改保留原组；只刷新或切换活动组不重排已有修改。普通 Git 暂存区独立，初始化、同步、移组与切换活动组不改写工作文件或原生 index；提交按协议安全同步原生 index。

## 先定位，再查询

1. 确认设备、仓库、目标组和授权文件范围。加载 Skill 不是提交或删除授权，普通 Git 任务不自行改成分组任务。
2. 按动作读取下表中的[完整协议](../../../docs/GIT_STAGING_LISTS.md)。用清除了外来 Git 环境覆盖的子进程定位；linked worktree 使用实际 Git-dir，不把 `.git` 指针文件或 common-dir 当目录。
3. 组与归属存于 `<ACTUAL_GIT_DIR>/narrafork/changelists/changelists.sqlite`。只读查询用稳定视图，所有写入经同一内核的 CLI；不直接 SQL 修改归属、不手工操作候选 index 或锁。

| 动作 | 先读协议 |
| --- | --- |
| 定位与首次初始化 | [§1 定位](../../../docs/GIT_STAGING_LISTS.md#1-定位实际-git-dir)、[§2 动态归属](../../../docs/GIT_STAGING_LISTS.md#2-初始化与动态归属) |
| 查询与同步 | [§3 SQLite](../../../docs/GIT_STAGING_LISTS.md#3-sqlite-只读查询)、[§4 观察版本](../../../docs/GIT_STAGING_LISTS.md#4-观察版本与同步) |
| 创建、改名、活动组与移组 | [§5 离线命令](../../../docs/GIT_STAGING_LISTS.md#5-离线命令)、[§6 文件块选择](../../../docs/GIT_STAGING_LISTS.md#6-文件块选择与结果核验)、[§8 边界](../../../docs/GIT_STAGING_LISTS.md#8-授权与资源边界) |
| 提交、删除与恢复 | [§7 提交与恢复](../../../docs/GIT_STAGING_LISTS.md#7-提交与恢复)，并重读 §4 |

```sh
git rev-parse --show-toplevel
git rev-parse --absolute-git-dir
```

令输出真实路径为 `ROOT`、`ACTUAL_GIT_DIR`，以下源码入口在 NarraFork 仓库执行；打包后将 `bun server/index.ts` 换成 `narrafork`。命令无需 HTTP、常驻服务或主数据库，输出结构化 JSON。

```sh
bun server/index.ts changelists --workspace "$ROOT" init
bun server/index.ts changelists --workspace "$ROOT" sync
bun server/index.ts changelists --workspace "$ROOT" list
```

首次初始化创建活动组 `Changes`，当前改动全部进入该组；重复初始化保留已有归属。读命令默认不同步，查看返回的 `generation`、`observationId`、`scannedAt` 与 `state`，需要当前结果时显式 `sync`。数据库记录是最后完成的观察，不代表服务停止后仍实时更新。

外部 HEAD 更新时，可靠旧归属保留，已被新 HEAD 吸收的改动退出；无法可靠区分来源的剩余差异自动进入“未分组”。文本归属重叠按文件保守重算，该文件在新 HEAD 下剩余的本地单元一起进入未分组，其他可靠文件保留；能证明文件基准未变的编辑按普通编辑处理。可验证的 `MERGE_HEAD` 存在期间，新建或重建区域保守进入未分组，未触及旧块保留，标记消失后恢复普通编辑策略。HEAD 未变且无可靠标记的 squash 输出按普通编辑处理，不把 `SQUASH_MSG` 当成可靠来源证明。区域采用实际 diff 划分，相邻修改、重复文本或零宽删除可能一并重建。

schema v1、稳定视图列及必要 DTO 字段保留兼容。正常新观察的 `needsReview`/`needsReviewCount` 为 false/0，可选 `reviewReason` 省略；SQLite 的 `needs_review`/`needs_review_count` 为 0，`review_reason` 为 NULL。正常 `sync` 自动升级旧标记，单独兼容升级保留当前所属组、内容和单元身份，不搬走未编辑的旧内容，不改历史快照。独立 SQLite 查询在同步升级前仍可能读到旧值，不能通过改写视图或直接 SQL 清零来代替同步。真实 Git 未合并、读取失败、超限、提交来源映射或恢复证据错误仍明确拒绝。

“未分组”固定 ID 为 `__narrafork_unassigned__`，默认存储名为 `Unassigned`，不是按名称匹配的普通组。界面只本地化默认显示名，用户自定义改名保留；可按原规则改名、删除，后续需要时可重新启用固定身份但不恢复旧成员。此机制不升级 schema，实际归属操作仍用 CLI，不直接 SQL 写入。运行实例与 CLI 需加载同版新实现；v1 格式兼容不保证旧写入程序维持新策略，避免混版写入。

## 选择文件或块，再移组

从 `list` 选组 ID，再用 `files`、`diff` 读取当前版本的文件与 unit ID。组内 `snapshotVersion` 是局部内容 hash，分页按它核对；写动作仍用当前全局 `generation`/`observationId`。显示 hunk 不等于归属单元，预览截断不能充当完整操作范围。

```sh
bun server/index.ts changelists --workspace "$ROOT" files --list "$FROM"
bun server/index.ts changelists --workspace "$ROOT" diff --list "$FROM" --path "$FILE_PATH"
bun server/index.ts changelists --workspace "$ROOT" move \
  --from "$FROM" --to "$TO" --path "$FILE_PATH" \
  --generation "$GENERATION" --observation "$OBSERVATION"
```

`GENERATION`、`OBSERVATION` 必须来自当前查询，`FILE_PATH` 是已授权的独立相对路径。按块移动用重复的 `--unit <id>`；特殊文件路径可用 JSON 数组或 NUL 文件，见 §5。移动只改变归属，文件选择默认只动来源组的块，不复制版本、不搬走其他组的块。完成后重新查询两组核对。

创建、改名、切换活动组也使用 CLI，携带同一观察版本；切换先同步，已有块不搬动。移动使用当前 `generation`/`observationId` 和真实 unit ID；同组 `move` 完成版本、权限、组和范围校验后作为无副作用操作返回，不生成新观察。未分组按普通组移动或提交，界面的移动目标禁用当前组。版本过期、扫描不完整或冲突时先按协议核对，不能套用旧 unit ID 重试。

## 独立只读查询

本例无需 `sqlite3`。以只读连接在一个短事务中查询稳定视图，不读取内容大字段：

```sh
DB="$ACTUAL_GIT_DIR/narrafork/changelists/changelists.sqlite"
bun -e 'import { Database } from "bun:sqlite";
const db = new Database(process.argv[1], { readonly: true });
try {
  db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 100;");
  const result = db.transaction(() => ({
    workspace: db.query("SELECT * FROM v_workspace_state LIMIT 1").all(),
    lists: db.query("SELECT * FROM v_changelists LIMIT 200").all(),
    changes: db.query("SELECT * FROM v_changes LIMIT 200").all(),
  }))();
  console.log(JSON.stringify(result, null, 2));
} finally { db.close(); }' "$DB"
```

`LIMIT 200` 只是预览。完整分页、列定义及 `sqlite3 -readonly` 例子见 §3。数据库与 WAL/SHM 一起处理，**不要使用 `immutable=1`**；未知格式或损坏时停止，不删库重建。

## 提交、删除与恢复

- **提交**：先取得目标组和提交说明的明确授权，再读 §7 并用 CLI 提交。未分组与普通组采用同一提交条件，旧观察须先通过正常 `sync` 完成兼容升级。`commit` 不隐式同步，只读复核来源；陈旧时先 `sync` 后重选。原生暂存、部分暂存、ITA、真实未合并冲突或进行中的 Git 操作存在时拒绝，不能清空原生 index 绕过保护；跨组路径删除、创建项与内容拆组等原子性保护仍生效。保留 hooks、签名和身份配置；只提交目标组单元，保留其他组及提交期间的新编辑。
- **删除**：先明确授权并说明组信息将移除、其改动移回活动组；不删除工作文件。当前活动组不可删除。全范围由内核处理，不依赖是否展开组或加载文件页。
- **恢复**：有未完成操作时先按原 `operationId` 处理，普通同步不能越过预约或改写源观察与证据。保留 token receipt、备份、映射、候选和锁，按 §7 使用 `recover`；它核对 SHA256、HEAD/tree/父提交及锁身份，以 `fence_token` 阻止旧生产者发布，必要时安全安装原生 index 并投影剩余归属，不再次提交。lease 不是死亡证明；结果无法证明、lease 有效或临界区忙时拒绝，不按 PID 或超时抢占外部锁。

交付记录组 ID、实际动作、观察版本与核验结果，提交额外记录 `commitOid`。示例和 Git 写入测试只在临时仓库执行，不拿用户真实分组试运行。
