/**
 * RenderMarkdown.table-math.test.tsx — LaTeX inside a GFM table cell must RENDER.
 *
 * The bug this locks down: a table cell is prepared through the same inline walker
 * as a paragraph, so `mathPiece` runs and the formula correctly reserves its
 * measured width in the cell's flow (the column solver even sizes the column for
 * it). But `PreparedTableCell` carried no `mathHtmls` slot, so the KaTeX markup was
 * dropped on the floor at the prepared layer, and `TableCellView` hardcoded
 * `math: null` for every fragment. The cell therefore painted the ATOM PLACEHOLDER
 * — a non-breaking space — so a formula in a table showed up as blank space of
 * exactly the right width.
 *
 * Both halves are asserted, because either one alone leaves the bug in place:
 *   1. the prepared cell CARRIES the math payload (parse/measure layer);
 *   2. the rendered cell PAINTS it as a KaTeX host, not an NBSP (render layer);
 *   3. the row is tall enough for a stacked formula (a fraction in a cell must not
 *      be clipped — the table's own lineHeight has to account for it);
 *   4. ordinary cells are untouched (no math payload, no behaviour change).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";

const CONTENT_WIDTH = 800;
const MEASURED_BASE_PX = 14;

/** The placeholder glyph an unrendered math atom would paint (parse-markdown). */
const MATH_ATOM_PLACEHOLDER = "\u00a0";

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

async function prepare(markdown: string) {
	const { ensureKatexLoaded } = await import("../katex-runtime");
	await ensureKatexLoaded(markdown);
	const { parseMarkdownToPreparedBlocks } = await import("../parse-markdown");
	const { markdownMathSupport } = await import("../measure/math-support");
	return parseMarkdownToPreparedBlocks(markdown, markdownMathSupport());
}

async function renderMarkdownBody(markdown: string, width = CONTENT_WIDTH) {
	const { ensureKatexLoaded } = await import("../katex-runtime");
	await ensureKatexLoaded(markdown);
	const { measureMarkdown } = await import("../measure/measure-markdown");
	const { RenderMarkdown } = await import("./RenderMarkdown");
	const measured = measureMarkdown(markdown, width);

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
	return {
		container: container as unknown as Element,
		measured,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

const TABLE = "| 符号 | 公式 |\n|---|---|\n| 质能 | $E = mc^2$ |";

describe("prepared layer carries a cell's math payload", () => {
	it("keeps the KaTeX markup on the table cell", async () => {
		const blocks = await prepare(TABLE);
		const table = blocks.find((b) => b.kind === "table");
		expect(table).toBeDefined();
		if (table?.kind !== "table") return;

		const cell = table.rows[0]?.[1];
		expect(cell).toBeDefined();
		// The atom already reserves the right width — that part always worked.
		expect(cell?.classNames.some((c) => c.includes("vlist-frag--math"))).toBe(true);
		// What was missing: the markup needed to actually paint it.
		const fragment = cell?.mathHtmls?.find((m) => m);
		expect(fragment).toBeDefined();
		expect(fragment?.latex).toBe("E = mc^2");
		expect(fragment?.html).toContain("katex");
		expect(fragment?.width).toBeGreaterThan(0);
	});

	it("adds no math payload to a formula-free table", async () => {
		const blocks = await prepare("| a | b |\n|---|---|\n| 1 | 2 |");
		const table = blocks.find((b) => b.kind === "table");
		if (table?.kind !== "table") return;
		expect(table.rows[0]?.[0]?.mathHtmls).toBeUndefined();
	});

	it("carries math in header cells too", async () => {
		const blocks = await prepare("| $x^2$ | plain |\n|---|---|\n| 1 | 2 |");
		const table = blocks.find((b) => b.kind === "table");
		if (table?.kind !== "table") return;
		expect(table.header[0]?.mathHtmls?.find((m) => m)?.latex).toBe("x^2");
	});
});

describe("render layer paints math in a table cell", () => {
	const mathHosts = (root: Element) => root.querySelectorAll('[data-vlist-math="inline"]');

	it("renders a KaTeX host instead of the atom placeholder", async () => {
		const view = await renderMarkdownBody(TABLE);
		const hosts = mathHosts(view.container);
		expect(hosts.length).toBe(1);
		const host = hosts[0] as unknown as HTMLElement;
		expect(host.innerHTML).toContain("katex");
		// The placeholder must NOT be what the reader sees.
		expect(host.textContent).not.toBe(MATH_ATOM_PLACEHOLDER);
		view.unmount();
	});

	it("applies the same font-size base and no-wrap rules as inline math", async () => {
		// A cell formula is subject to the identical KaTeX pitfalls (relative `1.21em`
		// root, multi-`.base` break opportunities), so it must carry both guards.
		const view = await renderMarkdownBody(
			"| a | $x_1 + x_2$ |\n|---|---|\n| 1 | $\\nabla f(x) = 0$ |",
		);
		const hosts = mathHosts(view.container);
		expect(hosts.length).toBe(2);
		for (const node of hosts) {
			const host = node as unknown as HTMLElement;
			expect(host.style.fontSize).toBe(`${MEASURED_BASE_PX}px`);
			expect(host.style.whiteSpace).toBe("nowrap");
		}
		view.unmount();
	});

	it("pins each host to the width the column solver reserved", async () => {
		const blocks = await prepare(TABLE);
		const table = blocks.find((b) => b.kind === "table");
		if (table?.kind !== "table") return;
		const expected = table.rows[0]?.[1]?.mathHtmls?.find((m) => m)?.width;

		const view = await renderMarkdownBody(TABLE);
		const host = mathHosts(view.container)[0] as unknown as HTMLElement;
		expect(host.style.width).toBe(`${expected}px`);
		view.unmount();
	});

	it("renders several formulas across rows and columns", async () => {
		const view = await renderMarkdownBody(
			"| A | B |\n|---|---|\n| $a_1$ | $\\frac{p}{q}$ |\n| $\\sqrt{x}$ | $\\sum_{i=1}^{n} i$ |",
		);
		expect(mathHosts(view.container).length).toBe(4);
		view.unmount();
	});

	it("leaves a formula-free table rendering exactly as before", async () => {
		const view = await renderMarkdownBody("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(mathHosts(view.container).length).toBe(0);
		expect(view.container.textContent).toContain("1");
		view.unmount();
	});
});

describe("row height accounts for a stacked formula", () => {
	it("reserves more height for a fraction row than a plain-text row", async () => {
		// A cell formula taller than the text line box must not be clipped by the row.
		const plain = await renderMarkdownBody("| a |\n|---|\n| x |");
		const fraction = await renderMarkdownBody("| a |\n|---|\n| $\\frac{a}{b}$ |");
		expect(fraction.measured.height).toBeGreaterThan(plain.measured.height);
		plain.unmount();
		fraction.unmount();
	});
});
