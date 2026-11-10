/**
 * Task notices in the transcript (PR-1), through the real chain: row → adapter → measure →
 * render, with the shell's real zh-CN labels (`useVListLabels`).
 *
 *   - the turn-end reminder, people's task changes, the interrupt guard and an update of the
 *     current-tasks view are ONE folded line naming the task (a titled outline link, a status
 *     chip), and their tasks are rows when unfolded (the generic per-key expansion);
 *   - rows written before the structured data (a prose body, a context_update without a summary)
 *     keep their card, now read as plain text: no `######`, no backslashes, the text once;
 *   - measure and render agree: the card's box is the measured height, and it draws exactly the
 *     measured rows; links are outline links inside a host and plain text outside one.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { OutlineOpenerProvider } from "@frontend/lib/outline-opener";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import type { TaskNoticeData } from "@shared/pretext-layout/task-notice";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import {
	BADGE_XS,
	CARD_PADDING,
	ORIGIN_HEADING_GAP,
	TASK_NOTICE_ROW_GAP,
} from "./measure/measure-system-text";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { typographyMetrics } from "./pretext-fonts";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegment } from "./segment-adapter";
import { useVListLabels } from "./useVListLabels";

const K = "MTBXwl1Y";
/**
 * One line of a task notice, as the measure pass takes it: xs text beside xs badges, so the
 * taller of the reader's live xs line box and the badge.
 */
const line = () => Math.max(typographyMetrics().line.xs, BADGE_XS);
const href = (sid: string) => `/outline/ref?a=${encodeURIComponent(`${K}/${sid}`)}`;
let labels: Record<string, string> = {};
const disposeCanvas = installCanvasStub();

beforeAll(async () => {
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
	}
	if (typeof g.cancelAnimationFrame !== "function") {
		g.cancelAnimationFrame = (handle: number) => clearTimeout(handle as unknown as Timer);
	}
	// The shell's real labels, in Chinese.
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
	const container = document.createElement("div");
	const root = createRoot(container);
	function Harness() {
		labels = useVListLabels().adapterLabels;
		return null;
	}
	await act(async () => {
		root.render(
			<I18nextProvider i18n={i18n}>
				<Harness />
			</I18nextProvider>,
		);
	});
	act(() => root.unmount());
});
afterAll(() => disposeCanvas());

function ctx(expanded: boolean): AdapterContext {
	return { lod: 5, labels, isExpanded: () => expanded };
}

function sysRow(id: string, blocks: unknown[], createdAt = "2026-11-03T09:13:00.000Z") {
	return {
		kind: "message",
		msg: rowWithElements({ id, role: "sys", origin: "system", createdAt }, blocks as never),
	} as AdapterSegment;
}

function injection(id: string, source: string, modelText: string, body: unknown) {
	return sysRow(id, [{ type: "system_injection", source, modelText, body }]);
}

function specOf(segment: AdapterSegment, expanded = false) {
	const specs = adaptSegment(segment, ctx(expanded));
	expect(specs).toHaveLength(1);
	const spec = specs[0];
	if (!spec) throw new Error("no spec");
	expect(spec.kind).toBe("system-text");
	return spec;
}

const TURN_END_TEXT = `系统备注：\`${K}/mSsl3Ccf\` 排查中断后无重试按钮（只读，不改代码） 仍是进行中；做完了就用 OutlineEdit 勾成 [x]。`;

const turnEnd = () =>
	injection("m-turn-end", "outline_task_turn_end", TURN_END_TEXT, {
		kind: "outlineTasks",
		variant: "turnEnd",
		items: [
			{
				address: `${K}/mSsl3Ccf`,
				title: "排查中断后无重试按钮（只读，不改代码）",
				status: "doing",
			},
		],
	});

const edited = () =>
	injection("m-edited", "outline_task_edit", "系统通知（不是用户发言）：…", {
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
				changes: [{ kind: "assigned", to: "agent:review-1" }],
			},
		],
		more: 1,
	});

function contextUpdate(id: string, notice: string, display?: unknown) {
	return sysRow(id, [
		{ type: "text", text: notice },
		{
			type: "context_update",
			epochId: "e1",
			changes: [],
			snapshotRef: "ref",
			...(display === undefined ? {} : { display }),
		},
	]);
}

const VIEW = {
	doing: [{ address: `${K}/Qp93LkaA`, title: "回归测试：中断后重试" }],
	waiting: [],
	next: [{ address: `${K}/Zx81aaQe`, title: "写 PR 描述", humanCreated: true }],
	counts: { doing: 1, waiting: 0, todo: 1 },
};

describe("task notices: one line naming the task, rows when unfolded", () => {
	it("the turn-end reminder: the task as a titled link with its status; nothing to unfold", () => {
		const spec = specOf(turnEnd());
		const data = spec.data as TaskNoticeData & { modelFacing?: string };
		expect(data.kind).toBe("tasks_notice");
		expect(data.title).toBe("回合末任务提醒");
		expect(data.summary.row).toMatchObject({
			title: "排查中断后无重试按钮（只读，不改代码）",
			href: href("mSsl3Ccf"),
			status: { label: "进行中", color: "blue" },
		});
		expect(data.summary.tail).toBe("还没勾成完成");
		expect(data.expandable).toBe(false);
		expect(spec.opts).toBeUndefined();
		// The inspector still has what the model got.
		expect(data.modelFacing).toBe(TURN_END_TEXT);
		const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, 800, 5, spec.opts);
		expect(measured.height).toBe(CARD_PADDING * 2 + line());
	});

	it("people's changes: who changed how many, chips from → to, and each person named", () => {
		const folded = specOf(edited());
		const data = folded.data as TaskNoticeData;
		expect(data.title).toBe("alice、bob 改了 3 个任务");
		expect(data.summary.tail).toBe("等 2 项");
		expect(data.rows).toEqual([
			{
				title: "排查中断后无重试按钮",
				href: href("mSsl3Ccf"),
				address: `${K}/mSsl3Ccf`,
				status: { label: "完成", color: "green" },
				statusFrom: { label: "进行中", color: "blue" },
				marks: ["人建", "已锁定"],
				note: "alice",
			},
			{
				title: "回归测试：中断后重试",
				href: href("Qp93LkaA"),
				address: `${K}/Qp93LkaA`,
				note: "bob；交给 @agent:review-1",
			},
			{ title: "还有 1 项未列出", dim: true },
		]);
		expect(data.expandable).toBe(true);
		expect(folded.opts).toEqual({ expanded: false });
		const foldedHeight = VLIST_REGISTRY[folded.kind].measure(folded.data, 800, 5, folded.opts);
		expect(foldedHeight.height).toBe(CARD_PADDING * 2 + line());
		// Unfolded: the heading line, a gap, three lines with two gaps between them.
		const open = specOf(edited(), true);
		expect(open.opts).toEqual({ expanded: true });
		const measured = VLIST_REGISTRY[open.kind].measure(open.data, 800, 5, open.opts) as never as {
			height: number;
			expanded: boolean;
			rowCount: number;
		};
		expect(measured).toMatchObject({
			expanded: true,
			rowCount: 3,
			height: CARD_PADDING * 2 + line() + ORIGIN_HEADING_GAP + 3 * line() + 2 * TASK_NOTICE_ROW_GAP,
		});
	});

	it("the interrupt guard: how many are open, outline tasks linked, spec tasks plain", () => {
		const outline = specOf(
			injection("m-guard", "interrupt_task_guard", "…", {
				kind: "tasks",
				variant: "current",
				taskBackend: "outline",
				tasks: [
					{ role: "doing", text: "修复重试按钮", ref: `${K}/mSsl3Ccf` },
					{ role: "blocked", text: "等权限", protected: true, ref: `${K}/Wa1tWa1t` },
				],
			}),
		).data as TaskNoticeData;
		expect(outline.title).toBe("中断任务提醒");
		expect(outline.summary.lead).toBe("2 个未完成：");
		expect(outline.rows.map((row) => [row.href, row.status?.label, row.marks])).toEqual([
			[href("mSsl3Ccf"), "进行中", undefined],
			[href("Wa1tWa1t"), "等待中", ["人建"]],
		]);
		const spec = specOf(
			injection("m-guard-spec", "interrupt_task_guard", "…", {
				kind: "tasks",
				variant: "current",
				tasks: [{ role: "todo", text: "补测试", protected: true }],
			}),
		).data as TaskNoticeData;
		expect(spec.rows).toEqual([
			{ title: "补测试", status: { label: "待办", color: "gray" }, marks: ["受保护"] },
		]);
		// More open than the guard lists: counted, as a lower bound, and the rest named as such.
		const many = specOf(
			injection("m-guard-many", "interrupt_task_guard", "…", {
				kind: "tasks",
				variant: "current",
				taskBackend: "outline",
				taskCount: 12,
				tasks: [{ role: "doing", text: "修复重试按钮", ref: `${K}/mSsl3Ccf` }],
			}),
		).data as TaskNoticeData;
		expect(many.summary.lead).toBe("至少 12 个未完成：");
		expect(many.summary.tail).toBe("等 11 项");
		expect(many.rows.at(-1)).toEqual({ title: "至少还有 11 项未列出", dim: true });
	});

	it("people's changes count tasks: two people changing one task is one task", () => {
		const data = specOf(
			injection("m-same", "outline_task_edit", "…", {
				kind: "outlineTasks",
				variant: "edited",
				items: [
					{
						address: `${K}/mSsl3Ccf`,
						title: "排查中断后无重试按钮",
						by: "alice",
						changes: [{ kind: "locked" }],
					},
					{
						address: `${K}/mSsl3Ccf`,
						title: "排查中断后无重试按钮",
						by: "bob",
						changes: [{ kind: "status", from: "doing", to: "done" }],
					},
				],
			}),
		).data as TaskNoticeData;
		expect(data.title).toBe("alice、bob 改了 1 个任务");
		expect(data.summary.tail).toBeUndefined();
		expect(data.rows).toHaveLength(2);
	});

	it("an update of the current-tasks view names the task in progress and what else is open", () => {
		const data = specOf(
			contextUpdate("m-view", "Context updated: outline.tasks", { "outline.tasks": VIEW }),
		).data as TaskNoticeData;
		expect(data.title).toBe("当前任务已更新");
		expect(data.summary.row).toMatchObject({
			title: "回归测试：中断后重试",
			href: href("Qp93LkaA"),
			status: { label: "进行中" },
		});
		expect(data.summary.tail).toBe("待办 1");
		expect(data.rows.map((row) => [row.title, row.status?.label, row.marks])).toEqual([
			["回归测试：中断后重试", "进行中", undefined],
			["写 PR 描述", "待办", ["人建"]],
		]);
		// A read that stopped early: the rest is a lower bound.
		const truncated = specOf(
			contextUpdate("m-view-more", "Context updated: outline.tasks", {
				"outline.tasks": { ...VIEW, more: true },
			}),
		).data as TaskNoticeData;
		expect(truncated.rows.at(-1)).toEqual({ title: "至少还有 1 项未列出", dim: true });
		expect(truncated.summary.tail).toBe("待办 1…");
		// With the behavior boundary changed too, the heading says both.
		const both = specOf(
			contextUpdate("m-view-2", "Context updated: outline.behavior, outline.tasks", {
				"outline.tasks": VIEW,
			}),
		).data as TaskNoticeData;
		expect(both.title).toBe("上下文已更新：行为边界 / 当前任务");
		// The view went away (no task open, or the tasks left the outline): a line true of both.
		const none = specOf(
			contextUpdate("m-view-3", "Context updated: outline.tasks", { "outline.tasks": null }),
		).data as TaskNoticeData;
		expect(none.summary).toEqual({ lead: "当前任务列表为空" });
		expect(none.rows).toEqual([]);
	});

	it("a live client's row (protocol v2) carries the summary too", async () => {
		const protocol = await import("@server/websocket/narrator-block-protocol");
		const { decodeBlockFrame } = await import("@frontend/lib/block-protocol");
		const stored = {
			id: "m-v2",
			narratorId: "n1",
			parentToolUseId: null,
			role: "sys",
			contentJson: [
				{ type: "text", text: "Context updated: outline.tasks" },
				{
					type: "context_update",
					epochId: "e1",
					changes: [],
					snapshotRef: "ref",
					display: { "outline.tasks": VIEW },
				},
			],
			contentText: "Context updated: outline.tasks",
			createdBy: "system",
			origin: "system",
			originLabel: null,
			createdAt: "2026-11-03T09:13:00.000Z",
			children: [],
		};
		const frames = protocol.toBlockFrames({
			type: "message",
			narratorId: "n1",
			message: stored,
		} as never);
		const decoded = frames.flatMap((frame) => decodeBlockFrame(frame as never)) as Array<{
			message?: unknown;
		}>;
		const msg = decoded.find((frame) => frame.message)?.message as never;
		const data = specOf({ kind: "message", msg } as AdapterSegment).data as TaskNoticeData;
		expect(data.kind).toBe("tasks_notice");
		expect(data.summary.row?.title).toBe("回归测试：中断后重试");
	});
});

/** A view the server compared with the one the session saw before (`changes` is present). */
const CHANGED_VIEW = {
	doing: [
		{ address: `${K}/Fx11race`, title: "修竞态" },
		{ address: `${K}/Kp22keep`, title: "保持不变的任务" },
	],
	waiting: [{ address: `${K}/Wt33wait`, title: "等评审" }],
	next: [{ address: `${K}/Zx81aaQe`, title: "写 PR 描述" }],
	counts: { doing: 2, waiting: 1, todo: 3 },
	states: {
		doing: [`${K}/Fx11race`, `${K}/Kp22keep`],
		waiting: [`${K}/Wt33wait`],
		todo: [`${K}/Zx81aaQe`, `${K}/Nw44new1`, `${K}/Nw55new2`],
	},
	changes: [
		{ address: `${K}/Dn00done`, title: "补测试", kind: "done", from: "doing" },
		{ address: `${K}/Fx11race`, title: "修竞态", kind: "started", from: "todo" },
		{ address: `${K}/Wt33wait`, title: "等评审", kind: "waiting", from: "doing" },
		{ address: `${K}/Nw44new1`, title: "新加的待办", kind: "added" },
	],
	changed: 6,
};

const viewUpdate = (id: string, view: unknown, notice = "Context updated: outline.tasks") =>
	contextUpdate(id, notice, { "outline.tasks": view });

describe("an update of the current-tasks view says what changed (任务树可读性 PR B)", () => {
	it("the heading names the first two changes in words and counts the rest", () => {
		const data = specOf(viewUpdate("m-chg", CHANGED_VIEW)).data as TaskNoticeData;
		expect(data.title).toBe("完成『补测试』，开始『修竞态』，另有 4 项变化");
		expect(data.title).not.toContain("已更新");
		// The heading is the notice: it keeps the folded line; the counts come second, all of them.
		expect(data.titleFirst).toBe(true);
		expect(data.quiet).toBeUndefined();
		expect(data.summary).toEqual({ lead: "进行中 2 · 等待 1 · 待办 3" });
		expect(data.expandable).toBe(true);
	});

	it("one or two changes are written out whole; each kind has its words", () => {
		const one = (kind: string, title = "修竞态") =>
			(
				specOf(
					viewUpdate(`m-${kind}`, {
						...CHANGED_VIEW,
						changes: [{ address: `${K}/Fx11race`, title, kind }],
						changed: 1,
					}),
				).data as TaskNoticeData
			).title;
		expect(one("done")).toBe("完成『修竞态』");
		expect(one("started")).toBe("开始『修竞态』");
		expect(one("cancelled")).toBe("取消『修竞态』");
		expect(one("added")).toBe("新增『修竞态』");
		expect(one("waiting")).toBe("『修竞态』进入等待");
		expect(one("unblocked")).toBe("『修竞态』解除等待");
		expect(one("delegated")).toBe("把『修竞态』交给子代理");
		expect(one("returned")).toBe("子代理交回『修竞态』");
		expect(one("requeued")).toBe("『修竞态』放回待办");
		expect(one("removed")).toBe("移除『修竞态』");
		expect(one("unlisted")).toBe("『修竞态』不再列出");
		expect(one("renamed")).toBe("任务改名为『修竞态』");
		// A long title is cut inside the sentence (its row has it whole).
		const long = one("done", "长".repeat(100));
		expect(long).toBe(`完成『${"长".repeat(39)}…』`);
		const two = specOf(
			viewUpdate("m-two", {
				...CHANGED_VIEW,
				changes: CHANGED_VIEW.changes.slice(0, 2),
				changed: 2,
			}),
		).data as TaskNoticeData;
		expect(two.title).toBe("完成『补测试』，开始『修竞态』");
	});

	it("changes nobody could name are counted", () => {
		const data = specOf(viewUpdate("m-cnt", { ...CHANGED_VIEW, changes: [], changed: 3 }))
			.data as TaskNoticeData;
		expect(data.title).toBe("任务有 3 处变化");
		expect(data.quiet).toBeUndefined();
	});

	it("unfolded: the changes the list does not show come first, changed rows are marked", () => {
		const data = specOf(viewUpdate("m-rows", CHANGED_VIEW), true).data as TaskNoticeData;
		expect(
			data.rows.map((row) => [
				row.title,
				row.statusFrom?.label,
				row.status?.label,
				row.note,
				row.changed,
			]),
		).toEqual([
			// Finished: no longer on the list, shown with what it came from.
			["补测试", "进行中", "完成", undefined, true],
			// A new to-do past the first: on the list's count but not among its rows.
			["新加的待办", undefined, "待办", "新加", true],
			// The list as it is now; the rows that changed say where they came from.
			["修竞态", "待办", "进行中", undefined, true],
			["保持不变的任务", undefined, "进行中", undefined, undefined],
			["等评审", "进行中", "等待中", undefined, true],
			["写 PR 描述", undefined, "待办", undefined, undefined],
			["还有 2 项未列出", undefined, undefined, undefined, undefined],
		]);
		expect(data.rows[0]?.href).toBe(href("Dn00done"));
		// Copying the row gives the sentence and the rows, transitions included.
		expect(data.text.split("\n").slice(0, 2)).toEqual([
			"完成『补测试』，开始『修竞态』，另有 4 项变化",
			`• [进行中 → 完成] 补测试 (${K}/Dn00done)`,
		]);
	});

	it("rows of the other kinds: a word where chips cannot say it", () => {
		const data = specOf(
			viewUpdate("m-notes", {
				doing: [
					{ address: `${K}/Rt11back`, title: "子代理交回的" },
					{ address: `${K}/Rn22name`, title: "新名字" },
					{ address: `${K}/Nw33strt`, title: "直接开工的新任务" },
				],
				waiting: [],
				next: [],
				counts: { doing: 3, waiting: 0, todo: 0 },
				states: { doing: [`${K}/Rt11back`, `${K}/Rn22name`, `${K}/Nw33strt`] },
				changes: [
					{ address: `${K}/Nw33strt`, title: "直接开工的新任务", kind: "started" },
					{ address: `${K}/Cx44cncl`, title: "不做了", kind: "cancelled", from: "todo" },
					{ address: `${K}/Rt11back`, title: "子代理交回的", kind: "returned", from: "delegated" },
					{ address: `${K}/Rm55gone`, title: "删掉的", kind: "removed", from: "todo" },
					{ address: `${K}/Rn22name`, title: "新名字", kind: "renamed", from: "doing" },
				],
				changed: 5,
			}),
			true,
		).data as TaskNoticeData;
		expect(
			data.rows.map((row) => [row.title, row.statusFrom?.label, row.status?.label, row.note]),
		).toEqual([
			["不做了", "待办", "已取消", undefined],
			// Removed: no state to be in; the note says it.
			["删掉的", undefined, undefined, "已移除"],
			["子代理交回的", "委派中", "进行中", "子代理交回"],
			// Renamed in place: the same state, so no transition.
			["新名字", undefined, "进行中", "已改名"],
			// New and already under way: nothing to come from, so it is new.
			["直接开工的新任务", undefined, "进行中", "新加"],
		]);
	});

	it("only the order or the wording changed: one quiet line, the list still a click away", () => {
		const data = specOf(viewUpdate("m-quiet", { ...CHANGED_VIEW, changes: [], changed: 0 }))
			.data as TaskNoticeData;
		expect(data.title).toBe("任务列表已刷新");
		expect(data.quiet).toBe(true);
		expect(data.titleFirst).toBe(true);
		expect(data.summary).toEqual({ lead: "进行中 2 · 等待 1 · 待办 3" });
		expect(data.rows.every((row) => row.changed === undefined)).toBe(true);
		expect(data.expandable).toBe(true);
	});

	it("nothing to compare with (the first view of an epoch): the list, not an update", () => {
		const { changes: _c, changed: _n, ...first } = CHANGED_VIEW;
		const data = specOf(viewUpdate("m-first", first)).data as TaskNoticeData;
		expect(data.title).toBe("当前任务");
		expect(data.titleFirst).toBeUndefined();
		// As before: the first task, then how many of each kind besides it.
		expect(data.summary.row).toMatchObject({ title: "修竞态", status: { label: "进行中" } });
		expect(data.summary.tail).toBe("进行中 1 · 等待 1 · 待办 3");
	});

	it("a row written before state tables existed reads exactly as it did", () => {
		const data = specOf(viewUpdate("m-old", VIEW)).data as TaskNoticeData;
		expect(data as unknown).toEqual({
			kind: "tasks_notice",
			variant: "view",
			title: "当前任务已更新",
			summary: {
				row: {
					title: "回归测试：中断后重试",
					href: href("Qp93LkaA"),
					address: `${K}/Qp93LkaA`,
					status: { label: "进行中", color: "blue" },
				},
				tail: "待办 1",
			},
			rows: [
				{
					title: "回归测试：中断后重试",
					href: href("Qp93LkaA"),
					address: `${K}/Qp93LkaA`,
					status: { label: "进行中", color: "blue" },
				},
				{
					title: "写 PR 描述",
					href: href("Zx81aaQe"),
					address: `${K}/Zx81aaQe`,
					status: { label: "待办", color: "gray" },
					marks: ["人建"],
				},
			],
			expandable: true,
			text: `当前任务已更新\n• [进行中] 回归测试：中断后重试 (${K}/Qp93LkaA)\n• [待办] 写 PR 描述 (${K}/Zx81aaQe) · 人建`,
			timeLabel: expect.any(String),
			origin: "system",
			originLabel: "context_update",
		});
	});

	it("the last task finished: the heading says so, the line says the list is empty", () => {
		const data = specOf(
			viewUpdate("m-empty", {
				doing: [],
				waiting: [],
				next: [],
				counts: { doing: 0, waiting: 0, todo: 0 },
				states: {},
				changes: [{ address: `${K}/Dn00done`, title: "补测试", kind: "done", from: "doing" }],
				changed: 1,
			}),
		).data as TaskNoticeData;
		expect(data.title).toBe("完成『补测试』");
		expect(data.summary).toEqual({ lead: "当前任务列表为空" });
		expect(data.rows.map((row) => [row.title, row.status?.label])).toEqual([["补测试", "完成"]]);
		// One row is worth unfolding for: the folded line shows no task.
		expect(data.expandable).toBe(true);
	});

	it("beside another part's update the heading stays theirs and the changes lead the line", () => {
		const data = specOf(
			viewUpdate("m-both", CHANGED_VIEW, "Context updated: outline.behavior, outline.tasks"),
		).data as TaskNoticeData;
		expect(data.title).toBe("上下文已更新：行为边界 / 当前任务");
		expect(data.titleFirst).toBeUndefined();
		expect(data.summary).toEqual({
			lead: "完成『补测试』，开始『修竞态』，另有 4 项变化 · 进行中 2 · 等待 1 · 待办 3",
		});
	});

	it("in English the sentence starts with a capital and quotes the titles", async () => {
		const { taskNoticeFromContextUpdate } = await import("@shared/pretext-layout/task-notice");
		const blocks = [
			{ type: "text", text: "Context updated: outline.tasks" },
			{
				type: "context_update",
				display: {
					"outline.tasks": {
						...CHANGED_VIEW,
						changes: [
							{ address: `${K}/Dn00done`, title: "Add tests", kind: "done" },
							{ address: `${K}/Fx11race`, title: "Fix the race", kind: "started" },
						],
						changed: 5,
					},
				},
			},
		];
		// No labels: the English fallbacks, as a reader in English gets them.
		const data = taskNoticeFromContextUpdate(blocks, null, undefined);
		expect(data?.title).toBe("Finished “Add tests”, started “Fix the race”, and 3 more");
		expect(data?.summary.lead).toBe("2 in progress · 1 waiting · 3 to do");
		const waiting = taskNoticeFromContextUpdate(
			[
				blocks[0] as never,
				{
					type: "context_update",
					display: {
						"outline.tasks": {
							...CHANGED_VIEW,
							changes: [{ address: `${K}/Wt33wait`, title: "Review", kind: "waiting" }],
							changed: 1,
						},
					},
				},
			],
			null,
			undefined,
		);
		// A phrase that starts with the title's quote has nothing to capitalise.
		expect(waiting?.title).toBe("“Review” is now waiting");
	});

	it("the shell has every label the card reads, in both languages", async () => {
		const { TASK_NOTICE_LABEL_FALLBACKS } = await import("@shared/pretext-layout/task-notice");
		const en = (await import("../../../locales/en/narrator.json")).default as never as {
			sidecar: { taskNotice: Record<string, string> };
		};
		const view = Object.keys(TASK_NOTICE_LABEL_FALLBACKS).filter((key) =>
			key.startsWith("taskNoticeView"),
		);
		expect(view.length).toBeGreaterThan(20);
		for (const key of view) {
			// Wired through `useVListLabels`, and translated (never the fallback by accident).
			expect(labels[key]).toBeString();
			const localeKey = `view${key.slice("taskNoticeView".length)}`;
			expect(zhNarrator.sidecar.taskNotice).toHaveProperty(localeKey);
			// The English file is the fallback, with i18next's braces.
			expect(en.sidecar.taskNotice[localeKey]?.replaceAll("{{", "{").replaceAll("}}", "}")).toBe(
				TASK_NOTICE_LABEL_FALLBACKS[key] as string,
			);
		}
	});
});

describe("answers to the session's questions (outline_answer)", () => {
	/** As the asking session gets it: a user row (the person's turn) carrying the injection. */
	function answerRow(body?: unknown) {
		return {
			kind: "message",
			msg: rowWithElements(
				{ id: "m-answer", role: "user", origin: "user", createdAt: "2026-11-03T09:13:00.000Z" },
				[
					{
						type: "system_injection",
						source: "outline_answer",
						modelText: `alice answered your questions in the outline:\n- Q3 [${K}/Zx81aaQe] 重试按钮放在哪里？ → option 2 (右上角), your recommendation`,
						...(body ? { body } : {}),
					},
				] as never,
			),
		} as AdapterSegment;
	}
	const BODY = {
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
				answer: { text: "先只修 Anthropic" },
				differs: true,
			},
		],
	};

	it("one line: who answered how many, the first question, its answer given the room", () => {
		const spec = specOf(answerRow(BODY));
		const data = spec.data as TaskNoticeData;
		expect(data).toMatchObject({ kind: "tasks_notice", variant: "answers", expandable: true });
		expect(data.title).toBe("alice 回答了 2 个提问");
		expect(data.summary.row).toMatchObject({
			title: "重试按钮放在哪里？",
			href: href("Zx81aaQe"),
			// The question's alias, as written.
			status: { label: "Q3", color: "teal" },
		});
		expect(data.summary.tail).toBe("→ 选 2. 消息气泡右上角；采纳了你的建议");
		// The answer is what the notice is for: the question gives way to it on the folded line.
		expect(data.summary.tailFirst).toBe(true);
	});

	it("unfolded, each answer has its own row under its question", () => {
		const data = specOf(answerRow(BODY), true).data as TaskNoticeData;
		expect(data.rows).toEqual([
			{
				title: "重试按钮放在哪里？",
				href: href("Zx81aaQe"),
				address: `${K}/Zx81aaQe`,
				status: { label: "Q3", color: "teal" },
			},
			{ title: "→ 选 2. 消息气泡右上角；采纳了你的建议", indent: true },
			{
				title: "要不要同时修 Codex 通道？",
				href: href("Zx81aaQf"),
				address: `${K}/Zx81aaQf`,
				marks: ["与你先做的不同"],
			},
			{ title: "→ “先只修 Anthropic”", indent: true },
		]);
	});

	it("a delivery written before the body keeps its card, under its own heading", () => {
		const spec = specOf(answerRow());
		expect(spec.data).toMatchObject({ kind: "origin_notice", title: "提问的回答" });
	});
});

describe("rows written before the structured data keep their card, read as plain text", () => {
	it("a prose turn-end note: the text once, no heading marks, escapes or code ticks", () => {
		const data = specOf(
			injection("m-old", "outline_task_turn_end", TURN_END_TEXT, {
				kind: "prose",
				text: TURN_END_TEXT,
			}),
		).data as { kind: string; title: string; text: string };
		expect(data.kind).toBe("origin_notice");
		expect(data.title).toBe("回合末任务提醒");
		expect(data.text).toBe(TURN_END_TEXT.replaceAll("`", ""));
	});

	it("a context_update without a summary keeps its line", () => {
		const data = specOf(contextUpdate("m-old-view", "Context updated: outline.tasks")).data as {
			kind: string;
			text: string;
		};
		expect(data.kind).toBe("info");
		expect(data.text).toBe("上下文已更新：当前任务");
	});
});

describe("measure and render agree; links open the outline only inside a host", () => {
	function render(segment: AdapterSegment, options: { expanded: boolean; host: boolean }) {
		const spec = specOf(segment, options.expanded);
		const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, 800, 5, spec.opts);
		const extra = resolveRenderExtra(spec) as Record<string, unknown>;
		let toggles = 0;
		extra.onToggle = () => {
			toggles++;
		};
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		act(() => {
			root.render(
				<MantineProvider>
					<OutlineOpenerProvider value={options.host ? { open: () => true } : null}>
						{renderElement(spec.kind, measured, extra)}
					</OutlineOpenerProvider>
				</MantineProvider>,
			);
		});
		return {
			measured,
			container: container as unknown as HTMLElement,
			toggles: () => toggles,
			unmount: () => {
				act(() => root.unmount());
				container.remove();
			},
		};
	}

	const style = (node: Element | null) => (node?.getAttribute("style") ?? "").replace(/\s+/g, "");

	it("folded: one line in the measured box, the first task linked", () => {
		const view = render(edited(), { expanded: false, host: true });
		expect(style(view.container.querySelector("[data-task-notice]"))).toContain(
			`height:${view.measured.height}px`,
		);
		expect(view.container.querySelectorAll("[data-task-notice-row]")).toHaveLength(0);
		const links = Array.from(view.container.querySelectorAll("a[data-outline-link]"));
		expect(links.map((a) => a.getAttribute("href"))).toEqual([href("mSsl3Ccf")]);
		expect(view.container.textContent).toContain("alice、bob 改了 3 个任务");
		expect(view.container.textContent).not.toContain("\\");
		// The folded line names the task's status now, not where it came from or who changed it
		// (the heading says who): one chip, no note.
		const summary = view.container.querySelector("[data-task-notice-summary]");
		expect(summary?.querySelectorAll("[data-task-notice-status]")).toHaveLength(1);
		expect(summary?.textContent).toContain("完成");
		expect(summary?.textContent).not.toContain("进行中");
		expect(summary?.querySelector("[data-task-notice-note]")).toBeNull();
		view.unmount();
	});

	it("unfolded: exactly the measured rows; the chevron toggles, a link does not", () => {
		const view = render(edited(), { expanded: true, host: true });
		const measured = view.measured as unknown as { height: number; rowCount: number };
		expect(style(view.container.querySelector("[data-task-notice]"))).toContain(
			`height:${measured.height}px`,
		);
		expect(view.container.querySelectorAll("[data-task-notice-row]")).toHaveLength(
			measured.rowCount,
		);
		expect(view.container.querySelectorAll("a[data-outline-link]")).toHaveLength(2);
		// A note may be cut by its line: its full text is the tooltip.
		const notes = Array.from(view.container.querySelectorAll("[data-task-notice-note]"));
		expect(notes.map((note) => note.getAttribute("title"))).toEqual(
			notes.map((note) => note.textContent),
		);
		expect(notes.map((note) => note.textContent)).toContain("bob；交给 @agent:review-1");
		const toggle = view.container.querySelector("[data-task-notice-toggle]") as HTMLButtonElement;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		act(() => toggle.click());
		expect(view.toggles()).toBe(1);
		act(() => (view.container.querySelector("a[data-outline-link]") as HTMLAnchorElement).click());
		expect(view.toggles()).toBe(1);
		view.unmount();
	});

	it("outside a host the titles are plain text, and a notice with one task has no toggle", () => {
		const view = render(turnEnd(), { expanded: false, host: false });
		expect(view.container.querySelectorAll("a")).toHaveLength(0);
		expect(view.container.querySelector("[data-task-notice-toggle]")).toBeNull();
		expect(view.container.textContent).toContain("排查中断后无重试按钮（只读，不改代码）");
		expect(view.container.textContent).toContain("进行中");
		view.unmount();
	});

	it("the view's changes: the heading keeps the folded line; unfolded, changed rows are marked", () => {
		const folded = render(viewUpdate("m-r-chg", CHANGED_VIEW), { expanded: false, host: true });
		expect(style(folded.container.querySelector("[data-task-notice]"))).toContain(
			`height:${folded.measured.height}px`,
		);
		// One line, whatever the sentence's length: the same height as any folded notice.
		expect(folded.measured.height).toBe(CARD_PADDING * 2 + line());
		const title = folded.container.querySelector("[data-task-notice-title]");
		expect(title?.textContent).toBe("完成『补测试』，开始『修竞态』，另有 4 项变化");
		// It does not give way to the summary (no 45% cap, the ordinary shrink), and a sentence
		// cut by a narrow line is whole in its tooltip.
		expect(style(title)).toContain("flex:01auto");
		expect(style(title)).not.toContain("max-width:45%");
		expect(title?.getAttribute("title")).toBe(title?.textContent);
		expect(style(title)).toContain("font-weight:600");
		expect(folded.container.querySelector("[data-task-notice-lead]")?.textContent).toBe(
			"进行中 2 · 等待 1 · 待办 3",
		);
		// The folded line names no task of its own: no chip, no link.
		expect(folded.container.querySelectorAll("[data-task-notice-status]")).toHaveLength(0);
		expect(folded.container.querySelectorAll("a[data-outline-link]")).toHaveLength(0);
		folded.unmount();

		const open = render(viewUpdate("m-r-chg", CHANGED_VIEW), { expanded: true, host: true });
		const measured = open.measured as unknown as { height: number; rowCount: number };
		expect(measured.rowCount).toBe(7);
		expect(measured.height).toBe(
			CARD_PADDING * 2 + line() + ORIGIN_HEADING_GAP + 7 * line() + 6 * TASK_NOTICE_ROW_GAP,
		);
		expect(style(open.container.querySelector("[data-task-notice]"))).toContain(
			`height:${measured.height}px`,
		);
		const rows = Array.from(open.container.querySelectorAll("[data-task-notice-row]"));
		expect(rows).toHaveLength(7);
		expect(rows.map((row) => row.hasAttribute("data-task-notice-changed"))).toEqual([
			true,
			true,
			true,
			false,
			true,
			false,
			false,
		]);
		// Every task row keeps the mark's width (coloured only on a changed one), so titles align.
		const marks = Array.from(open.container.querySelectorAll("[data-task-notice-mark]"));
		expect(marks).toHaveLength(6);
		expect(marks.map((mark) => style(mark).includes("background-color:transparent"))).toEqual([
			false,
			false,
			false,
			true,
			false,
			true,
		]);
		expect(rows[0]?.textContent).toContain("进行中→完成补测试");
		open.unmount();
	});

	it("a list that was only refreshed is drawn without emphasis; other notices are unchanged", () => {
		const quiet = render(viewUpdate("m-r-quiet", { ...CHANGED_VIEW, changes: [], changed: 0 }), {
			expanded: false,
			host: true,
		});
		const title = quiet.container.querySelector("[data-task-notice-title]");
		expect(title?.textContent).toBe("任务列表已刷新");
		expect(style(title)).toContain("font-weight:400");
		quiet.unmount();
		// An old view row and a people's-changes notice keep the heading that yields to the task,
		// and their rows carry no mark column.
		for (const segment of [viewUpdate("m-r-old", VIEW), edited()]) {
			const view = render(segment, { expanded: false, host: true });
			const heading = view.container.querySelector("[data-task-notice-title]");
			expect(style(heading)).toContain("flex:08auto");
			expect(style(heading)).toContain("max-width:45%");
			expect(heading?.hasAttribute("title")).toBe(false);
			view.unmount();
			const open = render(segment, { expanded: true, host: true });
			expect(open.container.querySelectorAll("[data-task-notice-mark]")).toHaveLength(0);
			expect(open.container.querySelectorAll("[data-task-notice-changed]")).toHaveLength(0);
			open.unmount();
		}
	});
});
