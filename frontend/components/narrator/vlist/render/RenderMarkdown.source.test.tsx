/**
 * RenderMarkdown.source.test.tsx — "view source" on a PLAIN markdown message must
 * actually change what is on screen.
 *
 * The bug this locks down: every markdown body's hover bar offered a
 * source/rendered toggle, but only the tool-card and subagent renderers read the
 * resulting state. On a plain assistant message the button lit up indigo and the
 * rendered markdown stayed exactly as it was — a control that looked live and did
 * nothing.
 *
 * The fix cannot be "let the source view size itself", which is what the chunked
 * `ContentViewer` does: this row's height was committed arithmetically from the
 * RENDERED markdown (headings, lists, wrapped prose), while the raw source is
 * unwrapped monospace text with a completely different line count. So the source
 * goes into a box pinned to the measured height and scrolls internally, and the
 * load-bearing assertion here is the CONTRACT's first iron law — toggling must not
 * move the row.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";

const CONTENT_WIDTH = 800;
/** Heading + list + prose: the rendered and raw forms differ in text AND line count. */
const MARKDOWN = "# Title\n\nsome **bold** prose\n\n- one\n- two";

beforeAll(() => {
	installCanvasStub();
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
});

interface Rendered {
	container: Element;
	/** The measured height the row reserved (identical across both views). */
	predictedHeight: number;
	unmount: () => void;
}

/** Measure + render one markdown string through the real measure/render pair. */
async function renderBody(
	markdown: string,
	opts: { showSource?: boolean } = {},
): Promise<Rendered> {
	// Dynamic imports: the canvas stub must be installed before the pretext-backed
	// modules load (CONTRACT §5).
	const { measureMarkdown } = await import("../measure/measure-markdown");
	const { RenderMarkdown } = await import("./RenderMarkdown");
	const measured = measureMarkdown(markdown, CONTENT_WIDTH);

	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	act(() => {
		reactRoot.render(
			<MantineProvider>
				<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
					<RenderMarkdown
						measured={measured}
						showSource={opts.showSource}
						sourceText={opts.showSource ? markdown : undefined}
					/>
				</RenderLodCtx.Provider>
			</MantineProvider>,
		);
	});

	return {
		container,
		predictedHeight: measured.frame.contentHeight,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

/** Parse a px value out of an inline style attribute. */
function pxOf(el: Element, prop: string): number {
	const style = el.getAttribute("style") ?? "";
	const match = new RegExp(`(?:^|;)\\s*${prop}:\\s*([\\d.]+)px`).exec(style);
	return match ? Number.parseFloat(match[1] ?? "0") : 0;
}

function sourceBox(root: Element): Element | null {
	return root.querySelector("[data-vlist-markdown-source]");
}

describe("plain markdown rows honour the source toggle", () => {
	it("paints the raw markdown, markers included", async () => {
		const r = await renderBody(MARKDOWN, { showSource: true });
		const text = r.container.textContent ?? "";
		// The markers are the whole point: the rendered form strips `#`, `**` and `-`.
		expect(text).toContain("# Title");
		expect(text).toContain("**bold**");
		expect(text).toContain("- one");
		r.unmount();
	});

	it("renders the markdown normally when the toggle is off", async () => {
		const r = await renderBody(MARKDOWN);
		const text = r.container.textContent ?? "";
		expect(text).toContain("Title");
		expect(text).not.toContain("# Title");
		expect(sourceBox(r.container)).toBeNull();
		r.unmount();
	});

	it("keeps the row at its measured height (CONTRACT iron law 1)", async () => {
		const rendered = await renderBody(MARKDOWN);
		const source = await renderBody(MARKDOWN, { showSource: true });

		const box = sourceBox(source.container);
		if (!box) throw new Error("expected a source box");
		// One box, pinned to the same height the rendered form occupies — so flipping
		// the toggle cannot move this row or any row below it.
		expect(pxOf(box, "height")).toBeCloseTo(rendered.predictedHeight, 1);
		expect(pxOf(box, "width")).toBeCloseTo(CONTENT_WIDTH, 1);
		// Overflow scrolls inside the reserved box rather than growing it.
		// Vertical-only: the source is pre-wrap, so horizontal overflow is a paint
		// artifact and must not summon a scrollbar.
		expect(box.getAttribute("style")).toMatch(/overflow-y:\s*auto/);
		expect(box.getAttribute("style")).toMatch(/overflow-x:\s*hidden/);

		rendered.unmount();
		source.unmount();
	});

	it("shows the raw text in an EXPANDED reasoning body too", async () => {
		// Reasoning routes its body through RenderMarkdown, so the toggle must survive
		// that hop — and only the expanded form has a body at all (the shell gates the
		// affordance on `measured.form`, see canShowRowSourceInline).
		const { measureReasoning } = await import("../measure/measure-reasoning");
		const { RenderReasoning } = await import("./RenderReasoning");
		const text = `# Thought\n\n${"word\n".repeat(20)}LAST\n\n- step`;
		const measured = measureReasoning({ text }, CONTENT_WIDTH, 5, { expanded: true });
		expect(measured.form).toBe("expanded");
		expect(measured.textPreview?.clipped).toBe(false);

		const container = document.createElement("div");
		document.body.appendChild(container);
		const reactRoot = createRoot(container);
		act(() => {
			reactRoot.render(
				<MantineProvider>
					<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
						<RenderReasoning measured={measured} showSource sourceText={text} />
					</RenderLodCtx.Provider>
				</MantineProvider>,
			);
		});
		expect(container.textContent ?? "").toContain("# Thought");
		const box = sourceBox(container);
		if (!box) throw new Error("expected a source box");
		expect(box.textContent).toBe(text);
		expect(box.getAttribute("style")).toMatch(/overflow-y:\s*auto/);
		expect(container.querySelector("[data-vlist-text-preview-toggle]")).toBeNull();
		// Pinned to the reasoning BODY's measured height, so the card cannot move.
		expect(pxOf(box, "height")).toBeCloseTo(measured.frame.contentHeight, 1);
		act(() => reactRoot.unmount());
		container.remove();
	});

	it("falls back to the render when no source text was supplied", async () => {
		// `showSource` without `sourceText` must not blank the row — the shell only
		// pairs them, but the renderer should not depend on that.
		const { measureMarkdown } = await import("../measure/measure-markdown");
		const { RenderMarkdown } = await import("./RenderMarkdown");
		const measured = measureMarkdown(MARKDOWN, CONTENT_WIDTH);
		const container = document.createElement("div");
		document.body.appendChild(container);
		const reactRoot = createRoot(container);
		act(() => {
			reactRoot.render(
				<MantineProvider>
					<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
						<RenderMarkdown measured={measured} showSource />
					</RenderLodCtx.Provider>
				</MantineProvider>,
			);
		});
		expect(sourceBox(container)).toBeNull();
		expect(container.textContent ?? "").toContain("Title");
		act(() => reactRoot.unmount());
		container.remove();
	});
});
