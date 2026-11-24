---
id: frontend.narrator-ui.message-list
title: 消息列表
summary: 虚拟列表、细节级别、滚动、消息与内容渲染、Markdown、流式输出。
anchors:
  - shared/agent-reference.ts
  - frontend/components/narrator/vlist/measure/
  - frontend/components/narrator/vlist/render/R*.tsx
  - frontend/components/narrator/vlist/render/[!R]*
  - frontend/components/narrator/vlist/vlist-{lod,morph,drill,fold,lifecycle,motion,stream-anim,swipe,width,resize,pointer,text-drag}*
  - frontend/components/narrator/vlist/vlist-{exact,virtualization,height,visible,unpredictable,jump,visual,window,row,trace,token,typography,highlight,selection,block,copy}*
  - frontend/components/narrator/vlist/{pretext,prepared,measure-cache,usePretext,segment,source-slice,parse-markdown,katex,message-math,guard-source,registry,render-registry,ExactRow,PretextExact,VListHarness}*
  - frontend/components/narrator/vlist/{vlist-live,vlist-message,vlist-data,vlist-reload,vlist-pipeline,vlist-persisted,vlist-head,vlist-tail,vlist-tool,streaming,exact-streaming,useVList,useReasoning,reasoning-translation,compact-progress,communication-navigation}*
  - frontend/components/narrator/vlist/{VList,Question,Reminder,auxiliary,markdown-images,outline,permission-textarea,remote-outline,spec-carryover,task-notice}*
  - frontend/components/narrator/vlist/vlist-{ask,compact,content,edit,error,injection,interaction,outline,permission,reflection,spec,subagent,user}*
  - frontend/components/narrator/lod/
  - frontend/components/narrator/scroll/
  - frontend/components/narrator/message/
  - frontend/components/narrator/markdown/
  - frontend/components/narrator/content/
  - frontend/components/narrator/streaming/
  - frontend/components/narrator/history/
  - frontend/components/narrator/selection/
  - frontend/components/narrator/trace/
  - frontend/components/narrator/NarratorMessageListSkeleton.tsx
  - frontend/components/narrator/HistoryRecoveryPanel.tsx
  - frontend/components/narrator/narrator-warning.ts
  - frontend/components/narrator/progress-label.ts
  - frontend/components/narrator/reflection-progress-store.ts
  - frontend/components/narrator/preload-panel-tail.ts
  - frontend/components/narrator/TurnElapsedTime.tsx
  - frontend/hooks/useNarratorLod.ts
  - frontend/hooks/scroll-parent.ts
  - frontend/hooks/useLodAnchor.ts
  - frontend/hooks/useLodIndicatorTrigger.ts
  - frontend/hooks/useShikiTokens.ts
  - frontend/lib/file-link-target.ts
  - frontend/lib/markdown-anchor-scroll.ts
  - frontend/lib/narrator-content-column.ts
  - frontend/lib/shiki-lang.ts
  - frontend/lib/shiki-language-aliases.ts
  - frontend/lib/shiki-language-loader.ts
  - frontend/lib/shiki-loader.ts
  - frontend/lib/shiki-token-cache.ts
  - frontend/lib/shiki-token-worker-client.ts
  - frontend/lib/shiki-token-worker-protocol.ts
  - frontend/lib/shiki-token.worker.ts
  - frontend/lib/stream-anim-duration.ts
  - frontend/lib/struct-view-tokens.ts
  - frontend/routes/dev-vlist-harness.tsx
  - shared/markdown-emphasis-compat.ts
  - shared/markdown-file-path.ts
  - shared/reasoning-content.ts
  - shared/reasoning-translation.ts
keywords:
  - PretextExactMessageList
  - 虚拟列表
  - LOD
  - 细节级别
  - narrafork_lod
  - narrafork_lod_alt_gesture
  - preparedBlock
  - 零 DOM 测量
  - 展开折叠
  - 活动轨迹
  - 流式输出
  - EXACT_RELOAD_COALESCE_MS
  - 历史加载
  - MarkdownContent
status: draft
verified_at: 878917e97
---
# 消息列表

叙述者面板里的消息区。它是一个"精确虚拟列表"：整段文档在当前 LOD 和宽度下用纯算术预测量，每行绝对定位，高度不靠 DOM 读取。`vlist/` 里既有这套布局内核的前端侧（`measure/`、`render/`），也有把 WebSocket 事件、权限/提问/压缩等交互接进列表的桥接模块。

## 关键规则
- 懒加载边界：`NarratorPanel.tsx` 用 `lazy(() => import("./vlist/PretextExactMessageList"))`；`vlist/vlist-isolation.guard.test.ts` 扫描 `frontend/`，vlist 之外任何文件静态 import vlist 即失败（动态 `import()`、`*.test.*`、`*.browser-fixture.*` 放行）。`PretextExactMessageList.tsx` 文件头自称“experimental/opt-in”，已与此不符（以懒加载与守卫测试为准）。
- 零 DOM 测量：`vlist/zero-dom-measure.guard.test.ts` 扫 `measure/*`、`registry.ts`、`vlist-pipeline.ts`、`vlist-tail-meta.ts`、`vlist-live-patch.ts` 等纯路径文件，禁止 `getBoundingClientRect`/`offsetHeight`/`ResizeObserver`/`getComputedStyle`；布局内核在 `shared/pretext-layout/`，由其 `shared-core.guard.test.ts` 枚举扫描。例外：渲染层对 mermaid/katex/未知尺寸图片的一次性局部修正（`PreparedUnknownBlock`）、滚动容器外壳、`VListHarness.tsx`（开发期校准）。
- 已提交行的高度只在用户操作后才变：`vlist-stable-height.guard.test.ts`（截断详情按完整上限预留高度、详情抓取要显式请求；反思通知不得渲染后再测量）。
- 每个 LOD 下每个工具调用都必须可寻址（有自己的卡片，或是轨迹里的具名行，不能只落进“工具调用 ×N”计数行）：`every-call-addressable.guard.test.ts`。
- LOD 取值 1–5，默认 4（`lod/RenderLodCtx.ts`）：
  - L5：未被用户手动折叠的工具卡片都展开（`measure-tool-call.ts:resolveToolCallOpened`，`lod >= 5` 返回 `!userCollapsed`）。
  - L4：最近两个 assistant run-segment（`trace/run-segments.ts:recentRunSegmentMessageIds`，count=2，在 `PretextExactMessageList.tsx` 调用）里的卡片按各自默认展开态，更早的折叠为头部。
  - L3：所有工具卡片折叠为头部（lodExempt / lodUserOverride 的卡片除外，恒展开）。
  - L2：推理与已完成工具合并成一条活动轨迹（`trace/render-units.ts`），文本完整。
  - L1：活动轨迹默认折叠；`measure-reasoning.ts` 在 `lod <= 2` 时推理走计数行。RenderLodCtx 注释所说的“L1 长助手文本截断”未核实。
- LOD 存取（`hooks/useNarratorLod.ts`）：每个叙述者各记一个 `narrafork_lod:<id>`；只有“设为默认”才写 `narrafork_lod_default`；打开时先用叙述者自己的，其次全局默认，再次 4。`narrafork_lod_schema`=2 标记存储档位已从旧 1–6 迁到 1–5（旧值 ≥4 减 1），迁移只做一次。
- LOD 手势（`vlist/vlist-lod-gesture.ts`）：Alt+滚轮（deltaY>0 降一级，否则升一级；`narrafork_lod_alt_gesture` 关闭时返回 null，不拦截滚动）、双指捏合（比例 >1.2 升、<1/1.2 降）；两次步进至少间隔 140ms。指示器 `lod/lod-indicator.ts`：按住 Alt 常驻，手势触发则短暂显示后淡出，指针在其上时不淡出。
- 结构性变更（新消息、编辑、删除、压缩完成）触发整窗重载，规则在 `vlist-reload-policy.ts`：
  - 读者在底部：重载；合并窗口 `EXACT_RELOAD_COALESCE_MS`=120ms，从第一个待处理修订起最迟 `EXACT_RELOAD_MAX_DELAY_MS`=1000ms 必须提交。
  - 读者已上滚：推迟（`deferred`），驱动“有新消息”提示，回到底部再评估。
  - 工具完成、反思裁决、权限决策等生命周期事件不重载，走 `vlist-live-patch.ts` 原地补丁；补丁层拒绝终态回退成非终态（`vlist-live-events.ts` 头注释，防重连重放把完成卡片翻回转圈）。
- 更早历史的自动加载（`history/older-history-auto-load.ts`）：需要最近 2500ms 内有朝向历史的用户手势。分支：
  - 无手势、手势已过期、或在底部：不加载，清空手势记录。
  - 关闭自动加载、无更早数据、正在展开、scrollTop 超过触发像素：不加载，但保留手势记录。
  - 其余：加载并清空记录。
  - 偏好查询未完成时视为不启用，查询结束但无数据则回落为启用。
- 流式：`streaming/streaming-delta-fold.ts` 按元素 id + 修订号 + 原始字符偏移折叠增量；`streaming-block-supersede.ts` 判断持久化块是否取代流式块；`vlist/streaming-handoff.ts` 与 `trace/render-units.ts` 保证流式行与落库行同 key（`tool-<toolUseId>`），交接时不换元素；`streaming-markdown-split.ts` 把增长文本切成“稳定前缀 + 活动尾部”，切点只落在空行处且不在围栏代码内，前缀含引用式链接/脚注定义则整条禁用切分。
- 嵌套行是扁平的（`message/nested-rows.ts`：有 `parentMessageId` 即嵌套，只通过父工具调用读取）；WS 事件对已加载行的不可变更新在 `message/message-tree-utils.ts`，分页查询缓存的删除裁剪在 `message/messages-query-cache.ts`。
- Markdown：`markdown/MarkdownContent.tsx`（remark-math 等动态加载）、代码高亮缓存 `highlight-cache.ts`（上限 64 条 / 1MB，单段可缓存 ≤20000 字符，文件面板上限 200000）；本地文件链接由 `remark-local-file-links.ts` 只对显式 `file:`/`nf-file:`/盘符目标改写，不从正文或行内代码推断。

## 从哪读起
- `vlist/PretextExactMessageList.tsx`（近 6000 行外壳）：滚动坐标系、可见窗口、WS 接线。
- `vlist/CONTRACT.md`：高度模型协议（文档，需回到 `measure/` 核对）；样板实现 `vlist/measure/measure-markdown.ts`。
- `vlist/registry.ts`、`vlist/vlist-pipeline.ts`：元件类型到测量函数的注册与管线。
- `vlist/vlist-live-patch.ts`、`vlist-live-events.ts`：实时补丁；`vlist/render/`：每种元件的绘制。
- `scroll/AutoFollowScroll.tsx`：自动跟随与“回到底部”；`message/message-list-handle.ts`：列表命令句柄（跳转到消息）。

## 改它时
- 新增一种行元件：`measure/measure-xxx.ts` + `render/RenderXxx.tsx` + `registry.ts`/`render-registry.tsx` 注册；测量文件放进 `zero-dom-measure.guard.test.ts` 的纯路径清单后必须零 DOM API。
- 改 LOD 档位或数量：同步 `lod/RenderLodCtx.ts`、`hooks/useNarratorLod.ts` 的迁移与 `SCHEMA_VERSION`，否则已存的档位会被误读。
- 从 vlist 之外引用 vlist 内容必须动态 import，否则 `vlist-isolation.guard.test.ts` 失败。
- 移动 `vlist/*.ts` 前全仓搜旧路径：多个守卫测试用 `readFileSync` 读源文件（`guard-source.ts`）。
- 改折叠逻辑要过 `every-call-addressable.guard.test.ts`。

## 相关
- [输入框与交互](composer.md)
- [工具卡片](tool-cards.md)
- [会话界面总览](index.md)
