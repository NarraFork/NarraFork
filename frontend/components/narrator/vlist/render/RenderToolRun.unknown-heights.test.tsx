import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installCanvasStub } from "../measure/test-canvas-stub";

let naturalHeight = 600;
const observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
	node: Element | null = null;
	disconnected = false;
	constructor(private callback: () => void) {
		observers.push(this);
	}
	observe(node: Element) {
		this.node = node;
	}
	disconnect() {
		this.disconnected = true;
	}
	unobserve() {}
	fire() {
		this.callback();
	}
}

beforeAll(() => {
	installCanvasStub();
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(globalThis, {
		window: win,
		document: win.document,
		navigator: win.navigator,
		HTMLElement: win.HTMLElement,
		Element: win.Element,
		Node: win.Node,
		ResizeObserver: FakeResizeObserver,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
	});
	win.HTMLElement.prototype.getBoundingClientRect = function () {
		if (!this.hasAttribute("data-md-body"))
			throw new Error("Unexpected ordinary body geometry read");
		return {
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 400,
			bottom: naturalHeight,
			width: 400,
			height: naturalHeight,
			toJSON() {},
		};
	};
});

async function measured(expanded = true, diagram = true) {
	const { measureActivityTrace } = await import("../measure/measure-tool-run");
	return measureActivityTrace(
		[
			{
				key: "diagram",
				title: "diagram",
				bodyText: diagram
					? `\`\`\`mermaid\n\n\`\`\`\n\n${"paragraph\n\n".repeat(30)}`
					: "ordinary text",
			},
			{ key: "after", title: "following row" },
		],
		400,
		{ itemsOpened: true, expandedIndices: [0], textExpandedKeys: expanded ? ["diagram"] : [] },
		{},
		5,
	);
}

function mdObservers() {
	return observers.filter((observer) => observer.node?.hasAttribute("data-md-body"));
}
function px(node: Element | null, name: "top" | "height" | "minHeight") {
	if (!node) throw new Error("Missing trace DOM node");
	return Number.parseFloat((node as HTMLElement).style[name]);
}

describe("expanded unknown trace body correction", () => {
	it("reflows the containing row, all following rows and trace chrome after controlled RO feedback", async () => {
		const { RenderToolRun } = await import("./RenderToolRun");
		const original = await measured();
		const body = original.rows[0]?.body;
		if (!body?.textPreview) throw new Error("Missing expanded fixture body");
		observers.length = 0;
		naturalHeight = body.frame.contentHeight + 200;
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const totals: number[] = [];
		const report = (height: number) => totals.push(height);
		const tree = (value = original) => (
			<MantineProvider>
				<RenderToolRun measured={value} onUnknownHeight={report} />
			</MantineProvider>
		);
		try {
			await act(async () => {
				root.render(tree());
			});
			const observer = mdObservers()[0];
			if (!observer) throw new Error("Missing controlled markdown observer");
			const initialAfter = px(host.querySelector('[data-nf-trace-row="after"]'), "top");
			await act(async () => {
				observer.fire();
			});
			expect(px(host.querySelector('[data-nf-trace-row="after"]'), "top")).toBeCloseTo(
				initialAfter + 200,
			);
			expect(px(host.querySelector('[data-nf-trace-block="diagram"]'), "height")).toBeCloseTo(
				(original.rows[0]?.blockHeight ?? 0) + 200,
			);
			expect(px(host.querySelector("[data-vlist-text-preview]"), "minHeight")).toBeCloseTo(
				naturalHeight + body.textPreview.buttonHeight,
			);
			expect(totals.at(-1)).toBeCloseTo(original.height + 200);
			expect(px(observer.node, "minHeight")).toBe(body.frame.contentHeight);
			naturalHeight = body.frame.contentHeight + 100;
			await act(async () => {
				observer.fire();
			});
			expect(totals.at(-1)).toBeCloseTo(original.height + 100);
			expect(px(host.querySelector('[data-nf-trace-row="after"]'), "top")).toBeCloseTo(
				initialAfter + 100,
			);
			expect(px(observer.node, "minHeight")).toBe(body.frame.contentHeight);
			naturalHeight = body.frame.contentHeight + 250;
			await act(async () => {
				observer.fire();
			});
			expect(totals.at(-1)).toBeCloseTo(original.height + 250);
			const totalCount = totals.length;
			naturalHeight++;
			await act(async () => {
				observer.fire();
			});
			expect(totals.length).toBe(totalCount);
			expect(mdObservers().filter((candidate) => !candidate.disconnected).length).toBe(1);

			// A new source body must immediately forget the old measurement. Late RO
			// callbacks from the disconnected source cannot correct the replacement.
			const rewritten = await measured();
			await act(async () => {
				root.render(tree(rewritten));
			});
			expect(px(host.querySelector('[data-nf-trace-row="after"]'), "top")).toBeCloseTo(
				rewritten.rows[1]?.top ?? 0,
			);
			const afterRewrite = totals.length;
			naturalHeight += 500;
			await act(async () => {
				observer.fire();
			});
			expect(totals.length).toBe(afterRewrite);
			const current = mdObservers().find((candidate) => !candidate.disconnected);
			if (!current) throw new Error("Missing replacement observer");
			await act(async () => {
				current.fire();
			});
			expect(totals.at(-1)).toBeCloseTo(
				rewritten.height +
					Math.round(naturalHeight) -
					(rewritten.rows[0]?.body?.frame.contentHeight ?? 0),
			);

			const collapsed = await measured(false);
			await act(async () => {
				root.render(tree(collapsed));
			});
			expect(mdObservers().filter((candidate) => !candidate.disconnected).length).toBe(0);
			expect(px(host.querySelector('[data-nf-trace-row="after"]'), "top")).toBeCloseTo(
				collapsed.rows[1]?.top ?? 0,
			);
			await act(async () => {
				current.fire();
			});
			expect(px(host.querySelector('[data-nf-trace-row="after"]'), "top")).toBeCloseTo(
				collapsed.rows[1]?.top ?? 0,
			);
		} finally {
			await act(async () => {
				root.unmount();
			});
			host.remove();
		}
	});

	it("keeps ordinary/preview traces hook-free and never observes their geometry", async () => {
		const { RenderToolRun } = await import("./RenderToolRun");
		for (const value of [await measured(false), await measured(true, false)]) {
			// Existing pure callers must still be allowed to invoke the renderer.
			expect(RenderToolRun({ measured: value })).not.toBeNull();
			observers.length = 0;
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = createRoot(host);
			try {
				await act(async () => {
					root.render(
						<MantineProvider>
							<RenderToolRun measured={value} />
						</MantineProvider>,
					);
				});
				expect(mdObservers().length).toBe(0);
			} finally {
				await act(async () => {
					root.unmount();
				});
				host.remove();
			}
		}
	});
});
