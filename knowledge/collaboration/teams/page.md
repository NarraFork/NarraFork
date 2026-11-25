---
id: collaboration.teams.page
title: 团队页与审批
summary: 团队页（页头、等你处理、对话与工作列表、工作项抽屉、起步与收尾）、就地审批与退回、谁批的记录、暂停全部。
anchors:
  - server/services/teams/team-board.ts
  - server/services/teams/team-decisions.ts
  - server/services/teams/team-work-view.ts
  - server/routes/__tests__/project-teams-work.test.ts
  - frontend/components/teams/
  - frontend/lib/recent-tabs-owner.ts
  - frontend/hooks/useTeams.ts
  - frontend/lib/api/teams.ts
  - frontend/routes/projects/$projectId_.teams.$teamId.tsx
keywords:
  - TeamPageView
  - TeamWorkspace
  - TeamHeader
  - TeamAttention
  - TeamWorkList
  - TeamWorkDrawer
  - TeamActivity
  - TeamStart
  - TeamCoordinatorHeader
  - hideHeader
  - onConnectionChange
  - reviewHeadColumns
  - 评审意见
  - TEAM_REVIEW_SUMMARIES_TOTAL_CHARS
  - TeamSettingsModal
  - TeamDisbandDialog
  - team-page-model
  - 等你处理
  - 需要你
  - 等成员处理
  - 工作项抽屉
  - 退回
  - work.returned
  - work-stats
  - pauseOrder
  - 全部暂停
  - UpgradeToTeamModal
  - teamOnlooker
  - narrator_access_changed
  - project_access_changed
  - /teams/:teamId/board
  - /teams/:teamId/approvals
  - /teams/:teamId/work/:itemId
  - permission_decided_by
  - answerForm
  - queuedLine
  - DependencySections
  - 被依赖
  - TeamMerge
  - MergeButton
  - MergeOutcome
status: draft
verified_at: 3586b5dd803f5035f610fc36d2c7d0245a2cd8e9
---
# 团队页与审批

团队页把一个团队放在一页里：页头一句状态，顶部「等你处理」（人要做的决定，就地操作），下面左边是和协调者的对话，右边是按「对人有意义的顺序」排的工作列表或动态；点工作项打开右侧抽屉。

## 关键规则
读模型与路由（`teams/team-board.ts`、`teams/team-work-view.ts`、`server/routes/project-teams.ts`）：
- 路由挂在 `/api/projects/:projectId/teams...`：列表/创建/详情/修改/归档/取消归档、`summary`、`board`（每列每页 50）、`events`、`approvals`、`members`、`running`，以及重设计（R）加的 `work-stats`、`work/:itemId`、`work/:itemId/diff`、`work/:itemId/return`，以及合并（M）的 `work/:itemId/merge` 与 `work/:itemId/merge/fast-forward`（见[合并工作项与基线配置](merge.md)）。
- 每条读都是带 LIMIT 的主键/索引读。看板项多一个 `activity`：工作者在 working/waiting 时它最近一次工具调用（`(narrator_id, created_at)` 索引一行，输入取 4KB 前缀，预览 ≤120 字）。摘要多 `coordinatorMessageCount`（判起步状态）、`coordinatorStopReason`（判「已暂停」）、运行中会话（最多 20 个）各自的 `activity`（每个一次索引探测，行的「在做什么」随摘要刷新而不必重读看板）和 `heldWorktreeCount`（已结束但仍记录 worktree 的项，数到 51 为止）。
- 待批列表每项多 `parentId`（子代理的上级，用来把助手的调用挂到工作者的工作项上）、计划的 `preview` 是计划首行标题（`planTitle`），提问在输入前缀能完整解析、只有一个问题且选项 1–6 个时带 `answerForm`（答案键 = 规范化后的 header，同时是标题；`description` 是完整提问；选项是完整标题，即发给模型的答案值，从不截断，页面只截显示；`optionDescriptions` 是每个选项的说明；同 `shared/ask-user-question-shape.ts`，与会话里的 `AskUserQuestionBanner` 一致），供就地回答。`questions` 预览也按规范化形状取（`description`，没有就标题；旧形状的 `question` 正文同样读得到）。审批接口不再算「最近的决定」（`recent`）：谁批的在动态里。
- D：看板卡片（`readTeamBoardColumn`、`readBoardItem`、`readReadyItems`）多 `dependsOn: { id, title, state }[]`，整页一次 `IN` 读（`team-board.ts:withDependencies`），没有依赖时是空数组。
- M：`readTeamBoardColumn` 与 `readReadyItems` 的 ready 卡片多 `merge`（模式、任务阶段、最新结果、能否合并与禁用原因；`team-board.ts:withMerge`，不跑 git，见[合并](merge.md)）。
- `work-stats?ids=`（读者可读，最多 50 个，逗号分隔）：每项 `+/-`、文件数、二进制数、`truncated`。活的项在其 worktree 里按 HEAD 与基线的合并基 `diff --numstat` 读；已结束或 worktree 没了的项用最近一次 `work.ready` 事件记下的 `head` 与 `mergeBase`，在项目仓库（协调者 cwd）里读；都没有就是 null。结果按项缓存 20 秒、项的 `updated_at` 一变就重读，最多 200 条，每条只留总数和前 300 个文件，同一请求并发 4 个。前端按 50 个一组分批请求，每一行都有大小；没有改动（+0 −0 且 0 个文件）时不显示。
- `work/:itemId`（读者可读）：卡片、基线、领先几个提交（`rev-list --count`）、大小、改动文件（最多 300，`filesMore`）、能否读 diff、评审轮次（`work.review` 与 `work.returned` 事件）、这一项最近 100 条事件（详情 ≤2304 字才带）、`canReturn`（成员、团队活跃、状态 in_review/ready）、依赖它的项 `dependents`（最多 50，`dependentsMore`），ready 项另带 `merge`（`team-merge.ts:mergeViewOf`）。不带 diff 正文。
- 评审意见（`work.review` 详情里的 `summary`，见[工作项](work-items.md)）：每轮的 `summary` 随轮次返回，读者能读抽屉就能读到，陌生人与抽屉一样 404。详情超过 2304 字的 review 行，分页查询只带头 96 字（`team-board.ts:reviewHeadColumns`：`case`/`substr`，不用 JSON 函数；`reviewHeadDetail` 从 `{"round":N,"verdict":…,"findings":N` 取轮次、结论、问题数），意见原文再按主键逐行读（`readReviewDetailText`，每行最多 8192 字即详情字节上限），从最新往前，攒够 6000 字意见或读满 `TEAM_REVIEW_DETAILS_READ_CHARS`=36000 字详情就停（`team-work-view.ts:itemEvents`）；没读的更早长评审只留轮次、结论、问题数，标 `summaryClipped`。`eventDetail` 解析后留下轮次、结论、问题数与 `summary`。一次抽屉读最多发 `TEAM_REVIEW_SUMMARIES_TOTAL_CHARS`=6000 字意见：从最新一轮往前，装不下的那轮截断，更早的不带，都标 `summaryClipped`（`team-work-view.ts:capReviewSummaries`）；时间线里的 review 事件去掉 `summary`，不重复发。动态（`events`）不读长详情：超过 2304 字的 review 事件照旧 `detailOmitted`。
- `work/:itemId/diff?path=`：路径按字面、从仓库根算（`:(top,literal)`，`*.txt` 就是那个文件，不是通配；已结束的项在协调者工作目录里读，它可能是子目录），只读合并基 → head 的改动，没改过的路径 diff 为空即 404；`diff -U3` 经 `stdoutStream` 读到 64KB+1 字节即停，`truncated` 标出。
- git 只经 `teams/team-git.ts`（`mergeBase`、`numstat`、`fileDiff`，见[工作项](work-items.md)）：全部只读提交，60s 超时、输出有上限。

退回（`work/:itemId/return`，`teams/work-items.ts:returnWorkItem`，`team-work-view.ts:returnWorkItemAsPerson`）：
- 成员才能退回（旁观者 403、陌生人 404），理由必填（trim 后 1–2000 字，严格 schema），只有 in_review / ready 能退回（否则 409 `TEAM_WORK_ITEM_NOT_RETURNABLE`），已归档 409 `TEAM_ARCHIVED`。
- 记为这个人的一轮 blocker 评审：状态回 in_progress、`reviewRounds+1`、`lastReview = blocker`（再 ready 前必须重新评审），写 `work.returned` 事件（`detail.reason/round/from/to/worker`；理由多引号或换行时序列化后可能超过 2304 字的详情预览，所以动态和抽屉对 `work.returned` 另读一份有上限的完整详情（`substr`，理由上限×6+1024 字，不用 JSON 函数以保持方言可移植）再解析出理由与轮次，`team-board.ts:returnedReasonColumns`/`eventDetail`，理由永远可读）；持有独占锁就同事务释放并记 `work.exclusive_released`（`reason: "returned"`）。
- 服务端不给工作者发消息、不碰分支：事务后给协调者写一条 `team_return` 注入（`lib/prompts/team-lead.ts:returnedNote`，按退回人的语言，`wakeIfIdle`），由协调者把理由转给工作者，与转达评审 blocker 是同一条路。投递失败只记日志，退回照样成立（`delivered: false`，前端提示去对话里告诉协调者）。测试接缝 `setReturnDeliveryForTests`。
- 合并：成员点「合并到 {{base}}」，后台任务在对象库里算合并、快进未被检出的基线，或在基线被检出时准备好等人「在该目录中快进」；冲突时列出文件，退回理由预填（见[合并工作项与基线配置](merge.md)）。合并在跑时退回也 409 `TEAM_WORK_ITEM_MERGING`，抽屉的退回按钮禁用。

谁批的（`teams/team-decisions.ts`）：
- 任何成员都可对团队树里的待决调用批准/拒绝/回答，经普通 HTTP 路由与 WebSocket 帧；决定前再按调用所属会话检查写权限（子代理取协调者的访问）。
- 工具调用行只记「人批的」（`permission_decided_by = 'user'`），具体是谁另记为团队事件，`actor_id` 为该用户。
- best-effort：决定之后、事务之外写，写失败只记日志，决定仍生效。
- 不在团队里的调用不处理；PG 上不记录。IM 网关永远不能做这种决定。

前端通讯与访问：
- RecentTabs 的统一访问作用域（`lib/recent-tabs-owner.ts`）在当前认证连接收到 `narrator_access_changed`、`project_access_changed` 后失效旧页并重取授权元数据，同时刷新 `teamOnlooker`。该标记让只读旁观者不收「等待」提醒；不再另设团队专用失效监听器（见[通知与注意力](../notifications.md)、[最近标签页](../recent-tabs.md)）。
- `TeamHeader.tsx` 的「…」菜单提供「通讯拓扑」，成员与旁观者都可查看，使用 team scope，复用普通会话的图组件与安全区内的右侧 drawer，手机提供返回操作；不恢复旧顶栏。团队身份仍按协调者/ACL root，通讯拆组不改变工作项、worktree、审批、全部暂停或自动报告；一支团队可同时包含多个互不自由互发的通讯框。
- 拓扑不复用团队摘要的轮询：团队记录/工作项/worker 绑定在外层事务提交后发 ids-only dirty，图经单 narrator socket 的 snapshot/delta 更新。图框显示真实团队名，节点只显示图标和会话名；拓扑注释仅携带团队 ID/名称与详情所需工作项标题，不再推导角色标签。外部团队详情仍单独鉴权，只读旁观者不能拖动改关系。跨团队精确 peer 不授予成员、控制或 worktree 权限。

前端（`frontend/components/teams/`）：
- 路由 `frontend/routes/projects/$projectId_.teams.$teamId.tsx`（不嵌在项目页下，占满外壳内容区）→ `TeamPageView.tsx`。对话是普通叙述者面板，只读成员的输入区换成「你是只读成员」（`NarratorPanel` 的 `readOnlyNotice`）；面板以 `hideHeader` 挂载，不画它自己的标题行与工具栏，对话上方是 `TeamCoordinatorHeader.tsx` 的一行「协调者 · N 个会话在运行 · 完整会话 ↗」（`team-page-model.ts:coordinatorLine`：摘要里协调者之外运行中的会话数；摘要分不出工作项工作者与评审者、嵌套子代理，所以说「会话」不说「工作者」；名单被截断时写下界 N+，即列出的其他会话数加一，不会出现 0+；没有别的在跑时写协调者自己的状态 工作中/在等人处理/空闲/已归档；圆点是协调者的运行状态）。`hideHeader` 也藏掉了面板的「连接断开」徽标，所以面板经 `onConnectionChange`（`narrator/panel-connection.ts:useReportPanelConnection`）报告自己的连接状态，路由转给 `TeamPageView` 的 `conversationConnection`，这一行在断开时显示「连接断开」，点击调用面板自己的 `reconnect`（不另写连接逻辑；`team-coordinator-connection.test.tsx`）。完整工具栏只在协调者自己的会话页上（「完整会话」与「…」菜单的协调者完整会话都走 `onOpenCoordinatorSession`）。消息区本身与会话页相同：协调者的 `Team` 工具调用照常是工具卡片（不折叠成「创建工作项 ×N」这类一行），团队事件也不作为分隔线插进对话（两者都要改虚拟列表的分组与高度模型，未做；事件看右栏动态与抽屉时间线）。
- 团队页只讲一个团队：没有项目团队列表、没有「新建团队」、没有左侧团队切换。切换走侧栏固定的团队标签和项目页的团队卡片；新建走项目页或新建会话弹窗的「以团队开始」。
- `TeamWorkspace.tsx`：页头、等你处理、两栏（对话约 60%，右栏约 40%，最小 320、最大 560，右栏顶部「工作 | 动态」切换与「N 项未完成」）；按自身宽度（不是视口）在 `split` 与 `tabs`（帧宽 < `TEAM_SPLIT_MIN_WIDTH` 860）之间选，`tabs` 是「对话 | 工作 (N)」，工作页里仍有同一个切换。对话在各布局里挂在 React 树的同一位置，换布局不重挂；从别处要求聚焦对话时先切到对话标签，渲染后再聚焦输入框。
- `TeamHeader.tsx`：一行（手机两行）：返回、项目名、团队名、状态句（`team-page-model.ts:statusSentence`：「N 项进行中 · M 项等你」，旁观者是「等成员处理」，「空闲 · 还没有工作项 / N 项已完成」，「已暂停」= 有未完成项、没有在跑的会话且协调者上一轮被人停下，「已归档」）；等待数在审批列表 `more` 时写成「N+ 项等你」；右侧成员头像（最多 3 个加 +N，点开成员抽屉 `TeamMembers.tsx`）、固定到侧栏、「全部暂停」（普通按钮；手机上在「…」里）、「…」菜单（运行中的会话列表，取自摘要，点开会话；团队设置 `TeamSettingsModal.tsx` 改基线分支、新工作项的起点（项目默认 / `origin/<基线>` / 本地基线，默认项写出它解析成什么，`settingsWithWorkStart` 只换 `workStart` 键）与简报、协调者完整会话、解散团队 `TeamDisbandDialog.tsx`）。手机上两行，第一行仍有返回箭头。「全部暂停」只给成员，协调者已归档时只在还有会话在跑时出现；协调者先停（`pauseOrder`），一次最多读 500 个运行中会话，结果分 paused / pausedSomeIdle / pausePartial / pauseNothing / pauseMore。
- `TeamAttention.tsx`「等你处理」：只给成员，没有就不显示，琥珀色是全页唯一高饱和色。条目（`attentionEntries`）先是待决调用（按提出顺序），再是 ready 项（按更新时间）。工具调用：谁、命令或路径、拒绝/批准；提问：标题、完整提问、各选项的说明（灰字，截成两行）、选项按钮和「自己写…」（`answerForm`）；提问超过 600 字或某个选项说明超过 300 字时不在卡片上一键回答（`fitsInPlace`），和多问题、多选一样点「回答」开对话框，经 human-attention 详情读取完整表单（`AskUserQuestionBanner`）；计划：标题、「看计划」（同样经详情读计划正文）与「批准」；规则请求：去会话里处理；卡片上的会话/工作项名点开提问的会话，有 `decisionReason` 时显示成一行灰字；列表有 `more` 或 `unscanned` 时底部说明还有没列出的并可打开协调者会话；可合并：+/-、文件数、评审结论、分支 → 基线、最新合并结果的徽标（冲突 / 未完成 / 已准备）、查看改动/退回/合并（`TeamMerge.tsx:MergeButton`，正在合并时显示进度、禁用时说原因；已准备时多一个「去快进…」打开抽屉；`AttentionActions.projectId` 给按钮的接口路径，项目页上按卡片所属团队调用）。多于 3 条折成「还有 N 条」；悬停卡片高亮右栏对应的工作项；手机上卡片横向滑动并显示「1 / N」。
- `TeamWorkList.tsx`「工作」（`workGroups`）：需要你（等人决定或可合并；旁观者看不到调用，用工作者的 waiting 状态代替，标题叫「等成员处理」）、进行中（先 in_progress 后排队）、评审 · 就绪，已完成和已取消折叠成数量，展开才读那一列；每行状态点、标题、标记（`itemMarks`：持有独占路径锁、已结束但仍保留 worktree）、一行在做什么（`rowLine`，活动取摘要里的 `liveActivity`，工具名经 `teams.page.row.tools.*` 译成动词；旁观者看到等待中的工作者时，按其最近一次工具调用写「等批准 X / 等回答」，不知道时写「等人处理」）、+/-。没有工作项时是虚线说明；全部结束时（`teamPageMode.wrapUp`）顶部建议归档或解散，已完成默认展开；还有已结束项保留 worktree 时不提供解散（服务端会以 `TEAM_HAS_LIVE_WORK` 拒绝），改为说明让协调者清理（每次清理都要人批准）或先归档。
- 依赖（D）：排队的行按 `team-page-model.ts:queuedLine` 写——等一两项时点名「排队 · 等「A」合并」/「排队 · 等「A」「B」合并」，更多时「排队 · 等 N 项合并」，有已取消的依赖时「排队 · 依赖「A」已取消」（只算未合并的依赖，`dependencyBlockers`）。抽屉在字段下面有「依赖」（每项状态徽标，标题点开那一项，排队且有已取消依赖时一条黄色警告，否则一行「都合并到 <基线> 后才能开始」）与「被依赖」（`TeamWorkDrawer.tsx:DependencySections`，`onOpenItem` 由 `TeamPageView` 传入）。人不能在这里改依赖。动态里 `work.dependencies_changed`（「依赖 N 项」/「不再依赖其他工作项」：事件只记 id，不知道当时哪些已合并，所以不说「等 N 项合并」）与 `work.unblocked`（「依赖的工作项都已合并」）有自己的文案。
- `TeamActivity.tsx`「动态」：安静的按时间列表（时间、谁、什么、哪一项、说明），标题与说明用 `eventLabelKey`/`eventNote`，未知种类显示 `teams.event.other`，种类名只在 tooltip 里；`work.returned` 的说明是理由原文。
- `TeamWorkDrawer.tsx`：标题与结论徽标、分支 → 基线与领先提交数、工作者会话链接、改动文件（展开某个文件才读它的 diff）、评审记录（人退回的那轮带理由；评审者的轮次带意见原文 `ReviewFindings`：灰字、保留换行、截成 3 行，实际溢出时才给「展开 / 收起」，先按 `findingsNeedToggle` 估、渲染后按 `scrollHeight` 改正；被总量截断时加一行说明）、这一项的时间线；底栏（`canReturn` 时）退回 / 合并到基线（ready 时 `MergeButton`，上方 `MergeOutcome` 显示冲突列表与「退回给工作者」、失败原因、或已准备的说明与「在该目录中快进」及可复制命令；快进失败时 prepared 仍在，下面写出失败原因与 git 列出的文件），退回就地展开成必填理由（最新结果是冲突时预填冲突文件，`conflictReasonFiles`），拒绝码 `TEAM_WORK_ITEM_NOT_RETURNABLE` / `TEAM_WORK_ITEM_CHANGED` / `TEAM_ARCHIVED` 有自己的中英文（`returnErrorKey`）。时间线与评审记录里协调者签作「协调者」（`isCoordinator`），不用团队名。
- `TeamStart.tsx` 起步状态（没有工作项且协调者还没有消息、未归档；只给成员，只读成员看到一行 `TeamReadOnlyStart`）：盖在对话的消息区上（协调者那一行在面板外、上方；不挡输入框），一句话、一行说明、3 个示例，点击经 `lib/composer-append-queue.ts` 填入协调者的输入框。
- 固定到侧栏：页头有 `PinToSidebarButton`（`team-page-model.ts:teamPinTitle`：团队未载入、非 active 或协调者已归档就不给）；侧栏团队标签显示协调者状态和成员的待批数加可合并数（`team-board.ts:teamPendingApprovalCount`、`teamReadyItemCount`），见[最近标签页](../recent-tabs.md)。
- 项目页（R2，见[项目页](../project-pages.md)）复用这里的读模型和组件：待决调用的扫描是 `team-board.ts:scanPendingCalls`（团队树用 `visiblePendingCalls`，项目用根会话链接范围加每页一次的 `acceptPage`），预览用 `pendingApprovalsOf`，团队卡片的数字用 `readTeamCards`（经读 worker，已结束项每种数到 1000）（经读 worker；已结束项每种数到 1000）；「等你处理」用同一个 `TeamAttention`，条目可带 `source`（团队名或会话与所有者），`onOpenTeam`、`onDecided(entry)`、`flush`、`inPage`、`beyondKeys` 只给项目页用。工具调用卡片和行的文案按工具（`team-page-model.ts:toolVerb`：Edit/Write/MultiEdit/NotebookEdit 编辑文件、Bash 运行命令、Read 读取文件、WebFetch 访问网页，其余「使用 X」），键在 `teams.page.attention.toolVerbs.*`、`workerAsksAction` 与 `teams.page.row.waitingTools.*`。
- 「升级为团队」不在团队页上：入口是会话溢出菜单（见[会话外框](../../frontend/narrator-ui/session-chrome.md)），对话框 `UpgradeToTeamModal.tsx` 用与新建团队相同的 `TeamCreateFields`/`useTeamDraft`；菜单项只给 `team-upgrade-eligibility.ts:canOfferTeamUpgrade` 为真的会话。
- `team-page-model.ts` 是纯规则：等你处理与折叠、分组、状态句、起步/收尾、行文案、退回理由、diff 行分类、布局、轮询退避、套接字推送合并（400ms 去抖、最长 2s）、暂停顺序。
- `hooks/useTeams.ts`：摘要在叙述者 socket 的相关帧上合并重取，同时带退避轮询（变化后 4s，翻倍到 60s，标签页隐藏时暂停）；看板（`lastEventId` 与各列计数变了才重取，连同 `work-stats`、抽屉、diff 一起失效）、动态、审批各自按变化重取。`useDecideApproval` 批准时可带 `answers`；`useApprovalDetail` 读 `permission:<id>` 的 human-attention 详情。`lib/api/teams.ts` 是客户端。

## 从哪读起
- `team-board.ts`：看板、动态、审批的读模型；`team-work-view.ts`：大小、抽屉、diff、退回入口；`team-decisions.ts`：决定记录。
- `frontend/components/teams/TeamPageView.tsx`，再到 `TeamWorkspace.tsx`、`TeamHeader.tsx`、`TeamAttention.tsx`、`TeamWorkList.tsx`、`TeamWorkDrawer.tsx`。
- 测试：`team-page-model.test.ts`、`team-page-components.test.tsx`（含依赖行文案、`DependencySections`、动态）、`team-page.browser.test.ts`（Chromium，`NF_TEST_CHROMIUM_PATH`；依赖一例用单独的团队，放在文件最后，不影响前面按数量断言的用例）、`server/routes/__tests__/project-teams-work.test.ts`。

## 改它时
- 看板列与状态：`TEAM_BOARD_COLUMN_STATES`、`team-board.ts` 与 `team-page-model.ts:workGroups` 一起改；页大小保持 50。
- 加事件种类：`team-page-model.ts` 的文案、`en` 与 `zh-CN` 的 `teams.event.*`（`team-page-model.test.ts` 核对）。
- 新增审批类型：`teamApprovalKind`（`shared/project-teams.ts`）、`TeamAttention.tsx` 的卡片与 `rowLine`。
- 新读接口必须带 LIMIT、走索引，并保持 SQLite 专用；git 读必须有超时与输出上限，diff 正文只在抽屉里按文件读。
- 改合并的按钮与结果：`TeamMerge.tsx` 与 `team-page-model.ts:mergeControl` 同时用于抽屉和卡片；规则见[合并](merge.md)。
- 改待批计数的规则：页头状态句、侧栏团队标签、项目页团队卡片共用 `pendingCount`；项目页 `ProjectTeamCards` 的 `data-testid="project-team-card"` 是每个团队一张（浏览器测试 `team-page.browser.test.ts` 按它数）。

## 相关
- [团队与成员](records.md)：成员列表的来源。
- [工作项](work-items.md)：状态机、`work.returned` 与只读 git。
- [协调者](coordinator.md)：活动里的超限事件与状态行。
