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
  lod: RenderLod,                // 1..5，默认 4（高度主开关）
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
| user 消息 | 气泡 p=sm + 头部单行(头像20+用户名+时间戳) 🟢 | 纯文本 pre-wrap（**不解析 markdown**）🔴 | 气泡 shrink-wrap: 宽=contentInset*2+usedWidth；带尺寸的附件图（`PreparedFixedBlock.displayWidth`）会把气泡**撑宽**到自己的显示宽（上限=列宽），无尺寸附件仍只占 300px 地板 |
| user 消息(斜杠指令) | 气泡 p=sm + 头部 + 指令行(sm mono truncate) + 预览行(xs 单行 clamp) + 溢出时 toggle 行(xs) 🟢 | 展开后=展开提示词 pre-wrap 🔴 | 折叠态**高度恒定**，与展开文本长度无关；`commandText` 存在即走此形态 |
| image | 有持久化宽高时=宽高比预留（`fitImageBox`，封顶 IMAGE_MAX_DISPLAY_HEIGHT=400）🟢 | — | 无尺寸（老消息）回落固定 200px；尺寸是**数据**不是测量：服务端上传时解析头部并写进 contentJson；fitted 分支与 image_generation 同属"高度随宽度单调性例外"（见 measure-media 注释），由 width-settle 结构护栏兜底 |
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

### 注入气泡（服务端注入内容，`measure-injection-bubble` / `RenderInjectionBubble`）

> 历史：本节此前描述的 sidecar 尾注（`measure-sidecar` / `RenderSidecar` / 工具卡内的 sidecar 带 / `payloadKind` / `sidecarRevision` / `appendMessageSidecars`）**已整条删除**，连同 `narrator_sidecars` 表与 WS `sidecars` 事件。注入内容现在拥有自己的消息行（`server/services/narrator-injection.ts`），不再挂在别人的消息或工具卡上。

**注入内容 → 左侧气泡。** 两个家族，区别只在**怎么拆**，不在有没有资格：

- **有具体说话人**（`SPOKEN_INJECTION_SOURCES`）：`messages` 按 sender 拆、`tasksDone` 按任务拆、`knowledge`（仅当全部 hits 有实质 summary）按条目拆。
- **平台自己的例行提醒**（`PLATFORM_INJECTION_SOURCES`：任务表摘要、行为围栏、进度提醒、计划提醒、Pipeline 确认、spec 更新）：整条投递**一个**气泡，因为说话人每次都是同一个平台，没有可拆的维度。

⚠️ 早期版本把平台提醒留成全宽 `origin_notice` 卡，理由是"例行提醒不该和队友消息等重"。那条理由**已被推翻**，两个原因：调度器说"你还有 3 条开放任务"本身就是有说话人的陈述，而且和 `spec_continuation`（当时已经是气泡）是同一个说话人同一类内容——一个做成气泡、一个留成卡是自相矛盾的；另外全宽让长任务文本远超舒适阅读宽度，气泡的宽度上限恰好修掉这点。"不该等重"现在由**更窄的宽度 + 中性配色**表达，而不是靠完全不同的形态。

没有结构化 body 的历史行仍走卡片：没有 body 就没有可拆的东西也没有可投影的东西。

**第三种气泡形态。** 此前只有两种：用户气泡（有框 + 纯 pre-wrap 文本）、assistant（markdown + 无框）。注入内容两半都要——框和 header 说明"谁"，markdown 承载投影已产出的结构（任务列表、子标题、bullet）。表面与用户气泡同族：同一个 8px 圆角、同一种 padding，差别只在**侧**（注入恒在左）与底色。

- **不加 per-producer 色标／accent rail／底色分色。** 身份由"左侧 + header 里的说话人"承担，够了。上一次重设计删掉的正是"彩色 Paper + 2px 彩色左轨 + 六种色相"，理由是**全列表最重的皮肤裹着最不重要的内容**；在新气泡上加回来是同一个错误换个位置。除审美外还有两个硬问题：左轨会被圆角裁成上下两段弧；`border-box` 下它悄悄吃掉内容宽度，而 measure 只算了 `padding*2`，于是测量与绘制不一致。有守卫断言守着（不写任何 border、且各 producer 表面一致）。

- **`usedWidth` 与 `contentWidth` 会不相等，正文必须画在后者上。** 测量顺序是：先在受 `INJECTION_BUBBLE_MAX_WIDTH_RATIO` 限制的 `innerWidth` 上测 markdown，再把**框**收缩到最宽行（`frame.usedWidth`，必然 ≤ `innerWidth`）与 header floor 的较大值。所以 shrink-wrap 后框内宽 < 换行宽。渲染层用 `usedWidth - padding*2` 会让正文在"按更宽盒子预测的高度"下重新换行、裁掉最后一行。`RenderMarkdown` 自己读 `measured.contentWidth`，两侧同源。
- **note 行单向一致**：measure 保留（`hasNote`）⇒ 渲染层必画。缺 label 时画的是**等高的空行**，绝不是"少画一行"——正文盒是固定高 `overflow:hidden`，"保留了却不画"留洞、"画了却没保留"顶出盒子，两者都违反 §0 铁律 2。（与旧尾注相反的口径：旧尾注是"没 label 则 measure 不保留"，两种做法都单向一致，但不能混用。）
- **正文有字符硬顶** `INJECTION_BODY_MAX_CHARS`。旧投影的 `SIDECAR_PROJECTION_MAX_LINES`=200 不在这条路上，而 `Send` 的消息文本一路到 `deliverInjection` 是**无界**的，所以上限必须落在这里。测量与绘制用同一个前缀。
- **`spec.key` 用内容身份，不用数组位置**：`-m{i}-{fromId}` / `-t{i}-{task.id}` / `-k-{entryId}`。空消息/空条目会被跳过，用"已发出计数"做 key 会让后面的气泡继承邻居的缓存高度与展开态（§4.5.1：`spec.key` 同时是 measure cache key、折叠/选择 key、height-override key）。曾经的隐患：knowledge 分支用过滤后下标，只因上游"全有全无"门恰好保证等长同序才正确——那是**视觉策略与 key 正确性之间的隐式耦合**，已消除。
- **`injection-bubble` 在 `UNKNOWN_HEIGHT_FORWARDING_KINDS` 里**。它的正文是别人写的 markdown，可以含 mermaid；渲染层转发了 `onUnknownHeight`，所以 shell 必须愿意为它保留 override。两者不一致的后果是渲染层走流式布局而行盒仍是固定裁剪 → 图被裁且无人能上报修正。这条一致性由源码级守卫断言守着（扫 render-registry 的转发点）。
- **刻意没有块级菜单**：一个 `system_injection` block 扇出 N 个气泡，而选择索引是按 `contentJson` block 建的，无法表达"这一行的第 3 个气泡"。因此 `injection-bubble` **显式**列入 `NON_INTERACTIVE_KINDS`，不靠"三个清单都没提到"来生效。要恢复菜单需先解决子块寻址。
#### 正文可以是 markdown，也可以是一张现成的系统卡（payload）

`measured.bodyForm` 显式区分二者，渲染层**必须**按它分支——绝不能嗅探 `blocks` 形状：卡片正文是 `PreparedFixedBlock`、markdown 不是，形状嗅探今天能用，等哪天某个 payload 恰好长得像 markdown 就会静默走错分支（这正是已删除的 `payloadKind` 标记当初要解决的同一类问题）。

- **为什么框住卡片而不是投影成 markdown**：`merge_summary` 有两个分支名和 commit sha、`spec_continuation` 有 badge 和 protected 标记。压成散文会把可用结构变成文字，所以卡片原样保留、气泡只负责加框和说话人行。
- **内层高度由卡片自己的 measure 决定**，气泡只加自己的 chrome。未识别的 payload kind 测成 0 高度而不是抛错——新生产者忘了登记应该退化成只有 header 的气泡，而不是把整个列表拖崩；`payloadKind` 让这个遗漏仍然可见。
- ⚠️ **必须传 card-scoped 的 measured 给内层**（`{ ...measured, height: frame.contentHeight }`）。多个卡片会用 `measured.height` 画自己的盒子，而复合元素上那是**气泡总高**（chrome + 卡片）——直接透传会让卡片把自己画得比框给它留的空间更高，溢出裁剪盒。这条踩过。

#### 哪些 system block 进气泡

判据不是"有没有主体"，而是**这是对话里的一次陈述，还是关于对话的一条元信息**。早期版本按前者判断，把 `container_ready` 归为"基础设施事件、没有主体"——但它的正文写着"**You can** use the Browser tool to test these services"，它在对模型说话、模型会回应它。

进气泡（`FRAMED_SYSTEM_CARDS`）：`merge_summary`、`review_feedback`、`spec_continuation`、`spec_blocked_continuation`。

**刻意排除**，三类各有理由：
- `compact` / `segment_compact` —— 关于对话的元信息（"这里之后历史被截断"），不是谁说的话。
- `spec_fork_carryover` / `spec_context_cleared` / `spec_goal_added` / `error` —— **带 live button**。shell 靠 `kind === "system-text"` 匹配来注入 `specCarryoverActions` / `errorNoticeActions`，改路由会让每个按钮静默失去 handler：照样画出来，点了没反应。**死按钮比缺一行说话人更糟**。要框它们得先让 action 注入能穿透到嵌套 payload。
- `bash_command` / `tool_loaded` / `tool_unloaded` —— 用户**自己**动作的回执，归给另一个说话人是反的。
- `ask_in_passing` / `subagent_recovery` / permission / question 表单 —— 是要**操作**的控件，不是读完的话；混成一个视觉语言会让"读消息"和"填表单"分不清。
- `container_ready` / `browser_session_lost` —— 想框但**框不了**：这两个 block type 从来不被 `isRecognizedSystemBlockType` 识别（chunked 侧也没特判过），所以根本到不了路由，只会回落到自己的 text 块渲染成 `info` 卡。先把它们注册为已识别的系统卡才谈框。

#### 说话人身份解析（集成层）

优先级：**真实账号** → **平台** → **自称的 agent** → **未知**。

- 真实账号（`merge_summary` 由按下合并的人产生，系统消息行本来就加载了 `creator`）用那个人的真名和**真头像**——给一个真账号画首字母占位，是"标成 System"那个 bug 的镜像错误。
- 平台事件（容器起来、调度器推进任务、浏览器会话丢失）共用**一个** NarraFork 身份，不给每种事件编一个名字——那会暗示一群并不存在的角色。
- 兜底是"未知发送者"，**绝不是 System**：气泡存在的唯一理由就是有别人说了话，标成系统恰好把这件事抹掉。
- 头像色标（`speakerTint`）是"又是这个 agent"的记忆辅助，**不是身份**——固定 5 色下约 20% 的名字对必然撞色（鸽巢原理），身份由旁边的**名字**承担。

- **header 是集成层注入的 slot**（`vlist-injection-header.tsx`）：纯 render 层不 import avatar / i18n。非账号说话人（子代理、后台任务）用名字生成确定性配色的首字母头像，不复用真人头像组件——那会声称一个不存在的账号。


### ToolCallCard（最复杂）
- **折叠态整卡 ≈ 40-42px**（Paper p=xs + header 单行 ~18-20px + border 1px×2）。inRun 无边框 + Divider。
- **header 单行**：category icon 16(内 icon 10) + summary(xs, truncate) + status 12 + 时长 + chevron 12。
- **展开体各详情 maxHeight（🟡 min(内容,上限)）**：
  - codeStyle=**200**、termStyle=**200**、bash/terminal cmd=**60**、EditDiff=**200**、图片/视频/iframe/skill/plan/knowledge body=**400**、流式 bash cmd=**120**。
  - 上限内的高度按**有界换行测量**得出（见 §4 开头 🟡 说明）：携带正文的详情一律测量换行，不再只数硬换行。
  - **media 详情（截图/图片）带 `media.width/height` 时按宽高比预留**（`fitImageBox` 进 可用宽×cap，纯算术，见 measure-tool-call 的 `mediaContentPx`）：截图 metadata 自带宽高，无尺寸时回落固定 200px。
  - **需测量🔴**：SpecTasks 列表(任务数×行高)、Recall/Send/Pipeline/WebSearch 结构化列表段、各 badge 头部行、error 文本、AskUserQuestionBanner、ReflectionNotice、InlinePermission 的 Textarea(1-3/8-30 行)+动态按钮行。
  - isPlan 的 `vpHeight`=0.85×视口高 → **用视口高公式替代，不测 DOM**。plan 正文按 **markdown** 测量/渲染（与 chunked 路径的 `ContentViewer markdown` 对齐），并可前置一行 `_planFile` 来源提示；正文解析同样走有界前缀（块边界截断）。plan 详情**不向上转发 `onUnknownHeight`** —— 外框高度由 cap 决定，转发会让虚拟列表与滚动框互相打架。
- **服务端截断的正文（`textTruncated`）预留整个 cap，且不占任何额外行**：
  - 无论普通 capped 正文（`cappedBodyHeight`）还是 markdown 正文（`measureMarkdownDetail`），只要正文是服务端前缀就把盒高钉在 `cap`，**不测前缀**。测前缀会让高度取决于服务端预算切在哪里（更宽的布局把前缀折成更少行 → 盒子变矮，剩余可滚内容无处安放）；cap 永不裁切，因为盒子本身 `overflow:auto`。
  - **没有"内容已截断"提示行**：完整 payload 由读者在正文盒内滚过一半时自动取（`VListContentViewHost` 的 capture 阶段 scroll 监听），或打开全屏查看器时取。两条路都经同一个 `fullPayloadRequested` 门控，所以仍是用户动作；又因为盒高已钉在 cap，落地的完整正文测得 `min(exact, cap)` —— 对任何溢出盒子的正文（每个服务端前缀都溢出）逐像素相同。
  - `truncatedLeafCount` / `truncatedTotalBytes` 因此是**纯 payload 完整性信号**，不带几何：shell 用它判断哪些行可以取数、哪些请求在飞，measure cache 用它做 `|tp:` revision（payload 落地时唯一会动的字段）。
- **effectiveOpened**：lodExempt(running/streaming/pendingPermission)恒展开；**最近一次 `spec://tasks.json` 调用的卡（latestSpecTasksToolUseId）恒展开**（`opts.forceExpanded`，由 adapter 从 shell 注入的 `resolveLatestSpecTasksToolUseId` 派生，任务板是叙述者的实时工作状态）；**L5 默认展开，但读者显式折叠（`userCollapsed`）时折叠**；L4 近卡随 opened、旧卡折叠；L3 全折叠 header；L1/L2 上游 gate 处理。
  - **⚠️ L5 不是"恒展开"**：早先这里 `return true`，于是 L5 的表头 chevron 是**死的**——shell 的 toggle 把 `!effectiveOpened` 写进 `expanded`，而该分支从不读这个通道，点击存进了没人读的状态，卡片高度毫无变化且没有任何反馈。最难受的正是最需要折叠的卡：被拒的 ExitPlanMode 实测 ~1200px（`0.85×视口`的 plan 正文 + 反思通知），超过一屏却收不起来。
  - **`userCollapsed` 必须与"派生出的 `opened === false`"区分**。后者来自 `computeDefaultOpen`，不代表读者的意图；在 L5 读它会把所有非自动展开类别的卡全部折叠。因此只有 shell 存有该 key 的偏好时才算显式折叠。
  - **`lodExempt` 优先于显式折叠**：待审批的卡折叠后权限表单无处可去。`resolveSubagentExpanded` 同一套语义（同样的缺陷、同样的修法）。
- **分组卡**：Paper p=xs + header(+×N badge) + 展开体(子 ToolCallCard 累加)。折叠 default=false。

### tool-run 折叠形态（全部基于 CollapsibleTrace，行高固定）
- **CollapsibleTrace**：表头 ≈24.8px（**条件渲染，见 `isTraceHeaderVisible`**）；每行 18.8px（title truncate 单行🟢）。maxVisible 超出+1 toggle 行。**reasoning step 行（独立 ReasoningStepsTrace 与 ActivityTrace 里的推理行都算）展开时有 markdown body🔴**；工具行展开是钻取整张卡（`card`，不是 `bodyText`），两条通道互斥。折叠靠 prop（`collapseItems`/`collapsed`/`expandedIndices`），不读 LOD。
  标题后紧跟**状态图标（12px 槽，仅在需要标记时渲染）+ 耗时**（`TraceItemData.status` / `.timing`，工具行才有；reasoning step 不带）。两者都落在行内容带 16.8px 之内（`TRACE_ROW_CONTENT` 由 xs 行盒决定），耗时是单行 nowrap、popover portaled，所以**不影响 18.8px 行高**（`measure-tool-run.test.ts` 有 height-neutral 断言）。它们是纯 passthrough，但会被画出来，因此必须进 `traceRevision`（`ts:` / `tm:`）。
  - **成功不画勾**：标记规则单源在 `@shared/tool-row-status`（chunk 与 vlist 共用）。只有"在飞 / 失败 / 取消"才画；`success`/`completed`、未识别状态、无生命周期的行**完全不渲染槽位**（不是空槽——每行留 12px 空隙和满列绿勾一样是噪音）。在飞状态是**显式枚举**而非"非终态"，否则拼写不认识的已完成调用会永远转圈。
  - **布局**：标题用 `flex: 0 1 auto`（可收缩以便 truncate，但不吸收剩余宽度），状态与耗时紧贴标题；行尾一个 `flex: 1` 的空 spacer 吃掉剩余宽度。耗时右对齐时读者需要横向跨过空隙回找本行，容易看成邻行的数字。
- **ToolRunCountLine**（L1/L2）：单行 ≈20.8px🟢。只有"整段 tool-run 未进入 activity fold"的兜底路径才会出现（见下面的可寻址不变量）。
- **Pinned tasks 卡不折叠**：L1/L2 的分组折叠把"最近一次 `spec://tasks.json` 调用"的卡与 active 工具同组处理（保持完整展开卡、留在原时间位置），与 `groupRenderUnits` 的 `keepToolUseIds` 豁免是同一根 pin——判定复用 spinner 的 `latestSpecTasksToolUseId` 规则（`vlist-spec-tasks-pin.ts`）。该卡仍计入 fold 数量（不从前缀 trace 的 items 移除，计数与 chunked 一致）。
  - **⚠️ 豁免按"工具条目"而非"整段 tool-run"**：`keepToolUseIds` 只把被 pin 的那一次调用拆出去，同段的其他调用照常折进 activity unit。早先按 message id 做段级豁免，整段 tool-run 会以普通 segment 抵达 adapter，L1/L2 于是把它的其他已完成调用压成 `tool-run-count`（唯一还会产生计数行的路径）——一条不含任何行、只有"工具调用 ×N"的计数行，那些调用在低档位下彻底不可寻址（现象：低 LOD "吞掉"了一次工具调用）。不变量：**任何档位下每次调用都必须可寻址**（自己的卡，或某个 trace 里的具名行）；计数行没有行，因此不得成为某次调用的唯一落点。permission 阻塞的调用同理只豁免自己。
  - **pin 的 id 只由 `buildPretextDocumentLayout` 推导，不接受 build option**：shell 另有一份（`LatestTodosToolUseIdCtx`，供 chunked 任务板 spinner 用），但那份扫的是 tail-meta 的消息列表，与 layout 实际布局的列表（persisted window + live streaming row）可能不一致；而一个"故意不进 build deps"的外部值一旦陈旧就永远无法自纠。就地推导保证 pin 始终与它所属的文档一致。
- **ActivityTrace**（L1/L2）：**行可见时不画表头**，高度 = 外层 py×2 + min(N,10)×18.8🟢；collapsed(L1) → 仅表头 ≈24.8px。
  - **表头只在它还在干活时保留**。它有两个职责，行一出现就只剩一个：① 它是**折叠开关**——L1 折成一条表头，那个 chevron 是读者回到行列表的唯一入口，所以 `collapseItems` 恒保留（含读者自己展开后的 `itemsOpened`，否则等于抽走他刚用过的控件）；② 它**标注 trace**——`reasoning-steps` 需要（「推理 · 5 步」是唯一能识别这个列表的东西），但 activity 的标签是泛化的：「活动 · 0 步推理 · 4 次工具」压在四条本来就各自写着工具名的行上面，是每个 assistant 回合固定要付的一份垂直开销（单次工具调用的回合，标签比调用本身还高）。因此**只有"activity 变体且行可见"这一种形状**丢表头，其余变体与折叠态一律保留。
  - **隐藏时是高度 0 的块，不是删块**：它仍持有外层 top padding，且 `frame.blocks[0]` 被直接当表头读。`header.visible` 把决定带到 render 层——**渲染层漏判就会画出一条测量层没预留高度的表头，压住第一行**。
  - **推理行可展开**：已落地（persisted）的结构化推理步骤带 `bodyText`，点击行展开该步 markdown🔴（高度按 `18.8 + 2*bodyPadY + markdownHeight`）。展开状态走 **row-KEY 通道**（`ctx.isRowExpanded`，与工具行钻取同一通道）——activity trace 的行序在流式过程中会被新步骤挤动，index 存不住。
  - **流式推理行不带 body**：live 行走 `parseStreamingReasoningTitles`（body 截首行），因此不可展开。原因是每帧重新 adapt 时返回完整 body 会重建整篇回复大小的字符串（实测占单帧 97.8%）；读者不吃亏，因为 live 行本身已有 `liveTail` 显示最新字符，且行 key 跨 hand-off 稳定，落地瞬间同一行长出 chevron。
- **ReasoningCountLine**（L1/L2）：单行 ≈20.8px🟢。
- **ReasoningStepsTrace**（L3–L5）：表头 + min(N,5)×18.8 + 展开 step markdown🔴。**不读 LOD**：不存在"标题可见但正文打不开"的档位（旧 `titlesOnly` 已下线），L3/L4/L5 形态一致，只有读者展开了哪些步骤不同。

### SubagentCard（唯一直接读 useRenderLod）
- Header：p=xs(20) + 徽标行 16.8 + description(折叠 truncate🟢 / 展开换行🔴) + 可选结果预览行。折叠≈55-75px。
- Recent Calls：≤3 行 × **18.8px（= `TRACE_ROW_HEIGHT`）🟢，行间无缝**（`RECENT_STACK_GAP = 0`）。这些行就是 trace 行：dot + 14px 类别 chip + 单行 `Tool · summary` + 状态槽 + 耗时，高度直接引用 `measure-tool-run` 而不是自己再算一遍；成功不画勾与"耗时紧贴标题"的规则同上，两条渲染路径的一致性由 `RenderSubagent.traceparity.test.tsx` 逐项比对守住。
  `recentCallSummaries` / `recentCallCategories` 是 render-only（切到 `recentRowCount`），summary 由 shell 注入的 `resolveSubagentRecentSummary` 从 header 的 `inputSummary` 得出；两者都进 `subagentRevision`（`gs:` / `gc:`），因为流式补全 `inputSummary` 时行数/名字/状态都不动，它们是唯一增量。
- 展开体：prompt ContentViewer **maxHeight:200🟡**、result ContentViewer **maxHeight:300🟡**、permission 子块。
- effectiveExpanded：lodExempt 恒展开；**L5 默认展开、显式折叠（`userCollapsed`）时折叠**（与 `effectiveOpened` 同一语义，见 §4 那条 ⚠️）；L4 近卡随 opened、旧卡折叠；L3 折叠。

### 其它列表级元素
- AskUserQuestionBanner（Alert，**高度强动态**）：Alert padding + Stack gap md × 问题数 + 每问题(header🔴 + 选项Σ(label+desc)🔴 + Textarea 1-3行) + 倒计时行(条件) + 按钮行30。只读模式去掉输入/按钮。无折叠、不读 LOD。

## 4.5 Live patch —— 由服务端事件驱动的高度变更（新增来源）

§4 列举的高度来源都由**本地输入**决定：数据一次装载、宽度/LOD 变化、用户展开折叠。`PretextLayoutCoordinator.applyLivePatch`（配套 `vlist-live-patch.ts` / `vlist-live-events.ts` / `useVListLivePatches.ts`）引入了第四种：**服务端 WS 生命周期事件在已装载的消息上原地改字段**，卡片因此变高变矮（工具完成长出输出体、reflection gate 推进换标题、subagent 卡片长出 recent calls 行）。

它与用户操作触发的高度变化性质不同：没有用户动作、随时可能发生、可能一帧内来一批。因此有三条硬约束：

1. **必须捕获 anchor。** 铁律"已提交的行不得在无用户动作时视觉跳动"在这里最容易被破坏。`applyLivePatch` 必须在 rebuild 前 `captureCoordinatorAnchor`、之后恢复 scrollTop。`applyCompactProgress` 不需要 anchor 是因为压缩标记高度恒定；live patch 不是。
2. **必须保持 `messageVersion` 与消息数不变。** 这是 field patch 不是结构变化。版本一动，全窗口的 measure 缓存条目全部失效，一张卡的更新会变成整窗重测。
3. **`extractDataRevision` 必须覆盖所写入的每一个影响高度的字段。** 这是 1 和 2 的直接代价，也是最容易漏的一条：patch 不改 `spec.key`（`tool-<toolUseId>` 恒定）、不改 `messageVersion`（约束 2 要求）、通常不改 `opts`，于是**缓存键唯一可动的部分就是 `extractDataRevision`**。漏一个字段 ⇒ 键完全相同 ⇒ 命中 patch 之前的高度条目 ⇒ 新内容被塞进旧尺寸的盒子里（被裁掉，或反向留出空洞）。

   已发生过的实例：`patchSubagentActivity` 只写 `_subagentActivity`，adapter 把它派生成 `recentCallCount`，而 revision 当时既不认识前者也不认识后者 —— 卡片一直服用 0 行的高度，recent calls 区域被完全裁掉。同类还有 `subagentConclusionPatch` 写 `outputJson`（→ `resultText`/`resultPreview`）：卡片本来已是 `success` 且无错时 `status` 不动，结果体是唯一的增量。

   派生字段尤其危险：patch 写的字段名和 measure 读的字段名往往不是同一个（`_subagentActivity` → `recentCallCount`），所以审计要顺着 **patch → adapter → measure** 整条链走，不能只看 patch 写了什么。

   历史上这条链最长的一例是 sidecar 的 `appendMessageSidecars` / `toolCompletedPatch`（往别人消息或工具卡上追加注入记录，既不新增消息也不动 `messageVersion`，却让 adapter 派生出自带高度的新元件）。**那套机制已整条删除**，但它留下的教训仍然适用于任何"派生出新元件"的 patch：

   - 判别 payload 要靠**显式标记**，不要嗅探字段形状（当年用"有 `fullText` 且有 `source`"来认，任何将来带这两个字段名的 payload 都会误入该分支、拿到描述别的东西的 revision）。
   - revision 的签名口径取**源文本**而不是投影产物：投影是源文本的纯函数，源文本签名已经覆盖它，而遍历投影结果会让成本随内容规模增长，违反本节开头的 O(1) 要求。

   revision 在**每次 measure 时都会调用**，所以必须保持 O(1)：只读基元字段，文本走 `textSignature`（长度 + 定量采样哈希），禁止 `JSON.stringify` 整个 payload、禁止随内容规模增长的遍历。

**回归防线：** `live-patch-measure-audit.test.ts` 的 EXHAUSTIVE 组对每个 patch 函数跑真实的 segmentMessages → adaptSegments → measure，断言"高度变了的行，缓存键必须也变"。新增 patch 时把它加进那份列表即可自动获得覆盖，不需要手工列字段。

## 4.5.1 历史删改的就地通道（删除 / 尾部截断 / 中段插入 / marker 整条替换）

§4.5 处理的是"服务端在已装载消息上原地改字段"。这一节处理另一件事：**服务端删掉了消息、截短了某条消息的 block 列表、或在窗口中段插入了一行**。它们是结构变化，本来只能走 `reload`。

问题在于 `reload` 被 `pinnedToBottom` 门控（`vlist-reload-policy.ts`）：读者滚上去时重载被**无限期推迟**，只暴露为未读提示。这条门控对"被动到达的新内容"是对的（替换窗口会把读者拽回底部、丢掉 loadOlder 页面），但对**读者自己刚点的回退/删除/压缩**是错的——他右键点的就是历史里某条消息，因此按定义不在底部，然后界面看起来没反应。未读徽标也是错误的表达：读者没有未读，是他的操作没落地。

因此现在共有**四条**就地通道，都与 `appendMessage` 同构。前三条的判定是纯函数（`vlist-message-remove.ts` / `vlist-message-replace.ts` / `vlist-message-insert.ts`），**保守**：拿不准就返回同一数组引用，调用方按身份跳过重建并回落 `reload`。

| 通道 | 入口 | 处理什么 |
|------|------|---------|
| 删除 | `removeMessages` | `messages_deleted` |
| 尾部截断 | `replaceMessage` | 前缀式 `message_updated`（rollback 的边界消息）|
| 中段插入 | `insertMessage` | 落在窗口中段的 compact marker（段压缩 / 带 `beforeMessageId` 的自定义压缩）|
| marker 整条替换 | `applyLivePatch` + `isCompactMarkerMessage` | `replaceMessage` 拒绝的 compact marker `message_updated` |

### 为什么不会命中错误高度

四条通道都保持 `messageVersion` 不变（§4.5 约束 2：动它会让全窗口重测，而留存行内容一个字没变），于是 `documentRevision` 不动，缓存键的正确性只能由 **`spec.key` + `extractDataRevision`** 承担（`registry.ts` 的 `buildCacheKey`）。

- **删除**：被删行的 key 直接不再出现，留存行的 key 与内容都没变 → 天然安全。
- **尾部截断**：assistant block 的 key 是 `${msg.id}-b${bi}`，`bi` 是 block 在**原数组**中的索引。截掉尾部只让高索引 key 消失，留下的每个 `-b{bi}` 仍指向同一 block 同一内容 → 安全。
- **中段插入**：新行带自己的 `spec.key`（`${markerMsgId}-sys`），既有行的 key 由**消息 id** 派生而不是数组下标，所以插入不会让任何既有 key 改指别的内容 → 安全。⚠️ 这依赖"key 从不含数组位置"这条既有约定（§4.5 里 `spec.key` 用内容身份那条的同一理由）；哪天有元件改用下标做 key，这条通道就必须一起收窄。
- **marker 整条替换**：见下面单独一节——这是唯一一条 key **和**内容都可能变的通道。

⚠️ **这就是 `replaceMessage` 只接受"严格变短且是前缀"的原因，别放宽。** 正文被改写而 key 不变（`-b0` 还是 `-b0`）时，version 又没动，缓存键完全相同 ⇒ 新内容被塞进旧高度的盒子——正是 §4.5 约束 3 警告的形态。所以长度相等（编辑）、变长（追加）、中段删除（非前缀，`-b1` 会改指原来的 `-b2`）全部拒绝，交给 `reload`：那条路连同新 `messageVersion` 一起换掉整个窗口，永远正确。判定用显式字段清单（`type`/`id`/`name`/`text`/`thinking`/`summary`/`status`）而不是深比较——它每个事件只跑一次，不在 measure 热路径上。

**已知残留（刻意）：** 非前缀的 `message_updated`（如手工编辑 assistant 文本）仍走 `reload`，因此非底部时仍会推迟。就地处理它需要让缓存键感知正文变化，而唯一能承载的就是 `documentRevision`（即 `messageVersion`），一动就是全窗口重测，等于放弃就地更新的全部收益。rollback 产生的恰好是前缀截断，不落在这个残留里。

### 插入的窗口边界（上下各一条，理由不同）

`insertMessage` 只在两个边界之内接受一行；越界一律回落 `reload`。

- **下边界（比已装载尾部更新）**：那是 `appendMessage` 的职责，两条通道都接会插两次。
- **上边界（`seq < oldestLoadedSeq`）**：⚠️ **判定只看这个边界，刻意不要 `hasPrev` 前提。** 两个独立的失败方式各自成立：
  1. 还有未取的更老历史时（`hasPrev`），下一次 loadOlder 会把同一个 marker 再取回来——分页只认 `beforeSeq`，不知道本地插过一行 → 重复。
  2. 即使 `hasPrev` 为 false 也不安全：`trimLoadedHead` 会把已取历史**交还**并同步把边界往新的方向推（`trimHead` 里 `oldestLoadedSeq = oldestKeptSeq`）。此时一个低于边界的 seq 在数组里**没有正确的位置**，而 `insertLoadedMessage` 会合法地给出 `insertAt = 0`，于是 marker 落到窗口最顶端——一个它不属于的位置，上面还压着比它更老的行。

  早期只判第 1 条（`hasPrev && …`），第 2 条就成了静默错位。代价只是极少数情况多走一次 reload。

### compact marker 的整条替换：靠正文签名而不是 status

`replaceMessage` 拒绝的 `message_updated` 里有一类必须就地处理：**compact marker 的状态推进**（`compacting → compacted/failed`）。它不是前缀截断（block 一个没少，只是字段变了），但读者刚点的就是这次压缩，推迟等于操作看起来没落地。所以 `replaceOrReload` 在 `replaceMessage` 拒绝后，对 `isCompactMarkerMessage` 认可的消息走 `applyLivePatch` 整条替换（保持 `messageVersion` 与消息数不变，并且**必须 anchor**：failed 的段压缩卡比单行 marker 高）。

这条通道的安全性**不能**只靠"status 折进了 measure cache key"：

- 非 failed 的 `compact`/`segment_compact` 是单行 `system-simple`，label 由 status **合成**（`composeCompactText`），正文无法独立变化 → status 足够。
- **failed 的段压缩是 `system-text` 卡，正文就是错误原文，按 pre-wrap 换行**，高度对文本敏感。而 `adaptSystemTextData` 的 `segment_compact_failed` 分支**根本不往 `data` 里写 status**，于是两次 `failed` 更新的 `extractDataRevision` 原本都是 `undefined` —— 缓存键逐字节相同，第二条更新直接命中第一条的高度，长错误信息被裁掉。

因此 `extractDataRevision` 为 system 卡补了一条 `data.text` 的内容签名（`|sx:` + `textSignature`，O(1)，与 `detailTextRevision` 同一口径；后者只走 `d.detail`，system 卡没有 detail 所以进不去）。**这是这条通道成立的前提**，不是可选优化：没有它，就必须把这类更新退回 `reload`。

覆盖：`measure-cache.test.ts` 断言同 status 不同正文（含等长不同换行）必须换 revision；`pretext-layout-coordinator.test.ts` 用真实 `applyLivePatch` 断言 version 不动时卡片高度确实跟着正文变高。

### rollback 会发出两个事件，必须都接

`rollbackToBlock`（服务端）分两步：先删目标之后的所有消息（`messages_deleted`），再删**目标自己**边界之后的尾部 block（整条被删则 `messages_deleted`，否则 `message_updated` 带改写后的消息）。只接前者会让回退**看起来只做了一半**：下面的消息消失了，而读者点的那张卡的尾部 block 还在。两条通道必须同时存在。

### `oldestLoadedSeq` / `hasPrev` 删除后绝不重算

⚠️ 易错点。`oldestLoadedSeq` 描述的是**已取数窗口的上边界**（"我已经拿到 seq ≥ 这个值的数据"），不是"当前最老那条消息的 seq"。它唯一的消费者是 `loadPretextDocumentOlder` 的 `beforeSeq` 与重叠检查。删除不会让服务端凭空长出更老的历史，边界没有移动，保留原值继续正确。

按剩余消息重算是**错的**：删掉最老一条后重算会把边界往新的方向推，下一次 loadOlder 就跳过中间那段永远取不回来，屏幕上留下一个静默的空洞。保留旧值最坏只是多取一页重叠数据，而 loader 的 `pageMaxSeq >= oldestLoadedSeq` 检查本来就会拒绝重叠页。

### 与 reload 门的交接

就地处理成功后必须同步推进 `appliedMessageRevisionRef`（与 `appendOrReload` 同一套），否则重载门仍把这次变更看作待处理：冒出一个假的"新消息"提示，然后 refetch 屏幕上已经正确的内容。

## 4.6 折叠过渡动画（FLIP，纯装饰层）

§4/§4.5 描述的是"高度是多少"，这一节描述的是"高度改变时怎么看起来在动"。

chunked 路径靠 Mantine `<Collapse>`：正文在正常流里，浏览器补间 `height`，下面的内容自然跟着滑。精确画布做不到——每行绝对定位在纯算术给出的 `top`，所以一次展开就是"重建 → 写新 top → 整列瞬移一帧"。正确但生硬。

实现是 FLIP（`vlist-fold-animation.ts` 纯算 + `vlist-fold-motion.ts` 出关键帧 + `vlist-motion-scheduler.ts` 播放 + shell 接线），三条设计约束：

1. **不能用 CSS transition 直接补间 `top`/`height`。** 行会随窗口挂载/卸载，新进窗口的行没有"上一个值"可补间，会从浏览器上次见到该 key 的位置飞进来；而且 `top`/`height` 是布局属性，几十行同时补间等于每帧一次全画布布局。更关键的是，全局 transition 会把**所有**几何变化都变成可见位移，包括 live patch、翻页、宽度沉降——那些重建之所以要锚定，正是为了让它们不可见。所以动画必须按用户动作逐次 opt-in。
2. **必须在视口坐标系里计算，不是文档坐标系。** 折叠重建是锚定的（`captureCoordinatorAnchor` → `restorePretextLayoutAnchor`），展开视口上方的卡片会用 +Δ 的 `scrollTop` 写入抵消 +Δ 的文档位移——屏幕上那些行根本没动。用原始 `top` 差值会给"看起来没动的行"编造 Δ 像素滑动，正是锚点要消除的伪影。两侧各减自己的 scrollTop 后，这种情况自然坍缩成"不动画"。
3. **展开与折叠不对称，这是刻意的。** 展开时新正文已在 commit 后的 DOM 里，所以被点的那行保持**最终盒高**（下方各行因此已经正确），用 `clip-path` 揭开新增区域，读起来就是正文在固定框里展开。折叠时展开态正文**已经被 React 卸载**，没有东西可裁，动画由下方各行从原位上滑承担（卡片头部不动，让出的空隙在 200ms 内闭合）。

   ⚠️ **不要给折叠补"自己的"过渡。** 三个方案都试过，都是错的：
   - **反向播放 reveal**（`inset(0)` → `inset(0 0 Δ 0)`）需要展开体还在 DOM 里，但它已经被卸载，动画落在一个本来就很短的盒子上，是 no-op。
     - **让展开体多挂一帧再卸载**：对**顶层卡片折叠**不划算——展开体是元件自己的正文，多挂一帧要让 `RenderToolCall` 按旧 `measured` 画正文，而它的高度模型与该 measured 强耦合。（⚠️ 注意这条只针对顶层卡片。**下钻卡片的收起恰恰必须这样做**，而且不违反铁律 2，见第 4 条。早期版本在这里笼统写成"违反铁律 2"，那是错的。）
   - **给被折叠行淡入**（`opacity: 0 → 1`）—— **短暂上线过，是 bug**。cross-fade 的作用是遮掩**组件替换**（见 §4.7「只有换了组件才淡入」），而折叠什么都没替换：卡片头部在开合两侧是同一个组件、同一位置、同一内容，卸载的只是它下面的正文体。于是淡入让**唯一没变的那部分**每次折叠都闪一下——正是那条规则要防的伪影。
   - 备选里还有 `cloneNode` 深拷贝旧子树（在 click handler 里同步克隆一张 400px 卡片），成本不值得。

   **头部不动不是这个设计的缺点，而是它能被读懂的原因**：它是那条正在闭合的空隙所依据的固定参照。

4. **trace 元素内部的行要单独规划（嵌套 FLIP）。** 低档位下**整段 activity run 是一个列表项**，它的工具行是这个项内部的绝对定位块（`measured.rows[i].top`，画成 `data-nf-trace-row`）。`planFoldMotion` 只看顶层项，所以下钻一行时：run 自己变高了、整段 run **下方**的内容正确滑动，而**同一个 run 内、被下钻行下方的兄弟行直接瞬移**。这正是"只对整个 activity 组下方内容做了动画"的现象。
   - 实测（860px、3 行 activity trace）：下钻中间行使元素 81.2 → 103.4px，其下方行 local top 60.4 → 82.6px。顶层 plan 能表达前者，无法表达后者。
   - 由 `planFoldNestedRowMotion` + `captureFoldNestedRows` 承担，与行/边框**同一次快照**，避免两处几何不一致。
   - **坐标是 trace 元素内的 local 值，不带 scrollTop、不带元素 top。** run 自身的位移已由该元素的 `shift` 承担，再叠加一次等于让这些行动两遍（看起来会比装着它们的盒子滑得更远）。因此"只是整段 run 移动了"的行 delta 为 0，自然被丢弃。
   - **scope 与所属 trace 的 `row:` 互不相同**（`row:<traceKey>:nested:<rowKey>`）：元素本身也在动（它变高了），共用 scope 会让调度器在启动前取消掉另一个。
   - ⚠️ **下钻行的"块高"必须动画，否则卡片是"瞬间消失"而不是"收起"。** 下钻行的块**就是卡片**（measure 层保留 `blockHeight === card.height`，`RenderToolRun` 按该高度画盒子），所以取消下钻不是"在稳定外框里卸载正文"（顶层卡片折叠才是那样），而是把 200px 的块换成 18.8px 的块。React 在**第一帧**就提交短高度，于是：
     - 卡片连标题一起**瞬间消失**，没有收起过程；
     - 下方各行从"已经变短的盒子"外面开始上滑，看起来是**从一条裁剪线里冒出来、而且追不上**上方内容。
     两个症状同一个根因，对策有**两半，缺一不可**：
     1. **块高动画**（`planFoldNestedRowResize` + `nestedResizeKeyframes`）：把块的 `height` 从卡片高动画到行高。下方各行位移**恰好等于它让出的高度**、时长与 easing 相同，因此全程**紧贴卡片底部**（"胶合不变量"有回归断言：实测块 41.0 → 18.8，下方三行各移 22.2）。
     2. **延迟卸载卡片**（`closingRowKeys` + `MotionOp.onDone`）：⚠️ **只做第 1 半是无效的**——React 在同一帧就把卡片卸载了，动画于是作用在一个**空盒子**上，观感仍是"瞬间消失"。所以 shell 在 toggle 时把该行标进 `closingRows`，渲染层继续画**上一帧的卡片节点**（钉在它原有高度上，由块的 `overflow: hidden` 逐步裁短 —— 是"整体被裁短"，内容不缩放、文字不变形），动画结束由调度器的 `onDone` 释放。
        - **这不违反 §0 铁律 2**：块盒的高度仍然精确等于布局刚提交的 `row.blockHeight`，全程不测 DOM、不读 measure 缓存、不碰布局索引；多画的那 200ms 是纯装饰，和 fold 的 `clip-path` 同类。
        - `MotionOp.onDone` 因此必须**恰好调用一次**，且覆盖全部退出路径（自然结束 / 被同 scope 重播取消 / `cancel()` 拆除 / 压根没启动 / resolver 抛错）：漏调会让一张卡片**永久留在屏幕上**，重复调用会清掉下一次交互的状态。调度器用 `once()` 包装并对每条路径都有测试。
        - **不用影子节点**（`cloneNode`）：那会引入一条 `fill:"none"` 刻意消灭的清理路径，且克隆一张 400px 卡片是同步深拷贝。延迟卸载让 React 继续拥有那棵子树，没有任何需要手工移除的东西。
     - 这里动画 `height`（布局属性）是**受控例外**，与装饰边框同理：块是 trace 内的绝对定位盒，没有流内兄弟，每个兄弟行都由纯布局自己的 `top` 定位，且没人回读这个盒子。**不能用 `scaleY`** —— 那会把卡片文字压扁。
     - 块盒因此必须 `overflow: hidden`，让收起过程中的卡片被逐步遮住而不是挂在外面。swipe / 右键菜单都走 portal（`position: fixed`），不受影响。
   - ⚠️ **下钻 morph 不得淡入。** `drillMorphKeyframes` 曾写 `opacity: 0 → 1`，逐帧慢放就是"标题 blur in"。按 §4.7 的规则 cross-fade 只用于遮掩**组件替换**，而摘要行与卡片头部承载同一行 `Name · summary`、位置相同，这里要的是**无缝替换 + 位移**，不是溶解；淡入还会和块的高度动画打架，两者叠起来就是"一团模糊"而不是"一次干脆的移动"。
   - ⚠️ **准入是"按 trace 全有或全无"，绝不逐行裁决。** 这些行不是各自独立的对象，而是**一列内容的整体上移**；放行一部分、拒绝另一部分，就会让通过的行缓动、被拒的行瞬移。
     - 曾经照搬 §4.7 的 L3→L2 裁剪判据（起始盒落在 trace 提交后高度之外就拒），**那是一个 bug**。两条都不成立：
       1. **类比不成立。** LOD 那条拒绝的是"整段动画躲在裁剪之下、末尾才弹出"的节点；而取消下钻时这些行是**从下方滑上来进入**盒子的，全程基本可见——用起始边去比最终高度，恰好拒掉了那些正确移动的行。
       2. **逐行裁决会把整组撕开。** 实测（860px、4 行 trace，行 0 与行 2 都下钻，随后关闭行 0）：盒子 144.4 → 122.2，下方三行都该移动 22.2px，但 `row-3` 起始底边 142.4 > 122.2 被拒 → 仍下钻的 `row-2` 缓动、紧邻的普通行 `row-3` 瞬移，两者在动画期间**重叠**。这比原来"整组一起瞬移"更差。
     - 现在同一 trace 内所有移动过的行共享同一时长与 easing，一起动或都不动。唯一的门是共享的可读距离上限，且**任一行超限即整组不动画**（亚像素行不算超限，它只是没动）。
     - 裁剪本身不值得设门：这些行的位移最多等于盒子刚缩掉的高度，因此瞬时溢出也被同一个 `overflow: hidden` 挡住——不会溢出 trace，也不会画到邻居身上。

### 铁律：一次视觉事件 = 一个调度器 = 一个取消边界

画布上有**四样**东西会动：fold 的行、fold 的装饰边框、下钻表头 morph、LOD 切档 morph。它们**不是相互独立的事件**——`onToggleRow` 一次点击同时产生 fold（捕获几何）和 drill 翻转，所以这两者必然同帧播放。

改造前每样各有自己的 controller 和取消边界，后果是**一次视觉事件会被拆散**：再点一次时 fold 的 controller 把自己启动过的全部取消，而 drill 的 controller 只取消同一 `rowUid`，于是一半停住、另一半继续跑到不同的结束时间。时长也已经漂移（fold 200ms、drill 引用 200ms、LOD 250ms）——LOD 长一点是合理的，其余的相等只是巧合，而三个模块里没有任何一处能表达这个区别。

现在统一由 `vlist-motion-scheduler.ts` 持有全部 WAAPI 句柄、决定时长与 easing、拥有唯一取消边界。三个 planner **不合并**（输入语义和坐标系各不相同，且它们是这套系统正确的部分），只统一执行：

- **scope 取消**：取消域是字符串（`row:<key>` / `frame:<key>` / `drill:<uid>` / `lod:<unitId>`）。重播一个 scope 只取消它自己——多行同时下钻时再点其中一行，其余行不受影响（保留了原 drill controller 的行为）；而一次 fold 重播能连带取消该行的 row/frame/drill 三个 scope（原来任何 controller 都表达不了）。
  ⚠️ 被点的行**同时**会有 reveal 与 shift（钉底展开），落在两个节点两种属性上，所以它们的 scope 必须不同（`row:<key>:reveal` / `:shift`）：调度器在启动前先取消同 scope，共用一个 scope 会让后者把前者取消在启动之前。
- **一次 commit 一次 flush**：三个 effect 各自 `begin()` + `push()`，由一个**声明在它们之后**的 layout effect 统一 `flush()`。层内 effect 按声明顺序执行，这与 §4.6 里 `usePretextDocument` 必须在 fold play 之前是同一机制。把 flush 挪到任何一个 planner 之前，那个 effect 的 op 就会落到下一个事件或永远不播——**静默失败**：plan 照样产出，只是时序散了。
- **时长单点**：`MOTION_DURATION_MS`（200）为共享基准，`LOD_MOTION_DURATION_MS`（250）是唯一的刻意偏离，且作为**事件级**覆盖施加到该次切档的每个 op（逐 op 覆盖会让配对元素在不同时刻落定）。
- `prefers-reduced-motion` 的三份重复判定合并为调度器一处。

铁律层面的位置：
- **不属于高度模型。** 只写 `transform` / `clip-path`，都是合成属性、不参与布局、不回读。`height` 会反馈进布局并可能扰动已测高度，`top` 会和布局拥有的绝对定位打架，两者都禁止（`vlist-fold-wiring.test.ts` 按关键帧构造函数逐个断言）。
- **不进 React state、不进测量缓存。** 和 `vlist-highlight.ts` 同一范式：用 ref 持有，直接写行节点。进 state 会为一个装饰让全窗口 memo 失效，还会把视觉关注点塞进"产生被动画几何"的那次 render。
- 行上新增 `data-nf-row-key`（data 属性，height-neutral）供控制器定位节点；`id` 不能用，它是**消息** id，一条消息的多行共享它。
- 行的**内层**内容盒另有 `data-nf-row-body`（同样 height-neutral，同样不得进 `spec.opts`），**只供 reveal 使用**。`clip-path` 的 inset 是从**它所作用节点的底边**量起的，而只有内层盒的高度等于布局的 `height`；外层行盒是 `hitHeight`（自身高 + 到下一行的间隙，见 `resolveRowHitHeight`）。把 reveal 打在外层，裁剪起点就比卡片真实下边缘低了一个 gap，首帧会露出本该还藏着的内容，而且内层盒自己还有一层 `overflow: hidden`，两层裁剪对"卡片在哪结束"的判断不一致。`shift` 平移整行，仍落在外层盒。

两个易错点（都有守卫）：
- **捕获必须在 click handler 里、`setInteraction` 之前。** 放在 effect 里读到的是重建后的几何，差值恒为 0。
- **"没有可播的动作"不等于"播完了"。** `setInteraction` 先触发一次 re-render，文档重建发生在 `usePretextDocument` 的后续 effect 里。所以播放用的 layout effect 会先在"几何还没变"的那次 commit 上跑一遍——那次若消费掉 capture，就等于在它真正对应的几何到来前一次 commit 把它扔了（早期版本因此完全不动画）。保留它的代价为零，两端都有界：revision 校验挡住"文档被别的东西改了"的 capture，年龄上限（~400ms）淘汰"重建始终没来"的 capture。

`prefers-reduced-motion: reduce` 下直接不捕获，于是播放 effect 找不到东西，折叠瞬时生效。

## 4.7 LOD 切档过渡（元素级 diff，纯装饰层）

切档和折叠是两件不同的事：折叠改一处高度，切档**重排整篇文档**。所以它不用 click 时捕获，而是**声明式 diff**——每次 commit 后快照视口×3 窗口，与上一帧配对，让已提交的新节点从旧屏幕位置滑回原位（`vlist-lod-morph.ts` 纯算 + `vlist-lod-morph-motion.ts` 出关键帧 + `vlist-motion-scheduler.ts` 播放 + shell 接线）。

- **配对身份是 `unitId ?? key`。** 被重新主题化的元素（工具卡/子代理卡）逐档换 key（折叠批次以首个成员命名为 `toolrun-count-tool-<id>`），靠 adapter 挂的 LOD 无关 `unitId` 配对；**其余全部元素**（markdown 正文、user 气泡、system 卡、turn-usage、divider）没有 `unitId`，但它们的 `spec.key` 本身就与档位无关（`${msgId}-b{n}` / `${msgId}-bubble` / `${idBase}-sys` / `${idBase}-usage-*`），所以 `key` 就是它们的跨档身份，不需要新造 id。早期只配对前者，结果是切档"一半平滑"——卡片缓动到位，承载它们的文档主体瞬移。
  - 两个命名空间不会撞：adapter 设 `unitId` 时一律设成该元素**自己的 `key`**，所以 `unitId` 绝不会是别的元素的 `key`。单档独占的 key（`toolrun-count-*`、`activity-*`）在另一档不存在，只会"配不上"（直接出现），不会"配错"。
  - 节点定位相应有两条：先 `data-nf-unit`，再回落 `data-nf-row-key`（按 key 配对的元素只画后者）。漏掉回落不会报错——plan 照样产出，只是全部解析为 null，症状是文档主体又开始瞬移。
- **只有换了组件才淡入。** cross-fade 的作用是遮掩**组件替换**，所以只在 `kind` 变化时播。一段只是移动了的 markdown 正文是同组件同内容，给它淡入等于让没变的正文每次缩放闪一下，比不动画更糟。
- **有距离上限（复用折叠的 2000px）。** L5→L1 把几千像素的卡片栈压成 19px 行，下方元素的位移可以到上万像素；250ms 跨过去是一团模糊，还会让读者丢掉正在看的行。代价是超限元素瞬移、未超限的邻居仍在滑动，大幅切档会有局部撕裂——与折叠动画同一取舍。**但换了组件的元素例外**：超限时退化为"原位淡入"（`deltaY: 0, fade: true`）而不是完全不动画，否则 L2/L3 这种既换形态又大位移的组合会彻底失去过渡。
- **原位换形态也要淡入。** 距离过滤（亚像素 / 超限）只能砍掉**滑动**，不能砍掉整个 plan：activity fold 常常在**原位**换组件（`deltaY ≈ 0`），只按距离 gate 会把最需要过渡的那一档静默丢掉。

### L2/L3 边界：trace 行 ↔ 卡片（1:1，方向不对称）

这是视觉落差最大的边界，因为它是**组件真的变了**的那一档：一次工具调用在 L1/L2 是 activity-trace 里的摘要**行**，在 L3+ 是顶层**卡片**。两者带同一个 `unitId`（`tool-<toolUseId>`，`segment-adapter.ts` 的 `:2994` 与 `:2586` 同源），所以**配对是 1:1**——一行对一卡，装着它们的 trace 元素本身不是参与者。因此快照会连同顶层元素一起收集**嵌套行**，几何提升到文档坐标（`traceTop + row.top`）。

⚠️ 曾经有过两条把这块列为"不做"的错误论断，都已修正：
- ~~"关系是 1:N，只有一个能 travel"~~ —— 错。把"N 张卡折进 1 个 trace 元素"与"配对关系"混为一谈了；配对发生在行↔卡片之间。
- ~~"overflow 裁剪让两个方向都不可行"~~ —— 只对**一个方向**成立，见下。

**两个方向不对称，这是画布的性质而非取舍。** morph 动的是**新节点**；嵌套行被裁剪到 trace 的盒子（shell 对非 dynamic 行 `overflow: hidden`），顶层卡片不被任何东西裁剪。所以哪一侧受裁剪取决于读者往哪个方向缩放：
- **L2 → L3（行 → 卡）**：新节点是顶层卡片，无裁剪，可以从行的原位一路滑过来。这个方向拿到完整滑动。
- **L3 → L2（卡 → 行）**：新节点是被裁剪的嵌套行，而它的来源卡片通常远在 trace 盒子之外；真去 translate 会让行在动画期间躲到裁剪之下**整段不可见**（闪一下，比瞬移更差）。为动画临时放开 overflow 会引入 `fill:"none"` 刻意消灭的清理路径，还会让行画到邻居身上。所以这个方向**保留淡入、放弃滑动**（`deltaY: 0, fade: true`）：读者仍然得到把两种形态联系起来的 cross-fade，只是失去位移，而那段位移本来也看不见。

判定在 `clipFor` 里（纯算术，不在 DOM 边），语义是"起始盒与裁剪**完全无交集**才拒绝"——部分露出的起点仍然滑动，因为那时读者看得见它在移动。

另外：trace 最多显示 `ACTIVITY_MAX_VISIBLE` 行，被"更早"折叠藏起来的调用**不产生行快照**，因此在另一档没有配对方、直接出现——绝不能让它从一个从未占据过的位置飞入。

### 推理步骤的跨档身份（第三种身份，两个前置条件）

工具调用两侧都是 `tool-<toolUseId>`，所以卡片一直能 morph；**推理曾经完全不能**，原因是结构性的：折叠行按 `stableKeyBase` 编号（run 在**其 activity 单元内**的序号，如 `run0`，这是保证流式 hand-off 稳定的东西），而 L3+ 根本没有 activity 单元，那个序号在那边不是"不同"而是**算不出来**。实测 16 条消息文档：L2→L3 推理行配对 0/16。

所以引入第三种身份 `reasoningStepUnitId()` = **消息 id + run 起始块索引 + run 内步骤序号**（`reason-<msgId>-b<runStart>-s<step>`）——两侧都能独立推导的唯一事实集合。`key` 不动（它是交互通道），只新增 `unitId`。修复后推理行 16/16 配对，两个方向都是。

⚠️ 两个前置条件，**两侧必须同时满足**（只有一侧收窄是最危险的形状：行会静默停止配对）：
1. **消息已落地。** 流式消息 id 是 `__streaming__`，hand-off 时会变，用它派生身份等于"先配不上、然后在脚下改变"。L1/L2 侧退回 run-ordinal 形式（仍然唯一，只是没有配对方），L3+ 侧干脆不发。
2. **run 只含一个块。** 两档的**分组方式不同**：activity fold 逐块 push 并逐块解析，L3+ 把 run 的相邻块 join 后整体解析。多块 run 的步骤边界因此可能不对齐，`s2` 在两侧可能是不同的步骤——**配错比不配更糟**，因为它看起来是刻意的。

`unitId` 是 height-neutral 但会被**画出来**（`data-nf-unit`），所以必须进 `traceRevision`（`|tu:`）：它能在 `key` 和所有高度字段都不动的情况下变化（turn 落地那一刻 run 获得可配对身份），漏掉会让缓存供应没有 `data-nf-unit` 的行，**静默损失掉它本该启用的那个 morph**。

**`reasoning-steps` 容器元素不配对，这是正确的。** 那才是真正的 1:N：L2 侧不存在"每个 run 一个容器"，一段里所有 run 和工具都并进同一个 `activity-trace`，N 个容器映射到 1 个元素；而且两侧 chrome 是不同的东西（「推理 · N 步」表头 vs 「活动」表头）。身份由行承载，容器只是外壳。

**折叠与 LOD morph 的 `transform` 争用（两条互斥条件，都必须在）。** 折叠靠 `data-nf-row-key` 定位、LOD morph 靠 `data-nf-unit` 或 `data-nf-row-key`，两者落在**同一个节点的同一个属性**上。现在两者共用一个调度器（见 §4.6 末），所以不再存在"两个 cancel 边界互不知情"的问题；但**同一属性上两个动画仍然会互相覆盖**，所以下面两条互斥条件依然必须成立——scope 分离只保证取消语义正确，不会把两个 plan 合成一个：
1. **折叠自己那次重建不动档位。** `toggleVListLodUserOverride` 只改 `lodUserOverrides`（作为 per-card opt 抵达 build），`manifest.lod` 来自 `useRenderLod()`，只有缩放手势能动它。所以 LOD morph 的 gate（revision 不变 **且** lod 移动）拒绝它。
2. **后续重建不能复活折叠的 capture。** 切档和折叠一样**不推进 documentRevision**，所以"折叠后 400ms 内立刻捏合"会同时通过 revision 与年龄两道校验 —— capture 因此额外记录自己的档位，`isFoldCaptureUsable` 一旦发现档位移动就判定失效（语义上也对：capture 拍的是另一套主题下的几何）。

## 4.8 钉底平滑跟随（流式滚动的"不顶跳"契约）

§4.6/§4.7 处理"高度怎么看起来在动"，这一节处理**视口怎么到达新底部**。钉底跟随流式输出时，每条新行/新 toolcall/卡高落地都曾把 `scrollTop` 瞬时写到新底部——相对视口，所有已提交行在一帧内上跳一个增量。现在这些写入走**追赶式平滑跟随**（`vlist-smooth-follow.ts`：纯算步进/门控 + rAF 控制器，与 fold-animation/fold-motion 同一分层范式）：提交帧画面保持不动，随后视口指数趋近（TAU=100ms，速度上限 4000px/s）滑行到**每帧重读的实时底部**，新内容从底部滑入。移动目标无需重启动画，无速度突变。

### 判据：只有"读者在场时内容到达"才 glide

⚠️ **这是本节最容易做错的一条，且做错不会报错、只会让列表动画化自己的挂载过程。**

底部写入有三个入口，但**只有一个**该 glide：

| 入口 | 语义 | 行为 |
|------|------|------|
| 流式 bottom 锚点修正（`onScrollTopCorrection` + 成因标记） | 读者在看，内容到达 | **glide**（唯一） |
| 几何 revision pin effect | 文档**建立/沉降** | 瞬时贴底 |
| `processScrollFrame` 的 re-glue | 行 paint 后**落定高度** | 瞬时贴底 |

后两者是**兜底路径**，接住的是一切几何变化：首次加载、切换叙述者（restore 提交后台 reload 再替换窗口）、prepend 重吸附、行上报真实高度（权限表单 textarea / 图片 / reflection notice）、footer 解析、视口 resize。这些增量**个个都很小**，所以一旦路由到同一个门控就会逐个通过并开始滑行——**症状是切换叙述者时列表从上方一路滚下来，而不是直接贴底打开**（已实际发生过）。纯函数门控测试抓不到这类问题：门控本身完全正确，错的是"谁有资格问它"。

**但后两者也不能无条件瞬时写**：那会在下一帧覆盖写到底，把流式修正刚启动的追赶整段截断。所以它们的规则是**追赶在跑时让位**（`smoothFollowerRef.current?.isActive()`）——追赶每帧重读实时底部，它们要答的那次增长已经在追赶的目标里了。

item 锚点修正、marker 跳转、reveal 跳转、`scrollToBottom` 一律瞬时并 cancel 追赶——锚定修正的全部意义在于不可见，导航跳转是读者的显式动作。

守卫断言 `ensure()` 在整个 shell 里**只出现一次**（多出一处就是这个 regression 回来了）。

**门控是一条纯算术规则**：`delta = 实时底部 − 当前 scrollTop`，仅当 `0 < delta <= smoothFollowMaxDelta(viewport)`（= clamp(1.5×vh, 480, 2000)）且非 reduced-motion 才滑行。它挡掉的是**巨型位移**：整页加载、切换后窗口替换、回退缩文档（delta ≤ 0）。

**但门控只是最后一道，不是主判据。** 它按 delta 大小工作，而"文档沉降"与"内容到达"在几何上完全可以同样小——上面那张表才是主判据（谁有资格 glide），门控只负责在有资格的那条路上再挡掉过大的位移。另有两道配合：

1. **成因标记 `scrollTopSmoothFollow`**（coordinator 快照 → `usePretextDocument` → `onScrollTopCorrection` 第三参）。只有 `setStreamingMessage` / `appendMessage` / `applyLivePatch` 三个**尾部增长**提交携带它；rebuild/remove/insert/replace/trim/restore/prepend 一律不携带。没有标记的 bottom 修正（如钉底下的 prepend 重吸附）几何上与流式增量不可区分——钉底时两者的 delta 都是"距新底部一小段"——所以成因必须由协调器盖章，shell 不得嗅探。契约测试在 `pretext-layout-coordinator.test.ts` 的 stamping 组。
2. **几何占有转换前吸附**：`captureFoldBefore` 与 LOD 的 `emit`/`prepareLodChange` 先调 `snapToTarget()`（无追赶时为空操作）。钉底下的 fold FLIP 按 `getScrollBottomTarget` **预测** afterScrollTop，追赶滞后会毁掉视口坐标 delta。

### 末段必须有步长下限与提前落定（两者缺一都会顿挫）

指数趋近的步长与剩余距离成正比，所以**尾部天然会退化**，而尾部正是读者盯着看的部分。两个效应叠加，各需一条对策，方向相反不可互换：

- **亚像素步长 → 画面完全不动，攒够 1px 才跳一下。** TAU=100ms@60Hz 每帧走剩余的 ~15%，残差 3px 时每帧 0.46px、0.39px、0.33px……写进 `scrollTop` 也不改变**渲染**位置（设备像素对齐），于是连续几帧静止再突然位移一像素——这就是"好几帧动一下"的顿挫。对策：`SMOOTH_FOLLOW_MIN_STEP_PX`=1，步长低于它就抬到它（并始终 clamp 到剩余距离，故不会越过目标）。
- **1px/帧 匀速尾巴 → 动画迟迟不落定。** 下限消除了静止帧，但把尾部变成一串 1px 帧。实测 20px 增长会附加约 6 帧（~100ms）看不见的运动。对策：`SMOOTH_FOLLOW_SETTLE_EPSILON_PX`=**3**（不是"尽可能小"），把该串压到最多 2-3 帧。

⚠️ **两个常量都不要"优化"**：把 epsilon 调回 1px 或去掉步长下限，都会让顿挫原样回来，而单元测试断言的正是这两件事（无亚像素帧 + 1px 帧数 ≤3）。3px 的收尾跳变是安全的——shell 本来就把 1px 内视作"已在底部"，且最后一次写入是**精确目标**；epsilon 只决定"最后两三个像素跳过去还是爬过去"，而在一段减速动画的末尾，≤3px 的跳变低于可察觉阈值（这也正是爬过去不值 100ms 的原因）。

**追赶期间的三条不变量**（都有守卫断言，见 `vlist-scroll-pin.test.ts` 的 smooth-follow 组）：

- **`readCurrentView` 必须把活跃追赶视为钉底。** 追赶中视口滞后底部一个残差，裸几何读数会报"未钉底"→ 每条流式提交捕获 item 锚点 → 其修正取消本应喂给它的追赶（自残死循环）。活跃追赶即"钉底在途中"。
- **追赶死于每一种读者意图。** `detachFromBottom`（wheel-up）、`processScrollFrame` 判出的非回声上滑、scrollToBottom/marker/reveal 跳转、卸载，全部 cancel。值基回声抑制与 `isBottomLostToContentGrowth` 天然兼容追赶写入：`processScrollFrame` 读 DOM 实时值，单调递增的追赶写入永远不会被误判为"用户上滑"（上滑 = scrollTop 下降 > 1px）。
- **追赶逐帧用轻量写**（DOM + refs + 抑制簿记，不推进 React state）；写入产生的 scroll 事件走 `processScrollFrame` 既有窗口门控推进 state。落定的最后一帧用完整写收敛 state。直接 `setScrollTop` 每帧全量重渲染是明确要避免的。

**为什么不用 CSS `scroll-behavior: smooth`**：逐帧写会不断重启浏览器补间（移动目标下永远追不上或攒延迟）、无法控制速度/阈值、且会污染锚定修正等必须瞬时的写入（该属性是容器级的，按写切换它会把时序复杂度搬回 shell）。

`prefers-reduced-motion: reduce` 下 `ensure()` 恒走瞬时写——行为与改造前完全一致，且这不是可选优化而是可达性契约（复用 vlist-motion-scheduler 的 `prefersReducedMotion()`）。

> **试过 transform 反向位移，已回退。** 曾把 glide 改成"`scrollTop` 瞬时到底 + 画布 `translateY(+delta)` 动画回 0"，目的是让插值跑在合成器线程。理论收益成立（零 scroll 事件/零窗口重算），但**实测看不到任何滚动动画，只有瞬间抖动**：真实的流式提交里，同一帧既写 `scrollTop` 又装位移动画，而画布本身正在被 React 重建（`totalHeight` 变化、行挂载/卸载），位移被反复清除或从错误基线起算。这条路要走通得先解决"位移与文档重建的时序归属"，成本远超收益。追赶方案虽然占用主线程，但它与既有的锚定/窗口/pin 机械是同一套坐标系，行为可预测。

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
