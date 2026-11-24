---
id: files.tree-snapshots
title: Tree 快照
summary: worktree 的树快照：Bash 观测、编辑预览、快照回退、写入认领。当前本地与远程都不再产生新快照，只剩读取旧记录与写入认领。
anchors:
  - server/services/worktree-tree-snapshot.ts
  - server/services/snapshot-revert.ts
  - server/services/worktree-write-claims.ts
  - server/services/tree-snapshot-loop-hooks.ts
  - server/services/tree-snapshot-paths.ts
  - server/services/narrator-tree-snapshot-hooks.ts
  - server/services/tool-edit-preview.ts
  - server/services/snapshot-capture-receipts.ts
  - server/services/struct-sed-remote-change.ts
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# Tree 快照

用不共享历史的“影子 git 仓库”给工作区做内容寻址快照：`git add -A` + `git write-tree` 得到整棵树的哈希，工具前后各记一次，两个哈希的差集能看到 Bash、构建脚本、外部编辑器这类工具输入里没写明的改动；编辑预览再从记录过的树里读回历史文件内容。

## 关键规则
- **现状：不会再新建快照。** `captureSessionTree` 先判 `isFileHistoryEnabledForDevice`（只有非 `local` 设备为真），本地直接返回 null，连 `workspace.treeSnapshotsEnabled` 都不看；`worktreeTreeSnapshot.capture` 对本地抛 "disabled"，`tryCaptureHot` 返回 null；远程设备则被 `assertLocal` 拒绝（"not implemented"）。该设置默认 false，描述写明只是兼容字段（`narrator-tree-snapshot-hooks.ts:captureSessionTree`、`worktree-tree-snapshot.ts`、`lib/settings/defaults.ts`）。下面的捕获机制仍在代码里，但上述两道门之后生产路径进不去。
- 字节精确靠 `SHADOW_ATTRIBUTES`（`* -text -filter -working-tree-encoding -ident`）加每次调用注入的 `core.autocrlf` 配置；`/.worktrees/` 被排除，真实仓库里“跟踪但被忽略”的路径强制加回（至多 5000 个，超出则整次捕获失败）。范围是 `(deviceId, worktreePath)` 而不是叙述者。
- 热路径预算 4s：超时返回 null，捕获转成该 worktree 唯一的后台暖机（单次 git 上限 10 分钟），失败后 15 分钟冷却；单次 git 调用默认 15s，列路径输出上限 32MiB（`tryCaptureHot`、`HOT_PATH_CAPTURE_BUDGET_MS` 等常量）。
- 工具边界由 `buildTreeSnapshotExecutionHooks` 在主/子叙述者共用：只对 `FILE_MUTATING_TOOLS`（Write/Edit/StructSed/Bash/GenUI 写类动作）、本地且目标确在 worktree 内的调用生效；`spec://` 虚拟文件、远程目标、重叠的 Bash 窗口都放弃边界；钩子不抛错。
- 编辑预览：`tool-edit-preview.ts` 只在 `worktree_tree_snapshots` 里确有该设备/路径/哈希的行时，才调 `readFilePreviewAtTree` 读旧内容（单文件 1MiB，带超时）；该函数只拒绝非本地设备，不看历史策略，所以旧记录仍可预览。
- 写入认领（`worktree-write-claims.ts`）是内存登记：工具执行前声明要写的路径（`declared`：`null` 表示 Bash 无法预知，`[]` 表示不写本 worktree，列表则精确），结束后封存；已关闭认领保留 5 分钟，未关闭的按 30 分钟视为封存，每个 worktree 最多 512 条。`foreignDeclaredPaths` 供 Bash 归属时扣除其他叙述者声明过的路径。认领在钩子里照常开关，编辑器本地保存也会开（`editor-document-runtime.ts:afterWrite`）。认领在没有树边界时对 Bash 归属有无实际效果：未核实。
- `snapshot-revert.ts` 现在只是回退结果的类型与断言（`RevertResult`、`SnapshotRevertError`、`unavailableSnapshotRevert`、`resolveNarratorCwd`），不再读树快照；回退流程见 [回退与文件历史](revert.md)。

## 从哪读起
- `server/services/worktree-tree-snapshot.ts`：`worktreeTreeSnapshot` 对象（capture、tryCaptureHot、diffPathStatuses、readFilePreviewAtTree、gcAll）。
- `server/services/tree-snapshot-loop-hooks.ts`、`narrator-tree-snapshot-hooks.ts`：边界记录与认领。

## 相关
- [回退与文件历史](revert.md)
- [文件变更证据](change-evidence.md)
