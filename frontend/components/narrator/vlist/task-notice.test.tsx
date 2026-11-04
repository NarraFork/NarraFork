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
});
