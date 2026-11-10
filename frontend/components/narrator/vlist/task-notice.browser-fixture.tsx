/**
 * Browser fixture for the transcript's task notices (`task-notice.browser.test.ts`): the turn-end
 * reminder, people's task changes, the interrupt guard, current-tasks updates (one with tasks
 * delegated to subagents; five that say what changed since the view before) and tasks finished
 * elsewhere, through the real
 * adapter → measure → render chain with the shell's labels (zh-CN, or en), laid out by Chromium. It reports
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
import enCommon from "../../../locales/en/common.json";
import enNarrator from "../../../locales/en/narrator.json";
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
	resources: {
		"zh-CN": { narrator: zhNarrator, common: zhCommon },
		en: { narrator: enNarrator, common: enCommon },
	},
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

/** A `context_update` row of the current-tasks view with this summary. */
function viewRow(view: unknown): AdapterSegment {
	return row([
		{ type: "text", text: "Context updated: outline.tasks" },
		{
			type: "context_update",
			epochId: "e",
			changes: [],
			snapshotRef: "r",
			display: { "outline.tasks": view },
		},
	]);
}

/**
 * 任务树可读性 PR B: updates of the view that say what changed since the one the session saw
 * before. Titles are in the reader's language; the English ones are Latin only, so what the test
 * asserts about widths does not depend on a CJK font being installed.
 */
function changeNotices(locale: FixtureLocale): AdapterSegment[] {
	const t =
		locale === "en"
			? {
					done: "Add the regression tests",
					race: "Fix the refresh race",
					keep: "Keep the build green",
					wait: "Wait for the review",
					next: "Write the PR description",
					added: "Draft the release note",
				}
			: {
					done: "补并发回归测试",
					race: "修刷新令牌的竞态",
					keep: "保持构建通过",
					wait: "等评审",
					next: "写 PR 描述",
					added: "起草发布说明",
				};
	const list = {
		doing: [
			{ address: `${K}/Fx11race`, title: t.race },
			{ address: `${K}/Kp22keep`, title: t.keep },
		],
		waiting: [{ address: `${K}/Wt33wait`, title: t.wait }],
		next: [{ address: `${K}/Zx81aaQe`, title: t.next }],
		counts: { doing: 2, waiting: 1, todo: 3 },
		states: {
			doing: [`${K}/Fx11race`, `${K}/Kp22keep`],
			waiting: [`${K}/Wt33wait`],
			todo: [`${K}/Zx81aaQe`, `${K}/Nw44new1`, `${K}/Nw55new2`],
		},
	};
	return [
		// Compared with the previous view: two changes named, the rest counted.
		viewRow({
			...list,
			changes: [
				{ address: `${K}/Dn00done`, title: t.done, kind: "done", from: "doing" },
				{ address: `${K}/Fx11race`, title: t.race, kind: "started", from: "todo" },
				{ address: `${K}/Wt33wait`, title: t.wait, kind: "waiting", from: "doing" },
				{ address: `${K}/Nw44new1`, title: t.added, kind: "added" },
			],
			changed: 6,
		}),
		// One change: short enough to stand whole on a phone.
		viewRow({
			...list,
			changes: [{ address: `${K}/Fx11race`, title: t.race, kind: "started", from: "todo" }],
			changed: 1,
		}),
		// Only the order or the wording changed.
		viewRow({ ...list, changes: [], changed: 0 }),
		// Nothing to compare with: the first view of an epoch.
		viewRow(list),
		// The last task finished.
		viewRow({
			doing: [],
			waiting: [],
			next: [],
			counts: { doing: 0, waiting: 0, todo: 0 },
			states: {},
			changes: [{ address: `${K}/Dn00done`, title: t.done, kind: "done", from: "doing" }],
			changed: 1,
		}),
	];
}

/** Every notice the transcript shows, in its structured and its older form. */
function notices(locale: FixtureLocale): AdapterSegment[] {
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
		// Team activity (outline P2 PR 10b): a long title beside a long name, counts, a file whose
		// task the session may not name.
		row([
			{
				type: "system_injection",
				source: "outline_team_activity",
				modelText: "团队动态（…）",
				body: {
					kind: "outlineTasks",
					variant: "activity",
					items: [
						{
							address: `${K}/mSsl3Ccf`,
							title:
								"改刷新逻辑，确保在网络断开后重连时不会重复提交同一个刷新请求并且要覆盖所有边界",
							// Overflow without relying on the runner's CJK fallback font metrics.
							by: "A deliberately long session title for browser truncation",
							changes: [{ kind: "status", from: "todo", to: "done" }],
						},
						{
							address: `${K}/Qp93LkaA`,
							title: "auth 模块稳定",
							by: "alice",
							changes: [
								{ kind: "notes", n: 2 },
								{ kind: "reports", n: 1 },
								{ kind: "answers", n: 3 },
							],
						},
						{
							address: "",
							title: "server/services/outline/live/deeply/nested/directory/agent-presence.ts",
							by: "B",
							changes: [
								{
									kind: "overlap",
									path: "server/services/outline/live/deeply/nested/directory/agent-presence.ts",
								},
							],
						},
					],
					more: 3,
				},
			},
		]),
		...changeNotices(locale),
	];
}

export type FixtureLocale = "zh-CN" | "en";

export interface FixtureOptions {
	width: number;
	expanded: boolean;
	scheme: "light" | "dark";
	/** Typography the reader chose (percent). */
	fontScalePercent?: number;
	lineHeightScalePercent?: number;
	/** The reader's language (default zh-CN). */
	locale?: FixtureLocale;
}

let root: Root | null = null;

function Cards({ options }: { options: FixtureOptions }) {
	const { adapterLabels } = useVListLabels();
	const ctx = { lod: 5 as const, labels: adapterLabels, isExpanded: () => options.expanded };
	const specs = notices(options.locale ?? "zh-CN").flatMap((segment) => adaptSegment(segment, ctx));
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
						data-measured-rows={(measured as { rowCount?: number }).rowCount ?? 0}
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
	await i18n.changeLanguage(options.locale ?? "zh-CN");
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
	/** Every state chip (a status, a lock): which state, its words, its icon, its background. */
	chips: Array<{ status: string; text: string; icon: string; shapes: number; backed: boolean }>;
	/** The heading: its painted width, whether its line cuts it, its tooltip and its weight. */
	titleWidth: number;
	titleTruncated: boolean;
	titleTooltip: string | null;
	titleWeight: string;
	/** The folded line's lead (the counts after the view's changes): its text. */
	leadText: string;
	/**
	 * The lead is painted inside the heading line, all of it (the counts after the view's changes
	 * wrap out of sight when the heading leaves them no room).
	 */
	leadShown: boolean;
	/** The lead is painted in part: cut by its box (a stub). Never, for counts after a sentence. */
	leadCut: boolean;
	/**
	 * Empty room between the last painted thing and the bottom of the card's content box (px): a
	 * measure pass that reserves more than is drawn shows here, where `spill` sees one that
	 * reserves less.
	 */
	slack: number;
	/** Task rows drawn, and the rows the measure pass counted. */
	rows: number;
	measuredRows: number;
	/** Rows marked as changed, and how many marks are painted (not transparent). */
	changedRows: number;
	paintedMarks: number;
	/** The left edge of each row's first chip or title, less the row's own: the mark column. */
	rowInsets: number[];
	/** Who made each change, where a row starts with it (team activity): width, cut short. */
	by: Array<{ text: string; width: number; truncated: boolean }>;
}

/**
 * The part of `node` that is painted: its box cut by every ancestor up to `root` that clips its
 * overflow. Null when nothing of it is (the counts after a change sentence wrap to a line their
 * one-line summary box does not draw).
 */
function paintedBox(
	node: HTMLElement,
	root: HTMLElement,
): { top: number; bottom: number; left: number; right: number } | null {
	const r = node.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return null;
	const box = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
	for (let up = node.parentElement; up && up !== root; up = up.parentElement) {
		const style = getComputedStyle(up);
		if (style.overflowX === "visible" && style.overflowY === "visible") continue;
		const clip = up.getBoundingClientRect();
		box.top = Math.max(box.top, clip.top);
		box.bottom = Math.min(box.bottom, clip.bottom);
		box.left = Math.max(box.left, clip.left);
		box.right = Math.min(box.right, clip.right);
		if (box.bottom - box.top <= 0 || box.right - box.left <= 0) return null;
	}
	return box;
}

/** All of `node` is painted inside `root` (half a pixel of rounding allowed). */
function wholeIn(node: HTMLElement, root: HTMLElement): boolean {
	const painted = paintedBox(node, root);
	if (!painted) return false;
	const r = node.getBoundingClientRect();
	return (
		painted.right - painted.left >= r.width - 0.5 && painted.bottom - painted.top >= r.height - 0.5
	);
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
				const r = paintedBox(child, line);
				if (!r) continue;
				overflow = Math.max(overflow, box.top - r.top, r.bottom - box.bottom);
			}
		}
		let spill = 0;
		let slack = 0;
		if (paper) {
			const box = paper.getBoundingClientRect();
			const style = getComputedStyle(paper);
			const top =
				box.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
			const bottom =
				box.bottom -
				Number.parseFloat(style.borderBottomWidth) -
				Number.parseFloat(style.paddingBottom);
			let lowest = top;
			for (const child of paper.querySelectorAll<HTMLElement>("*")) {
				const r = paintedBox(child, paper);
				if (!r) continue;
				spill = Math.max(spill, top - r.top, r.bottom - bottom);
				lowest = Math.max(lowest, r.bottom);
			}
			slack = bottom - lowest;
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
		const heading = card.querySelector<HTMLElement>("[data-task-notice-title]");
		const head = card.querySelector<HTMLElement>("[data-task-notice-head]");
		const marks = [...card.querySelectorAll<HTMLElement>("[data-task-notice-mark]")];
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
			title: heading?.textContent ?? "",
			statuses: [...card.querySelectorAll("[data-task-notice-status]")].map(
				(chip) => chip.textContent ?? "",
			),
			chips: [...card.querySelectorAll<HTMLElement>("[data-status-chip]")].map((chip) => {
				const svg = chip.querySelector<SVGSVGElement>("svg");
				const background = getComputedStyle(chip).backgroundColor;
				const border = getComputedStyle(chip).borderTopColor;
				const clear = (color: string) => color === "rgba(0, 0, 0, 0)" || color === "transparent";
				return {
					status: chip.dataset.statusChip ?? "",
					text: chip.textContent ?? "",
					icon: svg ? (svg.getAttribute("class") ?? "") : "",
					shapes: svg?.childElementCount ?? 0,
					// A tinted background, or (a gray chip) an outline: never bare words.
					backed: !clear(background) || !clear(border),
				};
			}),
			titleWidth: heading ? Math.round(heading.getBoundingClientRect().width) : -1,
			titleTruncated: !!heading && heading.scrollWidth > heading.clientWidth + 0.5,
			titleTooltip: heading?.getAttribute("title") ?? null,
			titleWeight: heading ? getComputedStyle(heading).fontWeight : "",
			leadText: lead?.textContent ?? "",
			leadShown: !!lead && !!head && wholeIn(lead, head),
			leadCut: !!lead && !!head && !!paintedBox(lead, head) && !wholeIn(lead, head),
			slack: Math.round(slack * 10) / 10,
			rows: card.querySelectorAll("[data-task-notice-row]").length,
			measuredRows: Number(card.dataset.measuredRows),
			changedRows: card.querySelectorAll("[data-task-notice-changed]").length,
			paintedMarks: marks.filter(
				(mark) => getComputedStyle(mark).backgroundColor !== "rgba(0, 0, 0, 0)",
			).length,
			rowInsets: [
				...card.querySelectorAll<HTMLElement>(
					"[data-task-notice-row]:not([data-task-notice-row='more'])",
				),
			].map((line) => {
				const first = line.querySelector<HTMLElement>(
					"[data-task-notice-status], [data-task-notice-task]",
				);
				return first
					? Math.round(first.getBoundingClientRect().left - line.getBoundingClientRect().left)
					: -1;
			}),
			by: [
				...card.querySelectorAll<HTMLElement>("[data-task-notice-row] [data-task-notice-by]"),
			].map((by) => ({
				text: by.textContent ?? "",
				width: Math.round(by.getBoundingClientRect().width),
				truncated: by.scrollWidth > by.clientWidth + 0.5,
			})),
		};
	});
}
