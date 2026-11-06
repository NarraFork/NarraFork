/**
 * Browser fixture for the outline tool cards (`outline-tool-cards.browser.test.ts`): OutlineEdit
 * (a change list, a legacy row without `display`, decisions, a held change, a failed call),
 * OutlineRead, OutlineSearch, Ask (questions, withdrawn, written down) and an answer delivered
 * back to the asking session, through the real segment → adapter → measure → render chain with
 * the shell's zh-CN labels, laid out by Chromium. It reports each card's measured height beside
 * the height the browser gave it, and anything that reaches into a card's padding, so the test
 * can hold the measure pass to what is painted at any typography the reader chose.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { setTypography } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { OutlineOpenerProvider } from "../../../lib/outline-opener";
import zhChat from "../../../locales/zh-CN/chat.json";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import { ImageViewerProvider } from "../../common/ImageViewerProvider";
import { segmentMessages } from "../message/message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { getCategory, getCategoryColor, getSummary } from "../tool-call/tool-display";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "./segment-adapter";
import { useVListLabels } from "./useVListLabels";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "zh-CN",
	fallbackLng: "zh-CN",
	defaultNS: "narrator",
	ns: ["narrator", "chat", "common"],
	resources: { "zh-CN": { narrator: zhNarrator, chat: zhChat, common: zhCommon } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

const K = "MTBXwl1Y";
const TASK = "LUwB3JZb";
const TASK_TITLE = "修复：排查中断后无重试按钮（只读，不改代码）";
const SPACE = { key: K, kind: "session" };
let seq = 0;
const at = () => `2026-11-03T09:${String(10 + (seq++ % 40)).padStart(2, "0")}:00.000Z`;

function tool(
	name: string,
	input: unknown,
	text: string,
	metadata: unknown,
	status = "completed",
): NarratorMsg {
	const outputJson = { _text: text, _metadata: metadata };
	const id = `a-${name}-${seq}`;
	return rowWithElements(
		{
			id,
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [
				{
					toolUseId: `tu-${id}`,
					toolName: name,
					inputJson: input,
					outputJson,
					status,
					...(status === "error" ? { errorMessage: text } : {}),
				},
			],
			createdAt: at(),
		},
		[
			{
				type: "tool_use",
				id: `tu-${id}`,
				name,
				input,
				inputJson: input,
				outputJson,
				status,
			},
		],
	) as unknown as NarratorMsg;
}

function userInjection(source: string, modelText: string, body?: unknown): NarratorMsg {
	return rowWithElements(
		{
			id: `u-${seq}`,
			narratorId: "n1",
			role: "user",
			origin: "user",
			createdAt: at(),
			creator: { id: "u-alice", username: "alice", displayName: "alice" },
		},
		[{ type: "system_injection", source, modelText, ...(body ? { body } : {}) }] as never,
	) as unknown as NarratorMsg;
}

// ── OutlineEdit: add three notes under the task and tick it (the owner's screenshot) ──
const EDIT_INPUT = {
	edits: [
		{
			add: TASK,
			markdown:
				"- 已提交并推送 fix/retry-after-interrupt（3 个文件，+42 −7），CI 绿\n- 根因：中断后 `status` 停在 `aborted`，重试按钮只在 `failed` 时显示\n- 回归测试放在 narrator-retry.test.ts",
		},
		{ set: TASK, checkbox: "x" },
	],
};
const EDIT_TEXT = `Committed #6 to ${K} · this session's notes (2 edits; it can be reverted as one commit).
1. added under [${TASK}] ${TASK_TITLE}:
  - [RQvana8Z] 已提交并推送 fix/retry-after-interrupt（3 个文件，+42 −7），CI 绿
  - [AEguaeis] 根因：中断后 status 停在 aborted，重试按钮只在 failed 时显示
  - [FrhoTICE] 回归测试放在 narrator-retry.test.ts
2. set [${TASK}]: [x]`;
const EDIT_META_LEGACY = {
	tool: "OutlineEdit",
	space: SPACE,
	commit: { id: "c6", seq: 6 },
	edits: [
		{ op: "add", created: [`${K}/RQvana8Z`, `${K}/AEguaeis`, `${K}/FrhoTICE`] },
		{ op: "set", address: `${K}/${TASK}` },
	],
	notes: 0,
};
const TASK_REF = { address: `${K}/${TASK}`, title: TASK_TITLE };
const EDIT_META = {
	...EDIT_META_LEGACY,
	display: {
		v: 1,
		space: { key: K, kind: "session", own: true },
		ops: [
			{
				op: "add",
				parent: TASK_REF,
				created: [
					{
						address: `${K}/RQvana8Z`,
						title: "已提交并推送 fix/retry-after-interrupt（3 个文件，+42 −7），CI 绿",
						depth: 0,
					},
					{
						address: `${K}/AEguaeis`,
						title: "根因：中断后 status 停在 aborted，重试按钮只在 failed 时显示",
						depth: 0,
					},
					{ address: `${K}/FrhoTICE`, title: "回归测试放在 narrator-retry.test.ts", depth: 0 },
				],
			},
			{ op: "set", target: TASK_REF, status: { from: "doing", to: "done" } },
		],
	},
};

// ── OutlineEdit: every other kind of change, one of them held for confirmation ──
const MIXED_INPUT = {
	edits: [
		{ move: "Qp93LkaA", to: "qZQGaQCV" },
		{ replace: "AEguaeis", text: "根因：中断后 status 停在 aborted，重试按钮只在 failed 时显示" },
		{ delete: "Old9Plan" },
		{ set: "Qp93LkaA", assignee: "agent:review-1" },
		{ set: TASK, alias: "Q?" },
		{ add: "Rel2v2Pl", markdown: "- [ ] 灰度 10%" },
	],
};
const MIXED_TEXT = "Committed #7 to MTBXwl1Y · this session's notes (6 edits; …).";
const MIXED_META = {
	tool: "OutlineEdit",
	space: SPACE,
	commit: { id: "c7", seq: 7 },
	edits: [
		{ op: "move", address: `${K}/Qp93LkaA` },
		{ op: "replace", address: `${K}/AEguaeis` },
		{ op: "delete", address: `${K}/Old9Plan` },
		{ op: "set", address: `${K}/Qp93LkaA` },
		{ op: "set", address: `${K}/${TASK}` },
		{ op: "add", created: [`${K}/Gray10Pc`], pending: true },
	],
	merged: [`${K}/AEguaeis`],
	pending: "P1a2B3c4D",
	notes: 0,
	display: {
		v: 1,
		space: { key: K, kind: "session", own: true },
		ops: [
			{
				op: "move",
				target: { address: `${K}/Qp93LkaA`, title: "回归测试：中断后重试" },
				to: { address: `${K}/qZQGaQCV`, title: "排查记录" },
			},
			{
				op: "replace",
				target: {
					address: `${K}/AEguaeis`,
					title: "根因：中断后 status 停在 aborted，重试按钮只在 failed 时显示",
				},
				merged: true,
			},
			{
				op: "delete",
				target: { address: `${K}/Old9Plan`, title: "旧方案：轮询重试" },
				under: 4,
			},
			{
				op: "set",
				target: { address: `${K}/Qp93LkaA`, title: "回归测试：中断后重试" },
				assignee: { to: "agent:review-1" },
			},
			{ op: "set", target: TASK_REF, alias: { to: "Q7" } },
			{
				op: "add",
				parent: { address: `${K}/Rel2v2Pl`, title: "发布 v2" },
				created: [{ address: `${K}/Gray10Pc`, title: "灰度 10%", depth: 0, status: "todo" }],
				held: true,
			},
		],
		pending: { label: "P1a2B3c4D", decider: "alice" },
	},
};

const DECIDE_INPUT = { edits: [{ confirm: "P1a2B3c4D" }] };
const DECIDE_TEXT = '1. Confirmed P1a2B3c4D (proposed by session "重构"); it is committed as #9.';
const DECIDE_META = {
	tool: "OutlineEdit",
	decided: [{ confirm: "P1a2B3c4D", commit: { id: "c9", seq: 9 }, space: K }],
};

const FAILED_INPUT = { edits: [{ replace: "AEguaeis", text: "根因：……" }] };
const FAILED_TEXT = `Nothing was written.
- edit 1 (replace AEguaeis): someone else changed it after you read it: alice wrote #7 (you read #5). Read it again and redo the edit.`;

// ── OutlineRead / OutlineSearch ──
const READ_TEXT = `‹space ${K} · this session's notes · in 排查记录›
- [${TASK}] [x] ${TASK_TITLE}
  - [RQvana8Z] 已提交并推送 fix/retry-after-interrupt（3 个文件，+42 −7），CI 绿
  - [AEguaeis] 根因：中断后 \`status\` 停在 \`aborted\`，重试按钮只在 \`failed\` 时显示
  - [FrhoTICE] 回归测试放在 narrator-retry.test.ts`;
const READ_META = {
	tool: "OutlineRead",
	address: `${K}/${TASK}`,
	space: SPACE,
	view: "all",
	blocks: 4,
	hiddenByBudget: 0,
	hiddenByView: 0,
	truncated: false,
	title: TASK_TITLE,
	path: ["排查记录"],
	display: { v: 1, space: { key: K, kind: "session", own: true } },
};
const SEARCH_TEXT = `‹2 results for "重试" in ${K} · this session's notes›
- [${K}/Qp93LkaA] 回归测试：中断后重试
  in 排查记录 · a task
- [${K}/${TASK}] ${TASK_TITLE}
  in 排查记录 · a task`;
const SEARCH_META = {
	tool: "OutlineSearch",
	query: "重试",
	spaces: [K],
	resultCount: 2,
	results: [
		{
			address: `${K}/Qp93LkaA`,
			title: "回归测试：中断后重试",
			alias: null,
			path: ["排查记录"],
			snippet: "回归测试：中断后重试",
			process: true,
		},
		{
			address: `${K}/${TASK}`,
			title: TASK_TITLE,
			alias: "Q7",
			path: ["排查记录"],
			snippet: TASK_TITLE,
			process: true,
		},
	],
};

// ── Ask ──
const ASK_INPUT = {
	questions: [
		{
			question: "重试按钮放在哪里？",
			options: ["消息底部", "消息气泡右上角"],
			recommend: 2,
			reason: "和复制按钮放在一起",
			items: [{ question: "要不要同时修 Codex 通道？", recommend: "先只修 Anthropic" }],
		},
	],
};
const ASK_TEXT = `Asked alice 2 questions under [${TASK}] ${TASK_TITLE}: Q3 [Zx81aaQe], [Zx81aaQf].
[${TASK}] now waits for the answer, and continuation skips it: do the work it does not affect meanwhile.`;
const ASK_META = {
	tool: "Ask",
	space: SPACE,
	under: `${K}/${TASK}`,
	addresses: [`${K}/Zx81aaQe`, `${K}/Zx81aaQf`],
	to: "u-alice",
	proceed: false,
};
const WITHDRAW_INPUT = { withdraw: ["Q3"] };
const WITHDRAW_TEXT = `Withdrew ${K}/Zx81aaQe; the tasks they held up no longer wait for them.`;
const WITHDRAW_META = {
	tool: "Ask",
	withdrawn: ["blk-1"],
	display: {
		v: 1,
		questions: [{ address: `${K}/Zx81aaQe`, alias: "Q3", title: "重试按钮放在哪里？" }],
	},
};

// ── An answer delivered back to the asking session ──
const ANSWER_TEXT = `alice answered your questions in the outline:
- Q3 [${K}/Zx81aaQe] 重试按钮放在哪里？ → option 2 (消息气泡右上角), your recommendation
- [${K}/Zx81aaQf] 要不要同时修 Codex 通道？ → "先只修 Anthropic，Codex 下周"
Tasks that waited only for these can continue. Note the decisions under their tasks if they matter later.`;
const ANSWER_BODY = {
	kind: "outlineAnswers",
	by: "alice",
	items: [
		{
			address: `${K}/Zx81aaQe`,
			alias: "Q3",
			question: "重试按钮放在哪里？",
			answer: { option: 2, optionText: "消息气泡右上角", adopted: true },
		},
		{
			address: `${K}/Zx81aaQf`,
			question: "要不要同时修 Codex 通道？",
			answer: { text: "先只修 Anthropic，Codex 下周" },
		},
	],
};

// ── A project space with a long Latin name (its chip must not upper-case or crowd out the rest) ──
const PRJ = "Prj9Atlas";
const LONG_NAME = "NarraFork outline display polish and the long-named project space";
const LONG_READ_META = {
	tool: "OutlineRead",
	address: `${PRJ}/Ab3dEf9Q`,
	space: { key: PRJ, kind: "project" },
	blocks: 4,
	asOf: 5,
	truncated: true,
	title: "Retry design notes",
	path: ["Design", ""],
	display: { v: 1, space: { key: PRJ, kind: "project", name: LONG_NAME } },
};
const LONG_EDIT_META = {
	tool: "OutlineEdit",
	space: { key: PRJ, kind: "project" },
	commit: { id: "c3", seq: 3 },
	edits: [{ op: "set", address: `${PRJ}/Ab3dEf9Q` }],
	display: {
		v: 1,
		space: { key: PRJ, kind: "project", name: LONG_NAME },
		ops: [
			{
				op: "set",
				target: { address: `${PRJ}/Ab3dEf9Q`, title: "Retry design notes" },
				status: { from: null, to: "done" },
			},
		],
	},
};

// ── Answers to long questions (the answer must stay visible) ──
const LONG_QUESTION =
	"重试按钮放在哪里？如果放在消息气泡右上角，会不会和复制按钮挤在一起，手机上是否还点得到";
const LONG_ANSWER_BODY = {
	kind: "outlineAnswers",
	by: "alice",
	items: [
		{
			address: `${K}/Zx81aaQe`,
			alias: "Q3",
			question: LONG_QUESTION,
			answer: { option: 2, optionText: "消息气泡右上角", adopted: true },
			differs: true,
		},
		{
			address: `${K}/Zx81aaQf`,
			question: LONG_QUESTION,
			answer: { text: "先只修 Anthropic，Codex 下周" },
		},
	],
};

export const SCENES: Record<string, () => NarratorMsg[]> = {
	edit: () => [
		tool("OutlineEdit", EDIT_INPUT, EDIT_TEXT, EDIT_META),
		tool("OutlineEdit", MIXED_INPUT, MIXED_TEXT, MIXED_META),
		tool("OutlineEdit", DECIDE_INPUT, DECIDE_TEXT, DECIDE_META),
		tool("OutlineEdit", FAILED_INPUT, FAILED_TEXT, { tool: "OutlineEdit", commit: null }, "error"),
	],
	legacy: () => [
		tool("OutlineEdit", EDIT_INPUT, EDIT_TEXT, EDIT_META_LEGACY),
		tool("OutlineEdit", MIXED_INPUT, MIXED_TEXT, { ...MIXED_META, display: undefined }),
		tool("OutlineEdit", DECIDE_INPUT, DECIDE_TEXT, {
			tool: "OutlineEdit",
			decided: [{ confirm: "P1a2B3c4D", commit: { id: "c9", seq: 9 } }],
		}),
		userInjection("outline_answer", ANSWER_TEXT),
	],
	reads: () => [
		tool("OutlineRead", { address: TASK, view: "all" }, READ_TEXT, READ_META),
		tool("OutlineSearch", { query: "重试" }, SEARCH_TEXT, SEARCH_META),
	],
	ask: () => [
		tool("Ask", ASK_INPUT, ASK_TEXT, ASK_META),
		tool("Ask", WITHDRAW_INPUT, WITHDRAW_TEXT, WITHDRAW_META),
		tool(
			"Ask",
			{ answered: [{ question: "Q4", option: 1 }] },
			`Wrote down the answer to ${K}/Zx81aaQg as the person's (relayed from this conversation); the tasks they held up no longer wait for them.`,
			{ tool: "Ask", relayed: ["blk-2"] },
		),
		userInjection("outline_answer", ANSWER_TEXT, ANSWER_BODY),
	],
	longspace: () => [
		tool("OutlineRead", { address: "Ab3dEf9Q", asOf: 5 }, READ_TEXT, LONG_READ_META),
		tool(
			"OutlineEdit",
			{ edits: [{ set: "Ab3dEf9Q", checkbox: "x" }] },
			"Committed #3",
			LONG_EDIT_META,
		),
	],
	answers: () => [userInjection("outline_answer", ANSWER_TEXT, LONG_ANSWER_BODY)],
};

export interface FixtureOptions {
	scene: string;
	width: number;
	scheme: "light" | "dark";
	/** Tool cards open (their detail shown). */
	expanded: boolean;
	/** The raw input / model result fold of each outline card open. */
	rawOpen?: boolean;
	lod?: 4 | 5;
	fontScalePercent?: number;
	lineHeightScalePercent?: number;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let root: Root | null = null;

function Scene({ options }: { options: FixtureOptions }) {
	const { adapterLabels, renderLabels } = useVListLabels();
	const lod = options.lod ?? 5;
	const ctx: AdapterContext = {
		lod,
		labels: adapterLabels,
		resolveToolCategory: getCategory,
		resolveToolColor: (n: string, i?: unknown) => getCategoryColor(getCategory(n, i)),
		resolveToolSummary: (tc) => {
			const call = tc as {
				toolName: string;
				inputJson?: unknown;
				outputJson?: unknown;
				status?: string;
			};
			const meta = (call.outputJson as { _metadata?: Record<string, unknown> } | undefined)
				?._metadata;
			// As the shell's resolver does for outline calls: their status rides along.
			return getSummary(
				call.toolName,
				call.inputJson,
				{ ...meta, _toolStatus: call.status },
				adapterLabels,
			);
		},
		isExpanded: () => options.expanded,
		isPromptOpen: () => options.rawOpen === true,
	};
	seq = 0;
	const messages = (SCENES[options.scene] ?? (() => []))();
	const specs = adaptSegments(segmentMessages(messages) as unknown as AdapterSegment[], ctx);
	return (
		<div
			id="shot"
			style={{
				width: options.width,
				boxSizing: "content-box",
				display: "flex",
				flexDirection: "column",
				gap: 10,
				padding: 16,
				background: "var(--mantine-color-body)",
			}}
		>
			{specs.map((spec) => {
				const entry = VLIST_REGISTRY[spec.kind];
				if (!entry) return <div key={spec.key}>?? {spec.kind}</div>;
				const measured = entry.measure(spec.data as never, options.width, lod, spec.opts as never);
				const extra = resolveRenderExtra(spec) as Record<string, unknown>;
				extra.narratorId = "n1";
				extra.onToggle = () => {};
				extra.onTogglePrompt = () => {};
				if (spec.kind === "tool-call") extra.labels = renderLabels.toolCall;
				return (
					<div
						key={spec.key}
						data-card=""
						data-kind={spec.kind}
						data-measured={measured.height}
						style={{ position: "relative", height: measured.height, width: options.width }}
					>
						{renderElement(spec.kind, measured, extra as never)}
					</div>
				);
			})}
		</div>
	);
}

/** Render a scene at these options; resolves once painted. */
export async function render(options: FixtureOptions): Promise<void> {
	setTypography({
		fontScalePercent: options.fontScalePercent ?? 100,
		lineHeightScalePercent: options.lineHeightScalePercent ?? 100,
	});
	const host = document.getElementById("root") as HTMLElement;
	root?.unmount();
	root = createRoot(host);
	root.render(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme={options.scheme}>
					<ImageViewerProvider>
						<OutlineOpenerProvider value={{ open: () => true }}>
							<Scene options={options} />
						</OutlineOpenerProvider>
					</ImageViewerProvider>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	await new Promise((resolve) => setTimeout(resolve, 50));
}

export interface CardReport {
	kind: string;
	measured: number;
	/** The painted card's own box (its first child: the paper the renderer draws), to 0.1px. */
	painted: number;
	/** Content height inside it: more than `painted` means something spills past the box. */
	content: number;
	/** How far any element reaches past the card's content box, into its padding or beyond. */
	spill: number;
	scrollWidth: number;
	width: number;
	text: string;
	/** Change rows: how far any child of a row reaches past that row's box (px). */
	rowOverflow: number;
	/** Change rows drawn, and their link texts. */
	rows: number;
	links: string[];
	/** Chips whose text the browser upper-cased. */
	upperChips: string[];
	/** Chips not fully visible: clipped by their row (pushed onto a hidden line, or cut). */
	hiddenChips: string[];
	/** Answer rows (a question's answer, under it): their text and visible width (px). */
	answers: Array<{ text: string; width: number }>;
	/** The folded line's tail (an answer): its visible width and its text's full width (px). */
	tail: { width: number; full: number } | null;
}

export function report(): CardReport[] {
	return Array.from(document.querySelectorAll<HTMLElement>("[data-card]")).map((card) => {
		const paper = card.firstElementChild as HTMLElement | null;
		let spill = 0;
		if (paper) {
			const box = paper.getBoundingClientRect();
			const style = getComputedStyle(paper);
			const top =
				box.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
			const bottom =
				box.bottom -
				Number.parseFloat(style.borderBottomWidth) -
				Number.parseFloat(style.paddingBottom);
			for (const child of paper.querySelectorAll<HTMLElement>("*")) {
				const r = child.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				// What is visible of it: a capped body is a scroll box, and what runs past it is
				// clipped by it (that is what the box is for). Only what shows past the card counts.
				let visibleTop = r.top;
				let visibleBottom = r.bottom;
				for (let up = child.parentElement; up && up !== paper; up = up.parentElement) {
					if (getComputedStyle(up).overflowY === "visible") continue;
					const clip = up.getBoundingClientRect();
					visibleTop = Math.max(visibleTop, clip.top);
					visibleBottom = Math.min(visibleBottom, clip.bottom);
				}
				if (visibleBottom <= visibleTop) continue;
				spill = Math.max(spill, top - visibleTop, visibleBottom - bottom);
			}
		}
		let rowOverflow = 0;
		const rows = card.querySelectorAll<HTMLElement>("[data-outline-change-row]");
		for (const line of rows) {
			const box = line.getBoundingClientRect();
			for (const child of line.querySelectorAll<HTMLElement>("*")) {
				const r = child.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				rowOverflow = Math.max(rowOverflow, box.top - r.top, r.bottom - box.bottom);
			}
		}
		const hiddenChips: string[] = [];
		for (const badge of card.querySelectorAll<HTMLElement>(".mantine-Badge-root")) {
			const r = badge.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			let left = r.left;
			let right = r.right;
			let top = r.top;
			let bottom = r.bottom;
			for (let up = badge.parentElement; up && up !== card; up = up.parentElement) {
				const style = getComputedStyle(up);
				if (style.overflowX === "visible" && style.overflowY === "visible") continue;
				const clip = up.getBoundingClientRect();
				left = Math.max(left, clip.left);
				right = Math.min(right, clip.right);
				top = Math.max(top, clip.top);
				bottom = Math.min(bottom, clip.bottom);
			}
			const label = badge.textContent ?? "";
			// Visible: its whole height, and its width (a chip that gives way is truncated by
			// design, so it only has to keep a few characters).
			const keeps = badge.title ? Math.min(r.width, 30) : r.width - 0.5;
			if (bottom - top < r.height - 0.5 || right - left < keeps) hiddenChips.push(label);
		}
		const answers = Array.from(card.querySelectorAll<HTMLElement>("[data-task-notice-row]"))
			.filter((row) => Number.parseFloat(getComputedStyle(row).paddingLeft) > 0)
			.map((row) => {
				const text = row.querySelector<HTMLElement>("[data-task-notice-task]");
				return {
					text: row.textContent ?? "",
					width: text ? Math.round(text.getBoundingClientRect().width) : 0,
				};
			});
		const tailNode = card.querySelector<HTMLElement>("[data-task-notice-tail]");
		const tail = tailNode
			? {
					width: Math.round(tailNode.getBoundingClientRect().width),
					full: Math.round(tailNode.scrollWidth),
				}
			: null;
		const upperChips: string[] = [];
		for (const badge of card.querySelectorAll<HTMLElement>(".mantine-Badge-root")) {
			const label = badge.textContent ?? "";
			if (/[a-z]/.test(label) && getComputedStyle(badge).textTransform === "uppercase")
				upperChips.push(label);
		}
		return {
			kind: card.dataset.kind ?? "",
			measured: Number(card.dataset.measured),
			// To a tenth of a pixel: a markdown body's measured height can be fractional.
			painted: paper ? Math.round(paper.getBoundingClientRect().height * 10) / 10 : 0,
			content: paper ? paper.scrollHeight : 0,
			spill: Math.round(spill * 10) / 10,
			scrollWidth: paper ? paper.scrollWidth : 0,
			width: paper ? paper.clientWidth : 0,
			text: card.textContent ?? "",
			rowOverflow: Math.round(rowOverflow * 10) / 10,
			rows: rows.length,
			links: Array.from(card.querySelectorAll<HTMLElement>("[data-outline-link]")).map(
				(a) => a.textContent ?? "",
			),
			upperChips,
			hiddenChips,
			answers,
			tail,
		};
	});
}
