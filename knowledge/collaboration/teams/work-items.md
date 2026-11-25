---
id: collaboration.teams.work-items
title: 工作项
summary: 工作项状态机、Team 工具、worktree 端口、ready 的知识检查、检查提醒、合并判定与清理。
anchors:
  - server/services/teams/work-items.ts
  - server/services/teams/work-item-ports.ts
  - server/services/teams/team-git.ts
  - server/services/teams/team-knowledge.ts
  - server/services/teams/work-item-dependencies.ts
  - server/lib/agent/tools/team.ts
  - server/services/teams/__tests__/work-item-lifecycle.test.ts
  - server/services/teams/__tests__/work-item-branch-name.test.ts
  - server/services/teams/__tests__/work-item-knowledge.test.ts
  - server/services/teams/__tests__/team-checkin-brief.test.ts
  - server/services/teams/__tests__/work-item-dependencies.test.ts
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
  - team_work_item_dependencies
  - dependsOn
  - work.update
  - work.dependencies_changed
  - work.unblocked
  - TEAM_WORK_ITEM_BLOCKED
  - TEAM_WORK_ITEM_NOT_QUEUED
  - TEAM_WORK_ITEM_NOT_STARTED
  - settleFailedStart
  - TEAM_WORK_ITEM_DEPENDENCY_CYCLE
  - TEAM_WORK_ITEM_DEPENDENCY_NOT_FOUND
  - TEAM_WORK_ITEM_DEPENDENCY_CANCELLED
  - TEAM_WORK_ITEM_DEPENDENCY_GRAPH_TOO_LARGE
  - TEAM_WORK_ITEM_MERGING
  - markMergedByLocalMerge
  - startFrom
  - team_unblocked
  - 依赖
status: draft
verified_at: 3586b5dd803f5035f610fc36d2c7d0245a2cd8e9
---
# 工作项

工作项（`team_work_items`）是团队里的一个交付单位：一条分支、一个 worktree、一个状态。协调者经 `Team` 工具推进它，服务端记录和校验；合回基线由成员在团队页发起（见[合并工作项与基线配置](merge.md)），协调者不能合并。

## 关键规则
状态与创建（`teams/work-items.ts`）：
- 状态：queued / in_progress / in_review / ready / merged / cancelled（`shared/project-teams.ts:TEAM_WORK_ITEM_STATES`）。
- 看板五列：queued、in_progress、review（含 in_review 与 ready）、done（merged）、cancelled。
- `work.create`：
  - 先经现有 narrator worktree 创建通道建分支 `team/<slug>-<id 哈希 8 位>` 与 worktree，起点按团队的起点模式（`team-work-start.ts:workStartPoint`：`origin/<基线>` 先拉取到远程跟踪 ref 再传那个提交，或本地基线；见[合并工作项与基线配置](merge.md)），`work.created` 记 `startFrom`；行的 `base_ref` 永远是基线分支名；
  - slug 只取 ASCII 单词（`workBranchSlug`：NFKD 去重音、全角折半，其余文字不音译，最多 40 字符），先取协调者给的 `branchHint`，再取标题，都没有就是 `work`；全 ASCII 是为了过 `gitBranchName`、worktree 服务的 ref 检查和 `git check-ref-format`，哈希保证唯一。`Agent({ isolation })` 的标题没有 ASCII 单词时用 description 当 hint。已有分支不改名；
  - 再写行与 `work.created` 事件，初始 `queued`。
- `Agent({ isolation: "worktree" })` 建的是 kind=`isolated` 的项，初始 `in_progress`。子代理结束时若没有提交也没有未提交改动，就清理 worktree 并取消该项（`settleIsolatedWorkItem`）。
- 第一层子代理经 `attachWorker` 记为工作者，queued 的项随之开始。开始 queued 项的只有协调者自己的 `Agent({ workdir: <它的 worktree> })`（`tools/task.ts` 用 `workItemAtWorktree` 找到还没有工作者的项后在创建钩子里 `attachWorker`；查找先比原样写法和它的真实路径（`realpath`，最多等 2 秒），在文件名不分大小写的平台（Windows、macOS，`platform-path.ts:caseInsensitiveFileNames`）再按折叠大小写的键从本团队的进行中项（最多 500 项）里筛出候选，候选还必须和所给路径是磁盘上同一个目录（`stat` 的 dev 与 inode 相同，最多等 2 秒，拿不准就不算；那两个平台也可能有区分大小写的卷，只差大小写的另一个目录不能被当成这个 worktree），Linux 仍区分大小写；找到后工人在记录的 worktree 路径里跑），没有调度器，也没有任何自动开始。同一个工作者再记一次什么都不变；已有别的工作者（并发的另一次调用先记上）时 409 `TEAM_WORK_ITEM_CHANGED`。创建钩子里的拒绝让这次 `Agent` 调用失败：`subagent-runner.ts` 把还没运行的子代理归档（`archiveUnstartedSubagent`），`task.ts` 再调 `settleFailedStart`；后者不碰已由别的工作者持有的项（不退回队列、不清理 worktree），所以被拒的一方既不会留下没人记录、仍在 worktree 里干活的子代理，也不会动赢的一方的项。

依赖（D，`teams/work-item-dependencies.ts`，表 `team_work_item_dependencies`，迁移 SQLite 0266、PG 0083）：
- 一项可以等同团队的其他项**合并**后才开始。表的主键 `(item_id, depends_on_item_id)`，另有 `(depends_on_item_id, item_id)` 与 `team_id` 索引；两端都外键到 `team_work_items` 并级联删除，`team_id` 外键到团队（级联）；`check item_id <> depends_on_item_id`。同团队不靠复合外键（PG 转译器不支持复合目标），由服务判定。
- 设置：`Team` 的 `work.create` 与 `work.update` 带 `dependsOn`（工作项 id，不收标题），整组替换（`[]` 清空），最多 `TEAM_WORK_DEPENDENCIES_MAX` = 20（多了 400），重复去掉。只能在项 queued 且没有工作者时改（否则 409 `TEAM_WORK_ITEM_NOT_QUEUED`）；改了（`changed`）就在事务后发 `team:communication_changed` 刷新团队页。每个目标都必须是本团队的项（别的团队的、不存在的都是 404 `TEAM_WORK_ITEM_DEPENDENCY_NOT_FOUND`，不说属于谁）；不能是已取消的（409 `TEAM_WORK_ITEM_DEPENDENCY_CANCELLED`）；必须和这一项从同一条基线建出（409 `TEAM_WORK_DEPENDENCY_BASE_MISMATCH`，消息点名两条基线，`details: { base, mismatched: [{ id, base }] }`；基线是项的 `base_ref`，为空时取团队当前基线。项建时钉住团队当时的基线，团队基线之后能改，而 `work.sync` 只拉这一项自己的基线，合进别的基线的依赖永远到不了它）；不能是自己或成环（409 `TEAM_WORK_ITEM_DEPENDENCY_CYCLE`，`details.cycle` 是环路）。查环是从新目标沿已有边广度优先，每层一次 `IN` 索引读，最多访问 500 项，超了 409 `TEAM_WORK_ITEM_DEPENDENCY_GRAPH_TOO_LARGE`。`work.create` 在建 worktree 之前就查，被拒不留 worktree；写入与 `work.dependencies_changed` 事件（`dependsOn/added/removed`）同事务，事务内再查一次。`work.update` 还按「状态 + `updated_at`」条件更新项。
- 开始的闸：只有合并进这一项自己基线的依赖算满足（`dependencyResolved`：`merged`（`dependencySatisfied`）且没有 `baseMismatch`），`ready` 不算（分支会从不含它的基线出发），已取消的依赖一直挡着，直到协调者去掉或换掉。加基线检查之前写下的跨基线边由 `readDependencies` 标上 `baseMismatch: { dependencyBase, dependentBase }`，不论状态都算挡着（`blockersOf`、`blockedBy`、解锁扫描同一规则）。`assertWorkItemStartable` 抛 409 `TEAM_WORK_ITEM_BLOCKED`，`details.blockers` 列出 `{ id, title, state }`（跨基线的另带 `baseMismatch`），消息点名已取消的与跨基线的（两条基线都写出）那些，让协调者用 `work.update` 处理。只要项还没有工作者，不论状态，`Agent({ workdir })` 都在创建子代理之前查（被拒什么都不建，工具结果带错误码），`attachWorker` 在事务内再查一次。
- 解锁：`merged` 的唯一写入者 `markMergedByAncestry` 在同一事务里调 `recordUnblocked`：按反向索引读被它挡着、仍 queued 且没有工作者的项（这两个条件在查询里过滤，再取最多 200，已开始的项挤不掉排队的），对依赖全部满足（`dependencyResolved`，跨基线的依赖永不满足）的项写一条 `work.unblocked`（system，`detail: { mergedItem, dependsOn }`）。`merged` 只写一次且不可逆，所以每项只解锁一次。事务后每个解锁项给协调者投一条说明（来源 `team_unblocked`，`wakeIfIdle`，与 `team_return` 同一条路；`createdBy`/执行主体是建这一项的人；按协调者会话的语言，`lib/prompts/team-lead.ts:unblockedNote`，首行「「X」现在可以开始了」，标题经 `team-coordinator-notes.ts:oneLine` 压成一行（最多 80 字，与重叠提醒相同），第二行让它先 `work.sync` 再派工人）。投递经 check-in 的生命周期排空跟踪，失败只记日志，事件照样成立。测试接缝 `setUnblockDeliveryForTests`。不会自动开始。
- 基线：worktree 在 `work.create` 时就从起点当时的提交建出（本地基线，或刚拉取的 `origin/<基线>`），所以依赖合并前建的项分支是旧基线。不挪动建 worktree 的时机：说明和提示词让协调者先 `work.sync`（还没有工作者时返回确定的合并指令），把指令放在工人简报最前面。
- `work.list` 与工具返回的项带 `dependsOn`（id）与 `blockedBy`（未合并的 id），整页一次读（`readDependencies`）。`work.cancel` 的结果列出依赖它、仍在排队的项（`dependents`，最多 20，状态在查询里过滤，`queuedDependentsOf`）并提示用 `work.update` 处理。
- 人不能在团队页改依赖（这一轮只读展示，见[团队页与审批](page.md)）。

评审与就绪：
- `work.review` 与 `work.ready` 只收已开始的项：queued 或没有工作者时 409 `TEAM_WORK_ITEM_NOT_STARTED`（否则一次评审会把 queued 项挪出队列，绕过开始的闸）。工作者会话被删（外键置空）的项要先用 `Agent({ workdir })` 派一个新工作者。
- `work.review`：blocker 把项退回 `in_progress`，clear 留在 `in_review`。事件详情记 `round`、`verdict`、`findings`（问题数）、`reviewer`、`head`，以及可选的 `summary`（评审意见原文，trim 后为空不存，最多 `TEAM_REVIEW_SUMMARY_MAX_LENGTH`=1000 字，超出 `recordReview` 抛 ValidationError、工具 schema 先拒；1000 字每字转义成 6 字节也在 8KB 详情上限内），团队页抽屉按轮显示它（见[团队页与审批](page.md)）。
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
- `work.sync`：服务端不在工作项分支上合并。要合进来的基线按起点模式取（`origin/<基线>` 先拉取，或本地基线，事件 `baseRef` 记的是它，拉取失败用已有的远程跟踪 ref 时记 `fetched: false`）；已在分支内就返回 up_to_date，否则把一条确定性的 `git merge --no-ff <基线提交>` 指令交给工作者。
- 投递结果分 started / queued / blocked / wake_failed / failed / none 六种。
- 服务端从不删分支、不自己跑 `git worktree`：创建与清理都走现有 worktree 服务（`work-item-ports.ts`）。
- `cleanup` 只能用于 merged 或 cancelled 的项。丢未提交文件或未合并提交时必须带人确认过的损失（`force` + `confirmedLoss`），分支保留。`Team` 的 `cleanup` 每次都等人批准。
- 更新是乐观并发：按「状态 + `updated_at`」条件更新，对不上就 409 `TEAM_WORK_ITEM_CHANGED`。
- 进入 merged/cancelled 时同事务释放独占锁并记 `work.exclusive_released`。
- `merged` 有两个来源，都经同一个写入者 `markMerged`（事务内核对 ready、head、`updated_at`、团队活跃，同事务释放独占锁并解锁依赖，之后不可逆）：祖先检测（`markMergedByAncestry`，`detectedBy: "ancestry"`，system；`ready` 项的记录 head 已在基线分支内，squash/rebase 合并检测不到）与成员的本地合并（`markMergedByLocalMerge`，`detectedBy: "local_merge"`，actor 为那个人，见[合并](merge.md)）。
- 合并任务持有一项时（`team-merge-guard.ts`），`work.review`、`work.ready`、`work.sync`、`work.cancel` 与人的退回都 409 `TEAM_WORK_ITEM_MERGING`；review、ready、sync 在最后一次 await 之后、写入或交给工人之前再查一次。
- 起点为 `origin/<基线>` 的项（`work.created` 的 `startFrom`）在 ready 的知识检查、评审后提交数与改动路径、以及隔离项结束时的提交计数里按 `refs/remotes/origin/<基线>` 比较（`team-work-start.ts:compareRefFor`），免得把本地基线落后的 origin 提交算成这一项的。

事件与 check-in：
- 每次状态变更、评审、同步、清理、check-in、决策都追加一行 `team_work_events`（`recordWorkEvent`）。actor 为 person / agent / system，详情上限 8KB。
- check-in 是一个团队只保留一个的定时唤醒（5 分钟到 1 天），记为 `team.checkin` 事件，重启与取消归档时重新装填。
- 服务端读 git 只经 `teams/team-git.ts`：禁用 hook、fsmonitor、外部 diff/textconv、写 index，读上限沿用 `gitService`（60s、1MB；`readBlob` 按 blob 大小限输出）。`changedPaths`、`branchFileChanges`、`treeEntry`、`treeBlobs`、`readBlob`、`mergeBase`、`numstat`（`diff --numstat --no-relative -z`，路径总是相对仓库根，512KB 上限，超出标 `truncated`）、`fileDiff`（单个从仓库根算起的字面路径 `:(top,literal)` 的 `diff -U3 --no-relative`，git 在子目录里跑也一样，经 `stdoutStream` 读到上限 +1 字节即停）只读提交与对象，不读工作区；前两者可传入钉住的提交。团队页的大小、抽屉与 diff 都经它们（`team-work-view.ts`）。同一文件的 `isGitWorkTree`（10s 超时）供建团队和 `resolve-directory` 判断项目目录是否 git 工作树。

`Team` 工具（`server/lib/agent/tools/team.ts`，仅 team trait 会话提供）：
- 动作：work.list/create/update/review/ready/sync/cancel、brief、checkin、cleanup、decision；`work.list` 最多 30 项。`work.update` 只改依赖（`dependsOn`），是写动作。
- 工具描述与协调者提示词（`lib/prompts/team-lead.ts` 中英文）都写了 ready 的拒绝条件；提示词还让协调者在仓库有 `knowledge/` 时，在工作者简报里要求完成前跑 `bun scripts/knowledge.ts affected` 并更新列出的节点。工作者自己只拿到通用的 worker 提示词和团队简报，没有团队专用的固定说明。
- 权限逐动作判定（`narrator-permission.ts`）：记账类与团队自己的 worktree 创建/同步在只读之外也允许，`cleanup` 总要人批准。

## 从哪读起
- `teams/work-items.ts`：生命周期、check-in、合并判定。
- `teams/work-item-ports.ts`：与 worktree 服务的端口；`teams/team-git.ts`：只读 git。
- `teams/team-knowledge.ts`：ready 的知识检查与它的上限。
- `teams/work-item-dependencies.ts`：依赖的读写、查环、开始的闸、解锁与说明投递。
- 测试：`work-item-lifecycle.test.ts`、`work-item-knowledge.test.ts`、`team-checkin-brief.test.ts`、`work-item-dependencies.test.ts`（设置/清空、各拒绝码、409 闸、未开始的项不能评审或就绪、没有工作者的项不论状态都查闸、刷新事件、解锁只写一次且不被已开始的项挤掉、已取消的依赖）；`tools/__tests__/agent-team-worktree.test.ts` 覆盖 Agent 进被挡的项（含 worktree 的另一种写法：符号链接、大小写）和创建钩子里被拒的记录（别的工作者先记上、查完后才加的依赖）；`work-item-dependencies.test.ts` 另钉着团队基线在两项之间改过时的拒绝与旧边不解锁。

## 改它时
- 加一个 `Team` 工具动作：`shared/project-teams.ts:TEAM_TOOL_ACTIONS`、`tools/team.ts` 的参数与分发、`narrator-permission.ts` 的逐动作分类（`isTeamReadAction`/`isTeamCleanupCall`，漏了会被当成写动作或绕过批准）、`team-status.ts` 与前端 `team-page-model.ts` 里对事件种类的文案。
- 加工作项状态或事件种类：`TEAM_WORK_ITEM_STATES`/`TeamWorkEventKind`、表上的 check 约束（SQLite 与 `drizzle-postgres` 两边，`team-tables-contract.test.ts` 会失败）、看板列映射 `TEAM_BOARD_COLUMN_STATES`。
- 加 ready 的前置条件：保持顺序（NOT_REVIEWED → DIRTY → 钉住 head → 知识检查 → 独占路径 → 复核 HEAD），新读的 git 都按钉住的 head 读，同步 `tools/team.ts` 的工具描述与 `team-lead.ts` 中英文提示词。
- 改知识检查的判定（锚点、源文件规则）改 `shared/knowledge-tree.ts`，工具与 ready 一起变；`tests/shared/knowledge-tree.test.ts`、`tests/scripts/knowledge.test.ts`、`work-item-knowledge.test.ts` 会拦。检查失败只能拒绝，不能放行。
- 加别的写 `merged` 的路径：经 `markMerged`（它同事务调 `recordUnblocked` 并在事务后投递说明），不要另写，否则被挡的项永远等不到通知。
- 依赖规则（什么算满足）只在 `shared/project-teams.ts:dependencySatisfied` / `dependencyResolved`，前端行文案（`dependencyBlockers`）与服务端闸共用。
- 不变量：服务端不在工作项的 worktree 里写 git、只在成员要求时合并（`team-merge.ts`，不碰任何工作区）、不删分支、不直接跑 `git worktree`；worktree 里的读只经 `team-git.ts`，写 git 只经 `team-git-write.ts`；状态更新必须带「状态 + `updated_at`」条件。

## 相关
- [团队与成员](records.md)：删除团队前对未收尾工作项的检查。
- [协调者](coordinator.md)：`team_status` 行里的工作项摘要。
- [仓库知识树](../../kb/repo-knowledge.md)：ready 检查所依据的节点与锚点约定。
