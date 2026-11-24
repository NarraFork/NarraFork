---
id: collaboration.recent-tabs
title: 最近标签页
summary: 每个用户最近打开的会话标签页：记录、运行时信息、作为通知和提醒的接收人来源。
anchors:
  - server/services/user-preferences-service.ts
  - server/services/recent-tabs-service.ts
  - shared/recent-tabs.ts
  - server/routes/user-preferences.ts
  - server/db/schema.ts
  - frontend/components/nav/NarratorStatusIcon.tsx
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
status: draft
verified_at: 2e6441ad0
---
# 最近标签页

侧栏里每个用户自己的一份标签列表（叙述者、子代理、项目，外加用户手建的文件夹），存在 `user_recent_tabs` 表，每个标签一行。除了侧栏，它还是「谁在关注某个叙述者」的索引：通知、IM 提醒、会话重命名等都靠它找人。

## 关键规则
- 一用户最多 500 行（`RECENT_TABS_STORAGE_LIMIT`）。超限从列表底部（最久没动的一端）逐个淘汰：先淘汰未置顶的游离子代理，再是未置顶的普通标签或文件夹成员，最后连置顶也可淘汰；正在写入的那个单元不会被淘汰（`recent-tabs-service.ts:trimTabsAtomic`）。
- 类型 `narrator/subagent/project/folder` 仍在使用；`chapter/group/workspace` 是旧数据，读取时排除或已迁移。分区只有 `projects` 与 `work`。文件夹不嵌套，成员紧跟文件夹头（`regroupFolders`）。
- 每次写入都在用户级锁内进行：读行 → 变换 → 去重加限额 → 在一个事务里只更新有差异的行并把 `user_recent_tabs_meta.revision` +1，再向该用户广播 `user:recent_tabs_delta`（每批 100 个操作）（`persistMutationLocked`、`broadcastDelta`）。无变化不增版本。
- 读取走游标分页：每页最多 50 行，游标绑定分区和版本，版本变了返回 409 `stale cursor`，客户端须从第一页重载（`listPage`）；文件夹成员不在顶层分页里。
- 运行时信息与记录分开：`getRuntimePatches` 一次最多 100 个键，返回状态、草稿、终端/后台任务计数、在线查看者、团队只读旁观者标记等，不写库（`POST /api/user-preferences/recent-tabs/runtime`）。
- 关闭、清空、解散文件夹会生成撤销令牌，内存里每用户一份、30 秒过期、全局最多 1000 份；令牌只在版本未变时可还原，否则 409（`restoreRecentTabs`）。进程重启后令牌失效。
- 被标记为 `hiddenFromLists` 的叙述者不会写入标签（`withoutHiddenNarratorTabs`）；归档前会记下它所在的文件夹，取消归档时放回，文件夹已不存在则回到顶部（`rememberArchivedTabPlacement`、`restoreArchivedTabPlacement`）。
- 旧版把标签存在偏好 JSON 里；首次访问时在锁内迁移，启动后还会分批（每批 100 个用户）补迁，找人的函数都会先等这次补迁完成（`ensureMigratedLocked`、`ensureAllRecentTabsMigrated`）。写入同时维护一份最多 20 条的旧格式影子。
- 作为接收人来源：`getRecentTabUserIdsForNarrator`（按用户 id 游标分批查，可带上限）、`...ByRecency`（按最近访问排序取前 N）、`getRecentTabUserIdsForTeamTrees`（团队协调者及其子代理）。用的是 `represented_narrator_id` 索引，所以子代理标签也算。使用方：通知中心扇出、外部 IM 提醒、IM 网关的状态通知与 `/list`、项目成员变更与共享时的受影响用户（`project-membership.ts`、`narrator-sharing.ts`）。持有标签本身不是授权，各使用方仍要自己再判读权。

- 数据导出只带一张相关表：`recent_tab_archive_marks`（归档时记下的文件夹位置，`snapshot-protocol.ts:SNAPSHOT_TABLES.sessions`）；`user_recent_tabs` 本身不导出。

## 前端
- `frontend/hooks/useRecentTabs.ts`（分页读、乐观更新、撤销提示、`user:recent_tabs_delta` 帧的合并）与 `useRecentTabsWS.ts`（订阅叙述者状态/标题等列表事件）；`recent-tabs-utils.ts`、`recent-tab-folders.ts`（把平铺列表按文件夹分组成渲染行；排布规则本身在 `shared/recent-tab-layout.ts`，前后端共用）。
- `frontend/components/nav/RecentTabs.tsx` 是侧栏主体；拖拽模型 `recent-tab-drag-model.ts`/`recent-tab-drop-target.ts`/`useRecentTabsDrag.ts`，外部拖入 `useRecentTabExternalDrop.ts`，键盘导航 `recent-tab-keyboard-nav.ts`，触摸滑动 `useRowSwipe.tsx`（右滑关闭、左滑开菜单）。
- 文件夹的折叠/预览/展开是每台设备的显示状态，存 localStorage，不上服务器（`useFolderDisplay.ts`）；预览条数才是文件夹行上的设置（`RECENT_TAB_FOLDER_DEFAULT_PREVIEW` = 3）。
- 侧栏在会话完成/等待时触发浏览器声音与 PWA 通知；服务器标记了 `backgroundWorkActive` 的 done 转换保持静默，权限等待始终通知（`recent-tabs-logic.ts:isBackgroundWorkSilencedStatus`，`recent-tabs-silence.test.ts`）。
- 状态气泡（`NarratorStatusIcon.tsx`、`narrator-status-icon-logic.ts`、`RecentTabBackgroundBubble.tsx`）同时被叙述者列表卡片和团队页复用，视觉决策放在 logic 文件里避免两处漂移。

## 从哪读起
- `server/services/recent-tabs-service.ts:mutate`：所有写入的入口。
- `server/routes/user-preferences.ts`：`/recent-tabs` 路由族（分页、runtime、upsert、batch、move、pin、clear、restore、folders）。
- `shared/recent-tabs.ts`、`shared/recent-tab-layout.ts`：前后端共用的类型、上限与文件夹排布。

## 改它时
- 改上限或分页常量：`shared/recent-tabs.ts`（`RECENT_TABS_STORAGE_LIMIT`、`PAGE_SIZE`、`LIVE_LIMIT`、`WS_BATCH_SIZE`、`LEGACY_LIMIT`）前后端共用，`server/services/recent-tabs-service.ts` 里还有撤销的 `UNDO_TTL_MS`/`UNDO_MAX_ENTRIES`；对应测试 `recent-tab-folders.test.ts`、`recent-tab-archive-placement.test.ts`、`frontend/hooks/useRecentTabs.test.ts`。
- 加一种写操作：必须经 `mutate` 进用户级锁，并产出 delta 广播；路由加在 `server/routes/user-preferences.ts` 的 `/recent-tabs` 族；前端 `useRecentTabs.ts` 的乐观更新要与服务端结果一致，版本冲突走 409。
- 改文件夹/置顶排布规则：只改 `shared/recent-tab-layout.ts`（服务端 `regroupFolders` 与客户端共用），不要在前端另写一份。
- 改接收人来源函数（`getRecentTabUserIdsFor*`）：使用方（通知扇出、外部提醒、IM 网关、项目成员变更、叙述者分享）不会自动校验读权限，每处都要自己再过滤；`notification-recent-tabs.test.ts`、`gateway/__tests__/recent-tabs-consumers.test.ts` 覆盖。
- 侧栏行不显示 cwd 的前导斜杠问题由 `frontend/components/nav/recent-tab-path-subtitle.guard.test.ts` 守住（读源码断言），改 `RecentTabs.tsx` / `RecentTabDetailCard.tsx` 的路径渲染会触发它。
- 改表 `user_recent_tabs`：SQLite 与 PG schema 两边；旧偏好 JSON 迁移（`ensureMigratedLocked`）仍在，别删。

## 相关
- [通知与注意力](notifications.md)
- [IM 网关](gateway.md)
