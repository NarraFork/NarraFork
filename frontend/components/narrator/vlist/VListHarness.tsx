/**
 * VListHarness.tsx — DEV-ONLY calibration harness for the pretext vlist.
 *
 * It renders sample content two ways and reports the height delta:
 *   - LEFT: the real component/DOM, measured with getBoundingClientRect
 *   - RIGHT: the pretext-predicted height from a measure function
 *
 * Purpose: calibrate font constants + wrapping so predicted heights match the
 * browser within tolerance. This harness is the ONLY place DOM measurement is
 * allowed in the vlist namespace, and it never ships in the production list
 * path (it is imported lazily behind a dev/hidden entry).
 *
 * TWO CASE FLAVOURS
 *   1. Ground-truth cases (markdown): a real DOM node is rendered and measured;
 *      predicted vs actual delta is reported. Only markdown has a light-enough
 *      DOM ground truth we can pull in (lazily) without breaking the isolation
 *      guard.
 *   2. Preview cases (every other element): the source component (MessageBubble /
 *      ToolCallCard / SubagentCard / …) is heavy and context-dependent, and
 *      importing it here would break the vlist isolation guard. So these cases
 *      have NO DOM ground truth (`hasGroundTruth: false`): they only render the
 *      RenderXxx(measured) copy inside a box sized to the predicted height, so a
 *      developer can eyeball whether the rendered copy fills its predicted box.
 *
 * Subagents implementing measure-*.ts should add their element to HARNESS_CASES
 * so it participates in the diff. All measure/render imports below are
 * vlist-internal; the ONLY cross-edge import is the lazy `../MarkdownContent`
 * (kept dynamic so the isolation guard stays green).
 */

import { Badge, Box, Button, Group, Stack, Text } from "@mantine/core";
import { classifyToolDetail } from "@shared/pretext-layout/tool-detail";
import {
	type ComponentType,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { ensureKatexLoaded, isKatexReady } from "./katex-runtime";
import { measureAskInPassing } from "./measure/measure-ask-in-passing";
import { measureMarkdown } from "./measure/measure-markdown";
import type { MediaBlockInput } from "./measure/measure-media";
import { measureMedia } from "./measure/measure-media";
import { measureMessageBubble } from "./measure/measure-message-bubble";
import { measurePruneDivider } from "./measure/measure-misc";
import {
	type AskUserQuestionData,
	type InlinePermissionData,
	measureAskUserQuestion,
	measureInlinePermission,
} from "./measure/measure-permission";
import { measurePlanCard } from "./measure/measure-plan-card";
import { measureReasoning, type ReasoningBlockData } from "./measure/measure-reasoning";
import { measureReviewCard } from "./measure/measure-review-card";
import { measureSubagentCard, type SubagentCardData } from "./measure/measure-subagent";
import { type KnowledgeHintData, measureKnowledgeHint } from "./measure/measure-system-list";
import {
	measureSystemSimpleCard,
	type SystemSimpleData,
	type SystemSimpleKind,
} from "./measure/measure-system-simple";
import {
	measureSystemTextCard,
	type SystemTextData,
	type SystemTextKind,
} from "./measure/measure-system-text";
import {
	measureToolCall,
	measureToolCallGroup,
	type ToolCallData,
} from "./measure/measure-tool-call";
import {
	type ActivityTraceItem,
	measureActivityTrace,
	measureReasoningCountLine,
	measureReasoningStepsTrace,
	measureToolRunCountLine,
	type ReasoningStepItem,
} from "./measure/measure-tool-run";
import { measureWebSearch } from "./measure/measure-web-search";
import { RenderAskInPassing } from "./render/RenderAskInPassing";
import { RenderMarkdown } from "./render/RenderMarkdown";
import { RenderMedia } from "./render/RenderMedia";
import { RenderMessageBubble } from "./render/RenderMessageBubble";
import { RenderPruneDivider } from "./render/RenderMisc";
import { RenderAskUserQuestion, RenderInlinePermission } from "./render/RenderPermission";
import { RenderPlanCard } from "./render/RenderPlanCard";
import { RenderReasoning } from "./render/RenderReasoning";
import { RenderReviewCard } from "./render/RenderReviewCard";
import { RenderSubagent } from "./render/RenderSubagent";
import { RenderSystemList } from "./render/RenderSystemList";
import { RenderSystemSimple } from "./render/RenderSystemSimple";
import { RenderSystemText } from "./render/RenderSystemText";
import { RenderToolCall, RenderToolCallGroup } from "./render/RenderToolCall";
import { RenderToolRun, RenderTraceCountLine } from "./render/RenderToolRun";
import { RenderWebSearch } from "./render/RenderWebSearch";

// Tolerance (px) below which a predicted/actual delta is considered a match.
const MATCH_TOLERANCE = 4;

interface HarnessCase {
	id: string;
	label: string;
	/** Content width (px) used for both DOM render and prediction. */
	width: number;
	/**
	 * Whether this case has a real DOM ground truth to measure against. Defaults
	 * to true. When false, the case is a PREVIEW: no actual column, no delta —
	 * only the RenderXxx(measured) copy inside a predicted-height box.
	 */
	hasGroundTruth?: boolean;
	/** Render the real DOM node whose height is the ground truth (ground-truth
	 * cases only; omitted for preview cases). */
	renderActual?: (width: number) => ReactNode;
	/** Predict the height via a measure function (zero DOM). */
	predict: (width: number) => number;
	/** Render the pretext-predicted output (absolute-positioned) for visual diff. */
	renderPredicted: (width: number) => ReactNode;
}

/**
 * Build a PREVIEW case (no DOM ground truth): measures once via `measure`, and
 * renders the RenderXxx copy from that measured result. `measure` is invoked in
 * both `predict` and `renderPredicted` with the identical width, so the box
 * height and the rendered copy always agree.
 */
function preview<M extends { height: number }>(
	base: { id: string; label: string; width: number },
	measure: (width: number) => M,
	render: (measured: M) => ReactNode,
): HarnessCase {
	return {
		...base,
		hasGroundTruth: false,
		predict: (width) => measure(width).height,
		renderPredicted: (width) => render(measure(width)),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample data (width-independent). Kept small + realistic so wrapping-sensitive
// elements produce interesting multi-line heights.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_MD = [
	"# Heading one",
	"",
	"A short paragraph with some **bold** and *italic* and `code` inline text that should wrap when the container is narrow enough to force multiple lines.",
	"",
	"- first list item",
	"- second list item that is long enough to wrap across more than a single line in a narrow column",
	"",
	"```ts",
	"const x = 1;",
	"const y = 2;",
	"```",
	"",
	"> a blockquote line",
].join("\n");

/**
 * LaTeX calibration sample. Math geometry comes from katex-geometry's arithmetic
 * walk over KaTeX's own layout tree, so this is where that prediction gets checked
 * against real browser rendering. Covers the cases that needed specific handling:
 * stacked fractions, the sqrt radical (CSS min-width + padding), big operators,
 * matrices, script-size superscripts, merged glyphs (`i\pi`), and CJK inside
 * `\text{}` (which KaTeX has no metrics for — it falls back to canvas measurement).
 */
const SAMPLE_MATH_MD = [
	"Inline mass-energy $E = mc^2$ inside a sentence that should wrap normally when the column is narrow.",
	"",
	"Merged glyphs and Greek: $e^{i\\pi} + 1 = 0$ and $\\alpha\\beta\\gamma$.",
	"",
	"CJK inside text mode: $\\text{速度} v = 3$ needs real font measurement.",
	"",
	"$$\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}$$",
	"",
	"A radical and a fraction: $\\sqrt{a^2+b^2}$ then $\\frac{1}{2}$.",
	"",
	"$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$",
	"",
	"$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$",
].join("\n");

/**
 * GFM table calibration sample.
 *
 * Tables are the one block the browser's own `table-layout: auto` would decide, so
 * the height model solves the columns itself (`layoutTable`) and the renderer paints
 * absolutely-positioned cells instead of a real `<table>`. That makes them the block
 * most exposed to a measure/render divergence, and the divergence is INTEGER-shaped:
 * column widths are solved from intrinsic min/max advances and then rounded, so a
 * cell that wraps at one extra line under real font metrics but not under the test
 * canvas stub is invisible to unit tests and visible here.
 *
 * Deliberately mixes short and long cells (so the solver has to distribute slack),
 * an inline-code cell, and CJK (whose advances the stub models as uniform).
 */
const SAMPLE_TABLE_MD = [
	"| Field | Meaning | Default |",
	"| --- | --- | --- |",
	"| `widthBucket` | Rounded content width folded into the measurement cache key | none |",
	"| `lod` | Render level of detail, 1 (count lines) through 6 (full cards) | 5 |",
	"| 字体世代 | 字体换代计数，prepared 缓存键的一部分 | 0 |",
	"",
	"A trailing paragraph, so the table's own bottom margin participates too.",
].join("\n");

const SAMPLE_USER_TEXT =
	"Can you extend the calibration harness so every batch-2 element gets a preview case?\nInclude the tool-call and subagent cards too.";

/** A slash command as the user typed it (short) plus its server-side expansion. */
const SAMPLE_COMMAND_TEXT = "/generate-changelog v0.3.0";
const SAMPLE_COMMAND_EXPANSION = [
	"You are generating a bilingual changelog for this release.",
	"",
	"Read the git commits since the previous tag, group them by type (features, fixes,",
	"refactors), and drop anything with no user-visible effect. Produce both an `en`",
	"and a `zh-CN` section using the same bullet order so the two read as translations",
	"of each other rather than independent summaries.",
].join("\n");

const REASONING_DATA: ReasoningBlockData = {
	text: "Let me reason about the height model. The header row is a single fixed line, and the expanded body reuses measureMarkdown at sm, so paragraphs wrap at 14px while code stays at 12px. That keeps the prediction aligned with MarkdownContent.",
	stepCount: 4,
};

const MEDIA_IMAGE: MediaBlockInput = {
	type: "image",
	filename: "network-diagram.png",
	mediaType: "image/png",
};
const MEDIA_IMAGE_GEN: MediaBlockInput = {
	type: "image_generation",
	status: "completed",
	statusText: "Generated image",
	revisedPrompt:
		"A neon city skyline at dusk, ultrawide cinematic composition with reflective streets",
	width: 1024,
	height: 640,
	result: "data:image/png;base64,PLACEHOLDER",
};
const MEDIA_TEXT_FILE: MediaBlockInput = {
	type: "text_file",
	filename: "design-notes.md",
	size: 20480,
};

const KNOWLEDGE_HINT_DATA: KnowledgeHintData = {
	heading: "Referenced 3 knowledge entries",
	entries: [
		{
			entryId: "k1",
			title: "Pretext line metrics",
			summary: "How pretext computes wrapped line counts with canvas measureText.",
		},
		{ entryId: "k2", title: "Mantine spacing scale (xs=10, sm=12, md=16)" },
		{
			entryId: "k3",
			title: "vlist isolation guard",
			summary: "Why the vlist must be loaded via a flag-guarded dynamic import.",
		},
	],
};

const PLAN_CARD_MD = [
	"## Plan",
	"",
	"1. Add a preview mode to the calibration harness",
	"2. Construct minimal sample data for every element kind",
	"3. Verify tsgo + biome + the vlist test suite stay green",
].join("\n");

/**
 * A realistic review conclusion: prose, inline code, a file path and a fenced snippet.
 *
 * Deliberately markdown-heavy — this is exactly the content the earlier plain-text card
 * could not render, so the sample has to exercise the markdown path rather than read as
 * three flat lines.
 */
const REVIEW_CONCLUSION_MD = [
	"## Code Review: Changes Requested",
	"",
	"- 🚨 **[critical]** `server/db/schema.ts:2606` — the new index has no migration, so",
	"  `chapter-roster-service.test.ts` asserts a plan the database cannot produce.",
	"- 📋 **[minor]** `server/services/pm-communication.ts` — the cached statement outlives",
	"  the module it was prepared in.",
	"",
	"```ts",
	"const stmt = sqlite.prepare(SELECT_ROSTER); // survives a hot reload",
	"```",
	"",
	"Please address the above findings before merging.",
].join("\n");

const ASK_QUESTION_DATA: AskUserQuestionData = {
	questions: [
		{
			header: "Which flow mode should be the default for new projects?",
			options: [
				{ label: "Classic canvas", description: "Interactive React Flow story-network graph." },
				{ label: "Ruler timeline", description: "Linear chronological view of chapters." },
			],
			multiSelect: false,
		},
	],
	hasCountdown: true,
};
const ASK_QUESTION_READONLY: AskUserQuestionData = {
	questions: [
		{
			header: "Which flow mode should be the default for new projects?",
			options: [
				{ label: "Classic canvas", description: "Interactive React Flow story-network graph." },
				{ label: "Ruler timeline", description: "Linear chronological view of chapters." },
			],
			multiSelect: false,
			savedCustomAnswer: "Classic canvas felt more intuitive for branching work.",
			hasSavedAnswer: true,
		},
	],
	readOnly: true,
};

const INLINE_PERM_DATA: InlinePermissionData = {
	hasExecutionTarget: true,
	executionCwdLines: 1,
	executionPathLines: 1,
	feedbackRows: 1,
	buttonCount: 2,
	buttonRows: 1,
};
const INLINE_PERM_READONLY: InlinePermissionData = {
	readOnly: true,
	hasExecutionTarget: true,
	executionCwdLines: 1,
	hasDecisionReason: true,
	decisionReasonLines: 2,
	feedbackRows: 1,
};

const TOOL_CALL_READ: ToolCallData = {
	toolName: "read",
	summary: "frontend/components/narrator/vlist/registry.ts",
	category: "read",
	status: "success",
};
const TOOL_CALL_TASKS: ToolCallData = {
	toolName: "todo",
	summary: "update task queue",
	category: "tasks",
	status: "success",
	detail: {
		kind: "sections",
		sections: [
			{
				key: "tasks",
				body: {
					kind: "spec-tasks",
					tasks: [
						{
							text: "Extend HarnessCase with a preview mode that skips the DOM ground truth",
							status: "done",
						},
						{
							text: "Construct sample data for every registry element kind",
							status: "doing",
							protected: true,
						},
						{ text: "Run tsgo, biome, and the vlist test suite", status: "todo" },
					],
				},
			},
		],
	},
};
const TOOL_CALL_ASK: ToolCallData = {
	toolName: "AskUserQuestion",
	summary: "Which flow mode should be the default for new projects?",
	category: "ask",
	status: "success",
	detail: {
		kind: "sections",
		sections: [
			{
				key: "question",
				body: {
					kind: "ask",
					questions: [
						{
							// Single question → the card header already shows this text.
							header: "Which flow mode should be the default for new projects?",
							omitHeader: true,
							options: [
								{
									label: "Classic canvas",
									description:
										"Interactive React Flow story-network graph with drag, context menus.",
								},
								{
									label: "Ruler timeline",
									description: "Linear chronological view of chapters.",
									selected: true,
								},
							],
							answer: "Answer: Ruler timeline",
						},
					],
				},
			},
		],
	},
};
const TOOL_CALL_BASH: ToolCallData = {
	toolName: "bash",
	summary: "bun test frontend/components/narrator/vlist/",
	category: "bash",
	status: "success",
	detail: classifyToolDetail({
		previewId: "vlist-harness-bash",
		toolName: "Bash",
		category: "bash",
		status: "success",
		inputJson: { command: "bun test frontend/components/narrator/vlist/" },
		outputJson: { _text: "1 pass\n2 pass\n3 pass\n4 pass\n5 pass\n6 pass" },
	}),
};
const TOOL_CALL_GROUP: ToolCallData[] = [
	{ toolName: "read", summary: "measure-tool-call.ts", category: "read", status: "success" },
	{ toolName: "read", summary: "measure-tool-run.ts", category: "read", status: "success" },
	{ toolName: "read", summary: "measure-subagent.ts", category: "read", status: "success" },
];

const ACTIVITY_ITEMS: ActivityTraceItem[] = [
	{ title: "read registry.ts", hasIcon: true, iconColor: "lime" },
	{ title: "read measure-markdown.ts", hasIcon: true, iconColor: "lime" },
	{ title: "grep measureElement", hasIcon: true, iconColor: "cyan" },
	{ title: "edit VListHarness.tsx", hasIcon: true, iconColor: "violet" },
	{ title: "bash bun test", hasIcon: true, iconColor: "orange" },
	{ title: "bash bunx tsgo --noEmit", hasIcon: true, iconColor: "orange" },
];
const REASONING_STEPS: ReasoningStepItem[] = [
	{
		title: "Inspect the measure signatures",
		body: "Each `measure-*.ts` returns a `MeasuredElement` (or a superset) with a `height` and `blocks`/`frame`.",
	},
	{ title: "Map RenderXxx props" },
	{ title: "Assemble the harness cases" },
];

const SUBAGENT_DATA: SubagentCardData = {
	agentType: "explore",
	model: "haiku",
	reasoningEffort: "high",
	description:
		"Investigate how the pretext vlist measures wrapped line counts across the element family and summarise the shared constants.",
	prompt:
		"Explore the vlist measure layer and report the per-element height model, noting which parts are fixed vs pretext-measured.",
	resultText:
		"There are 21 element kinds. Shared font/size constants live in `pretext-fonts.ts`; each element adds fixed chrome + Σ(line count × line box).",
	isTerminal: true,
	recentCallCount: 2,
	hasRecentCallsButton: true,
	promptOpen: true,
};
const subagentDetail = classifyToolDetail({
	previewId: "vlist-harness-subagent",
	toolName: "Agent",
	category: "agent",
	status: "success",
	inputJson: { prompt: SUBAGENT_DATA.prompt },
	outputJson: { _text: SUBAGENT_DATA.resultText },
});
for (const section of subagentDetail?.sections ?? []) {
	if (section.body.kind !== "capped") continue;
	if (section.body.source === "input.prompt") SUBAGENT_DATA.promptBody = section.body;
	if (section.body.source === "output.main") SUBAGENT_DATA.resultBody = section.body;
}
const SUBAGENT_RECENT_CALLS = ["read registry.ts", "grep measureElement"];

// ─────────────────────────────────────────────────────────────────────────────
// Cases. Markdown parity (ground truth) first; every other element is a preview.
// ─────────────────────────────────────────────────────────────────────────────

const HARNESS_CASES: HarnessCase[] = [
	// ── Markdown (DOM ground truth) ──────────────────────────────────────────
	{
		id: "markdown-basic",
		label: "Markdown (headings/list/code/quote) @600px",
		width: 600,
		renderActual: (width) => <MarkdownActual width={width} md={SAMPLE_MD} />,
		predict: (width) => measureMarkdown(SAMPLE_MD, width).height,
		renderPredicted: (width) => <RenderMarkdown measured={measureMarkdown(SAMPLE_MD, width)} />,
	},
	{
		id: "markdown-narrow",
		label: "Markdown wrapping stress @320px",
		width: 320,
		renderActual: (width) => <MarkdownActual width={width} md={SAMPLE_MD} />,
		predict: (width) => measureMarkdown(SAMPLE_MD, width).height,
		renderPredicted: (width) => <RenderMarkdown measured={measureMarkdown(SAMPLE_MD, width)} />,
	},

	// ── GFM table (DOM ground truth for layoutTable's column solve) ───────────
	// Two widths on purpose: the wide case has slack to distribute, the narrow one
	// forces cells to wrap and is where a rounding-recovery bug shows up as an
	// off-by-one-row height.
	{
		id: "markdown-table",
		label: "Markdown table @600px",
		width: 600,
		renderActual: (width) => <MarkdownActual width={width} md={SAMPLE_TABLE_MD} />,
		predict: (width) => measureMarkdown(SAMPLE_TABLE_MD, width).height,
		renderPredicted: (width) => (
			<RenderMarkdown measured={measureMarkdown(SAMPLE_TABLE_MD, width)} />
		),
	},
	{
		id: "markdown-table-narrow",
		label: "Markdown table @320px (cells wrap; column rounding recovery)",
		width: 320,
		renderActual: (width) => <MarkdownActual width={width} md={SAMPLE_TABLE_MD} />,
		predict: (width) => measureMarkdown(SAMPLE_TABLE_MD, width).height,
		renderPredicted: (width) => (
			<RenderMarkdown measured={measureMarkdown(SAMPLE_TABLE_MD, width)} />
		),
	},

	// ── LaTeX (DOM ground truth for katex-geometry) ───────────────────────────
	// Note: math is only measured once KaTeX has loaded. Reload the harness if the
	// first paint shows source text instead of formulas.
	{
		id: "markdown-math",
		label: "LaTeX inline + display @600px",
		width: 600,
		renderActual: (width) => <MarkdownActual width={width} md={SAMPLE_MATH_MD} />,
		predict: (width) => measureMarkdown(SAMPLE_MATH_MD, width).height,
		renderPredicted: (width) => (
			<RenderMarkdown measured={measureMarkdown(SAMPLE_MATH_MD, width)} />
		),
	},
	{
		id: "markdown-math-narrow",
		label: "LaTeX wrapping stress @320px (atoms must not split)",
		width: 320,
		renderActual: (width) => <MarkdownActual width={width} md={SAMPLE_MATH_MD} />,
		predict: (width) => measureMarkdown(SAMPLE_MATH_MD, width).height,
		renderPredicted: (width) => (
			<RenderMarkdown measured={measureMarkdown(SAMPLE_MATH_MD, width)} />
		),
	},

	// ── Message bubble (assistant / user) ────────────────────────────────────
	preview(
		{ id: "message-bubble-assistant", label: "Message bubble · assistant @600", width: 600 },
		(w) => measureMessageBubble({ role: "assistant", text: SAMPLE_MD }, w),
		// biome-ignore lint/a11y/useValidAriaRole: `role` is a domain prop (assistant/user), not an ARIA role
		(m) => <RenderMessageBubble role="assistant" measured={m} />,
	),
	preview(
		{ id: "message-bubble-user", label: "Message bubble · user @600", width: 600 },
		(w) => measureMessageBubble({ role: "user", text: SAMPLE_USER_TEXT, hasHeader: true }, w),
		(m) => (
			// biome-ignore lint/a11y/useValidAriaRole: `role` is a domain prop (assistant/user), not an ARIA role
			<RenderMessageBubble
				role="user"
				measured={m}
				hasHeader
				header={
					<Text size="xs" c="dimmed">
						You · 12:34
					</Text>
				}
			/>
		),
	),
	preview(
		{
			id: "message-bubble-command-collapsed",
			label: "Message bubble · slash command collapsed @600",
			width: 600,
		},
		(w) =>
			measureMessageBubble(
				{
					role: "user",
					text: SAMPLE_COMMAND_EXPANSION,
					commandText: SAMPLE_COMMAND_TEXT,
					hasHeader: true,
				},
				w,
			),
		(m) => (
			// biome-ignore lint/a11y/useValidAriaRole: `role` is a domain prop (assistant/user), not an ARIA role
			<RenderMessageBubble
				role="user"
				measured={m}
				hasHeader
				header={
					<Text size="xs" c="dimmed">
						You · 12:34
					</Text>
				}
			/>
		),
	),
	preview(
		{
			id: "message-bubble-command-expanded",
			label: "Message bubble · slash command expanded @600",
			width: 600,
		},
		(w) =>
			measureMessageBubble(
				{
					role: "user",
					text: SAMPLE_COMMAND_EXPANSION,
					commandText: SAMPLE_COMMAND_TEXT,
					hasHeader: true,
				},
				w,
				5,
				{ expanded: true },
			),
		(m) => (
			// biome-ignore lint/a11y/useValidAriaRole: `role` is a domain prop (assistant/user), not an ARIA role
			<RenderMessageBubble
				role="user"
				measured={m}
				hasHeader
				header={
					<Text size="xs" c="dimmed">
						You · 12:34
					</Text>
				}
			/>
		),
	),

	// ── Reasoning (collapsed / expanded / low-LOD count) ─────────────────────
	preview(
		{ id: "reasoning-collapsed", label: "Reasoning · collapsed (L4) @600", width: 600 },
		(w) => measureReasoning(REASONING_DATA, w, 4, {}),
		(m) => <RenderReasoning measured={m} />,
	),
	preview(
		{ id: "reasoning-expanded", label: "Reasoning · expanded (L4) @600", width: 600 },
		(w) => measureReasoning(REASONING_DATA, w, 4, { expanded: true }),
		(m) => <RenderReasoning measured={m} />,
	),
	preview(
		{ id: "reasoning-count", label: "Reasoning · count line (L2) @600", width: 600 },
		(w) => measureReasoning(REASONING_DATA, w, 2, {}),
		(m) => <RenderReasoning measured={m} />,
	),

	// ── Media (image / image_generation / text_file) ─────────────────────────
	preview(
		{ id: "media-image", label: "Media · image (fixed 200) @600", width: 600 },
		(w) => measureMedia(MEDIA_IMAGE, w),
		(m) => <RenderMedia measured={m} />,
	),
	preview(
		{ id: "media-image-generation", label: "Media · image_generation @600", width: 600 },
		(w) => measureMedia(MEDIA_IMAGE_GEN, w),
		(m) => <RenderMedia measured={m} />,
	),
	preview(
		{ id: "media-text-file", label: "Media · text_file chip @600", width: 600 },
		(w) => measureMedia(MEDIA_TEXT_FILE, w),
		(m) => <RenderMedia measured={m} />,
	),

	// ── Web search (completed / searching) ───────────────────────────────────
	preview(
		{ id: "web-search-done", label: "Web search · completed @600", width: 600 },
		(w) =>
			measureWebSearch(
				{
					query: "pretext canvas measureText line wrapping",
					status: "completed",
					label: "Searched",
				},
				w,
			),
		(m) => <RenderWebSearch measured={m} isSearching={false} />,
	),
	preview(
		{ id: "web-search-searching", label: "Web search · searching @360", width: 360 },
		(w) =>
			measureWebSearch(
				{
					query: "how does react-markdown wrap long inline code fragments in a narrow column",
					status: "searching",
					label: "Searching",
				},
				w,
			),
		(m) => <RenderWebSearch measured={m} isSearching />,
	),

	// ── System-simple (compact / merge / review / spec_continuation) ─────────
	...systemSimpleCase("compact", "System · compact indicator", {
		text: "Compacted 12 messages to save context",
		status: "compacted",
	}),
	...systemSimpleCase("merge_summary", "System · merge summary", {
		text: "Merged feature/pretext-vlist into trunk (14 files changed)",
		hasAvatar: true,
		color: "indigo",
	}),
	// review_feedback is no longer a system-simple card either: it wraps its findings and
	// carries an action button, so it lives in the system-text group below.
	// spec_continuation / spec_blocked_continuation are no longer system-simple cards:
	// the framed bubble draws them as a task row (RenderSpecTask). See measure-spec-task.

	// ── System-text (info / error / bash / spec_goal_added / carryover) ──────
	...systemTextCase("info", "System-text · info (multi-line)", {
		text: "Context restored from snapshot.\nWorking directory reset to the project root.",
	}),
	...systemTextCase("error", "System-text · error + actions", {
		text: "Command failed with exit code 1: module not found 'foo/bar' while resolving imports.",
		actions: true,
	}),
	...systemTextCase("bash_command", "System-text · bash command", {
		command:
			"bunx @biomejs/biome check --write frontend/components/narrator/vlist/VListHarness.tsx",
	}),
	...systemTextCase("spec_goal_added", "System-text · spec goal added", {
		text: "Implement a zero-DOM height model for every narrator list element",
		badges: ["protected", "added"],
		buttons: ["View tasks"],
		added: true,
		color: "indigo",
	}),
	...systemTextCase("spec_fork_carryover", "System-text · spec fork carryover", {
		text: "Carried over 3 protected tasks from the parent chapter's spec into this fork.",
		badges: ["Fork carryover"],
		buttons: ["View tasks", "Clear", "Reset"],
		variant: "fork",
		color: "indigo",
	}),

	// ── Review card ───────────────────────────────────────────────────────────
	// Its own element rather than a system-text case: the body is real markdown inside a
	// capped scroll box, so a long conclusion scrolls instead of growing the row.
	preview(
		{ id: "review-card", label: "Review card · changes requested @600", width: 600 },
		(w) =>
			measureReviewCard(
				{
					text: REVIEW_CONCLUSION_MD,
					verdictLabel: "Changes Requested",
					color: "orange",
					actionLabel: "Handle",
				},
				w,
			),
		(m) => (
			<RenderReviewCard
				measured={m}
				data={{ verdictLabel: "Changes Requested", color: "orange", actionLabel: "Handle" }}
			/>
		),
	),

	// ── Knowledge hint ────────────────────────────────────────────────────────
	preview(
		{ id: "knowledge-hint", label: "Knowledge hint · 3 entries @600", width: 600 },
		(w) => measureKnowledgeHint(KNOWLEDGE_HINT_DATA, w),
		(m) => <RenderSystemList measured={m} />,
	),

	// ── Plan card ─────────────────────────────────────────────────────────────
	preview(
		{ id: "plan-card", label: "Plan card @600", width: 600 },
		(w) => measurePlanCard({ summary: PLAN_CARD_MD, hasActions: false }, w),
		(m) => <RenderPlanCard measured={m} label="plan" />,
	),

	// ── Ask in passing (pending / resolved) ──────────────────────────────────
	preview(
		{ id: "ask-in-passing-pending", label: "Ask in passing · pending (fixed 77) @600", width: 600 },
		(w) => measureAskInPassing("pending", {}, w),
		(m) => <RenderAskInPassing kind="pending" measured={m} />,
	),
	preview(
		{ id: "ask-in-passing-resolved", label: "Ask in passing · resolved @600", width: 600 },
		(w) =>
			measureAskInPassing(
				"resolved",
				{ question: "Should the harness show a delta badge for preview-only elements?" },
				w,
			),
		(m) => <RenderAskInPassing kind="resolved" measured={m} />,
	),

	// ── Tool call (collapsed / expanded spec-tasks / expanded generic) ───────
	preview(
		{ id: "tool-call-collapsed", label: "Tool call · collapsed (L4) @600", width: 600 },
		(w) => measureToolCall(TOOL_CALL_READ, w, 4, { opened: false, isRecent: true }),
		(m) => <RenderToolCall measured={m} />,
	),
	preview(
		{ id: "tool-call-spec-tasks", label: "Tool call · expanded spec-tasks @600", width: 600 },
		(w) => measureToolCall(TOOL_CALL_TASKS, w, 5, { opened: true, isRecent: true }),
		(m) => <RenderToolCall measured={m} />,
	),
	preview(
		{ id: "tool-call-generic", label: "Tool call · expanded generic (capped) @600", width: 600 },
		(w) => measureToolCall(TOOL_CALL_BASH, w, 5, { opened: true, isRecent: true }),
		(m) => <RenderToolCall measured={m} />,
	),
	preview(
		{ id: "tool-call-ask", label: "Tool call · expanded ask replay @600", width: 600 },
		(w) => measureToolCall(TOOL_CALL_ASK, w, 5, { opened: true, isRecent: true }),
		(m) => <RenderToolCall measured={m} />,
	),

	// ── Tool call group (expanded, ×3 children) ──────────────────────────────
	preview(
		{ id: "tool-call-group", label: "Tool call group · expanded ×3 @600", width: 600 },
		(w) => measureToolCallGroup(TOOL_CALL_GROUP, w, 5, { expanded: true, isRecent: true }),
		(m) => (
			<RenderToolCallGroup measured={m} label="read ×3" statusColor="green" statusLabel="success" />
		),
	),

	// ── Tool-run trace family ─────────────────────────────────────────────────
	preview(
		{ id: "tool-run-count", label: "Tool run count line (L1/L2) @600", width: 600 },
		(w) => measureToolRunCountLine(12, w, { label: "Tool calls", count: "12 calls" }),
		(m) => <RenderTraceCountLine measured={m} />,
	),
	preview(
		{ id: "activity-trace-rows", label: "Activity trace · rows (L2) @600", width: 600 },
		(w) => measureActivityTrace(ACTIVITY_ITEMS, w, {}, { label: "Activity", count: "6" }),
		(m) => <RenderToolRun measured={m} />,
	),
	preview(
		{ id: "activity-trace-collapsed", label: "Activity trace · collapsed (L1) @600", width: 600 },
		(w) =>
			measureActivityTrace(
				ACTIVITY_ITEMS,
				w,
				{ collapsed: true, itemsOpened: false },
				{ label: "Activity", count: "6" },
			),
		(m) => <RenderToolRun measured={m} />,
	),
	preview(
		{ id: "reasoning-steps", label: "Reasoning steps trace (1 expanded) @600", width: 600 },
		(w) =>
			measureReasoningStepsTrace(
				REASONING_STEPS,
				w,
				{ expandedIndices: [0] },
				{ label: "Reasoning", count: "3 steps" },
			),
		(m) => <RenderToolRun measured={m} />,
	),
	preview(
		{ id: "reasoning-count", label: "Reasoning count line (L2) @600", width: 600 },
		(w) => measureReasoningCountLine(5, w, { label: "Reasoning", count: "5 steps" }),
		(m) => <RenderTraceCountLine measured={m} />,
	),

	// ── Ask user question banner (interactive / readOnly) ────────────────────
	preview(
		{ id: "ask-user-question", label: "Ask user question · interactive @420", width: 420 },
		(w) => measureAskUserQuestion(ASK_QUESTION_DATA, w),
		(m) => <RenderAskUserQuestion measured={m} />,
	),
	preview(
		{ id: "ask-user-question-readonly", label: "Ask user question · readOnly @420", width: 420 },
		(w) => measureAskUserQuestion(ASK_QUESTION_READONLY, w),
		(m) => <RenderAskUserQuestion measured={m} />,
	),

	// ── Inline permission (interactive / readOnly) ───────────────────────────
	preview(
		{ id: "inline-permission", label: "Inline permission · interactive @420", width: 420 },
		(w) => measureInlinePermission(INLINE_PERM_DATA, w, 5),
		(m) => <RenderInlinePermission measured={m} includeTopMargin={false} />,
	),
	preview(
		{ id: "inline-permission-readonly", label: "Inline permission · readOnly @420", width: 420 },
		(w) => measureInlinePermission(INLINE_PERM_READONLY, w, 5),
		(m) => <RenderInlinePermission measured={m} includeTopMargin={false} />,
	),

	// ── Subagent card (collapsed / expanded) ─────────────────────────────────
	preview(
		{ id: "subagent-collapsed", label: "Subagent card · collapsed (L4) @600", width: 600 },
		(w) => measureSubagentCard(SUBAGENT_DATA, w, 4, { opened: false, isRecent: true }),
		(m) => (
			<RenderSubagent
				measured={m}
				description={SUBAGENT_DATA.description}
				agentType={SUBAGENT_DATA.agentType}
				model={SUBAGENT_DATA.model}
				reasoningEffort={SUBAGENT_DATA.reasoningEffort}
				resultPreview={SUBAGENT_DATA.resultText}
				recentCallNames={SUBAGENT_RECENT_CALLS}
				isActive={false}
			/>
		),
	),
	preview(
		{ id: "subagent-expanded", label: "Subagent card · expanded (L4) @600", width: 600 },
		(w) => measureSubagentCard(SUBAGENT_DATA, w, 4, { opened: true, isRecent: true }),
		(m) => (
			<RenderSubagent
				measured={m}
				description={SUBAGENT_DATA.description}
				agentType={SUBAGENT_DATA.agentType}
				model={SUBAGENT_DATA.model}
				reasoningEffort={SUBAGENT_DATA.reasoningEffort}
				recentCallNames={SUBAGENT_RECENT_CALLS}
				isActive={false}
			/>
		),
	),

	// ── Prune divider ─────────────────────────────────────────────────────────
	preview(
		{ id: "prune-divider", label: "Prune divider @600", width: 600 },
		(w) => measurePruneDivider(w),
		(m) => <RenderPruneDivider measured={m} data={{ label: "Earlier context pruned" }} />,
	),
];

/** Build a system-simple preview case (single-line/clamped card). */
function systemSimpleCase(
	kind: SystemSimpleKind,
	label: string,
	data: SystemSimpleData,
	width = 600,
): HarnessCase[] {
	return [
		preview(
			{ id: `system-simple-${kind}`, label: `${label} @${width}`, width },
			(w) => measureSystemSimpleCard(kind, data, w),
			(m) => <RenderSystemSimple measured={m} />,
		),
	];
}

/** Build a system-text preview case (multi-line / pre-wrap card). */
function systemTextCase(
	kind: SystemTextKind,
	label: string,
	data: SystemTextData,
	width = 600,
): HarnessCase[] {
	return [
		preview(
			{ id: `system-text-${kind}`, label: `${label} @${width}`, width },
			(w) => measureSystemTextCard(kind, data, w),
			(m) => <RenderSystemText measured={m} kind={kind} data={data} />,
		),
	];
}

/** Renders real markdown DOM for ground-truth measurement.
 * NOTE: imported lazily to avoid pulling MarkdownContent into the prod bundle
 * of the vlist path (and to keep the isolation guard green). */
function MarkdownActual({ width, md }: { width: number; md: string }) {
	// Lazy require to keep the harness self-contained; MarkdownContent is heavy.
	const [Comp, setComp] = useState<ComponentType<{ text: string }> | null>(null);
	useLayoutEffect(() => {
		let alive = true;
		void import("../markdown/MarkdownContent").then((m) => {
			if (alive) setComp(() => m.MarkdownContent as ComponentType<{ text: string }>);
		});
		return () => {
			alive = false;
		};
	}, []);
	return <Box style={{ width }}>{Comp ? <Comp text={md} /> : <Text size="sm">loading…</Text>}</Box>;
}

interface GroundTruthReport {
	label: string;
	width: number;
	predicted: number;
	actual: number;
	delta: number;
}

interface PreviewOverflowReport {
	label: string;
	overflowPx: number;
}

function CaseRow({
	testCase,
	onGroundTruth,
	onPreviewOverflow,
}: {
	testCase: HarnessCase;
	onGroundTruth?: (report: GroundTruthReport) => void;
	onPreviewOverflow?: (report: PreviewOverflowReport) => void;
}) {
	const actualRef = useRef<HTMLDivElement>(null);
	const predictedRef = useRef<HTMLDivElement>(null);
	const [actualHeight, setActualHeight] = useState<number | null>(null);
	const [overflowPx, setOverflowPx] = useState<number | null>(null);
	const predicted = testCase.predict(testCase.width);
	const hasGroundTruth = testCase.hasGroundTruth !== false && testCase.renderActual != null;

	// The single allowed DOM measurement — harness calibration only, and only for
	// ground-truth cases (preview cases have no DOM baseline).
	useLayoutEffect(() => {
		if (!hasGroundTruth) return;
		const node = actualRef.current;
		if (!node) return;
		const measure = () => {
			const actual = node.getBoundingClientRect().height;
			setActualHeight(actual);
			onGroundTruth?.({
				label: testCase.label,
				width: testCase.width,
				predicted: Math.round(predicted),
				actual: Math.round(actual),
				delta: Math.abs(Math.round(actual) - Math.round(predicted)),
			});
		};
		const ro = new ResizeObserver(measure);
		ro.observe(node);
		measure();
		return () => ro.disconnect();
	}, [hasGroundTruth, onGroundTruth, predicted, testCase.label, testCase.width]);

	// Preview-only diagnostic: detect descendants that actually paint past the
	// predicted dashed box. Ignore the known 1px border/subpixel rounding fringe.
	useLayoutEffect(() => {
		if (hasGroundTruth) return;
		const node = predictedRef.current;
		if (!node) return;
		const measure = () => {
			const bounds = node.getBoundingClientRect();
			let maxRight = bounds.left;
			let maxBottom = bounds.top;
			for (const child of node.querySelectorAll("*")) {
				const rect = child.getBoundingClientRect();
				maxRight = Math.max(maxRight, rect.right);
				maxBottom = Math.max(maxBottom, rect.bottom);
			}
			const rawOverflow = Math.max(maxRight - bounds.right, maxBottom - bounds.bottom);
			const nextOverflow = Math.max(0, Math.ceil(rawOverflow - 1));
			setOverflowPx(nextOverflow);
			onPreviewOverflow?.({ label: testCase.label, overflowPx: nextOverflow });
		};
		const ro = new ResizeObserver(measure);
		ro.observe(node);
		measure();
		return () => ro.disconnect();
	}, [hasGroundTruth, onPreviewOverflow, testCase.label]);

	// Compare the same integer pixel quantities shown in the badges. Browser
	// layout may expose fractional subpixels (e.g. 313.6px), but the vlist
	// contract and the calibration display are integer CSS pixels.
	const delta =
		hasGroundTruth && actualHeight != null
			? Math.abs(Math.round(actualHeight) - Math.round(predicted))
			: null;
	const matched = delta != null && delta <= MATCH_TOLERANCE;

	return (
		<Stack gap={4} p="sm" style={{ border: "1px solid var(--mantine-color-dark-4)" }}>
			<Group justify="space-between">
				<Text fw={600} size="sm">
					{testCase.label}
				</Text>
				<Group gap={6}>
					<Badge size="xs" color="gray">
						w={testCase.width}
					</Badge>
					<Badge size="xs" color="blue">
						predicted {Math.round(predicted)}
					</Badge>
					{hasGroundTruth ? (
						<Badge size="xs" color="grape">
							actual {actualHeight != null ? Math.round(actualHeight) : "…"}
						</Badge>
					) : (
						<Badge size="xs" color="gray" variant="outline">
							preview
						</Badge>
					)}
					{delta != null ? (
						<Badge size="xs" color={matched ? "green" : "red"}>
							Δ {Math.round(delta)}px
						</Badge>
					) : null}
					{!hasGroundTruth && overflowPx != null ? (
						<Badge size="xs" color={overflowPx === 0 ? "green" : "red"}>
							{overflowPx === 0 ? "overflow pass" : `overflow ${overflowPx}px`}
						</Badge>
					) : null}
				</Group>
			</Group>
			<Group align="flex-start" gap="md" grow>
				{hasGroundTruth ? (
					<Box>
						<Text size="xs" c="dimmed" mb={4}>
							actual (DOM)
						</Text>
						<div ref={actualRef}>{testCase.renderActual?.(testCase.width)}</div>
					</Box>
				) : null}
				<Box>
					<Text size="xs" c="dimmed" mb={4}>
						{hasGroundTruth
							? "predicted (pretext)"
							: "predicted render (pretext · no DOM baseline)"}
					</Text>
					<Box
						ref={predictedRef}
						style={{
							width: testCase.width,
							height: predicted,
							border: "1px dashed var(--mantine-color-blue-7)",
						}}
					>
						{testCase.renderPredicted(testCase.width)}
					</Box>
				</Box>
			</Group>
		</Stack>
	);
}

/**
 * The harness surface. Mount behind a dev/hidden entry; never in the prod list.
 */
export function VListHarness() {
	// Math predictions require the lazily-loaded KaTeX runtime (in the app this is
	// awaited by the document coordinator). Load it up front and re-render once it
	// lands, otherwise the LaTeX cases would compare source text against formulas.
	const [katexReady, setKatexReady] = useState(() => isKatexReady());
	useEffect(() => {
		if (katexReady) return;
		let alive = true;
		void ensureKatexLoaded(SAMPLE_MATH_MD).then(() => {
			if (alive) setKatexReady(isKatexReady());
		});
		return () => {
			alive = false;
		};
	}, [katexReady]);
	const [reports, setReports] = useState<Record<string, GroundTruthReport>>({});
	const [previewOverflows, setPreviewOverflows] = useState<Record<string, PreviewOverflowReport>>(
		{},
	);
	const [copyStatus, setCopyStatus] = useState<string | null>(null);
	const [fallbackReport, setFallbackReport] = useState<string | null>(null);
	const handleGroundTruth = useCallback((report: GroundTruthReport) => {
		setReports((current) => {
			const key = `${report.label}:${report.width}`;
			const previous = current[key];
			if (
				previous?.actual === report.actual &&
				previous.predicted === report.predicted &&
				previous.delta === report.delta
			) {
				return current;
			}
			return { ...current, [key]: report };
		});
	}, []);
	const handlePreviewOverflow = useCallback((report: PreviewOverflowReport) => {
		setPreviewOverflows((current) => {
			const previous = current[report.label];
			if (previous?.overflowPx === report.overflowPx) return current;
			return { ...current, [report.label]: report };
		});
	}, []);
	const previewRows = Object.values(previewOverflows).sort((a, b) =>
		a.label.localeCompare(b.label),
	);
	const overflowingRows = previewRows.filter((row) => row.overflowPx > 0);
	const expectedPreviewCount = HARNESS_CASES.filter(
		(testCase) => testCase.hasGroundTruth === false || testCase.renderActual == null,
	).length;
	const overflowStatus =
		previewRows.length < expectedPreviewCount
			? `PENDING (${previewRows.length}/${expectedPreviewCount})`
			: overflowingRows.length === 0
				? `PASS (${previewRows.length}/${expectedPreviewCount})`
				: `FAIL (${overflowingRows.length}/${expectedPreviewCount})`;
	const reportText = [
		"vlist height calibration report",
		...Object.values(reports)
			.sort((a, b) => a.label.localeCompare(b.label))
			.map(
				(row) =>
					`- ${row.label}: predicted=${row.predicted}px actual=${row.actual}px Δ=${row.delta}px`,
			),
		`- preview overflow: ${overflowStatus}`,
		...overflowingRows.map((row) => `  - ${row.label}: overflow=${row.overflowPx}px`),
	].join("\\n");
	const copyReport = useCallback(async () => {
		if (Object.keys(reports).length === 0) {
			setCopyStatus("等待 DOM 测量");
			return;
		}
		try {
			await navigator.clipboard.writeText(reportText);
			setFallbackReport(null);
			setCopyStatus("已复制");
		} catch {
			setFallbackReport(reportText);
			setCopyStatus("复制失败，请手动选择下方文本");
		}
	}, [reportText, reports]);

	return (
		<Stack gap="md" p="md">
			<Group justify="space-between" align="center">
				<Text fw={700}>vlist height calibration harness</Text>
				<Group gap="xs">
					<Button size="xs" variant="light" onClick={copyReport}>
						复制校准摘要
					</Button>
					{copyStatus ? (
						<Text size="xs" c="dimmed">
							{copyStatus}
						</Text>
					) : null}
				</Group>
			</Group>
			{fallbackReport ? (
				<Box component="pre" style={{ userSelect: "text", whiteSpace: "pre-wrap", margin: 0 }}>
					{fallbackReport}
				</Box>
			) : null}
			{katexReady ? null : (
				<Text size="xs" c="yellow">
					KaTeX 尚未加载完成，LaTeX 用例的预测值暂时按源文本计算。
				</Text>
			)}
			<Text size="sm" c="dimmed">
				Markdown cases show real DOM (left) vs pretext-predicted (right); green Δ means the
				prediction matches within {MATCH_TOLERANCE}px. Every other element is a preview: it has no
				lightweight DOM ground truth (the source components are heavy + break the vlist isolation
				guard), so only the RenderXxx(measured) copy is shown inside its predicted-height box —
				eyeball whether the rendered copy fills the dashed box.
			</Text>
			{HARNESS_CASES.map((c) => (
				<CaseRow
					key={c.id}
					testCase={c}
					onGroundTruth={handleGroundTruth}
					onPreviewOverflow={handlePreviewOverflow}
				/>
			))}
		</Stack>
	);
}

export { HARNESS_CASES, type HarnessCase };
