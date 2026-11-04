/**
 * Outline tool cards (PR-2) through the real chain: row → adapter → measure → render, with the
 * shell's real zh-CN labels (`useVListLabels`):
 *
 *   - the header says what the call did ("勾成完成 <task> · 记下 3 条") with `✓1 +3 #6` beside it,
 *     on the card and on its folded row alike;
 *   - the change list is one fixed line per change, so the card is exactly as tall as its rows;
 *   - the raw input and the model's result are folded under it; the fold rides the card's own
 *     channel (`isPromptOpen` / `onTogglePrompt`), and opening it re-keys the measured card;
 *   - an older call (no display) and a decision keep a change list too.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { OutlineOpenerProvider } from "@frontend/lib/outline-opener";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import zhCommon from "../../../locales/zh-CN/common.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import { segmentMessages } from "../message/message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { getCategory, getSummary } from "../tool-call/tool-display";
import {
	CHANGE_ROW_GAP,
	CHANGE_TOGGLE_GAP,
	changeRowHeight,
	type MeasuredToolCall,
} from "./measure/measure-tool-call";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { extractDataRevision } from "./measure-cache";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "./segment-adapter";
import { useVListLabels } from "./useVListLabels";

const K = "MTBXwl1Y";
const TASK = { address: `${K}/LUwB3JZb`, title: "修复：排查中断后无重试按钮" };
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

function tool(name: string, input: unknown, text: string, metadata: unknown): NarratorMsg {
	const outputJson = { _text: text, _metadata: metadata };
	return rowWithElements(
		{
			id: `a-${name}`,
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [
				{
					toolUseId: `tu-${name}`,
					toolName: name,
					inputJson: input,
					outputJson,
					status: "completed",
				},
			],
			createdAt: "2026-11-03T09:10:00.000Z",
		},
		[
			{
				type: "tool_use",
				id: `tu-${name}`,
				name,
				input,
				inputJson: input,
				outputJson,
				status: "completed",
			},
		],
	) as unknown as NarratorMsg;
}

const EDIT_INPUT = {
	edits: [
		{ add: "LUwB3JZb", markdown: "- 已提交并推送\n- 根因\n- 回归测试" },
		{ set: "LUwB3JZb", checkbox: "x" },
	],
};
const EDIT_TEXT = "Committed #6 to MTBXwl1Y · this session's notes (2 edits; …).";
const EDIT_META = {
	tool: "OutlineEdit",
	space: { key: K, kind: "session" },
	commit: { id: "c6", seq: 6 },
	edits: [
		{ op: "add", created: [`${K}/RQvana8Z`, `${K}/AEguaeis`, `${K}/FrhoTICE`] },
		{ op: "set", address: TASK.address },
	],
	display: {
		v: 1,
		space: { key: K, kind: "session", own: true },
		ops: [
			{
				op: "add",
				parent: TASK,
				created: [
					{ address: `${K}/RQvana8Z`, title: "已提交并推送", depth: 0 },
					{ address: `${K}/AEguaeis`, title: "根因", depth: 0 },
					{ address: `${K}/FrhoTICE`, title: "回归测试", depth: 0 },
				],
			},
			{ op: "set", target: TASK, status: { from: "doing", to: "done" } },
		],
	},
};

function ctx(options: { rawOpen?: boolean; lod?: 4 | 5 } = {}): AdapterContext {
	return {
		lod: options.lod ?? 5,
		labels,
		resolveToolCategory: getCategory,
		resolveToolSummary: (tc) => {
			const call = tc as { toolName: string; inputJson?: unknown; outputJson?: unknown };
			const meta = (call.outputJson as { _metadata?: Record<string, unknown> })?._metadata;
			return getSummary(call.toolName, call.inputJson, meta, labels);
		},
		isExpanded: () => true,
		isPromptOpen: () => options.rawOpen === true,
	};
}

function cardOf(message: NarratorMsg, options: { rawOpen?: boolean } = {}) {
	const specs = adaptSegments(
		segmentMessages([message]) as unknown as AdapterSegment[],
		ctx(options),
	);
	const spec = specs.find((s) => s.kind === "tool-call");
	if (!spec) throw new Error(`no tool-call spec: ${specs.map((s) => s.kind).join(",")}`);
	return spec;
}

function measure(spec: ReturnType<typeof cardOf>): MeasuredToolCall {
	return VLIST_REGISTRY[spec.kind].measure(spec.data, 760, 5, spec.opts) as MeasuredToolCall;
}

function render(spec: ReturnType<typeof cardOf>, onTogglePrompt?: () => void) {
	const measured = measure(spec);
	const extra = resolveRenderExtra(spec) as Record<string, unknown>;
	extra.narratorId = "n1";
	if (onTogglePrompt) extra.onTogglePrompt = onTogglePrompt;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<MantineProvider forceColorScheme="dark">
				<OutlineOpenerProvider value={{ open: () => true }}>
					{renderElement(spec.kind, measured, extra as never)}
				</OutlineOpenerProvider>
			</MantineProvider>,
		);
	});
	return {
		measured,
		container: container as unknown as HTMLElement,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("an OutlineEdit card", () => {
	const edit = tool("OutlineEdit", EDIT_INPUT, EDIT_TEXT, EDIT_META);

	it("says what it did in its header, with its figures beside it", () => {
		const spec = cardOf(edit);
		const data = spec.data as { summary: string; diffStats?: Record<string, number> };
		expect(data.summary).toBe("勾成完成 修复：排查中断后无重试按钮 · 记下 3 条");
		expect(data.diffStats).toEqual({ added: 3, removed: 0, done: 1, commit: 6 });
		const view = render(spec);
		const figures = view.container.querySelector("[data-nf-diff-stats]");
		expect(figures?.textContent).toBe("✓1+3#6");
		expect(figures?.getAttribute("aria-label")).toBe("✓1 +3 #6");
		view.unmount();
	});

	it("lists its changes, one measured line each, the raw input and result folded under them", () => {
		const spec = cardOf(edit);
		const view = render(spec);
		const rows = view.container.querySelectorAll("[data-outline-change-row]");
		expect(Array.from(rows).map((r) => r.textContent)).toEqual([
			"在修复：排查中断后无重试按钮下新增 3 块",
			"已提交并推送",
			"根因",
			"回归测试",
			"修复：排查中断后无重试按钮进行中→完成",
		]);
		// Exactly the rows' geometry: N lines, their gaps, the fold row.
		const body = view.container.querySelector("[data-outline-changes]");
		const line = changeRowHeight();
		expect((body?.getAttribute("style") ?? "").replace(/\s+/g, "")).toContain(
			`height:${5 * line + 4 * CHANGE_ROW_GAP + CHANGE_TOGGLE_GAP + line}px`,
		);
		expect(view.container.textContent).toContain("本会话笔记");
		expect(view.container.textContent).toContain("提交 #6 · 在时间线中查看 / 撤销");
		// Folded: neither the input nor the model's English result.
		expect(view.container.textContent).not.toContain("Committed #6");
		expect(view.container.textContent).not.toContain("**add**");
		view.unmount();
	});

	it("opens the fold through the card's own channel, and the open card is measured anew", () => {
		const folded = cardOf(edit);
		let toggles = 0;
		const view = render(folded, () => toggles++);
		const button = view.container.querySelector("[data-outline-raw-toggle]") as HTMLButtonElement;
		expect(button.textContent).toContain("原始输入 · 模型看到的结果");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.disabled).toBe(false);
		act(() => button.click());
		expect(toggles).toBe(1);
		view.unmount();

		const open = cardOf(edit, { rawOpen: true });
		expect(extractDataRevision(open.data)).not.toBe(extractDataRevision(folded.data));
		expect(measure(open).height).toBeGreaterThan(measure(folded).height);
		const openView = render(open);
		expect(openView.container.textContent).toContain("Committed #6");
		expect(
			openView.container.querySelector("[data-outline-raw-toggle]")?.getAttribute("aria-expanded"),
		).toBe("true");
		openView.unmount();
	});

	it("an older call (no display) lists its input's changes; a decision is not a bare Edit", () => {
		const legacy = cardOf(
			tool("OutlineEdit", EDIT_INPUT, EDIT_TEXT, { ...EDIT_META, display: undefined }),
		);
		expect((legacy.data as { summary: string }).summary).toBe("勾成完成 LUwB3JZb · 记下 3 条");
		const view = render(legacy);
		expect(
			Array.from(view.container.querySelectorAll("[data-outline-change-row]")).map(
				(r) => r.textContent,
			),
		).toContain("LUwB3JZb→完成");
		view.unmount();

		const decision = cardOf(
			tool("OutlineEdit", { edits: [{ confirm: "P1a2B3c4D" }] }, "1. Confirmed P1a2B3c4D", {
				tool: "OutlineEdit",
				decided: [{ confirm: "P1a2B3c4D", commit: { id: "c9", seq: 9 }, space: K }],
			}),
		);
		expect((decision.data as { summary: string }).summary).toBe("确认 P1a2B3c4D → #9");
		const decided = render(decision);
		expect(decided.container.querySelector("[data-outline-change-row]")?.textContent).toBe(
			"确认了P1a2B3c4D→提交 #9",
		);
		decided.unmount();
	});
});
