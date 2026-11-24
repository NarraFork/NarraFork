---
id: collaboration.recent-tabs
title: 最近标签页
summary: 每个用户的侧栏标签：会话、文件夹、固定的项目与团队；记录、运行时信息、作为通知和提醒的接收人来源。
anchors:
  - server/services/user-preferences-service.ts
  - server/services/recent-tabs-service.ts
  - server/services/recent-tab-teams.ts
  - server/services/recent-tab-projects.ts
  - frontend/components/nav/recent-tab-menu-target.ts
  - shared/recent-tabs.ts
  - server/routes/user-preferences.ts
  - server/db/schema.ts
  - frontend/components/nav/NarratorStatusIcon.tsx
  - frontend/components/nav/PinToSidebarButton.tsx
  - frontend/components/nav/recent-tab-page-pin.ts
  - frontend/components/nav/RecentTabBackgroundBubble.tsx
  - frontend/components/nav/RecentTabDetailCard.tsx
  - frontend/components/nav/RecentTabDropIndicator.tsx
  - frontend/components/nav/RecentTabFolderEditModal.tsx
  - frontend/components/nav/RecentTabFolderRows.tsx
  - frontend/components/nav/RecentTabMenu.tsx
  - frontend/components/nav/RecentTabs.tsx
  - frontend/components/nav/narrator-status-icon-logic.ts
  - frontend/components/nav/recent-tab-drag-model.ts
  - frontend/components/nav/recent-tab-drop-target.ts
  - frontend/components/nav/recent-tab-folder-icons.ts
  - frontend/components/nav/recent-tab-hover.ts
  - frontend/components/nav/recent-tab-keyboard-nav.ts
  - frontend/components/nav/recent-tab-new-session.ts
  - frontend/components/nav/recent-tabs-logic.ts
  - frontend/components/nav/useRecentTabExternalDrop.ts
  - frontend/components/nav/useRecentTabsDrag.ts
  - frontend/components/nav/useRowSwipe.tsx
  - frontend/hooks/recent-tab-folders.ts
  - frontend/hooks/recent-tabs-utils.ts
  - frontend/hooks/useFolderDisplay.ts
  - frontend/hooks/useRecentTabKeyboardNav.ts
  - frontend/hooks/useRecentTabs.ts
  - frontend/hooks/useRecentTabsWS.ts
  - shared/recent-tab-layout.ts
keywords:
  - /api/user-preferences/recent-tabs
  - user_recent_tabs
  - user_recent_tabs_meta
  - user:recent_tabs_delta
  - RECENT_TABS_STORAGE_LIMIT
  - STALE_CURSOR
  - RECENT_TABS_UNDO_CONFLICT
  - recent_tab_archive_marks
  - 侧栏标签
  - 最近会话
  - 标签文件夹
  - recent_tabs_group_mode
  - useRecentTabs
  - 固定到侧栏
  - PinToSidebarButton
  - enrichProjectTabs
  - isCoordinatorSessionTab
  - RECENT_TAB_STATE_QUERY_ROOT
  - 团队标签
  - team tab
  - pendingApprovalCount
  - project_id
status: draft
verified_at: 99e33f8fc
---
# 最近标签页

侧栏里每个用户自己的一份标签列表（叙述者、子代理、用户手建的文件夹，以及从项目页、团队页固定进来的项目与团队），存在 `user_recent_tabs` 表，每个标签一行。除了侧栏，它还是「谁在关注某个叙述者」的索引：通知、IM 提醒、会话重命名等都靠它找人；团队标签不进这个索引。

## 关键规则
- 一用户最多 500 行（`RECENT_TABS_STORAGE_LIMIT`）。超限从列表底部（最久没动的一端）逐个淘汰：先淘汰未置顶的游离子代理，再是未置顶的普通标签或文件夹成员，最后连置顶也可淘汰；正在写入的那个单元不会被淘汰（`recent-tabs-service.ts:trimTabsAtomic`）。
- 类型 `narrator/subagent/project/folder/team` 在使用；`chapter/group/workspace` 是旧数据，读取时排除或已迁移。文件夹不嵌套，成员紧跟文件夹头（`regroupFolders`）；只有 `narrator/subagent` 能进文件夹（`canJoinFolder`），项目与团队只在顶层。
- 分区：现在每个标签都写在 `work`（侧栏唯一的列表，`tabSection`）。`projects` 是项目标签旧的分区，侧栏早已不渲染它；每个用户首次读写时在锁内转换一次（`convertLegacyProjectSectionLocked`，探测是一条走索引的 `LIMIT 1`）：
  - 置顶的旧项目标签移进 `work`（强制改写行的 `section`，`forceRowSync`）；
  - 没置顶的旧项目标签删掉（当年访问项目页时自动记下的，不再翻出来）；
  - 首次从偏好 JSON 迁移时同样只留置顶的项目标签。
  - 「没置顶的旧项目标签」这条规则只写一处（`isRetiredProjectVisit`）。还没做文件夹转换的老用户（`folders_migrated` 未置）先跑 `convertLegacyWorkspaceRowsLocked`，它会把保留的每一行都改写进 `work`，所以它在改写前就按行原来的分区用同一条规则丢掉这些旧访问，否则它们会被搬进 `work`、躲过随后的项目分区转换（`recent-tab-teams.test.ts` 的「before the folder conversion too」守着）。两个转换都记账（标志位、`projects` 里不再有行），重复执行无变化。
  `GET ...?section=projects` 仍可用，转换后为空。
- 置顶：`PATCH /pin` 之外，upsert 可带 `pin`（true/false），在同一个版本里建标签并置顶（项目页、团队页的「固定到侧栏」用它）；不带 `pin` 的再次访问保留已存的置顶状态（`applyRecentTabUpsert`）。
- 单个 upsert（`PUT /recent-tabs`，`upsertRecentTab`）被服务端滤掉时：如果是团队标签或带了 `pin`（用户有意的操作），返回 409 `RECENT_TAB_REFUSED`，页面据此提示失败；隐藏会话的普通访问仍静默不写。批量 upsert 和整表恢复照旧静默过滤。
- 单个标签的置顶状态：`GET /recent-tabs/state?type=&id=` 返回 `{ present, pinned }`，一次 `(user_id, tab_key)` 唯一索引读、不加锁、不迁移；`projects` 分区里没置顶的旧行按转换后的样子答「不在」（`getRecentTabState`）。它不受分页限制，给页面上的固定按钮用。
- 团队标签（`type: "team"`，id = 团队 id = 协调者叙述者 id，`recent-tab-teams.ts`）：
  - 不代表协调者会话：`represented_narrator_id`、`narrator_id` 都是 NULL，所以 `getRecentTabUserIdsFor*` 看不到它，持有它不会收到协调者的通知；
  - 标题与 `project_id`（新列，只有团队标签有值）由服务端从 `project_teams` 和协调者标题写入，客户端传的不算；upsert 和整表恢复都先过 `authorizeTeamTabs`：团队不存在、已归档、或用户读不了协调者，就不写（`upsertRecentTabsBatch`、`restoreRecentTabs`）；
  - 协调者改名时持有者的团队标签跟着改（`syncNarratorTitleToRecentTabs` 另按 `(type, entity_id)` 索引找团队标签持有者）；
  - 运行时补丁（`enrichTeamTabs`）：读得了才给协调者的 `status/substatus`；只读者加 `teamOnlooker`；成员加 `pendingApprovalCount`（团队页顶栏同一个计数 `teamPendingApprovalCount`，每次请求最多算 20 个团队，`TEAM_TAB_PENDING_COUNT_LIMIT`），其他人为 null；读不了的团队补丁为空状态；
  - 何时移除：团队归档（`startTeamStatusSync` 发现归档后调 `pruneTeamTabs`，取消归档不恢复）、删除协调者（`narrator-service` 删除时 `removeTabFromAllUsers("team", id)`）、协调者共享变化后读不了（`narrator-sharing.ts:announceAccessChange` 调 `pruneTeamTabs`，逐个持有者重新判读）、失去项目（`pruneUnreadableProjectTabs` 对该项目的团队标签按协调者 ACL 判读，`usersWithTabsInProject` 也把团队标签持有者算进去）。
- 每次写入都在用户级锁内进行：读行 → 变换 → 去重加限额 → 在一个事务里只更新有差异的行并把 `user_recent_tabs_meta.revision` +1，再向该用户广播 `user:recent_tabs_delta`（每批 100 个操作）（`persistMutationLocked`、`broadcastDelta`）。无变化不增版本。
- 读取走游标分页：每页最多 50 行，游标绑定分区和版本，版本变了返回 409 `stale cursor`，客户端须从第一页重载（`listPage`）；文件夹成员不在顶层分页里。
- 运行时信息与记录分开：`getRuntimePatches` 一次最多 100 个键，返回状态、草稿、终端/后台任务计数、在线查看者、团队只读旁观者标记等，不写库（`POST /api/user-preferences/recent-tabs/runtime`）。
  - 项目标签没有叙述者 socket，不进实时窗口，另由 `recent-tabs-utils.ts:selectProjectRuntimeTabs` 选进运行时请求（当前页的、置顶的、其余的，最多 20 个，`PROJECT_TAB_RUNTIME_LIMIT`）；`RecentTabsWSProvider` 从实时窗口的预算里扣掉这些名额，一次请求仍不超过 `RECENT_TABS_LIVE_LIMIT` 个键。卡片或触屏详情打开时再单读这一个键（`useRecentTabs.ts:refreshProjectTabDetails`，同一键 10 秒内不重复，取消或失败不算），补丁并进标签缓存。行菜单（右键或触屏左滑）只记行的 `type:id`，每次渲染从当前列表按键取标签（`recent-tab-menu-target.ts:useRecentTabMenuTarget`）：运行时补丁替换缓存里的标签对象而不是原地改，打开时抓住的对象看不到之后到达的详情；行离开列表时菜单关闭（测试 `recent-tab-menu-target.test.tsx`）。测试 `RecentTabs.requests.test.tsx`（持久化行的键进请求、打开卡片显示路径与计数并单读一次）。
  - 项目标签的悬停卡片数据只在这条运行时路径上算（`recent-tab-projects.ts:enrichProjectTabs`，不在分页列表里）：读得了项目（`resolveProjectGate`）才给 `projectPath`（项目目录）、`activeSessionCount` / `waitingSessionCount`（链到该项目、此刻 `working`/`waiting`、本人读得了的 primary 会话，`narratorReadableWhere`）、`teamCount`（活跃且协调者读得了的团队）；读不了或已删的项目全为 null。上限：每次请求最多 20 个项目标签（`PROJECT_TAB_DETAIL_LIMIT`），两条连接查询经读 worker（`readQuery`，`worker-required`，5s 超时）各最多读 `PROJECT_TAB_ROW_CAP` + 1 = 201 行，只读正在运行的会话，不对项目历史做 `COUNT(*)`；碰到上限时 `projectCountsCapped`，卡片显示「N+」。卡片（`RecentTabDetailCard.tsx:ProjectTabDetails`）没有进行中的会话时写「没有进行中的会话」，等待数和团队数为 0 时不显示。测试 `recent-tab-projects.test.ts`（真实 ACL：别人的私有会话/团队不计，失去项目读权限后为空）、`recent-tab-project-coordinator.test.tsx`。
- 关闭、清空、解散文件夹会生成撤销令牌，内存里每用户一份、30 秒过期、全局最多 1000 份；令牌只在版本未变时可还原，否则 409（`restoreRecentTabs`）。进程重启后令牌失效。
- 被标记为 `hiddenFromLists` 的叙述者不会写入标签（`withoutHiddenNarratorTabs`）；归档前会记下它所在的文件夹，取消归档时放回，文件夹已不存在则回到顶部（`rememberArchivedTabPlacement`、`restoreArchivedTabPlacement`）。
- 旧版把标签存在偏好 JSON 里；首次访问时在锁内迁移，启动后还会分批（每批 100 个用户）补迁，找人的函数都会先等这次补迁完成（`ensureMigratedLocked`、`ensureAllRecentTabsMigrated`）。写入同时维护一份最多 20 条的旧格式影子。
- 作为接收人来源：`getRecentTabUserIdsForNarrator`（按用户 id 游标分批查，可带上限）、`...ByRecency`（按最近访问排序取前 N）、`getRecentTabUserIdsForTeamTrees`（团队协调者及其子代理）。用的是 `represented_narrator_id` 索引，所以子代理标签也算，团队标签不算。使用方：通知中心扇出、外部 IM 提醒、IM 网关的状态通知与 `/list`（读整表后滤掉团队标签，一行都不列）、项目成员变更与共享时的受影响用户（`project-membership.ts`、`narrator-sharing.ts`）。持有标签本身不是授权，各使用方仍要自己再判读权。

- 数据导出只带一张相关表：`recent_tab_archive_marks`（归档时记下的文件夹位置，`snapshot-protocol.ts:SNAPSHOT_TABLES.sessions`）；`user_recent_tabs` 本身不导出。

## 前端
- `frontend/hooks/useRecentTabs.ts`（分页读、乐观更新、撤销提示、`user:recent_tabs_delta` 帧的合并）与 `useRecentTabsWS.ts`（订阅叙述者状态/标题等列表事件）；`recent-tabs-utils.ts`、`recent-tab-folders.ts`（把平铺列表按文件夹分组成渲染行；排布规则本身在 `shared/recent-tab-layout.ts`，前后端共用）。
- 去哪：`recent-tabs-utils.ts:recentTabHref`（会话 `/narrators/:id`、项目 `/projects/:id`、团队 `/projects/:projectId/teams/:id`），`isTabActive`、行的点击、键盘 Enter（行上的 `data-tab-href`，`navRowHref`）和「在窗口中打开」（`recentTabWindowHref`）都按它。
- 实时：`recentTabLiveNarratorId` 让团队标签跟随协调者，套接字订阅和运行时读取都带上它（同一个协调者的会话标签与团队标签各占一个键）；套接字补丁对团队标签只取标题和状态（`teamTabPatch`）；协调者状态一变，2 秒后合并重读一次运行时以刷新待批数。提醒（声音、favicon、PWA、`above_idle` 提前）只认会话标签：只固定了团队的人不会因协调者等待而被提醒。
- 固定按钮：`PinToSidebarButton.tsx`（项目页标题旁、团队页顶栏标题旁、项目团队列表每行；团队只在活跃时给，见[团队页与审批](teams/page.md)）。是否已置顶：标签在侧栏已载入的行里就直接用那一行（`recent-tab-page-pin.ts:loadedSidebarPin`，跟着侧栏即时变）；不在（可能排在第 50 行之后）就用 React Query 读 `GET /recent-tabs/state`（键 `recentTabStateQueryKey(userId, key)`，根 `RECENT_TAB_STATE_QUERY_ROOT` = `["user-preferences", "recent-tab-state"]`，60 秒内算新鲜）。这是按用户的数据：键里带用户 id，且挂在 `["user-preferences"]` 下，换账号时 `useAuth.ts:applySession` 与 `useUserPreferences.ts` 的 token 观察者整体移除这一前缀，新账号不会看到上一个账号的置顶状态（测试见 `PinToSidebarButton.test.tsx` 的换账号用例），读到之前按钮禁用，免得把已置顶的再置顶一次（`resolvePagePin`）。这个读在三种时候被标为过期（`useRecentTabs.ts:invalidateRecentTabStates`）：任何 delta（本页的写入或别的客户端的 `user:recent_tabs_delta` 帧，都经 `applyRecentTabsDeltaAndFollowUp`）碰到该键；列表因缺口或重连从第一页重载（`refreshRecentTabsLoadedWindow` 的 `reset`、`refreshRecentTabsAfterReconnect`）；按钮自己点完。点了走 `useRecentTabs.ts:setRecentTabPinnedFromPage`（置顶 = 带 `pin: true` 的 upsert，取消 = 普通 unpin，标签留着），失败（含 409 `RECENT_TAB_REFUSED`）弹红色提示。测试 `PinToSidebarButton.test.tsx`。项目列表卡片没有菜单，没加。
- 团队标签的图标：协调者的 `NarratorStatusIcon` 加团队角标，成员有待批时右上角显示数量（`RecentTabs.tsx:TeamTabIcon`）；悬停卡片显示同样的状态和待批数。
- 协调者的会话标签和团队标签可能并排、同名：会话标签保持原样（它的 `represented_narrator_id` 决定通知收件人，不能去掉或合并），行标题后加一个暗色「协调者」小字（`RecentTabs.tsx:RecentTabTitle`，判定 `recent-tabs-utils.ts:isCoordinatorSessionTab` = `narrator` 类型且运行时补丁的 `teamSession` 为真；团队里只有协调者是 primary），悬停卡片多一行说明。`teamSession` 列入 `RECENT_TAB_RUNTIME_KEYS`，列表重取时沿用，标签不闪。
- `frontend/components/nav/RecentTabs.tsx` 是侧栏主体；拖拽模型 `recent-tab-drag-model.ts`/`recent-tab-drop-target.ts`/`useRecentTabsDrag.ts`，外部拖入 `useRecentTabExternalDrop.ts`，键盘导航 `recent-tab-keyboard-nav.ts`，触摸滑动 `useRowSwipe.tsx`（右滑关闭、左滑开菜单）。
- 文件夹的折叠/预览/展开是每台设备的显示状态，存 localStorage，不上服务器（`useFolderDisplay.ts`）；预览条数才是文件夹行上的设置（`RECENT_TAB_FOLDER_DEFAULT_PREVIEW` = 3）。
- 侧栏在会话完成/等待时触发浏览器声音与 PWA 通知；服务器标记了 `backgroundWorkActive` 的 done 转换保持静默，权限等待始终通知（`recent-tabs-logic.ts:isBackgroundWorkSilencedStatus`，`recent-tabs-silence.test.ts`）。
- 状态气泡（`NarratorStatusIcon.tsx`、`narrator-status-icon-logic.ts`、`RecentTabBackgroundBubble.tsx`）同时被叙述者列表卡片和团队页复用，视觉决策放在 logic 文件里避免两处漂移。

## 从哪读起
- `server/services/recent-tabs-service.ts:mutate`：所有写入的入口。
- `server/routes/user-preferences.ts`：`/recent-tabs` 路由族（分页、state、runtime、upsert、batch、move、pin、clear、restore、folders）。
- `shared/recent-tabs.ts`、`shared/recent-tab-layout.ts`：前后端共用的类型、上限与文件夹排布。

## 改它时
- 改上限或分页常量：`shared/recent-tabs.ts`（`RECENT_TABS_STORAGE_LIMIT`、`PAGE_SIZE`、`LIVE_LIMIT`、`WS_BATCH_SIZE`、`LEGACY_LIMIT`）前后端共用，`server/services/recent-tabs-service.ts` 里还有撤销的 `UNDO_TTL_MS`/`UNDO_MAX_ENTRIES`；对应测试 `recent-tab-folders.test.ts`、`recent-tab-archive-placement.test.ts`、`frontend/hooks/useRecentTabs.test.ts`。
- 加一种写操作：必须经 `mutate` 进用户级锁，并产出 delta 广播；路由加在 `server/routes/user-preferences.ts` 的 `/recent-tabs` 族；前端 `useRecentTabs.ts` 的乐观更新要与服务端结果一致，版本冲突走 409。
- 改文件夹/置顶排布规则：只改 `shared/recent-tab-layout.ts`（服务端 `regroupFolders` 与客户端共用），不要在前端另写一份。
- 改接收人来源函数（`getRecentTabUserIdsFor*`）：使用方（通知扇出、外部提醒、IM 网关、项目成员变更、叙述者分享）不会自动校验读权限，每处都要自己再过滤；`notification-recent-tabs.test.ts`、`gateway/__tests__/recent-tabs-consumers.test.ts` 覆盖。团队标签不能写 `represented_narrator_id` 或 `narrator_id`：前者会让它进接收人索引，后者会让 IM 网关 `/list` 把它当会话编号（`recent-tab-teams.test.ts` 守着前者）。
- 改团队标签：服务端规则在 `recent-tab-teams.ts`（这个模块不能静态导入 `recent-tabs-service`，反过来服务也只动态导入它，免得 ACL 依赖进到每个只 mock 了 `db` 的测试里）；测试 `server/services/__tests__/recent-tab-teams.test.ts`（存什么、置顶/移动/关闭撤销/淘汰、不进接收人索引、改名、运行时、归档/删除/失权移除、旧 `projects` 分区转换）、`frontend/hooks/recent-tabs-team.test.ts`、`RecentTabs.requests.test.tsx` 最后一条。
- 改迁移/分区规则：除 `recent-tab-teams.test.ts` 外，`tests/server/services/recent-tabs-service.test.ts`（偏好 JSON 迁移、delta 重放、分页）和 `tests/server/routes/user-preferences.test.ts`（路由契约，含 `/recent-tabs/state` 与 409 拒绝）也按「项目标签在 `work`、没置顶的旧项目标签被丢」断言。
- 侧栏行不显示 cwd 的前导斜杠问题由 `frontend/components/nav/recent-tab-path-subtitle.guard.test.ts` 守住（读源码断言），改 `RecentTabs.tsx` / `RecentTabDetailCard.tsx` 的路径渲染会触发它。
- 改表 `user_recent_tabs`：SQLite 与 PG schema 两边；旧偏好 JSON 迁移（`ensureMigratedLocked`）和旧 `projects` 分区转换仍在，别删。`type` 枚举只在 TS 层（两边库里都是 text），加类型不需要迁移；`project_id` 列是 `0263`/PG `0080` 加的。

## 相关
- [通知与注意力](notifications.md)
- [IM 网关](gateway.md)
- [团队页与审批](teams/page.md)：团队标签的固定入口与待批计数。
- [项目](projects.md)：项目页的固定入口。
