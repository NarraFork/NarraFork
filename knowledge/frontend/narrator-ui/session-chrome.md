---
id: frontend.narrator-ui.session-chrome
title: 会话外框
summary: 会话头部与工具栏、模型与额度、dock 与工作区布局、后台任务、上下文管理与压缩、Spec、详情、时间线、会话导入导出。
anchors:
  - frontend/components/narrator/header/
  - frontend/components/narrator/model/
  - frontend/components/narrator/dock/
  - frontend/components/narrator/workspace/
  - frontend/components/narrator/background/
  - frontend/components/narrator/context-management/
  - frontend/components/narrator/compact/
  - frontend/components/narrator/spec/
  - frontend/components/narrator/session-interchange/
  - frontend/components/narrator/panels/
  - frontend/components/narrator/timeline/
  - frontend/components/narrator/details/
  - frontend/components/narrator/browser/
  - frontend/components/narrator/AppearancePanel.tsx
  - frontend/components/narrator/appearance-panel-overflow.browser-fixture.tsx
  - frontend/components/narrator/NarratorPublicShareManager.tsx
  - frontend/components/narrator/NarratorSearchPanel.tsx
  - frontend/components/narrator/MobileToolPanelHost.tsx
  - frontend/components/narrator/OutlineDrawerHost.tsx
  - frontend/components/narrator/details-panel-lifecycle.tsx
  - frontend/components/narrator/ManualResourceForms.tsx
  - frontend/hooks/narrator-toolbar-layout.ts
  - frontend/hooks/useFirstScreenActivity.ts
  - frontend/hooks/useNarratorExecutionDevices.ts
  - shared/execution-devices.ts
  - frontend/hooks/useNarratorToolbarLayout.ts
  - frontend/hooks/useSpec.ts
  - frontend/hooks/useSpecImport.ts
  - frontend/hooks/useSpecLoss.ts
  - frontend/lib/narrator-loading-metrics.ts
  - frontend/lib/narrator-panel-state.ts
  - shared/narrator-toolbar.ts
  - shared/identicon.ts
keywords:
  - NarratorDock
  - dockview
  - FocusChatHost
  - narrafork_ndock_
  - 工作区布局
  - 导演模式
  - workspaces.tree
  - HeaderToolbar
  - 工具栏溢出
  - worktree
  - 模型选择
  - 额度指示
  - 子代理模型池
  - 后台任务
  - background_task_list_delta
  - 上下文构成
  - 压缩摘要
  - Spec 面板
  - 时间线
  - 导入会话
  - 访问权限
status: draft
verified_at: fac3988333435e3fc3b5a4a6ace226c72ce14745
---
# 会话外框

围绕聊天区的一切：头部/工具栏、状态与模型控件、侧面板（文件、详情、Spec、终端、Git、浏览器、时间线、任务、搜索、外观…）如何在 dock 或工作区里摆放，以及压缩、上下文占用、会话导入导出等对话框。聊天区本身见[消息列表](message-list.md)，输入区见[输入框与交互](composer.md)。

## 关键规则
- 面板种类统一在 `panels/panel-kind.ts:PanelKind`：chat、terminal、details、spec、git、browser、tasks、communication、search、userchat、appearance、timeline、filetree、subagent、file、knowledge、outline、webview、plugin、mock。`ResourcePanelKind` 是工具栏控制的单例资源面板，排除 chat/subagent/file/knowledge/outline/webview/plugin（file、subagent 多实例，每路径/每子会话一个）。
- 单叙述者 dock 布局存 localStorage（`dock/narrator-dock-layout.ts`），key 为 `narrafork_ndock_<narratorId>_<desktop|mobile>`，桌面与手机各一份；启动时清理 30 天未打开或格式损坏的布局（`narrator-dock-storage-cleanup.ts`，时间未知的保留）。恢复时分支：
  - 没有 chat 面板，或 chat 面板的 narratorId 与当前不符：丢弃并重建默认布局（只含不可关闭的 chat）。
  - `fromJSON` 抛错：同样回落默认布局。
- 工作区布局存服务端 `workspaces.tree`（dockview 序列化加版本信封），只记录位置；面板成员由服务端 `workspace_panels` 权威决定，布局里不是成员的条目被丢弃（`workspace/workspace-panel-set.ts`），布局丢失只损失排布不损失面板。
- 新开工具面板的落位（`panels/tool-placement.ts:resolveToolPlacement`）：
  - 已有次级组：作为标签叠入。
  - 无次级组但有 chat：在 chat 右侧分栏，约占 1/3 宽。
  - 宽面板（目前只有 `timeline`）且有 chat：在 chat 上方分栏，初始高度 380，最多占表面高度 55%。
  - 无 chat：独立添加。
- 没有 dock 的宿主（手机页、分离窗口）：`MobileToolPanelHost` 用抽屉承载工具面板，`OutlineDrawerHost` 用抽屉承载大纲；`REMOTE_BUILD` 下详情/Spec/文件面板/保存转储等替换为 `RemoteUnsupported`（`remote-ui-panels.tsx` 别名）。
- `communication` 工具栏项同时声明 dock/drawer 宿主，旧自定义布局会追加新入口而不移动已有区位；团队页也打开同一通讯组件。dock/workspace 隐藏标签经现有可见性 Provider 释放图订阅、取消拖动；重新显示取新快照，不卸载旁侧会话或草稿。
- 头部工具栏容量（`header/narrator-header-toolbar-capacity.ts`）：预算来自头部整行宽度而非工具栏自身宽度（避免级联收缩）；条目宽度是常量 22px、间距 10px；标题至少保留 140px；折叠的条目要多出 12px 才恢复（迟滞）；溢出的进入 `NarratorToolbarOverflowMenu`。该菜单在可拖动列表下面还有固定项（兼容性、大纲、保存的录制、「升级为团队」，最后是归档）；「升级为团队」只在 `onUpgradeToTeam` 传入时出现，对话框由 `NarratorPanel` 在菜单外渲染（见[团队页与审批](../../collaboration/teams/page.md)）。条目注册表 `narrator-toolbar-items.tsx` 用 `hosts` 声明哪些宿主能呈现，手机走抽屉。
- 创建 worktree 是步骤机（`header/worktree-flow.ts`：idle→prepare→create→reconcile→switch→done），失败结果未知时保留冻结的原请求供对账，不改写 requestId；移除流程 `worktree-removal-flow.ts` 的确认项必须是用户真正勾选的，不从计划推断。
- 工作树列表只在面板真实可见、菜单打开、权限允许且搜索防抖完成时读；稳定 key 包含 principal、opaque credential identity、narrator/device/repository/workspace 与搜索排序，不用随机 generation。30 秒 stale/60 秒 GC；关闭、换条件或卸载先取消再只保留首页，保留原 `dataUpdatedAt/isInvalidated`，新鲜重开不读、过期只读首页，不复活旧 cursor 链；另一个可见 observer 仍拥有列表时不裁它。关闭不恢复过期游标；创建未知结果/成功对账只标 stale，删除后先裁页再失效。创建能力来自 GitBar 已有权威 workspace probe，不能为未打开列表预读（`header/worktree-query-cache.ts`、`NarratorWorktreeControls.tsx`）。
- 额度/余额指示器按提供商分别实现（`model/`：Codex、OpenCode、Sub2Api 订阅、NUG、Kimi、DeepSeek、CommandCode、TokenDance、自定义 API 用量）；`use-narrator-quota.ts` 读取持久化的 `payment_required` 信息，`resumeAction` 只有 `continue` 否则为 `retry`。
- 子代理模型池编辑（`SubagentModelPoolEditor.tsx`）：只有用户的选择编辑会移除某类型的声明，未触碰的显式空数组保留（`subagent-model-pool-state.ts:selectPoolModels`）。
- 后台任务列表（`background/useBackgroundTaskList.ts`）：游标分页 + `background_task_list_delta` WS 帧，`refetchInterval: false`，不轮询；仅监听列表增量与进度，不再为宽泛的 `subagent_status_changed` 建 5 秒 fallback。`continued/child_running` 等叙述者派生展示变化由服务端占用索引的列表语义通知覆盖。增量缺口/失效/epoch 变化、显式刷新与重连都先丢弃后续页再重读首页，防止拼接失效游标；按类型（agent/bash/watch）和文本筛选，运行中在上、已结束在分隔线下。
- 执行设备（`hooks/useNarratorExecutionDevices.ts`）：面板、详情与路径规则共用 `["narratorExecutionDevices", narratorId]` 查询，按需/挂载读取，无在线 60 秒轮询（也不建离线设备轮询）；远程构建不启用。每个 QueryClient 引用计数共享一个监听器，设备空数据提示、连接建立与控制面恢复触发 100ms 合并失效；先取消旧请求，防止过时授权/设备快照覆盖。设备详情、默认设备与各设备目录仍从会话 HTTP 接口读取，不从全局提示推断授权。
- 上下文构成菜单把占用分为 10 类：system、summary、toolDefinition、user、assistant、reasoning、toolCall、toolResult、attachment、other（`ContextCompositionMenu.tsx:CONTEXT_COLORS`）；阈值设置弹窗先夹取/取整再保存。
- 压缩摘要弹窗的目标状态被提升到虚拟行之上（`compact/use-compact-summary-modal.ts`），消息追加或流式更新不会卸载行而关掉弹窗；切换叙述者时重置。
- 时间线（`timeline/useNarratorTimeline.ts`）：回合分页 50；实时回合最快 2500ms 轮询、最慢 15000ms；跟随兜底轮询 30000ms，主要靠 WS 的状态变更。
- Spec 面板展示模式 `source | split | rich`（`spec/spec-editor-mode.ts`）；`rich` 是 Tiptap 所见即所得，会重新序列化整份文档，因此只对能无损载入的 markdown 提供；标签排布保存串行，一次只发一个请求且总发最新排布（`spec-tab-save.ts`）。
- 会话导入（`session-interchange/ImportSessionModal.tsx`）三种来源：浏览器上传（任何人）、服务器 `~/.claude`/`~/.codex` 扫描（仅管理员，否则隐藏）、在线设备扫描；UI 只隐藏服务端会拒绝的选项，服务端会重复校验。
- 普通会话的模型状态栏/测试/思考强度只用 runtime 设置与当前 `modelSummary`，不为一个模型读取 `useAllModels`/完整 card。模型菜单只在打开时取 options 有界页，当前选中值独立来自 runtime 摘要，不要求在第一页；不会自动抓完分页。NUG 额度只请求实际显示的 provider；未观察 auto 不虚构 provider 额度，选项协议见[来源组与模型列表](../../agent/model-catalog/sourcing.md)。
- Spec 标签布局按当前 narrator 单独 GET，不随 UI prefs 下载全部历史 map；独立 token/user/narrator key，30 秒 stale/60 秒 GC，写入前取消旧读。串行 saver 只持有已加载布局，写中读取或旧 epoch 不盖过新手势；PATCH 用服务端 json_set 合并（`spec/useSpecTabLayout.ts`、`useSpecTabLayout.test.tsx`）。
- 访问面板（`details/NarratorAccessPanel.tsx`）：可见范围（private/project/everyone）与可写范围（始终是可见范围的子集）两级，被限制的选项置灰而不是隐藏，另有逐人读/写授权。
- 团队标记（`header/NarratorTeamBadge.tsx`）：带 `team` trait 且有项目（`NarratorPanel` 的 `compatibilityProjectId`）的会话在标题后显示「团队」徽标，点开 `/projects/$projectId/teams/$teamId`（团队 id 就是协调者的叙述者 id）。`useNarratorTeamBadge` 决定显示与否并给出固定宽度：Remote Access 构建（`REMOTE_BUILD`，其路由没有团队页）、工作区预览、没有路由上下文时不显示；是否在团队页本身按路由状态的 pathname（已去掉 basepath）比较；原生 `href` 用 `router.buildLocation` + `history.createHref`，反代子路径下带前缀。宽度由 `header-title-width.ts:headerBadgeLayoutWidth`（canvas 量完整文字 + sm 徽标固定外框）给出，徽标按该 px 宽度绘制，并作为 `titleBadgeWidth` 计入 `resolveHeaderLayoutAfterTitle` 预算：工具先收进溢出菜单，标题再缩；连最小标题宽度旁都放不下时 `showTitleBadge` 为 false，不显示徽标，溢出与关闭按钮不会被挤出标题行（`header-team-badge.browser.test.ts` 在 en / zh-CN 窄宽度下验证）。模型菜单触发器（`model/ModelPickerMenu.tsx`）的「默认（模型）」经 `followDefaultLabel`。

## 从哪读起
- `dock/NarratorDockContext.tsx`：聊天面板与工具面板之间的发布/订阅与跨面板命令（页面级，无 Provider 时发布 hook 为空操作）。
- `dock/FocusChatHost.tsx`：聊天面板在 dock 中的承载；`panels/panel-kind.ts`、`panels/tool-placement.ts`。
- `workspace/WorkspacePage.tsx`、`dockview-layout.ts`、`DirectorLayout.tsx`（导演模式：一个主面板 + 缩略预览栏）。
- `header/use-header-toolbar.tsx`、`narrator-toolbar-items.tsx`；`details/details-panel-sections.ts`（详情面板的折叠与过滤规则）。

## 改它时
- 新增面板种类：`PanelKind`、`PANEL_COMPONENT`/默认标题、dock 与工作区两处注册（`dock/panels.tsx`、`workspace/panels.tsx`）、工具栏注册表；布局信封版本变化要处理旧布局。
- 新增头部工具栏条目必须按 `ActionIcon size="sm"`（22px）渲染：容量计算用常量宽度而非测量，注释称有守卫测试保证该前提，但在 `narrator-header-toolbar-capacity.test.ts` 里未找到（未核实）。
- 改工作树显示缓存：`header/worktree-query-cache.test.ts`、`NarratorWorktreeControls.pagination.test.tsx`、`NarratorGitBar.test.tsx` 钉住关闭零读、首页复用/过期、身份切换、取消先于裁页、updatedAt/invalidation 保留与创建 capability 的权威来源。
- 改 `worktree-flow` 的步骤或失败语义要同步 `WorktreeRemovalDialog` 与服务端错误码翻译。

## 相关
- [会话界面总览](index.md)
- [文件面板](file-panels.md)
- [面板与布局](../panels.md)
- [数据获取与实时同步](../data-flow.md)
