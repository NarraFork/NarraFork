# vlist 高度模型协议（子代理实现契约）

> 本文件是 narrator 虚拟列表 pretext 化改造的**实现契约**。所有实现子代理必须严格遵循。
> 目标：开关 `narrafork_narrator_virtual_list` 打开后，用一个**全新独立组件** `PretextMessageList` 渲染 narrator 消息，每个列表元件的高度**纯算术可预测、零 DOM 测量**。

## 0. 两条铁律（最高优先级）

1. **不得影响开关关闭时的原有路径。** 只在 `frontend/components/narrator/vlist/` 内新增文件。除唯一接线点（NarratorPanel 的开关分支，由主 agent 负责）外，**不改动 vlist/ 外任何现有文件**。开关关闭时新代码根本不 import。
   - **接线点必须用动态 `import()` 懒加载 `PretextMessageList`**（flag-guarded），使开关关闭时浏览器连 vlist chunk 都不会请求。**禁止任何 vlist 外文件静态 `import`/`export … from` vlist/**。
   - 该不变量由 `vlist-isolation.guard.test.ts` 自动强制：它扫描整个 `frontend/`（排除 vlist 自身），发现任何静态 import vlist 即失败（动态 `import()` 放行）。接入阶段泄漏静态 import 会立刻变红。
2. **零 DOM 测量。** measure 函数内**禁止** `getBoundingClientRect` / `offsetHeight` / `offsetWidth` / `scrollHeight` / `clientHeight` / `ResizeObserver` / `getComputedStyle`。高度只能来自：固定常量 + pretext 纯算术行数。唯一受控例外：mermaid / katex / 未知宽高图片 → `PreparedUnknownBlock`（占位 + 渲染层一次性局部测量修正）。VListHarness 是唯一允许 DOM 测量的地方（仅用于开发期校准）。
   - 该不变量由**两道守卫**共同强制，职责按代码所在目录划分（见 §8：内核已迁到 `shared/pretext-layout/`）：
     - `vlist/zero-dom-measure.guard.test.ts` — 扫描 `vlist/` 侧纯路径模块（`measure/*` + registry/vlist-pipeline/vlist-tail-meta/vlist-live-patch 等）。注意其清单里有若干项如今只是转发壳，扫壳查不出问题，真正的实现体由下面那道守卫负责。
     - `shared/pretext-layout/shared-core.guard.test.ts` — 用 `readdirSync` **枚举**该目录全部非测试模块（新增模块自动纳入，不需要维护清单），断言无 React/Mantine/`@frontend` 依赖、无 DOM 测量、无 `document.*` / `window.*`。
     两道守卫合起来才覆盖完整纯路径。受控例外（PretextMessageList 外壳的滚动容器 viewport 尺寸、render 层、VListHarness、测试脚手架）不在扫描范围。往纯路径塞测量会立刻变红。
   - **推论：字体度量也是"测量输入"。** prepared 层把每个 fragment 的像素宽度烤进 handle（`naturalWidth`/`minWidth`/`maxLineWidth` 的来源），所以 prepared 缓存的键必须含**字体世代**，否则 fallback 字体下算出的换行会配上真字体绘制的 DOM。内核不能读 `document.fonts`，世代由 `katex-runtime` 观察后经 `setPreparedFontRevision` 注入（与 KaTeX runtime / glyph resolver 同一注入范式）。当前项目全用系统字体栈、无 `@font-face`，该世代恒为 0；加 webfont 时它会自动生效。

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

### 表格（`PreparedTableBlock`）

GFM 表格**不渲染真 `<table>`**。CSS `table-layout: auto` 的列宽算法规范欠定义、各引擎实现有差异，纯算术无法复现，若照搬就只能退化成 `PreparedUnknownBlock` + ResizeObserver 事后修正，等于放弃本路径的全部收益（缓存键稳定、虚拟化锚点、滚动不跳）。因此列宽由我们自己解，渲染层用解出的几何**绝对定位每个单元格**——浏览器的表格算法完全不参与，预测与绘制同源，结构上不存在漂移。

- **Prepared 层**（`buildTableBlock`）：每格走与段落相同的 inline walker（因此单元格内的粗体/链接/inline code/inline math 都成立），并预存两个与宽度无关的固有宽度：
  - `naturalWidth`（max-content）= 在极大宽度下测量，不发生换行。
  - `minWidth`（min-content）= 最宽的**不可断单元**。⚠️ **不能**用 `measureRichInlineStats(flow, 1)` 求它：pretext 的 `break: "normal"` 在单词放不下时会退让到词内断行，1px 探测返回的是最宽**字形**（≈1 字符），会让每列看起来无限可压缩、regime 3 变成死代码。正确做法是用 `prepareWithSegments` 的 `segments`（pretext 自己的断行单元：拉丁按词、CJK 按字，与浏览器一致）逐个作为 `break: "never"` 原子测量取最大。
  - 表头按 **bold** 测量（`boldenPiece`），因为它按 bold 绘制；漏了就会算窄。header 内的 inline code 保留等宽字体不加粗（与 chunked 的 `Table.Th` 一致）。
- **Frame 层**（`solveTableColumns` + `layoutTable`）：三段式确定性解算，budget = 可用宽 − `columns × paddingX × 2`。
  1. Σnatural ≤ budget → 直接用 natural（完全不换行）。
  2. 装不下但 Σmin ≤ budget → 按各列自身 slack（natural − min）比例分摊压缩，下限为 min。**取整方向：目标宽 `floor`、min 下限 `ceil`。** 压缩后总和本就恰等于 budget，向上取整会越界并为亚像素溢出误报 overflow、白留一条滚动条；向下取整只会多换一次行，而换行是被测量的。
  3. Σmin > budget → 保持 min 宽并**横向滚动**（对齐 chunked 的 `overflowX: auto`）。
- **行高** = 该行最高单元格的 `lineCount × lineHeight` + `paddingY × 2` + `rowBorder`；表高 = Σ 行高（+ 溢出时的滚动条预留）。表头行在前（若有）。
- **滚动条预留**：溢出时加固定 `scrollbarHeight`（12px），**不是** Mantine 常量而是我们自己的。水平滚动条的真实厚度是 OS/主题值，纯路径读它就把高度模型绑到了平台设置上（缓存键会随用户改设置漂移），而 `scrollbar-gutter` 只作用于竖直方向且不给出尺寸。行从顶部排布，所以真实滚动条更细或不存在时只有最后一行下方的空隙变化，**任何一行都不会移动**。渲染层配 `scrollbar-width: thin` 让实际厚度接近预留值。
- **常量来源**（`DEFAULT_TABLE_METRICS`，抄 `node_modules/@mantine/core/styles/Table.css`）：`paddingX`=10（`--table-horizontal-spacing` 默认 spacing xs）、`paddingY`=7（Table 自身 `verticalSpacing` 默认 prop）、`rowBorder`=1（`withRowBorders` 默认 true）。斑马纹只数 **body** 行（表头永不参与），条纹与 hover 走 CSS 的 `data-striped` 属性而非内联样式——内联背景会压过基于 class 的 hover 规则，逼出一个 `!important`。
- **`usedWidth` 上限**：溢出表格在自己的框内滚动，因此上报 `min(tableWidth, boxWidth)`；否则 shrink-wrap 容器（如 user 气泡）会被拉到未滚动的完整表宽。

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
| error | Paper p=xs + Stack(图标16 + 错误 pre-wrap🔴 + 2 图标控件, [可选修复按钮行]) | 最小≈37（带修复按钮 +24） |
| knowledge_hint | Paper p=xs + heading行 + N条目(每行 truncate🟢) | 20+17×(1+N) 线性可预测 |
| info | Paper p=xs + 文本 pre-wrap🔴 | 最小≈37 |
| tool_loaded/unloaded | Paper p=xs + 单行文本 pre-wrap🔴 | ≈37 |
| bash_command | Paper p=xs + 命令 monospace pre-wrap🔴 | ≈37 |

### sidecar 迷你卡（系统注入，`measure-sidecar` / `RenderSidecar`）

**每条注入一张卡**，不是 chunked 那个聚合的 `SideCarNotice`（后者是"×N"一行展开成列表）。这是刻意的重设计：一次 turn 可能同时注入进度提醒、后台任务完成、群聊投递、spec 更新几类互不相关的内容，聚合成一条会让读者只能整组展开、无法只留下自己关心的那一条。代价是每条各有自己的折叠状态，因此高度模型必须能表达"同一行内第 k 张卡展开"。

| 形态 | 结构 | 高度 |
|------|------|------|
| 折叠 | Paper p=xs + 单行 header（accent rail 2 + info icon 14 + 来源 badge + target badge + 预览 lineClamp=1 + chevron + copy）🟢 | **恒定 37px**（`SIDECAR_COLLAPSED_HEIGHT`）|
| 展开 | 同一 header + `HEADER_BODY_GAP` 6 + 正文 pre-wrap🔴（`SIDECAR_DETAIL_MAX_LINES`=40 封顶）+ 截断时 `NOTICE_GAP` 4 + 提示行 17 | 37 + 6 + 行数×17 [+ 4 + 17] |

- **折叠态高度与内容完全无关**：预览是 `lineClamp={1}`，所以它的长度不进高度（§3 的 truncate 规则）。这是为什么无论注入多大，折叠态都能不测量。
- **正文走 `PreparedCodeBlock`**（同 `measure-system-text`）：渲染层用 measure 换行过的同一个 prepared + 同一个 `FONT_XS` 逐行还原，零漂移、零 DOM。高度**不读 `lod`** —— sidecar 从不因 LOD 折叠消失，它是"模型看到过什么"的证据，低 LOD 下把它藏掉会让读者以为没发生。
- **两个上限，两种性质**：adapter 侧 `SIDECAR_DETAIL_MAX_CHARS`=120_000 截字符并把 `sidecarTruncated` 标签**追加进文本**（于是被当作普通正文行测量）；measure 侧 `SIDECAR_DETAIL_MAX_LINES`=40 截行数，用于给病态记录一个有界的测量成本和可预测的最大卡高。
- **行数被截断必须给提示，且提示行的高度由 measure 保留**（`SIDECAR_TRUNCATION_NOTICE_HEIGHT` / `_GAP`）。正文盒是固定高 `overflow:hidden`、没有滚动条，所以渲染层自作主张多画一行只有两个结果：被裁掉，或把一行正文顶出盒子——两者都违反 §0 铁律 2。文案跟其它 adapter 字符串一样走 `ctx.labels` 注入（`sidecarTruncated`），渲染层只画 measure 交给它的 `noticeText`；没有 label 时 measure 不保留、渲染层不画，保证"保留的高度"和"画出来的行"永远一致。
- **工具卡内的 sidecar 带（`measure-tool-call` 的 `sidecars` / `sidecarsTop`）在折叠态也算高度**：chunked 的 notice 画在 collapse 之外，所以一张带注入的折叠工具卡就是比不带的高一个 `SIDECAR_COLLAPSED_HEIGHT`。这些迷你卡的折叠态**不能**用工具卡自己的 `expanded` 表达（它们各自独立），所以按 index 存进 `opts.sidecarExpanded: number[]`，由 `digestOpts` 进缓存键。空数组时**省略该字段**，让没有 sidecar 的卡片缓存键与本功能之前 byte-identical —— 这是刻意保证的性质，有测试守着。
- **折叠状态的 key 是 `${key}-sc${index}`**，adapter（`buildSidecarSpecs`）和工具卡（`opts.sidecarExpanded` 的探测）共用这一套编号。独立 sidecar 元件把这个后缀写在**自己的 spec.key** 里、走普通 `expanded` 通道；工具卡的迷你卡则是**子 key**，不是顶层布局项，所以 `measuredByKeyRef` 里永远没有它们。
  - ⚠️ 由此得到一条易错点（已发生过）：shell 的折叠开关靠"从 measured 读当前是否已展开"再取反，而这两条路径都答不上来 —— 子 key 没有 measured 条目，`MeasuredSidecar` 又只有 `expanded`（没有 `form` / `effectiveOpened` / `effectiveExpanded`）。结果两条路径的每次点击都写 `expanded = true`：卡片能展开、永远关不掉。所以 `resolveRowOpenState` 显式列出每种 kind 的字段，并在**没有 measured 条目时回落到交互状态**（对子 key 而言状态就是权威，除了这个开关没人写它）。
  - ⚠️ 同理，行签名（`rowInteractionSig`）必须按该行**实际的迷你卡数量**迭代 `-sc{i}`，不能"遇到缺失就 break"：读者完全可以只展开第 2 张，那时 `-sc0` 不存在，break 版本在 index 0 就停、`-sc1` 永远不进签名。这属于 §4.5 反复说的那类"靠别处兜底所以看不出来"的坏签名（这里恰好被 memo 的 `item.measured` 比较兜住）。
- **`payloadKind` 是显式判别标记**：measure cache 必须区分"独立 sidecar 元件的 data"和"工具卡的 `sidecars` 数组"，两者的 revision 分支不同。用字段形状嗅探（有 `fullText` 且有 `source`）只是猜测，任何将来带这两个字段名的 payload 都会误入前一分支、拿到描述别的东西的 revision —— 也就是命中错误高度的缓存条目。
- **交互**：header 整行是折叠热区，并且是**可键盘操作的**（`role="button"` + `tabIndex` + Enter/Space + `aria-expanded`），全部是属性和 handler，不动已测量的几何。内部的 copy 按钮是真 `<button>`，鼠标路径靠外层 `stopPropagation` 隔离、键盘路径靠 `event.target !== currentTarget` 提前返回 —— 否则一次 Enter 会同时复制并折叠。

> 注：`bash_command` / `tool_loaded` / `tool_unloaded` 三种块**由 role=user 的消息承载**（服务端为了让模型看到它们而存成 user 角色），但视觉上是 system 卡。adapter 的 user 分支必须先检测它们并路由到 system 卡，否则会画出一个只有头部的空气泡。

> 注：`error` 卡是唯一 chrome 不完全由 kind 决定的 system 卡。它的右侧两个图标控件（标记可重试 / 关闭）恒定，但「关闭图像生成并重试」这个 provider 修复是**带文字的按钮**，占据正文下方独立一行，因此**会改变卡片高度**。是否显示由 adapter 通过 `ctx.canOfferProviderFix(errorText)` 在适配阶段决定并写入 `data.buttons`，measure 读同一个数组加上 `STACK_GAP + BUTTON_COMPACT_XS`。之所以不做成第三个图标：图标控件只能靠 hover tooltip 说明自己，触屏用户永远看不到，而这是唯一能真正解决该故障的操作。

### ToolCallCard（最复杂）
- **折叠态整卡 ≈ 40-42px**（Paper p=xs + header 单行 ~18-20px + border 1px×2）。inRun 无边框 + Divider。
- **header 单行**：category icon 16(内 icon 10) + summary(xs, truncate) + status 12 + 时长 + chevron 12。
- **展开体各详情 maxHeight（🟡 min(内容,上限)）**：
  - codeStyle=**200**、termStyle=**200**、bash/terminal cmd=**60**、EditDiff=**200**、图片/视频/iframe/skill/plan/knowledge body=**400**、流式 bash cmd=**120**。
  - 上限内的高度按**有界换行测量**得出（见 §4 开头 🟡 说明）：携带正文的详情一律测量换行，不再只数硬换行。
  - **需测量🔴**：SpecTasks 列表(任务数×行高)、Recall/Send/Pipeline/WebSearch 结构化列表段、各 badge 头部行、error 文本、AskUserQuestionBanner、ReflectionNotice、InlinePermission 的 Textarea(1-3/8-30 行)+动态按钮行。
  - isPlan 的 `vpHeight`=0.85×视口高 → **用视口高公式替代，不测 DOM**。plan 正文按 **markdown** 测量/渲染（与 chunked 路径的 `ContentViewer markdown` 对齐），并可前置一行 `_planFile` 来源提示；正文解析同样走有界前缀（块边界截断）。plan 详情**不向上转发 `onUnknownHeight`** —— 外框高度由 cap 决定，转发会让虚拟列表与滚动框互相打架。
- **服务端截断的正文（`textTruncated`）预留整个 cap，且不占任何额外行**：
  - 无论普通 capped 正文（`cappedBodyHeight`）还是 markdown 正文（`measureMarkdownDetail`），只要正文是服务端前缀就把盒高钉在 `cap`，**不测前缀**。测前缀会让高度取决于服务端预算切在哪里（更宽的布局把前缀折成更少行 → 盒子变矮，剩余可滚内容无处安放）；cap 永不裁切，因为盒子本身 `overflow:auto`。
  - **没有"内容已截断"提示行**：完整 payload 由读者在正文盒内滚过一半时自动取（`VListContentViewHost` 的 capture 阶段 scroll 监听），或打开全屏查看器时取。两条路都经同一个 `fullPayloadRequested` 门控，所以仍是用户动作；又因为盒高已钉在 cap，落地的完整正文测得 `min(exact, cap)` —— 对任何溢出盒子的正文（每个服务端前缀都溢出）逐像素相同。
  - `truncatedLeafCount` / `truncatedTotalBytes` 因此是**纯 payload 完整性信号**，不带几何：shell 用它判断哪些行可以取数、哪些请求在飞，measure cache 用它做 `|tp:` revision（payload 落地时唯一会动的字段）。
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

   `appendMessageSidecars` 是这条链最长的一例，也正是本节警告的形态：它只往最新 assistant 消息的 `sideCars` 追加记录（`sidecars` WS 事件带来的 turn 间注入 —— 后台任务完成、群聊投递、spec 更新），既不新增消息也不动 `messageVersion`；但 adapter 会由这个字段**派生出全新的 sidecar 元件**（§4 的迷你卡），每一张都自带高度。`toolCompletedPatch` 写 `tc.sideCars` 是同一条链的工具卡版本，而且更隐蔽：一次已是终态的重放或同状态重投递会让 `status` 完全不动，sidecar 就是唯一的增量。两者都由 `sidecarRevision` 覆盖（独立元件按自身文本、工具卡按每条注入的文本），并且**靠 `payloadKind` 标记而不是字段形状**来选分支 —— 形状嗅探会让将来任何带 `fullText`+`source` 的 payload 误入独立元件分支、拿到错误的 revision，也就是错误的高度。

   revision 在**每次 measure 时都会调用**，所以必须保持 O(1)：只读基元字段，文本走 `textSignature`（长度 + 定量采样哈希），禁止 `JSON.stringify` 整个 payload、禁止随内容规模增长的遍历。

**回归防线：** `live-patch-measure-audit.test.ts` 的 EXHAUSTIVE 组对每个 patch 函数跑真实的 segmentMessages → adaptSegments → measure，断言"高度变了的行，缓存键必须也变"。新增 patch 时把它加进那份列表即可自动获得覆盖，不需要手工列字段。

## 4.6 折叠过渡动画（FLIP，纯装饰层）

§4/§4.5 描述的是"高度是多少"，这一节描述的是"高度改变时怎么看起来在动"。

chunked 路径靠 Mantine `<Collapse>`：正文在正常流里，浏览器补间 `height`，下面的内容自然跟着滑。精确画布做不到——每行绝对定位在纯算术给出的 `top`，所以一次展开就是"重建 → 写新 top → 整列瞬移一帧"。正确但生硬。

实现是 FLIP（`vlist-fold-animation.ts` 纯算 + `vlist-fold-motion.ts` 播放 + shell 接线），三条设计约束：

1. **不能用 CSS transition 直接补间 `top`/`height`。** 行会随窗口挂载/卸载，新进窗口的行没有"上一个值"可补间，会从浏览器上次见到该 key 的位置飞进来；而且 `top`/`height` 是布局属性，几十行同时补间等于每帧一次全画布布局。更关键的是，全局 transition 会把**所有**几何变化都变成可见位移，包括 live patch、翻页、宽度沉降——那些重建之所以要锚定，正是为了让它们不可见。所以动画必须按用户动作逐次 opt-in。
2. **必须在视口坐标系里计算，不是文档坐标系。** 折叠重建是锚定的（`captureCoordinatorAnchor` → `restorePretextLayoutAnchor`），展开视口上方的卡片会用 +Δ 的 `scrollTop` 写入抵消 +Δ 的文档位移——屏幕上那些行根本没动。用原始 `top` 差值会给"看起来没动的行"编造 Δ 像素滑动，正是锚点要消除的伪影。两侧各减自己的 scrollTop 后，这种情况自然坍缩成"不动画"。
3. **展开与折叠不对称，这是刻意的。** 展开时新正文已在 commit 后的 DOM 里，所以被点的那行保持**最终盒高**（下方各行因此已经正确），用 `clip-path` 揭开新增区域，读起来就是正文在固定框里展开。折叠时展开态正文**已经被 React 卸载**，没有东西可裁，动画由下方各行从原位上滑承担（卡片头部不动，让出的空隙在 200ms 内闭合）。备选方案是 `cloneNode` 深拷贝旧子树——在 click handler 里同步克隆一张 400px 的卡片，不值得。

铁律层面的位置：
- **不属于高度模型。** 只写 `transform` / `clip-path`，都是合成属性、不参与布局、不回读。`height` 会反馈进布局并可能扰动已测高度，`top` 会和布局拥有的绝对定位打架，两者都禁止（`vlist-fold-wiring.test.ts` 按关键帧构造函数逐个断言）。
- **不进 React state、不进测量缓存。** 和 `vlist-highlight.ts` 同一范式：用 ref 持有，直接写行节点。进 state 会为一个装饰让全窗口 memo 失效，还会把视觉关注点塞进"产生被动画几何"的那次 render。
- 行上新增 `data-nf-row-key`（data 属性，height-neutral）供控制器定位节点；`id` 不能用，它是**消息** id，一条消息的多行共享它。

两个易错点（都有守卫）：
- **捕获必须在 click handler 里、`setInteraction` 之前。** 放在 effect 里读到的是重建后的几何，差值恒为 0。
- **"没有可播的动作"不等于"播完了"。** `setInteraction` 先触发一次 re-render，文档重建发生在 `usePretextDocument` 的后续 effect 里。所以播放用的 layout effect 会先在"几何还没变"的那次 commit 上跑一遍——那次若消费掉 capture，就等于在它真正对应的几何到来前一次 commit 把它扔了（早期版本因此完全不动画）。保留它的代价为零，两端都有界：revision 校验挡住"文档被别的东西改了"的 capture，年龄上限（~400ms）淘汰"重建始终没来"的 capture。

`prefers-reduced-motion: reduce` 下直接不捕获，于是播放 effect 找不到东西，折叠瞬时生效。

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
- **源码视图（`showSource` / `sourceText`）**：markdown 正文可就地换成原始文本，但必须画在**钉死到已测高度**的滚动盒子里（`RenderMarkdown` 的 `MarkdownSourceBody`、工具卡的 `CappedMarkdownBody`）。渲染态和源码态的换行行数完全不同，任何让内容自己决定高度的写法都会在切换时移动已提交的行（违反 §0 铁律 1）。
- 悬浮工具条的源码按钮由 `VListViewTarget.sourceInline` 门控：只有渲染层真的会读 `showSource` 的正文才能声明它。没有渲染方实现却把按钮画出来，就是一个点了没反应的死控件（折叠态 reasoning 没有正文，因此不声明）。

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

> ⚠️ **高度内核已迁到 `shared/pretext-layout/`。** `vlist/` 下的 `prepared-block.ts`、`pretext-fonts.ts`、`parse-markdown.ts`、`vlist-virtualization.ts`、`segment-adapter.ts`、`measure/pretext-metrics.ts` 等**只剩两行转发壳**（`export * from "@shared/pretext-layout/…"`）。改实现必须去 `shared/pretext-layout/`；改转发壳等于什么都没改。壳保留是为了不动上百处既有 import。

DOM-free 内核（`@shared/pretext-layout/`，禁止 React/Mantine/DOM）：
- `prepared-block.ts` — PreparedBlock 类型 + `accumulateFrame` + `RenderLod` + 表格解算（`solveTableColumns` / `layoutTable` / `tableRowLineHeight`）
- `pretext-fonts.ts` — 全部字体/尺寸常量 + `headingFont` / `lineBoxHeight` / `emToPx` / `MATH_BASE_FONT_SIZE`
- `parse-markdown.ts` — `parseMarkdownToPreparedBlocks` / `parseMarkdownUnits` + `MARKDOWN_CONSTANTS` + `buildUnknownBlock`
- `prepared-markdown-cache.ts` — 跨宽度 prepared 记忆（`getPreparedMarkdownBlocks` / `getPreparedTextWithSegments`），键含 KaTeX revision **与字体世代**；`resetPreparedMarkdownCache()` 由 coordinator 的 `reset()` 释放
- `katex-geometry.ts` / `math-delimiters.ts` — 公式零 DOM 几何（注入 glyph resolver）+ 分隔符识别
- `pretext-metrics.ts` — `pretextLineMetrics`（生产 resolver）
- `vlist-virtualization.ts` — `layoutItems` / `findVisibleRange` / `spacerHeights`
- `segment-adapter.ts` — 消息 → element spec

前端侧（`vlist/`）：
- `measure/measure-markdown.ts` — **measure 参考实现样板**（+ 测试）；代码块内边距单源 `MEASURE_MARKDOWN_CODE_PADDING`，任何测量 markdown 正文的元件都必须用它而不是自己写数字
- `measure/test-canvas-stub.ts` — `installCanvasStub`
- `katex-runtime.ts` — KaTeX 懒加载 + canvas 字形测量 + 字体世代观察（`onFontRevisionChange` / `getFontRevision`）
- `render/RenderMarkdown.tsx` — **render 参考实现样板**（绝对定位 + fonts[] 一致绘制）
- `VListHarness.tsx` — 对拍校准台（DOM 实测 vs pretext 预测+真实渲染；子代理把自己的元件加入 `HARNESS_CASES`）
