---
id: collaboration.teams.work-items
title: 工作项
summary: 工作项状态机、Team 工具、worktree 端口、ready 的知识检查、检查提醒、合并判定与清理。
anchors:
  - server/services/teams/work-items.ts
  - server/services/teams/work-item-ports.ts
  - server/services/teams/team-git.ts
  - server/services/teams/team-knowledge.ts
  - server/lib/agent/tools/team.ts
  - server/services/teams/__tests__/work-item-lifecycle.test.ts
  - server/services/teams/__tests__/work-item-branch-name.test.ts
  - server/services/teams/__tests__/work-item-knowledge.test.ts
  - server/services/teams/__tests__/team-checkin-brief.test.ts
keywords:
  - team_work_items
  - team_work_events
  - work.create
  - work.review
  - work.ready
  - work.sync
  - work.list
  - TEAM_WORK_ITEM_CHANGED
  - TEAM_WORK_ITEM_NOT_REVIEWED
  - TEAM_WORK_ITEM_DIRTY
  - TEAM_WORK_ITEM_KNOWLEDGE_STALE
  - TEAM_KNOWLEDGE_CHECK_UNAVAILABLE
  - TEAM_WORK_ITEM_HEAD_MOVED
  - TEAM_WORK_ITEM_HEAD_UNAVAILABLE
  - assertKnowledgeFresh
  - 知识检查
  - TEAM_WORK_ITEM_STATES
  - attachWorker
  - settleIsolatedWorkItem
  - recordWorkEvent
  - confirmedLoss
  - team.checkin
  - work.returned
  - returnWorkItem
  - TEAM_WORK_ITEM_NOT_RETURNABLE
  - Team 工具
  - Agent isolation worktree
status: draft
verified_at: 3a43303a2
---
# 工作项

工作项（`team_work_items`）是团队里的一个交付单位：一条分支、一个 worktree、一个状态。协调者经 `Team` 工具推进它，服务端只记录和校验，从不替人合并。

## 关键规则
状态与创建（`teams/work-items.ts`）：
- 状态：queued / in_progress / in_review / ready / merged / cancelled（`shared/project-teams.ts:TEAM_WORK_ITEM_STATES`）。
- 看板五列：queued、in_progress、review（含 in_review 与 ready）、done（merged）、cancelled。
- `work.create`：
  - 先经现有 narrator worktree 创建通道建分支 `team/<slug>-<id 哈希 8 位>` 与 worktree；
  - slug 只取 ASCII 单词（`workBranchSlug`：NFKD 去重音、全角折半，其余文字不音译，最多 40 字符），先取协调者给的 `branchHint`，再取标题，都没有就是 `work`；全 ASCII 是为了过 `gitBranchName`、worktree 服务的 ref 检查和 `git check-ref-format`，哈希保证唯一。`Agent({ isolation })` 的标题没有 ASCII 单词时用 description 当 hint。已有分支不改名；
  - 再写行与 `work.created` 事件，初始 `queued`。
- `Agent({ isolation: "worktree" })` 建的是 kind=`isolated` 的项，初始 `in_progress`。子代理结束时若没有提交也没有未提交改动，就清理 worktree 并取消该项（`settleIsolatedWorkItem`）。
- 第一层子代理经 `attachWorker` 记为工作者，queued 的项随之开始。

评审与就绪：
- `work.review`：blocker 把项退回 `in_progress`，clear 留在 `in_review`。
- `work.ready` 需要最新一轮评审为 clear，否则 409 `TEAM_WORK_ITEM_NOT_REVIEWED`。
- `work.ready` 还要 worktree 无未提交改动，否则 409 `TEAM_WORK_ITEM_DIRTY`。
- `work.ready` 事件除 `head`、`changedPathCount` 外还记 `mergeBase` 与 `diffStat`（钉住 head 时的 `+/-` 与文件数，best-effort，读不出为 null），已合并的项（head 已在基线里）靠它们在团队页显示大小和改动文件。
- 人从团队页退回（`returnWorkItem`，见[团队页与审批](page.md)）：只能从 in_review / ready（否则 409 `TEAM_WORK_ITEM_NOT_RETURNABLE`），记 `work.returned`（actor 为那个人，带理由），回 in_progress、`reviewRounds+1`、`lastReview = blocker`，所以再 ready 前要重新评审；持有的独占锁同事务释放。服务端只把理由作为 `team_return` 注入给协调者，由它转给工作者。
- 评审之后的新提交不拦，只在结果里计数。
- DIRTY 之后钉住一个 head 提交（读不出：409 `TEAM_WORK_ITEM_HEAD_UNAVAILABLE`）。知识检查、改动路径、独占路径判定、评审后提交计数都按它读，记录的 `headSha` 与 `work.ready` 事件的 `head` 也是它。按别的提交读出的改动路径算读不出。
- 知识检查排在钉住 head 之后、独占路径之前（`teams/team-knowledge.ts:assertKnowledgeFresh`），见下一节。
- 独占路径与路径不可读的拒绝见 [重叠与独占路径](overlap.md)。
- 写行前最后一次 await 再读 HEAD，不等于钉住的提交（工作者期间又提交了，或读不出）就 409 `TEAM_WORK_ITEM_HEAD_MOVED`，什么都不记；之后到事务结束是同步的。没有知识树的仓库也一样。

`work.ready` 的知识检查（`teams/team-knowledge.ts`，规则本身在 `shared/knowledge-tree.ts`，与 `scripts/knowledge.ts` 同一份）：
- 先按确切路径查钉住的提交里的 `knowledge/index.md`（`team-git.ts:treeEntry`，`ls-tree` 不带 `-r`），不是普通文件 blob（模式 100644/100755）就整个跳过，不列 `knowledge/`；所以没有标记的大 `knowledge/` 不会撞列表上限。
- 改动路径：合并基（基线提交与钉住的 head）→ head 的 `diff --name-status --no-renames`，改名两边都算；状态 `A` 的算新增，改名的新路径也是（`team-git.ts:branchFileChanges`）。
- 节点是钉住的提交里 `knowledge/` 下除 `README.md` 外的 `.md` 普通文件（模式 100644/100755，符号链接与子模块不读）。`treeBlobs`（`ls-tree -r -l`）列出 blob id 与大小，个数与字节上限按列出的大小在读任何内容之前判定；再经 `readBlob`（`cat-file blob`，16 个并发，读到大小 +1 字节即停，长度不符即失败）从 git 对象读，不读 worktree 文件。没有节点头部的文件跳过。
- 某节点的锚点命中改动路径、而节点文件本身不在改动路径里，就要更新；改了节点文件就算，哪怕只改 `verified_at`。
- 分支新增的源文件（`server/`、`frontend/`、`shared/` 下的 `.ts/.tsx/.go`，排除测试等，同工具）没有任何节点锚定，就是缺口；只看新增，不看修改。宽锚点也算覆盖（`coverage` 不算）。
- 有要更新的节点或缺口：409 `TEAM_WORK_ITEM_KNOWLEDGE_STALE`。`details` 为 `head`、`mergeBase`、`nodes`（最多 20 个，每个 `{ file, files, moreFiles }`，`files` 最多 10 个）、`moreNodes`、`uncovered`（最多 20 个）、`moreUncovered`。消息是英文（团队错误不走错误目录、不本地化），写明让工作者更新节点（或核对后只改 `verified_at`）、给新文件加锚点、提交后再 ready。
- 检查跑不了时不放行：409 `TEAM_KNOWLEDGE_CHECK_UNAVAILABLE`。情形：
  - 基线解析不出或与分支无共同历史；
  - git 失败（含节点 blob 读不出），或 diff 列表超 1MB、`ls-tree` 列表超 512KB；
  - 节点文件超 2000 个或合计超 8MiB（按列出的大小，读之前判定，消息点名越线的文件）；
  - 节点 blob 是 Git LFS 指针（以 `version https://git-lfs.github.com/spec/v1` 开头）：读不到真实锚点，不运行仓库过滤器去还原，直接判失败；
  - （改动 + 新增路径数）×（目录与 glob 锚点数）超过 25 万次匹配（同步匹配，上限按不明显阻塞事件循环取）。
- `Team` 工具的错误结果带上 `AppError.details`，协调者由此拿到节点清单。

同步、清理、并发：
- `work.sync`：服务端从不合并。基线已在分支内就返回 up_to_date，否则把一条确定性的 `git merge --no-ff <基线提交>` 指令交给工作者。
- 投递结果分 started / queued / blocked / wake_failed / failed / none 六种。
- 服务端从不删分支、不自己跑 `git worktree`：创建与清理都走现有 worktree 服务（`work-item-ports.ts`）。
- `cleanup` 只能用于 merged 或 cancelled 的项。丢未提交文件或未合并提交时必须带人确认过的损失（`force` + `confirmedLoss`），分支保留。`Team` 的 `cleanup` 每次都等人批准。
- 更新是乐观并发：按「状态 + `updated_at`」条件更新，对不上就 409 `TEAM_WORK_ITEM_CHANGED`。
- 进入 merged/cancelled 时同事务释放独占锁并记 `work.exclusive_released`。
- `merged` 只由祖先检测自动判定：`ready` 项的记录 head 已在基线分支内（squash/rebase 合并检测不到）。事务内核对状态、head、`updated_at` 一致才写入，之后不可逆。

事件与 check-in：
- 每次状态变更、评审、同步、清理、check-in、决策都追加一行 `team_work_events`（`recordWorkEvent`）。actor 为 person / agent / system，详情上限 8KB。
- check-in 是一个团队只保留一个的定时唤醒（5 分钟到 1 天），记为 `team.checkin` 事件，重启与取消归档时重新装填。
- 服务端读 git 只经 `teams/team-git.ts`：禁用 hook、fsmonitor、外部 diff/textconv、写 index，读上限沿用 `gitService`（60s、1MB；`readBlob` 按 blob 大小限输出）。`changedPaths`、`branchFileChanges`、`treeEntry`、`treeBlobs`、`readBlob`、`mergeBase`、`numstat`（`diff --numstat -z`，512KB 上限，超出标 `truncated`）、`fileDiff`（单个字面路径 `:(literal)` 的 `diff -U3`，经 `stdoutStream` 读到上限 +1 字节即停）只读提交与对象，不读工作区；前两者可传入钉住的提交。团队页的大小、抽屉与 diff 都经它们（`team-work-view.ts`）。同一文件的 `isGitWorkTree`（10s 超时）供建团队和 `resolve-directory` 判断项目目录是否 git 工作树。

`Team` 工具（`server/lib/agent/tools/team.ts`，仅 team trait 会话提供）：
- 动作：work.list/create/review/ready/sync/cancel、brief、checkin、cleanup、decision；`work.list` 最多 30 项。
- 工具描述与协调者提示词（`lib/prompts/team-lead.ts` 中英文）都写了 ready 的拒绝条件；提示词还让协调者在仓库有 `knowledge/` 时，在工作者简报里要求完成前跑 `bun scripts/knowledge.ts affected` 并更新列出的节点。工作者自己只拿到通用的 worker 提示词和团队简报，没有团队专用的固定说明。
- 权限逐动作判定（`narrator-permission.ts`）：记账类与团队自己的 worktree 创建/同步在只读之外也允许，`cleanup` 总要人批准。

## 从哪读起
- `teams/work-items.ts`：生命周期、check-in、合并判定。
- `teams/work-item-ports.ts`：与 worktree 服务的端口；`teams/team-git.ts`：只读 git。
- `teams/team-knowledge.ts`：ready 的知识检查与它的上限。
- 测试：`work-item-lifecycle.test.ts`、`work-item-knowledge.test.ts`、`team-checkin-brief.test.ts`。

## 改它时
- 加一个 `Team` 工具动作：`shared/project-teams.ts:TEAM_TOOL_ACTIONS`、`tools/team.ts` 的参数与分发、`narrator-permission.ts` 的逐动作分类（`isTeamReadAction`/`isTeamCleanupCall`，漏了会被当成写动作或绕过批准）、`team-status.ts` 与前端 `team-page-model.ts` 里对事件种类的文案。
- 加工作项状态或事件种类：`TEAM_WORK_ITEM_STATES`/`TeamWorkEventKind`、表上的 check 约束（SQLite 与 `drizzle-postgres` 两边，`team-tables-contract.test.ts` 会失败）、看板列映射 `TEAM_BOARD_COLUMN_STATES`。
- 加 ready 的前置条件：保持顺序（NOT_REVIEWED → DIRTY → 钉住 head → 知识检查 → 独占路径 → 复核 HEAD），新读的 git 都按钉住的 head 读，同步 `tools/team.ts` 的工具描述与 `team-lead.ts` 中英文提示词。
- 改知识检查的判定（锚点、源文件规则）改 `shared/knowledge-tree.ts`，工具与 ready 一起变；`tests/shared/knowledge-tree.test.ts`、`tests/scripts/knowledge.test.ts`、`work-item-knowledge.test.ts` 会拦。检查失败只能拒绝，不能放行。
- 不变量：服务端不合并、不删分支、不直接跑 `git worktree`；读 git 只经 `team-git.ts`；状态更新必须带「状态 + `updated_at`」条件。

## 相关
- [团队与成员](records.md)：删除团队前对未收尾工作项的检查。
- [协调者](coordinator.md)：`team_status` 行里的工作项摘要。
- [仓库知识树](../../kb/repo-knowledge.md)：ready 检查所依据的节点与锚点约定。
