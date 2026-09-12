# 批次2 工作分解与派发清单（WBS）

> 本文件把 `CONTRACT.md §4` 的元件目录拆成**可直接喂给子代理**的任务包。用户放行后，主 agent 按此清单一次性并行 fan-out（每个包一个 general 子代理）。
> **未放行前不分发。** 本文件本身是零风险的规划产物。

## 派发前提（每个子代理的通用指令头）

每个子代理任务 prompt 必须包含：
1. 先读 `frontend/components/narrator/vlist/CONTRACT.md`（全文）+ 本包对应的 CONTRACT §4 行。
2. 样板：measure 抄 `measure/measure-markdown.ts`（或消息级 `measure/measure-message-bubble.ts`），render 抄 `render/RenderMarkdown.tsx`（或 `render/RenderMessageBubble.tsx`），测试抄对应 `.test.ts` + 用 `measure/test-canvas-stub.ts`。
3. 只在 `vlist/` 内新增文件，**不改 vlist/ 外任何文件**，不改已就绪骨架的公共类型（如需扩展 `PreparedBlock` 必须先回报主 agent，避免并行冲突）。
4. 交付自检：`bunx tsgo --noEmit`（无 vlist 错误）+ `bunx @biomejs/biome check --write <新文件>`（退出0）+ `bun test <新测试>`（全过）+ 隔离守卫仍绿。
5. 不重启运行中的 NarraFork 进程。

## 并行批次划分（避免公共类型写冲突）

- **Wave A（可立即全并行）**：纯新增、互不依赖、不碰公共类型的包 → P1..P8。
- **Wave B（Wave A 后）**：需要组合 Wave A 产物或可能微调公共类型的包 → P9..P12。
- 若某包发现 `PreparedBlock` 需要新变体，**串行经主 agent 改 `prepared-block.ts`**，再放行依赖它的包。

---

## 任务包清单

### P1 — reasoning / thinking 块
- 文件：`measure/measure-reasoning.ts` + `render/RenderReasoning.tsx` + 测试。
- 输入：reasoning/thinking block（text/translatedText）、LOD、展开态、streaming。
- 高度模型（CONTRACT §4）：
  - streaming 无内容 → 单行 "thinking…" ≈ 固定行。
  - L2/L1 → ReasoningCountLine 单行 ≈20.8px（见 P10 组件，或本包内联单行）。
  - 折叠 → header 单行(chevron12+icon16+label+字符数) ≈固定；展开 body = markdown(xs 12px) 🔴，`pl="md"` 缩进 + `py=4` + borderLeft 2px。
- 验收：折叠≈header 单行；展开=header + markdown(xs) 高度；LOD 切换改变形态。

### P2 — image / image_generation / text_file 块
- 文件：`measure/measure-media.ts` + `render/RenderMedia.tsx` + 测试。
- 高度模型：
  - image → 固定 **200px**（Skeleton 也 200）🟢。
  - text_file → 单行(图标14+文件名+大小) py=2 ≈固定 🟢。
  - image_generation → header 行 + 图(显示宽/aspectRatio)🟢；有 metrics 时零测量；revisedPrompt 换行🔴（可选）。
- 验收：三者高度固定/可算，无 DOM 测量；image_generation 用宽高比预留。

### P3 — web_search 块
- 文件：`measure/measure-web-search.ts` + `render/RenderWebSearch.tsx` + 测试。
- 高度模型：单行卡 Paper p=xs + Group(icon18 + 可选 loader + xs 文本) ≈固定；query 长可换行🔴（次要）。
- 验收：单行高度固定；长 query 换行按 pretext。

### P4 — system 卡（单行/lineClamp 类，全 🟢）
- 文件：`measure/measure-system-simple.ts` + `render/RenderSystemSimple.tsx` + 测试。
- 覆盖：compact(单行 py=4 ≈25px)、merge_summary(p=xs lineClamp=1 ≈37)、review_feedback(≈37)、spec_continuation/blocked(truncate ≈37)、segment_compact(ing/ed)(单行 ≈25)。
- 高度模型：全部固定单行/截断，无换行。
- 验收：每种一个固定高度常量，零测量。

### P5 — system 卡（多行/pre-wrap 类，🔴）
- 文件：`measure/measure-system-text.ts` + `render/RenderSystemText.tsx` + 测试。
- 覆盖：info、tool_loaded/unloaded、bash_command、error、segment_compact(failed)、spec_goal_added、spec_fork_carryover/context_cleared。
- 高度模型：Paper p=xs + 图标/badge/按钮固定行 + 正文 pre-wrap 或 monospace pre-wrap🔴（用 `prepareWithSegments(..., {whiteSpace:"pre-wrap"})`，参考 measure-message-bubble 的 user 分支）。
- 验收：固定 chrome + pre-wrap 行数×行高；按钮行/badge 行计入固定。

### P6 — system 卡（列表类，线性可预测）
- 文件：`measure/measure-system-list.ts` + `render/RenderSystemList.tsx` + 测试。
- 覆盖：knowledge_hint（heading + N 条目每行 truncate 🟢，高度 = 20+17×(1+N)）。
- 验收：高度随条目数线性，零换行不确定性。

### P7 — plan 卡（compact subtype=plan / PlanCard）
- 文件：`measure/measure-plan-card.ts` + `render/RenderPlanCard.tsx` + 测试。
- 高度模型：Paper p=sm + header(icon16+mb6≈24) + markdown 正文🔴（非编辑态）。
- 验收：固定≈48 + markdown 高度。

### P8 — ask_in_passing（pending / resolved）
- 文件：`measure/measure-ask-in-passing.ts` + `render/RenderAskInPassing.tsx` + 测试。
- 高度模型：
  - pending：Box px=md py=xs + 提示行 + 输入行(TextInput sm 36 + 2 按钮) ≈77px 🟢。
  - resolved：Paper px=sm py=xs + 单行(标签 + 问题 lineClamp=2) 57~77px 🟡。
- 验收：固定/封顶高度，无自由换行。

---

### P9 — tool-run 折叠形态（CollapsibleTrace 家族）— Wave B
- 文件：`measure/measure-tool-run.ts` + `render/RenderToolRun.tsx` + 测试。
- 覆盖：CollapsibleTrace（表头 24.8px + 行 18.8px truncate🟢）、ToolRunSummary(L3)、ToolRunCountLine(L2 单行 20.8)、ActivityTrace(L1/L2)、ReasoningCountLine(L1/L2)、ReasoningStepsTrace(表头 + N×18.8 + 展开 step markdown🔴)。
- 依赖：可能与 P1(reasoning) 共用 ReasoningCountLine → Wave B 统一在此实现，P1 引用。
- 验收：行高固定；maxVisible 折叠 + toggle 行；仅 ReasoningStepsTrace 展开 body 需 markdown。

### P10 — ToolCallCard（header + 折叠体 maxHeight）— Wave B
- 文件：`measure/measure-tool-call.ts` + `render/RenderToolCall.tsx` + 测试。
- 高度模型（CONTRACT §4）：
  - 折叠态整卡 ≈40-42px（Paper p=xs + header 单行 + border）🟢。
  - 展开体各详情 **maxHeight 封顶**🟡：code/term/diff=200、bash/terminal cmd=60、图片/视频/iframe/skill/plan/knowledge=400、流式 bash=120 → 高度 = min(内容, cap)，只判断是否超限。
  - 需测量🔴：SpecTasks 列表、Recall/Send/Pipeline/WebSearch 结构化段、badge 头部行、error 文本、权限 UI（见 P11）。
  - effectiveOpened：lodExempt 恒展开 / L6 展开 / L5 近卡随 opened、旧卡折叠 / L4 折叠 / L1-L3 上游 gate。
  - isPlan vpHeight=0.85×视口高 → 用视口高公式，不测 DOM。
- 分组卡：header(+×N badge) + 展开体(子卡累加)。
- 依赖：最复杂，建议单独一个能力强的子代理；可能需要给 `PreparedFixedBlock` 加详情 tag（经主 agent）。
- 验收：折叠≈header；展开=min(详情,cap)；LOD 组合覆盖。

### P11 — 权限/交互 UI（AskUserQuestionBanner + InlinePermission）— Wave B
- 文件：`measure/measure-permission.ts` + `render/RenderPermission.tsx` + 测试。
- 高度模型（强动态）：
  - AskUserQuestionBanner：Alert padding + Stack gap md × 问题数 + 每问题(header🔴 + 选项Σ(label+desc)🔴 + Textarea 1-3 行) + 倒计时行(条件) + 按钮行30。
  - InlinePermission：executionTarget 行 + Textarea(反馈 1-3 / ExitPlanMode 8-30 行) + PermButtonBar 动态按钮。
- 验收：高度随问题/选项/按钮数线性；只读模式去输入/按钮。

### P12 — SubagentCard — Wave B
- 文件：`measure/measure-subagent.ts` + `render/RenderSubagent.tsx` + 测试。
- SubagentCard 高度模型：Header(p=xs 20 + 徽标行 16.8 + description 折叠 truncate🟢/展开换行🔴 + 可选结果预览行) + Recent Calls(≤3×26.8🟢) + 展开体(prompt maxHeight:200🟡 + result maxHeight:300🟡 + permission 引用 P11)；直接读 LOD 决定 effectiveExpanded。
- 依赖：permission 部分引用 P11。
- 验收：折叠≈55-75px；展开 = header + recent + min(prompt,200) + min(result,300)。

---

## 收尾（主 agent，全部包完成后）

1. 建统一 registry：`segment → measure/render` 分发表（对齐 `message-segments.ts` 的 RenderSegment 种类）。
2. VListHarness 加入所有元件的对拍 case，浏览器校准字体常量。
3. 组装 `PretextMessageList.tsx`：用 `vlist-virtualization.ts` + registry + 消息数据源，实现虚拟化列表。
4. 接入 `NarratorPanel.tsx:7170` 开关分支（**动态 import**，隔离守卫保证不泄漏）。
5. **接入阶段护栏核验**：开关关闭 → 走原 ChunkedMessageList 且行为不变；开关打开 → PretextMessageList。端到端验证后方可关闭第1条 protected 护栏。
6. 全量 tsgo + biome + bun test + 生产构建 + 隔离守卫。

## 覆盖度对照（对齐 message-segments RenderSegment）

- `message`（assistant/user 文本）→ measure-message-bubble ✅（已完成样板）+ 各 block 包 P1/P2/P3/P4/P5/P6/P7。
- `tool-run`（ToolRunItem[]）→ P9(折叠形态) + P10(单卡/分组) + P12(subagent 卡)。
- 权限/问题（跨 message 与 tool）→ P11。
