---
id: frontend.layout-engine
title: 前端排版引擎
summary: shared/pretext-layout：不量 DOM、只靠 pretext 字形度量与常量算出每个会话条目的高度，另含 diff、工具输入输出投影、推理分段等前后端共用的纯函数。
anchors:
  - shared/pretext-layout/agent-reference-flow.ts
  - shared/pretext-layout/auxiliary-content.ts
  - shared/pretext-layout/communication-state.ts
  - shared/pretext-layout/diff-core.ts
  - shared/pretext-layout/diff-layout.ts
  - shared/pretext-layout/diff-word-tokens.ts
  - shared/pretext-layout/element-kinds.ts
  - shared/pretext-layout/engine.ts
  - shared/pretext-layout/fragment-style.ts
  - shared/pretext-layout/golden-fixture.ts
  - shared/pretext-layout/golden.ts
  - shared/pretext-layout/image-fit.ts
  - shared/pretext-layout/index.ts
  - shared/pretext-layout/injection-target.ts
  - shared/pretext-layout/katex-geometry.ts
  - shared/pretext-layout/layout-pipeline.ts
  - shared/pretext-layout/markdown-anchor.ts
  - shared/pretext-layout/math-delimiters.ts
  - shared/pretext-layout/media-attachment-layout.ts
  - shared/pretext-layout/outline-tool-card.ts
  - shared/pretext-layout/parse-markdown.ts
  - shared/pretext-layout/parse-unified-diff.ts
  - shared/pretext-layout/prepared-block.ts
  - shared/pretext-layout/prepared-markdown-cache.ts
  - shared/pretext-layout/pretext-fonts.ts
  - shared/pretext-layout/pretext-metrics.ts
  - shared/pretext-layout/protocol.ts
  - shared/pretext-layout/reasoning-live-tail.ts
  - shared/pretext-layout/reasoning-segments-cache.ts
  - shared/pretext-layout/reasoning-segments.ts
  - shared/pretext-layout/reasoning-translation-sources.ts
  - shared/pretext-layout/reflection-reason.ts
  - shared/pretext-layout/reflection.ts
  - shared/pretext-layout/row-metrics.ts
  - shared/pretext-layout/segment-adapter.ts
  - shared/pretext-layout/source-text.ts
  - shared/pretext-layout/streaming-live-blocks.ts
  - shared/pretext-layout/task-notice.ts
  - shared/pretext-layout/text-document-layout.ts
  - shared/pretext-layout/text-document.ts
  - shared/pretext-layout/text-preview.ts
  - shared/pretext-layout/tool-detail.ts
  - shared/pretext-layout/tool-io-projection.ts
  - shared/pretext-layout/turn-usage.ts
  - shared/pretext-layout/typography-css.ts
  - shared/pretext-layout/typography.ts
  - shared/pretext-layout/vlist-virtualization.ts
  - shared/pretext-layout/workspace-tool-display.ts
  - frontend/lib/typography-css-vars.ts
  - frontend/lib/typography-preferences.ts
keywords:
  - pretext
  - "@chenglou/pretext"
  - 零 DOM 测量
  - zero-dom-measure
  - PretextLayoutManifest
  - buildPretextLayoutIndex
  - buildPretextEngineLayout
  - computePretextVListLayout
  - RenderLod
  - VListElementKind
  - TYPOGRAPHY_RANGE
  - setTypography
  - 外观 · 排版
  - narratorFontScalePercent
  - narratorLineHeightV2Percent
  - TOOL_IO_BUDGETS
  - projectToolIO
  - MAX_DIFF_LINES
  - DiffDocument
  - TEXT_DOCUMENT_PACKET_BYTES
  - parseReasoningSegments
  - KaTeX 几何
  - shared-core.guard
status: draft
verified_at: cf135939ebf92132d5a03bc18cf391d612c36614
---
# 前端排版引擎

`shared/pretext-layout/` 是会话时间线的“高度模型”：不读 DOM，用 `@chenglou/pretext` 的字形度量加常量算出每个条目的精确高度，供虚拟列表放置滚动条、恢复滚动锚点。它放在 `shared/` 里是因为前端、服务端、Bun 测试都要跑同一份算术；其中一部分模块（diff、工具输入输出投影、文本文档、推理分段）也被服务端当普通纯函数库使用。列表本身（滚动、渲染、缓存接线）在[消息列表](narrator-ui/message-list.md)。

## 关键规则
- 纯度：`shared-core.guard.test.ts` 枚举目录下全部非测试 `.ts`（新增模块默认被覆盖），禁止 import `react`/`react-dom`/`@mantine`/`@frontend`（含动态 import），禁止调用 `getBoundingClientRect`/`offsetHeight`/`offsetWidth`/`createElement`，剔除注释行后禁止出现 `document.` 与 `window.`。浏览器侧的东西（字体代际、KaTeX 运行时、字形宽度解析器）只能由前端通过 setter 注入，例如 `prepared-markdown-cache.ts:setPreparedFontRevision`、`typography.ts:setTypography`。
- 三层：解析层 `parse-markdown.ts` 把 Markdown 变成宽度无关的 `PreparedBlock[]`（`prepared-block.ts`，带 pretext 预备句柄）；测量层按内容宽度和 `RenderLod`（1–5，默认 4）求高度（`pretext-metrics.ts` 调 pretext 的行统计）；布局层 `index.ts:buildPretextLayoutIndex` 把条目高度累加成前缀和。`engine.ts:buildPretextEngineLayout` 是注入式接缝：`prepare` 不碰宽度，`measure` 返回有限且非负的高度，`contentWidth` 非有限正数或高度非法直接抛错；`golden.ts` 与 `server/services/__tests__/pretext-layout-golden.test.ts` 在 Bun 里验证同一份固定输入得到同一几何。
- 清单与索引（`index.ts`）：`itemKey` 重复抛错；条目可带 `gapAfter` 覆盖统一的 `itemGap`，最后一项后的间距总被丢弃；索引提供按偏移二分、按 `itemKey`、按源 seq、按源消息 id 的查找；`captureAnchor`/`restoreAnchor` 在布局重建（例如 LOD 切换）后把锚点恢复到屏幕上的同一位置，贴底时记为 `bottom` 锚点；`checksumPretextLayoutItems` 是 FNV 校验和。`vlist-virtualization.ts` 与 `layout-pipeline.ts:computePretextVListLayout` 是纯管线：段 → 适配 → 逐条测量 → 布局 → 可见窗口。
- 条目种类词汇表在 `element-kinds.ts:VListElementKind`；前端 `vlist/registry.ts` 的 `VLIST_REGISTRY: Record<VListElementKind, …>` 要求每个种类都有测量项，漏一个会编译失败。`segment-adapter.ts`（约 6300 行）把消息与内容块映射成这些种类的测量输入，`tool-detail.ts`（约 4400 行）把工具调用归类成详情区高度数据。
- 排版是测量输入而不是样式：`typography.ts` 里字号、字距、行高、段距四个旋钮有范围（`TYPOGRAPHY_RANGE`：字号 70–180、字距 -5–25、行高 60–185、段距 50–250，单位百分比），改值会递增 `getTypographyRevision()`，该代际进入准备缓存键、布局版本和文档版本；`pretext-fonts.ts` 的 `export const` 只是 100% 基线，测量代码必须在测量时读 `typographyMetrics()`。该范围同时被服务端校验器 `server/lib/validators/settings.ts` 复用，所以改范围就是改接口契约。字体串必须与实际 CSS 一致（`SANS_FAMILY` 写死了 UI 字体栈，因为 canvas 不解析 CSS 变量）。
- 缓存：`prepared-markdown-cache.ts` 键含数学运行时修订、字体代际、排版代际和源码范围标志；单条文本超过 256 KiB 不进缓存，总量超过 4 MiB 整体清空；字体代际变化清空全部（宽度已烘焙进去）。`reasoning-segments-cache.ts` 给增长中的推理文本做增量解析。
- `fragment-style.ts:fragmentTextStyle` 是“测量过的文本片段变成 CSS”的唯一入口，让字距与字体一起被绘制；`typography-css.ts` + `frontend/lib/typography-css-vars.ts` 把同一组数值发布成 `<html>` 上的 `--nf-type-*` 变量，供大纲等由浏览器自己排版的界面共用；`frontend/lib/typography-preferences.ts` 是旋钮与用户偏好字段的双向映射，行高存 `narratorLineHeightV2Percent`（新刻度，100 即旧的 120%），不能读写旧字段 `narratorLineHeightScalePercent`。
- 图片、媒体、数学：`image-fit.ts` 只用上传时持久化的像素尺寸算盒子；`media-attachment-layout.ts` 固定音视频高度（音频 54+24、视频 200+24）；`katex-geometry.ts` 用 KaTeX 的布局树（不触 DOM）算公式盒子，`math-delimiters.ts` 决定哪些文本算公式（`$..$`、`$$..$$`、`\(..\)`、`\[..\]`）。
- 服务端也在用的部分：`diff-core.ts`（`MAX_DIFF_LINES`=500、`MAX_DIFF_INPUT_CHARS`=240000、`MAX_WORD_DIFF_CHARS`=4000，`countDiffLineStats` 被文件编辑工具与团队限额使用）、`text-document.ts`（`TEXT_DOCUMENT_PAGE_CHARS`=8 KiB、`TEXT_DOCUMENT_PACKET_BYTES`=64 KiB，流式工具输入的引用与区间）、`tool-io-projection.ts`（`TOOL_IO_BUDGETS`：叶子 8 KiB、`plan` 类 Markdown 32 KiB、总量 256 KiB、深度 8、数组与对象键各 200；没有字段需要截断时返回原引用）、`reasoning-segments.ts`、`reflection.ts`、`parse-unified-diff.ts`。
- `protocol.ts` 定义了布局清单分块传输的消息类型与上限（每块 512 条、总计 50000 条、每块 512 KiB），但在 `server/`、`frontend/` 里没有找到使用它的代码，只能视为预留（未核实）。

## 从哪读起
- `shared/pretext-layout/index.ts`、`engine.ts`：清单、索引、锚点。
- `layout-pipeline.ts`、`segment-adapter.ts`：从消息到条目高度。
- `prepared-block.ts`、`parse-markdown.ts`、`pretext-fonts.ts`、`typography.ts`：准备层与排版输入。
- `tool-detail.ts`、`diff-layout.ts`、`diff-core.ts`：工具详情与差异的高度。
- 前端接线：`frontend/components/narrator/vlist/`（`pretext-layout-coordinator.ts`、`pretext-layout-manifest.ts`、`registry.ts`），其合同文档 `vlist/CONTRACT.md` 只作线索。

## 改它时
- 在本目录加模块：不要 import UI 运行时、不要碰 `document`/`window`/DOM 测量，否则 `shared-core.guard.test.ts` 失败；前端侧另有 `vlist/zero-dom-measure.guard.test.ts` 扫纯路径文件。
- 加一种条目种类：改 `element-kinds.ts`，再在 `vlist/registry.ts:VLIST_REGISTRY` 补测量项（`Record<VListElementKind, …>` 会在编译期拦住遗漏；渲染侧是否另有同类表未核实），并让 `segment-adapter.ts` 产出它；渲染层必须画出测量层预留的同一组数字。
- 改任何影响高度的常量或字体：同步更新 `pretext-fonts.ts` 与实际 CSS，涉及缓存的变化要递增相应代际（字体 `setPreparedFontRevision`、排版 `getTypographyRevision`），否则滚动条长度会静默出错；`tests` 里的 `typography*.test.ts`、`prepared-markdown-cache.test.ts`、`golden` 测试会暴露一部分。
- 改排版范围或旧刻度换算：同时检查 `server/lib/validators/settings.ts`、`shared/appearance-preferences.ts` 和 `frontend/lib/typography-preferences.test.ts`。
- 改 `tool-io-projection.ts` 或 `diff-core.ts` 的上限：服务端 `narrator-messages.ts`、`external-message-projection.ts` 与文件工具会一起变，先搜 `@shared/pretext-layout/` 的服务端引用。

## 相关
- [消息列表](narrator-ui/message-list.md)：虚拟列表如何消费这些高度。
- [通用组件与主题](components-theme.md)：外观设置页里的排版滑块。
- [工具卡片](narrator-ui/tool-cards.md)
