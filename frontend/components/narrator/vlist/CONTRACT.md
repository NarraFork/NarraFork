# vlist 高度模型协议（子代理实现契约）

> 本文件是 narrator 虚拟列表 pretext 化改造的**实现契约**。所有实现子代理必须严格遵循。
> 目标：开关 `narrafork_narrator_virtual_list` 打开后，用一个**全新独立组件** `PretextMessageList` 渲染 narrator 消息，每个列表元件的高度**纯算术可预测、零 DOM 测量**。

## 0. 两条铁律（最高优先级）

1. **不得影响开关关闭时的原有路径。** 只在 `frontend/components/narrator/vlist/` 内新增文件。除唯一接线点（NarratorPanel 的开关分支，由主 agent 负责）外，**不改动 vlist/ 外任何现有文件**。开关关闭时新代码根本不 import。
   - **接线点必须用动态 `import()` 懒加载 `PretextMessageList`**（flag-guarded），使开关关闭时浏览器连 vlist chunk 都不会请求。**禁止任何 vlist 外文件静态 `import`/`export … from` vlist/**。
   - 该不变量由 `vlist-isolation.guard.test.ts` 自动强制：它扫描整个 `frontend/`（排除 vlist 自身），发现任何静态 import vlist 即失败（动态 `import()` 放行）。接入阶段泄漏静态 import 会立刻变红。
2. **零 DOM 测量。** measure 函数内**禁止** `getBoundingClientRect` / `offsetHeight` / `offsetWidth` / `scrollHeight` / `clientHeight` / `ResizeObserver` / `getComputedStyle`。高度只能来自：固定常量 + pretext 纯算术行数。唯一受控例外：mermaid / katex / 未知宽高图片 → `PreparedUnknownBlock`（占位 + 渲染层一次性局部测量修正）。VListHarness 是唯一允许 DOM 测量的地方（仅用于开发期校准）。
   - 该不变量由 `zero-dom-measure.guard.test.ts` 自动强制：它扫描 23 个纯路径模块（`measure/*` + prepared-block/parse-markdown/segment-adapter/registry/vlist-tail-meta/vlist-virtualization/vlist-pipeline），发现任何 DOM 测量 API 调用即失败。受控例外（PretextMessageList 外壳的滚动容器 viewport 尺寸、render 层、VListHarness、测试脚手架）不在扫描范围。往纯路径塞测量会立刻变红。

## 1. 三层模型（prepared-block.ts）

仿 pretext markdown-chat demo：

1. **Prepared 层**（一次性、宽度无关）：解析数据 + pretext `prepareRichInline()` / `prepareWithSegments()` 预测量 → `PreparedBlock[]`。
2. **Frame 层**（宽度/LOD 变化才重算）：`accumulateFrame()` 用 pretext `measureRichInlineStats()` / `measureLineStats()` 纯算术得行数 → 每块 top/height → 元件总高。
3. **Render 层**（进入视口才做）：`walkRichInlineLineRanges()` / `layoutWithLines()` 还原每行 fragment，绝对定位渲染。

**通用高度公式：** `height = 固定装饰(padding/margin/icon/gap/border) + Σ(块文本行数 × 行盒高度)`。

### PreparedBlock 联合类型（已定义于 `prepared-block.ts`）
- `PreparedInlineBlock` — 段落/标题/列表项文本/引用文本（`flow: PreparedRichInline` + `lineHeight` + `classNames[]` + `hrefs[]` + `fonts[]`）。**`fonts[]` 必填**：渲染层必须用与测量完全相同的 `font` 串绘制每个 fragment，否则浏览器重排会偏离预测高度。
- `PreparedCodeBlock` — 代码块（`prepared: PreparedTextWithSegments` + `lineHeight` + `lang`）
- `PreparedRuleBlock` — 分隔线（固定 `height`）
- `PreparedFixedBlock` — 固定高度块（图标行/单行 dimmed/badge/图片占位/工具详情 maxHeight 区），`height` + `tag` + 可选 `data`
- `PreparedUnknownBlock` — 不可预测块（mermaid/katex/未知图片），`placeholderHeight` + `tag`

所有块共享 `PreparedBlockBase`：`marginTop` / `contentLeft` / `quoteRailLefts` / `markerText` / `markerLeft` / `markerClassName`。

## 2. measure 函数签名约定

每个元件一个 `measure/measure-xxx.ts`，导出：

```ts
export function measureXxx(
  data: <该元件的数据类型>,
  contentWidth: number,          // 可用内宽 px
  lod: RenderLod,                // 1..6，默认 5（高度主开关）
  expandState?: <展开态，如有>,   // 折叠/展开、用户 override 等
): MeasuredElement             // { height, blocks, frame, usedWidth }
```

- 用 `accumulateFrame(blocks, contentWidth, pretextLineMetrics, { codePaddingX, codePaddingY, codeLangExtraTop })`（见 `measure/pretext-metrics.ts`）。
- **可选**：提供 `prepareXxxMeasurer(data)` 返回 `(width, lod, expand) => MeasuredElement`，解析一次多次测量（resize 用）。
- **参考实现 = `measure/measure-markdown.ts`**（样板，照抄结构）。

## 3. 字体/尺寸常量（ground truth，来自 pretext-fonts.ts）

项目 Mantine 主题只改了 `primaryColor` + `defaultRadius:"sm"`，字体/字号/行高/间距全用 Mantine v7 默认（1rem=16px）：

| 类别 | 值 |
|------|-----|
| fontSizes | xs=12, sm=14, md=16, lg=18, xl=20 px |
| lineHeights | xs=1.4, sm=1.45, md=1.55(base), lg=1.6, xl=1.65 |
| headings | h1=34/1.3, h2=26/1.35, h3=22/1.4, h4=18/1.45, h5=16/1.5, h6=14/1.5 |
| spacing | xs=10, sm=12, md=16, lg=20, xl=32 px |
| radius | xs=2, sm=4, md=8 px（默认 sm=4） |
| fontFamily | `-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif, ...` |
| monospace | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, ...` |

**派生行盒高**（`lineBoxHeight = round(size × lineHeight)`）：
- body（sm/1.45）≈ **20px**；xs（12/1.4）≈ **17px**；inline code（12/1.55）≈ 19px；code block（12/1.55）≈ **19px**。
- Badge size=xs = **16px**；ThemeIcon 16/14；Loader 12；chevron 12；StatusIcon 12。
- Button：compact-xs=18, xs=30, sm=36, compact-sm=22。
- `truncate` / `lineClamp={1}` → **强制单行**（xs 单行=17px），高度恒定，无需 pretext。
- `whiteSpace:"pre-wrap"` 多行、`MarkdownContent`、无截断文本 → **需 pretext 测量**。

markdown 常量见 `parse-markdown.ts` 的 `MARKDOWN_CONSTANTS`。

## 4. 元件高度目录（批次1探索结论）

图例：🟢固定（无需测量）｜🔴需 pretext 测量｜🟡maxHeight 封顶=min(内容,上限)。

> 🟡 的"内容"含义（P10 修订）：当详情携带真实正文文本时，内容高度来自**按可用宽度测量该文本的换行结果**（pretext 纯算术，零 DOM），而不是只数硬换行的 `contentLines` —— 后者会把长单行正文算成 1 行，导致 15px 的框裁掉实际内容。测量对**有界前缀**进行（前缀保证"整体超限时前缀也必然超限"，一旦达到 cap 即早停），因此 sub-cap 结果精确、超大正文的成本仍为 O(cap)。无正文的详情（媒体、纯估算）仍回退到 `contentLines × 行高` 或像素估算。换行宽度须扣除滚动框水平内边距、内容高度须计入其垂直内边距。

### MessageBubble 内 block
| 元件 | 固定部分 | 可变部分 | 备注 |
|------|---------|---------|------|
| assistant text | markdown 内边距 paddingInline=xs, paddingBlock=0.25rem 🟢 | markdown 正文 🔴 | ClampableText: L1 且 >600 字 → maxHeight:160 🟡 |
| user 消息 | 气泡 p=sm + 头部单行(头像20+用户名+时间戳) 🟢 | 纯文本 pre-wrap（**不解析 markdown**）🔴 | 气泡 shrink-wrap: 宽=contentInset*2+usedWidth |
| user 消息(斜杠指令) | 气泡 p=sm + 头部 + 指令行(sm mono truncate) + 预览行(xs 单行 clamp) + 溢出时 toggle 行(xs) 🟢 | 展开后=展开提示词 pre-wrap 🔴 | 折叠态**高度恒定**，与展开文本长度无关；`commandText` 存在即走此形态 |
| image | 固定 200px 🟢 | — | Skeleton 200×300 也 200 |
| text_file | 单行(图标14+文件名+大小) py=2 🟢 | — | |
| reasoning/thinking | 折叠 header 单行 🟢 | 展开=markdown 🔴（body 实际按 sm：正文14px/代码12px，见下注） | L2/L1→ReasoningCountLine 单行；见 measure-reasoning |

> 注（P1 校订）：reasoning 展开 body 虽外层 `fontSize:xs`，但 `MarkdownContent.module.css` 把 p/li/strong/em/h1-h6/a 硬编码为 `font-size: sm(14px)`，react-markdown 又总把内容包进 `<p>`，故 body 实际按 **sm(正文14px/代码12px)** 渲染 = `measureMarkdown` 现有模型。**不要**为 reasoning 另做 xs 变体。
| web_search | 单行卡 p=xs 🟢 | query 换行(次要)🔴 | |
| image_generation | header + 图(宽/aspectRatio) 🟢 | revisedPrompt 换行🔴 | 有 metrics 时零测量 |

### system 卡（Paper p=xs/sm, radius=sm/md）
| 类型 | 结构 | 高度 |
|------|------|------|
| compact | 居中单行 py=4 + 图标14 + xs文本 🟢 | ≈25px |
| compact(plan) | Paper p=sm + header(16+mb6) + markdown 正文🔴 | 固定≈48 + 正文 |
| merge_summary | Paper p=xs + 单行 lineClamp=1 🟢 | ≈37px |
| review_feedback | Paper p=xs + 单行 lineClamp=1 🟢 | ≈37px |
| ask_in_passing(pending) | Box px=md py=xs + 提示行 + 输入行(TextInput sm 36 + 2按钮) 🟢 | ≈77px |
| ask_in_passing(resolved) | Paper px=sm py=xs + 单行(标签+问题 lineClamp=2)🟡 | 57~77px |
| segment_compact(failed) | Paper p=xs + 标题行 + 错误 pre-wrap🔴 | 最小≈56 |
| segment_compact(ing/ed) | 居中单行 py=4 🟢 + 可展开(每条 maxHeight:200🟡) | ≈25 + 展开 |
| spec_fork_carryover/context_cleared | Paper p=xs + Stack(徽标行+描述🔴 + 3按钮 compact-xs) | ≈80 |
| spec_goal_added | Paper p=xs + Stack(徽标行+文本 pre-wrap🔴 + 1按钮) | ≈72 |
| spec_continuation/blocked | Paper p=xs + 单行 truncate 🟢 | ≈37px |
| cwd_recovery | Paper p=sm + 多段 + DirectoryPicker(动态) | 较高，非固定 |
| error | Paper p=xs + 单行(图标16 + 错误 pre-wrap🔴) | 最小≈37 |
| knowledge_hint | Paper p=xs + heading行 + N条目(每行 truncate🟢) | 20+17×(1+N) 线性可预测 |
| info | Paper p=xs + 文本 pre-wrap🔴 | 最小≈37 |
| tool_loaded/unloaded | Paper p=xs + 单行文本 pre-wrap🔴 | ≈37 |
| bash_command | Paper p=xs + 命令 monospace pre-wrap🔴 | ≈37 |

> 注：`bash_command` / `tool_loaded` / `tool_unloaded` 三种块**由 role=user 的消息承载**（服务端为了让模型看到它们而存成 user 角色），但视觉上是 system 卡。adapter 的 user 分支必须先检测它们并路由到 system 卡，否则会画出一个只有头部的空气泡。

### ToolCallCard（最复杂）
- **折叠态整卡 ≈ 40-42px**（Paper p=xs + header 单行 ~18-20px + border 1px×2）。inRun 无边框 + Divider。
- **header 单行**：category icon 16(内 icon 10) + summary(xs, truncate) + status 12 + 时长 + chevron 12。
- **展开体各详情 maxHeight（🟡 min(内容,上限)）**：
  - codeStyle=**200**、termStyle=**200**、bash/terminal cmd=**60**、EditDiff=**200**、图片/视频/iframe/skill/plan/knowledge body=**400**、流式 bash cmd=**120**。
  - 上限内的高度按**有界换行测量**得出（见 §4 开头 🟡 说明）：携带正文的详情一律测量换行，不再只数硬换行。
  - **需测量🔴**：SpecTasks 列表(任务数×行高)、Recall/Send/Pipeline/WebSearch 结构化列表段、各 badge 头部行、error 文本、AskUserQuestionBanner、ReflectionNotice、InlinePermission 的 Textarea(1-3/8-30 行)+动态按钮行。
  - isPlan 的 `vpHeight`=0.85×视口高 → **用视口高公式替代，不测 DOM**。plan 正文按 **markdown** 测量/渲染（与 chunked 路径的 `ContentViewer markdown` 对齐），并可前置一行 `_planFile` 来源提示；正文解析同样走有界前缀（块边界截断）。plan 详情**不向上转发 `onUnknownHeight`** —— 外框高度由 cap 决定，转发会让虚拟列表与滚动框互相打架。
- **effectiveOpened**：lodExempt(running/streaming/pendingPermission)恒展开；L6 全展开；L5 近卡随 opened、旧卡折叠；L4 全折叠 header；L1-L3 上游 gate 处理。
- **分组卡**：Paper p=xs + header(+×N badge) + 展开体(子 ToolCallCard 累加)。折叠 default=false。

### tool-run 折叠形态（全部基于 CollapsibleTrace，行高固定）
- **CollapsibleTrace**：表头 ≈24.8px；每行 18.8px（title truncate 单行🟢）。maxVisible 超出+1 toggle 行。仅 ReasoningStepsTrace 展开 step 有 markdown body🔴。折叠靠 prop（`collapseItems`/`collapsed`/`titlesOnly`），不读 LOD。
  标题后紧跟**状态图标（12px 槽，仅在需要标记时渲染）+ 耗时**（`TraceItemData.status` / `.timing`，工具行才有；reasoning step 不带）。两者都落在行内容带 16.8px 之内（`TRACE_ROW_CONTENT` 由 xs 行盒决定），耗时是单行 nowrap、popover portaled，所以**不影响 18.8px 行高**（`measure-tool-run.test.ts` 有 height-neutral 断言）。它们是纯 passthrough，但会被画出来，因此必须进 `traceRevision`（`ts:` / `tm:`）。
  - **成功不画勾**：标记规则单源在 `@shared/tool-row-status`（chunk 与 vlist 共用）。只有"在飞 / 失败 / 取消"才画；`success`/`completed`、未识别状态、无生命周期的行**完全不渲染槽位**（不是空槽——每行留 12px 空隙和满列绿勾一样是噪音）。在飞状态是**显式枚举**而非"非终态"，否则拼写不认识的已完成调用会永远转圈。
  - **布局**：标题用 `flex: 0 1 auto`（可收缩以便 truncate，但不吸收剩余宽度），状态与耗时紧贴标题；行尾一个 `flex: 1` 的空 spacer 吃掉剩余宽度。耗时右对齐时读者需要横向跨过空隙回找本行，容易看成邻行的数字。
- **ToolRunSummary**（L3）：表头 + min(N,10)×18.8🟢。
- **ToolRunCountLine**（L2）：单行 ≈20.8px🟢。
- **ActivityTrace**（L1/L2）：表头 + min(N,10)×18.8🟢；collapsed(L1) → 仅表头 ≈24.8px。
- **ReasoningCountLine**（L1/L2）：单行 ≈20.8px🟢。
- **ReasoningStepsTrace**：表头 + min(N,5)×18.8 + 展开 step markdown🔴。

### SubagentCard（唯一直接读 useRenderLod）
- Header：p=xs(20) + 徽标行 16.8 + description(折叠 truncate🟢 / 展开换行🔴) + 可选结果预览行。折叠≈55-75px。
- Recent Calls：≤3 行 × **18.8px（= `TRACE_ROW_HEIGHT`）🟢，行间无缝**（`RECENT_STACK_GAP = 0`）。这些行就是 trace 行：dot + 14px 类别 chip + 单行 `Tool · summary` + 状态槽 + 耗时，高度直接引用 `measure-tool-run` 而不是自己再算一遍；成功不画勾与"耗时紧贴标题"的规则同上，两条渲染路径的一致性由 `RenderSubagent.traceparity.test.tsx` 逐项比对守住。
  `recentCallSummaries` / `recentCallCategories` 是 render-only（切到 `recentRowCount`），summary 由 shell 注入的 `resolveSubagentRecentSummary` 从 header 的 `inputSummary` 得出；两者都进 `subagentRevision`（`gs:` / `gc:`），因为流式补全 `inputSummary` 时行数/名字/状态都不动，它们是唯一增量。
- 展开体：prompt ContentViewer **maxHeight:200🟡**、result ContentViewer **maxHeight:300🟡**、permission 子块。
- effectiveExpanded：lodExempt 恒展开；L6 展开；L5 近卡随 opened、旧卡折叠；L4 折叠。

### 其它列表级元素
- prune-divider（Divider + label）🟢
- AskUserQuestionBanner（Alert，**高度强动态**）：Alert padding + Stack gap md × 问题数 + 每问题(header🔴 + 选项Σ(label+desc)🔴 + Textarea 1-3行) + 倒计时行(条件) + 按钮行30。只读模式去掉输入/按钮。无折叠、不读 LOD。

## 4.5 Live patch —— 由服务端事件驱动的高度变更（新增来源）

§4 列举的高度来源都由**本地输入**决定：数据一次装载、宽度/LOD 变化、用户展开折叠。`PretextLayoutCoordinator.applyLivePatch`（配套 `vlist-live-patch.ts` / `vlist-live-events.ts` / `useVListLivePatches.ts`）引入了第四种：**服务端 WS 生命周期事件在已装载的消息上原地改字段**，卡片因此变高变矮（工具完成长出输出体、reflection gate 推进换标题、subagent 卡片长出 recent calls 行）。

它与用户操作触发的高度变化性质不同：没有用户动作、随时可能发生、可能一帧内来一批。因此有三条硬约束：

1. **必须捕获 anchor。** 铁律"已提交的行不得在无用户动作时视觉跳动"在这里最容易被破坏。`applyLivePatch` 必须在 rebuild 前 `captureCoordinatorAnchor`、之后恢复 scrollTop。`applyCompactProgress` 不需要 anchor 是因为压缩标记高度恒定；live patch 不是。
2. **必须保持 `messageVersion` 与消息数不变。** 这是 field patch 不是结构变化。版本一动，全窗口的 measure 缓存条目全部失效，一张卡的更新会变成整窗重测。
3. **`extractDataRevision` 必须覆盖所写入的每一个影响高度的字段。** 这是 1 和 2 的直接代价，也是最容易漏的一条：patch 不改 `spec.key`（`tool-<toolUseId>` 恒定）、不改 `messageVersion`（约束 2 要求）、通常不改 `opts`，于是**缓存键唯一可动的部分就是 `extractDataRevision`**。漏一个字段 ⇒ 键完全相同 ⇒ 命中 patch 之前的高度条目 ⇒ 新内容被塞进旧尺寸的盒子里（被裁掉，或反向留出空洞）。

   已发生过的实例：`patchSubagentActivity` 只写 `_subagentActivity`，adapter 把它派生成 `recentCallCount`，而 revision 当时既不认识前者也不认识后者 —— 卡片一直服用 0 行的高度，recent calls 区域被完全裁掉。同类还有 `subagentConclusionPatch` 写 `outputJson`（→ `resultText`/`resultPreview`）：卡片本来已是 `success` 且无错时 `status` 不动，结果体是唯一的增量。

   派生字段尤其危险：patch 写的字段名和 measure 读的字段名往往不是同一个（`_subagentActivity` → `recentCallCount`），所以审计要顺着 **patch → adapter → measure** 整条链走，不能只看 patch 写了什么。

   revision 在**每次 measure 时都会调用**，所以必须保持 O(1)：只读基元字段，文本走 `textSignature`（长度 + 定量采样哈希），禁止 `JSON.stringify` 整个 payload、禁止随内容规模增长的遍历。

**回归防线：** `live-patch-measure-audit.test.ts` 的 EXHAUSTIVE 组对每个 patch 函数跑真实的 segmentMessages → adaptSegments → measure，断言"高度变了的行，缓存键必须也变"。新增 patch 时把它加进那份列表即可自动获得覆盖，不需要手工列字段。

## 5. 测试约定

- **canvas stub**：measure 测试 `beforeAll(() => installCanvasStub())`（见 `measure/test-canvas-stub.ts`），提供确定性 measureText（每字符=0.6×fontSize）。**必须在 import pretext-backed 模块之前调用**（用动态 `await import()`）。
- 断言**高度模型**（chrome + 行数×行高），不断言像素级字体度量。真实字体准确性由 VListHarness 浏览器对拍保证。
- 每个 measure-xxx.ts 配 measure-xxx.test.ts，覆盖：单行、换行随宽度增长、块间距、LOD 关键组合、折叠/展开、maxHeight 封顶。
- 参考：`measure/measure-markdown.test.ts`。

## 6. 渲染副本约定（render/RenderXxx.tsx）

- 从 `MeasuredElement.blocks` + `frame` + `contentWidth` 做**绝对定位**渲染（对齐 markdown-chat demo：line-row 绝对定位、fragment inline-block）。
- 每个 fragment 必须用 `block.fonts[itemIndex]` 的 `font` 串绘制（`whiteSpace:"pre"`, `display:"inline-block"`），保证渲染换行与测量一致、零漂移。
- inline 块用 `walkRichInlineLineRanges` + `materializeRichInlineLineRange` 还原每行；code 块用 `layoutWithLines`。
- 视觉尽量对齐原组件（复用 Mantine 颜色变量/类名语义）。
- 不在渲染期做 DOM 测量（`PreparedUnknownBlock` 的一次性局部修正除外）。
- **参考实现 = `render/RenderMarkdown.tsx`**（样板，照抄结构）。

## 7. 交付自检（每个子代理提交前）

```
bunx tsgo --noEmit                                   # 无 vlist 类型错误
bunx @biomejs/biome check --write frontend/components/narrator/vlist/<你的文件>
bun test frontend/components/narrator/vlist/measure/<你的测试>
```
- 不重启运行中的 NarraFork 进程。
- 不改 vlist/ 外文件。
- git diff 自查：只新增 vlist/ 内文件。

## 8. 已就绪的骨架（可直接依赖）

- `prepared-block.ts` — PreparedBlock 类型 + `accumulateFrame` + `RenderLod`
- `pretext-fonts.ts` — 全部字体/尺寸常量 + `headingFont` / `lineBoxHeight` / `emToPx`
- `parse-markdown.ts` — `parseMarkdownToPreparedBlocks` + `MARKDOWN_CONSTANTS` + `buildUnknownBlock`
- `vlist-virtualization.ts` — `layoutItems` / `findVisibleRange` / `spacerHeights`（+ 测试）
- `measure/pretext-metrics.ts` — `pretextLineMetrics`（生产 resolver）
- `measure/measure-markdown.ts` — **measure 参考实现样板**（+ 测试）
- `measure/test-canvas-stub.ts` — `installCanvasStub`
- `render/RenderMarkdown.tsx` — **render 参考实现样板**（绝对定位 + fonts[] 一致绘制）
- `VListHarness.tsx` — 对拍校准台（DOM 实测 vs pretext 预测+真实渲染；子代理把自己的元件加入 `HARNESS_CASES`）
