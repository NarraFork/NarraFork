/**
 * Browser fixture for the transcript's task notices (`task-notice.browser.test.ts`): the turn-end
 * reminder, people's task changes, the interrupt guard, current-tasks updates (one with tasks
 * delegated to subagents) and tasks finished elsewhere, through the real
 * adapter → measure → render chain with the shell's zh-CN labels, laid out by Chromium. It reports
 * each card's measured height beside the height the browser actually gave it, so the test can
 * hold the measure pass to what is painted (at any typography the reader chose).
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { setTypography } from "@shared/pretext-layout/typography";
import i18next from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { OutlineOpenerProvider } from "../../../lib/outline-opener";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { type AdapterSegment, adaptSegment } from "./segment-adapter";
import { useVListLabels } from "./useVListLabels";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "zh-CN",
	fallbackLng: "zh-CN",
	defaultNS: "narrator",
	ns: ["narrator", "common"],
	resources: { "zh-CN": { narrator: zhNarrator, common: zhCommon } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

const K = "MTBXwl1Y";
let at = 0;

function row(blocks: unknown[]): AdapterSegment {
	at++;
	return {
		kind: "message",
		msg: rowWithElements(
			{
				id: `m${at}`,
				role: "sys",
				origin: "system",
				createdAt: `2026-11-03T09:${String(10 + at).padStart(2, "0")}:00.000Z`,
			},
			blocks as never,
		),
	};
}

const VIEW = {
	doing: [{ address: `${K}/Qp93LkaA`, title: "回归测试：中断后重试" }],
	waiting: [
		{ address: `${K}/Wa1tWa1t`, title: "等运维开通测试环境的访问权限，之后才能跑端到端用例" },
	],
	next: [{ address: `${K}/Zx81aaQe`, title: "写 PR 描述", humanCreated: true }],
	counts: { doing: 1, waiting: 1, todo: 3 },
};

/** Every notice the transcript shows, in its structured and its older form. */
function notices(): AdapterSegment[] {
	at = 0;
	return [
		row([
			{
				type: "system_injection",
				source: "outline_task_turn_end",
				modelText: "系统备注：…",
				body: {
					kind: "outlineTasks",
					variant: "turnEnd",
					items: [
						{
							address: `${K}/mSsl3Ccf`,
							title:
								"排查中断后无重试按钮（只读，不改代码），并确认 Codex 与 Anthropic 两个通道表现一致",
							status: "doing",
							humanCreated: true,
						},
					],
				},
			},
		]),
		row([
			{
				type: "system_injection",
				source: "outline_task_edit",
				modelText: "系统通知（不是用户发言）：…",
				body: {
					kind: "outlineTasks",
					variant: "edited",
					items: [
						{
							address: `${K}/mSsl3Ccf`,
							title: "排查中断后无重试按钮",
							by: "alice",
							humanCreated: true,
							locked: true,
							changes: [{ kind: "status", from: "doing", to: "done" }],
						},
						{
							address: `${K}/Qp93LkaA`,
							title: "回归测试：中断后重试",
							by: "bob",
							changes: [
								{ kind: "assigned", to: "agent:review-1" },
								{ kind: "rejected", status: "done", reason: "截图里还是旧按钮，请重新验证" },
							],
						},
					],
					more: 2,
				},
			},
		]),
		row([
			{
				type: "system_injection",
				source: "interrupt_task_guard",
				modelText: "刚才的运行被用户中断……",
				body: {
					kind: "tasks",
					variant: "current",
					taskBackend: "outline",
					tasks: [
						{ role: "doing", text: "修复重试按钮", ref: `${K}/mSsl3Ccf` },
						{ role: "blocked", text: "等权限", protected: true, ref: `${K}/Wa1tWa1t` },
					],
				},
			},
		]),
		row([
			{ type: "text", text: "Context updated: outline.tasks" },
			{
				type: "context_update",
				epochId: "e",
				changes: [],
				snapshotRef: "r",
				display: { "outline.tasks": VIEW },
			},
		]),
		row([
			{ type: "text", text: "Context updated: outline.tasks" },
			{
				type: "context_update",
				epochId: "e",
				changes: [],
				snapshotRef: "r",
				display: { "outline.tasks": null },
			},
		]),
		// Older rows: their prose, read as plain text.
		row([
			{
				type: "system_injection",
				source: "outline_task_turn_end",
				modelText: "x",
				body: {
					kind: "prose",
					text: `系统备注：\`${K}/mSsl3Ccf\` 排查中断后无重试按钮 仍是进行中；做完了就用 OutlineEdit 勾成 [x]。`,
				},
			},
		]),
		// Outline P2 PR 9b: the view with what the session's subagents are doing (「委派中」), and
		// the notice of tasks the session created that were finished elsewhere.
		row([
			{ type: "text", text: "Context updated: outline.tasks" },
			{
				type: "context_update",
				epochId: "e",
				changes: [],
				snapshotRef: "r",
				display: {
					"outline.tasks": {
						...VIEW,
						delegated: [
							{ address: `${K}/De1eGa7e`, title: "修复刷新令牌的竞态" },
							{ address: `${K}/De2eGa7e`, title: "给重试按钮补端到端用例" },
						],
						counts: { ...VIEW.counts, delegated: 2 },
					},
				},
			},
		]),
		row([
			{
				type: "system_injection",
				source: "outline_task_finished",
				modelText: "系统通知（不是用户发言）：…",
				body: {
					kind: "outlineTasks",
					variant: "finished",
					items: [
						{
							address: `${K}/mSsl3Ccf`,
							title: "排查中断后无重试按钮",
							by: "发布准备",
							changes: [{ kind: "status", from: "doing", to: "done" }],
						},
					],
					more: 2,
				},
			},
		]),
	];
}

export interface FixtureOptions {
	width: number;
	expanded: boolean;
	scheme: "light" | "dark";
	/** Typography the reader chose (percent). */
	fontScalePercent?: number;
	lineHeightScalePercent?: number;
}

let root: Root | null = null;

function Cards({ options }: { options: FixtureOptions }) {
	const { adapterLabels } = useVListLabels();
	const ctx = { lod: 5 as const, labels: adapterLabels, isExpanded: () => options.expanded };
	const specs = notices().flatMap((segment) => adaptSegment(segment, ctx));
	return (
		<div
			id="shot"
			style={{
				width: options.width,
				boxSizing: "content-box",
				padding: 16,
				display: "flex",
				flexDirection: "column",
				gap: 8,
				background: "var(--mantine-color-body)",
			}}
		>
			{specs.map((spec) => {
				const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, options.width, 5, spec.opts);
				const extra = resolveRenderExtra(spec) as Record<string, unknown>;
				extra.onToggle = () => {};
				// The interrupt guard's close button, as the shell wires it.
				if ((spec.data as { originLabel?: string }).originLabel === "interrupt_task_guard") {
					extra.injectionGuardActions = { onDismiss: () => {}, dismissLabel: "删除此提醒" };
				}
				return (
					<div
						key={spec.key}
						data-card=""
						data-measured={measured.height}
						data-kind={(spec.data as { kind?: string }).kind}
						style={{ position: "relative", width: options.width }}
					>
						{renderElement(spec.kind, measured, extra as never)}
					</div>
				);
			})}
		</div>
	);
}

/** Render every notice at these options; resolves once painted. */
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
			<MantineProvider forceColorScheme={options.scheme}>
				<OutlineOpenerProvider value={{ open: () => true }}>
					<Cards options={options} />
				</OutlineOpenerProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export interface CardReport {
	kind: string;
	measured: number;
	/** The painted card's own box. */
	painted: number;
	/** Content height inside it: more than `painted` means something spills past the box. */
	content: number;
	/**
	 * How far any element reaches past the card's content box, into its padding or beyond (px).
	 * `content` only sees what passes the padding too: a body pushed 9px down sits in the 10px
	 * padding with `content` still equal to `painted`.
	 */
	spill: number;
	/** Widths: the card's content may not be wider than the card. */
	scrollWidth: number;
	width: number;
	text: string;
	/** How far any child of a line reaches past that line's box (px). */
	lineOverflow: number;
	/** Width of the task's title on the folded line; -1 when the line names no task. */
	foldedTaskWidth: number;
	/** The interrupt guard's close button, in its heading. */
	closeButtons: number;
	/** The folded line's tail: its width and font size (px); -1 when not drawn. */
	tailWidth: number;
	tailFontPx: number;
	/** The folded line's lead: drawn, and cut short (an ellipsis). */
	lead: boolean;
	leadTruncated: boolean;
	/** The card's heading, and the status chips drawn (their text, in order). */
	title: string;
	statuses: string[];
}

export function report(): CardReport[] {
	return Array.from(document.querySelectorAll<HTMLElement>("[data-card]")).map((card) => {
		const paper = card.firstElementChild as HTMLElement | null;
		// Every child of a line (the heading, a task row) inside that line's box: the card's own
		// height holds by construction, so this is what catches a chip or a button taller than
		// the line the measure pass reserved.
		let overflow = 0;
		for (const line of card.querySelectorAll<HTMLElement>(
			"[data-task-notice-head], [data-task-notice-row]",
		)) {
			const box = line.getBoundingClientRect();
			for (const child of line.querySelectorAll<HTMLElement>("*")) {
				const r = child.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				overflow = Math.max(overflow, box.top - r.top, r.bottom - box.bottom);
			}
		}
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
				spill = Math.max(spill, top - r.top, r.bottom - bottom);
			}
		}
		const task = card.querySelector<HTMLElement>(
			"[data-task-notice-summary] [data-task-notice-task]",
		);
		const tail = card.querySelector<HTMLElement>(
			"[data-task-notice-summary] [data-task-notice-tail]",
		);
		const lead = card.querySelector<HTMLElement>(
			"[data-task-notice-summary] [data-task-notice-lead]",
		);
		return {
			kind: card.dataset.kind ?? "",
			measured: Number(card.dataset.measured),
			painted: paper ? Math.round(paper.getBoundingClientRect().height) : 0,
			content: paper ? paper.scrollHeight : 0,
			spill: Math.round(spill * 10) / 10,
			scrollWidth: paper ? paper.scrollWidth : 0,
			width: paper ? paper.clientWidth : 0,
			text: card.textContent ?? "",
			lineOverflow: Math.round(overflow * 10) / 10,
			foldedTaskWidth: task ? Math.round(task.getBoundingClientRect().width) : -1,
			closeButtons: card.querySelectorAll("[data-task-notice-head] button[aria-label='删除此提醒']")
				.length,
			tailWidth: tail ? Math.round(tail.getBoundingClientRect().width) : -1,
			tailFontPx: tail ? Number.parseFloat(getComputedStyle(tail).fontSize) : -1,
			lead: !!lead,
			leadTruncated: !!lead && lead.scrollWidth > lead.clientWidth + 0.5,
			title: card.querySelector("[data-task-notice-title]")?.textContent ?? "",
			statuses: [...card.querySelectorAll("[data-task-notice-status]")].map(
				(chip) => chip.textContent ?? "",
			),
		};
	});
}
