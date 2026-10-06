/**
 * RenderToolRun.lifecycle.test.tsx — a folded trace row through a live lifecycle.
 *
 * Two render-layer halves of the low-LOD lifecycle work:
 *
 *  1. A LIVE reasoning row with no text yet paints a placeholder instead of an empty
 *     label, and its label fades only when it SWITCHES form (placeholder → title,
 *     title → tail) — never when a row merely mounts or its text grows.
 *  2. A row the system drilled open for a live permission form (`pinnedOpen`) binds
 *     no toggle: the reader answers the form, and the row closes by itself.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { TRACE_SHIMMER_CLASS } from "@shared/tool-shimmer";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { measureReasoning } from "../measure/measure-reasoning";
import { measureActivityTrace, measureCollapsibleTrace } from "../measure/measure-tool-run";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderReasoning } from "./RenderReasoning";
import { RenderToolRun, type TraceRenderLabels } from "./RenderToolRun";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

const WIDTH = 700;
const FADE = "vlist-trace-label-in";

let host: HTMLElement;

beforeAll(() => {
	const { window: win, document: doc } = parseHTML(
		"<!doctype html><html><body><div id='host'></div></body></html>",
	);
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = doc;
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
	host = doc.getElementById("host") as unknown as HTMLElement;
});

const LABELS: TraceRenderLabels = {
	reasoningPending: "正在思考",
	reasoningEmpty: "思考已完成（无可见摘要）",
};

/** One live reasoning row (no status: that is what marks it as reasoning). */
function reasoningTrace(title: string, shimmer = true) {
	return measureActivityTrace(
		[{ title, hasIcon: true, iconColor: "grape", key: "r-run0-0-step-0", shimmer }],
		WIDTH,
	);
}

function mount(): { root: Root; render: (node: React.ReactNode) => void } {
	const root = createRoot(host);
	return {
		root,
		render: (node) =>
			act(() => {
				root.render(<MantineProvider defaultColorScheme="dark">{node}</MantineProvider>);
			}),
	};
}

function rowText(): string {
	return host.querySelector("[data-nf-trace-titlerow]")?.textContent ?? "";
}

function fadedLabels(): number {
	return host.querySelectorAll(`.${FADE}`).length;
}

describe("live reasoning row label", () => {
	it("paints a placeholder while the row has no text", () => {
		const { root, render } = mount();
		render(<RenderToolRun measured={reasoningTrace("")} labels={LABELS} />);
		expect(rowText()).toContain("正在思考");
		expect(host.querySelector(`.${TRACE_SHIMMER_CLASS.streaming}`)).not.toBeNull();
		// A freshly mounted row is not a switch.
		expect(fadedLabels()).toBe(0);
		act(() => root.unmount());
	});

	it("fades the label in when its first title replaces the placeholder", () => {
		const { root, render } = mount();
		render(<RenderToolRun measured={reasoningTrace("")} labels={LABELS} />);
		render(<RenderToolRun measured={reasoningTrace("分析构建脚本")} labels={LABELS} />);
		expect(rowText()).toContain("分析构建脚本");
		expect(fadedLabels()).toBeGreaterThan(0);
		act(() => root.unmount());
	});

	it("does not re-fade while the title merely grows", () => {
		const { root, render } = mount();
		render(<RenderToolRun measured={reasoningTrace("分析")} labels={LABELS} />);
		render(<RenderToolRun measured={reasoningTrace("分析构建")} labels={LABELS} />);
		render(<RenderToolRun measured={reasoningTrace("分析构建脚本")} labels={LABELS} />);
		expect(fadedLabels()).toBe(0);
		act(() => root.unmount());
	});

	it("settles an empty summary with an honest label and stops its shimmer", () => {
		const { root, render } = mount();
		render(<RenderToolRun measured={reasoningTrace("")} labels={LABELS} />);
		render(<RenderToolRun measured={reasoningTrace("", false)} labels={LABELS} />);
		expect(rowText()).toContain("思考已完成（无可见摘要）");
		expect(rowText()).not.toContain("正在思考");
		expect(host.querySelector(`.${TRACE_SHIMMER_CLASS.streaming}`)).toBeNull();
		act(() => root.unmount());
	});

	it("treats a whitespace-only summary as empty", () => {
		const { root, render } = mount();
		render(<RenderToolRun measured={reasoningTrace(" \n\t ")} labels={LABELS} />);
		expect(rowText()).toContain("正在思考");
		expect(host.querySelector(`.${TRACE_SHIMMER_CLASS.streaming}`)).not.toBeNull();
		render(<RenderToolRun measured={reasoningTrace(" \n\t ", false)} labels={LABELS} />);
		expect(rowText()).toContain("思考已完成（无可见摘要）");
		expect(host.querySelector(`.${TRACE_SHIMMER_CLASS.streaming}`)).toBeNull();
		act(() => root.unmount());
	});

	it("uses meaningful fallbacks when labels are omitted", () => {
		const { root, render } = mount();
		render(<RenderToolRun measured={reasoningTrace("")} />);
		expect(rowText()).toContain("Thinking");
		expect(host.querySelector(`.${TRACE_SHIMMER_CLASS.streaming}`)).not.toBeNull();
		render(<RenderToolRun measured={reasoningTrace("", false)} />);
		expect(rowText()).toContain("Thought complete (no visible summary)");
		act(() => root.unmount());
	});

	it("does not replace an empty tool title with a reasoning label", () => {
		const { root, render } = mount();
		const measured = measureActivityTrace(
			[{ title: "", hasIcon: true, iconColor: "gray", status: "success" }],
			WIDTH,
		);
		render(<RenderToolRun measured={measured} labels={LABELS} />);
		expect(rowText()).not.toContain("思考已完成");
		expect(rowText()).not.toContain("正在思考");
		act(() => root.unmount());
	});
});

describe("standalone reasoning live indicator", () => {
	it("uses the same text shimmer without changing the measured form", () => {
		const { root, render } = mount();
		const measured = measureReasoning({ text: "", isStreaming: true }, WIDTH);
		expect(measured.form).toBe("streaming");
		render(<RenderReasoning measured={measured} labels={{ thinking: "正在思考" }} />);
		expect(host.textContent).toContain("正在思考");
		expect(host.querySelector(`.${TRACE_SHIMMER_CLASS.streaming}`)).not.toBeNull();
		act(() => root.unmount());
	});
});

describe("a row drilled open for a live permission form", () => {
	it("binds no toggle, so the reader cannot fold it away from the form", () => {
		// `measureCollapsibleTrace` is the entry point the adapter uses, and the one
		// whose item type carries `pinnedOpen` (the activity wrapper is a test helper).
		const measured = measureCollapsibleTrace(
			{
				variant: "activity",
				items: [
					{
						title: "Bash · npm run build",
						hasIcon: true,
						iconColor: "gray",
						key: "tool-t1",
						status: "pending",
						canDrillDown: true,
						pinnedOpen: true,
					},
					{
						title: "Read · a.ts",
						hasIcon: true,
						iconColor: "gray",
						key: "tool-t2",
						status: "success",
						canDrillDown: true,
					},
				],
			},
			WIDTH,
		);
		const toggled: string[] = [];
		const { root, render } = mount();
		render(
			<RenderToolRun
				measured={measured}
				labels={LABELS}
				onToggleRow={(_index, key) => toggled.push(key)}
			/>,
		);
		const rows = host.querySelectorAll("[data-nf-trace-titlerow]");
		expect(rows.length).toBe(2);
		// The pinned row is not a button; its sibling still is.
		expect(rows[0]?.getAttribute("role")).toBeNull();
		expect(rows[1]?.getAttribute("role")).toBe("button");
		act(() => {
			(rows[0] as unknown as { click: () => void }).click();
			(rows[1] as unknown as { click: () => void }).click();
		});
		expect(toggled).toEqual(["tool-t2"]);
		act(() => root.unmount());
	});
});
