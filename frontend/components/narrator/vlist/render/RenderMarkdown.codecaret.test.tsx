/**
 * RenderMarkdown.codecaret.test.tsx — a drag-selection inside a MULTI-LINE fenced
 * code block must never snap back to the top of the history.
 *
 * The bug this locks down (the one the first caret-filler pass missed): every code
 * row was painted as a shrink-to-fit absolute box — `top` only, no `height`, and a
 * `font` shorthand that resets `line-height` to `normal` (~13px at 11px) inside a
 * 17px slot. So two strips inside the panel belonged to NO line box:
 *   - the ~4px of leading between consecutive rows,
 *   - the blank remainder of each row past its last glyph, plus the panel padding.
 * Every child of the panel is absolutely positioned, so the panel has no in-flow
 * line box to fall back on either. A pointer crossing one of those strips resolved
 * no caret, the browser fell back to the scroll container's FIRST position, and the
 * selection focus jumped to the start of the history mid-drag.
 *
 * The fix is geometric, so the assertions are geometric: consecutive rows must
 * TILE the line stack (row N's bottom == row N+1's top) and span the panel's full
 * inner width, with the padding strips covered by a CaretFiller. All of it has to
 * hold WITHOUT changing the measured height (CONTRACT §0 iron law 2).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";

const CONTENT_WIDTH = 800;
const CODE_LINES = ["const a = 1;", "const b = 2;", "console.log(a + b);"];

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
	/** The fenced panel host (the element the measure layer sized). */
	panel: Element;
	/** Predicted height of the code block from the measure layer. */
	predictedHeight: number;
	/** The code block's own line height (the slot each row must fill). */
	lineHeight: number;
	unmount: () => void;
}

async function renderCode(markdown: string, width = CONTENT_WIDTH): Promise<Rendered> {
	// Dynamic imports: the canvas stub must be installed before the pretext-backed
	// modules load (CONTRACT §5).
	const { measureMarkdown } = await import("../measure/measure-markdown");
	const { RenderMarkdown } = await import("./RenderMarkdown");
	const measured = measureMarkdown(markdown, width);
	const codeIndex = measured.blocks.findIndex((block) => block.kind === "code");
	if (codeIndex < 0) throw new Error("expected the markdown to produce a code block");
	const codeBlock = measured.blocks[codeIndex];
	if (!codeBlock || codeBlock.kind !== "code") throw new Error("code block missing");

	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	act(() => {
		reactRoot.render(
			<MantineProvider>
				<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
					<RenderMarkdown measured={measured} />
				</RenderLodCtx.Provider>
			</MantineProvider>,
		);
	});
	const panel = container.querySelector('[style*="--vlist-code-bg"]');
	if (!panel) throw new Error("code panel not rendered");

	return {
		container,
		panel,
		predictedHeight: measured.frame.blocks[codeIndex]?.height ?? 0,
		lineHeight: codeBlock.lineHeight,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

/** Parse a px value out of an inline style attribute (0 when absent). */
function pxOf(el: Element, prop: string): number {
	const style = el.getAttribute("style") ?? "";
	const match = new RegExp(`(?:^|;)\\s*${prop}:\\s*([\\d.]+)px`).exec(style);
	return match ? Number.parseFloat(match[1] ?? "0") : 0;
}

/** Raw declaration value, so absence is distinguishable from `0px`. */
function declOf(el: Element, prop: string): string | null {
	const style = el.getAttribute("style") ?? "";
	const match = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(style);
	return match ? (match[1] ?? "").trim() : null;
}

/**
 * The painted code rows.
 *
 * Selected by the code FOREGROUND variable rather than by the marker attribute the
 * fix introduced: that keeps this suite discriminating. Were the rows found only by
 * `data-vlist-code-line`, a regression that drops the attribute would return an
 * EMPTY list and every per-row geometry assertion would pass vacuously. The
 * foreground colour is what a code row has always carried, so the geometry checks
 * run against whatever the render layer actually paints.
 */
const codeRows = (panel: Element) =>
	Array.from(panel.querySelectorAll('[style*="--vlist-code-fg"]'));
const fillers = (panel: Element) => Array.from(panel.querySelectorAll("[data-vlist-caret-filler]"));

describe("fenced code drag-selection geometry (virtual list)", () => {
	it("tiles consecutive code rows so no leading strip is caret-less", async () => {
		const view = await renderCode(`\`\`\`js\n${CODE_LINES.join("\n")}\n\`\`\``);
		const rows = codeRows(view.panel);
		expect(rows.length).toBe(CODE_LINES.length);

		for (const row of rows) {
			// The row must FILL its slot: a shorter box (the `font` shorthand's
			// `line-height: normal`) is exactly what left the leading uncovered.
			expect(pxOf(row, "height")).toBe(view.lineHeight);
			expect(declOf(row, "line-height")).toBe(`${view.lineHeight}px`);
		}
		// Row N's bottom is row N+1's top — zero gap anywhere in the stack.
		for (let i = 1; i < rows.length; i++) {
			const previous = rows[i - 1] as Element;
			const current = rows[i] as Element;
			expect(pxOf(current, "top")).toBe(pxOf(previous, "top") + pxOf(previous, "height"));
		}
		view.unmount();
	});

	it("stretches each row past its glyphs to the panel's inner edges", async () => {
		const view = await renderCode(`\`\`\`js\n${CODE_LINES.join("\n")}\n\`\`\``);
		// The panel's padding box: its border-box width minus the 1px border per side.
		const innerWidth = pxOf(view.panel, "width") - 2;
		for (const row of codeRows(view.panel)) {
			// Full-bleed box (so the blank remainder of a short line still resolves a
			// caret) with the glyphs still inset by the panel's own x padding.
			expect(pxOf(row, "width")).toBe(innerWidth);
			expect(pxOf(row, "left")).toBe(0);
			expect(pxOf(row, "padding-left")).toBeGreaterThan(0);
			expect(declOf(row, "box-sizing")).toBe("border-box");
			// A long line must still be able to overflow (and be clipped by the panel),
			// which is what `min-width: max-content` preserves.
			expect(declOf(row, "min-width")).toBe("max-content");
		}
		view.unmount();
	});

	it("covers the panel's top and bottom padding with caret fillers", async () => {
		const view = await renderCode(`\`\`\`js\n${CODE_LINES.join("\n")}\n\`\`\``);
		const rows = codeRows(view.panel);
		const firstRowTop = pxOf(rows[0] as Element, "top");
		const lastRow = rows[rows.length - 1] as Element;
		const linesBottom = pxOf(lastRow, "top") + pxOf(lastRow, "height");
		const innerHeight = view.predictedHeight - 2; // padding box (1px border/side)

		const strips = fillers(view.panel).map((el) => ({
			top: pxOf(el, "top"),
			height: pxOf(el, "height"),
		}));
		// Top strip: from the panel's inner top edge down to the first row (this is
		// where the language label sits, and it carries no line box of its own).
		expect(strips).toContainEqual({ top: 0, height: firstRowTop });
		// Bottom strip: from the end of the line stack to the panel's inner bottom.
		expect(strips).toContainEqual({
			top: linesBottom,
			height: innerHeight - linesBottom,
		});
		view.unmount();
	});

	it("keeps the panel geometry identical to the predicted height", async () => {
		// The whole fix must be height-neutral: rows now fill their slots and two
		// fillers were added, but the measure layer's number is unchanged.
		const view = await renderCode(`\`\`\`js\n${CODE_LINES.join("\n")}\n\`\`\``);
		expect(pxOf(view.panel, "height")).toBe(view.predictedHeight);
		const rows = codeRows(view.panel);
		const lastRow = rows[rows.length - 1] as Element;
		// The painted stack must fit inside the reserved box, never overflow it.
		expect(pxOf(lastRow, "top") + pxOf(lastRow, "height")).toBeLessThanOrEqual(
			view.predictedHeight,
		);
		view.unmount();
	});

	it("holds for a code block with no language label", async () => {
		// Without a lang label the top strip is just the box padding; it must still be
		// filled, and the rows must still tile.
		const view = await renderCode(`\`\`\`\n${CODE_LINES.join("\n")}\n\`\`\``);
		const rows = codeRows(view.panel);
		expect(rows.length).toBe(CODE_LINES.length);
		const firstRowTop = pxOf(rows[0] as Element, "top");
		expect(firstRowTop).toBeGreaterThan(0);
		expect(fillers(view.panel).map((el) => pxOf(el, "top"))).toContain(0);
		for (let i = 1; i < rows.length; i++) {
			const previous = rows[i - 1] as Element;
			const current = rows[i] as Element;
			expect(pxOf(current, "top")).toBe(pxOf(previous, "top") + pxOf(previous, "height"));
		}
		view.unmount();
	});
});
