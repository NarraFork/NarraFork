/**
 * RenderMarkdown.table.test.tsx — a GFM table must PAINT at exactly the geometry
 * the height model predicted.
 *
 * The bug this locks down: the vlist path used to degrade every table into a
 * monospace code panel with un-padded `a | b` rows, so a table that the chunked
 * renderer drew as a Mantine `<Table>` came out as misaligned fixed-width text.
 * The replacement paints without a real `<table>` precisely so the geometry stays
 * predictable — which is only true if the render layer and the measure layer agree.
 *
 * The load-bearing assertion is therefore the CONTRACT's iron law: the sum of the
 * painted row boxes equals the predicted block height, with no DOM measurement
 * involved on either side. A real `<table>` would make that impossible, so a
 * regression toward one shows up here as a geometry mismatch.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";

const CONTENT_WIDTH = 800;
const TABLE_MD = "| Name | Size |\n|---|---|\n| alpha | 1 |\n| beta | 22 |";

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
	/** Predicted height of the table block from the measure layer. */
	predictedHeight: number;
	unmount: () => void;
}

async function renderTable(markdown: string, width = CONTENT_WIDTH): Promise<Rendered> {
	// Dynamic imports: the canvas stub must be installed before the pretext-backed
	// modules load (CONTRACT §5).
	const { measureMarkdown } = await import("../measure/measure-markdown");
	const { RenderMarkdown } = await import("./RenderMarkdown");
	const measured = measureMarkdown(markdown, width);
	const tableIndex = measured.blocks.findIndex((block) => block.kind === "table");
	if (tableIndex < 0) throw new Error("expected the markdown to produce a table block");
	const predictedHeight = measured.frame.blocks[tableIndex]?.height ?? 0;

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
		container,
		predictedHeight,
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

describe("table painting matches the predicted geometry", () => {
	it("paints a table host rather than a code panel", async () => {
		const r = await renderTable(TABLE_MD);
		expect(r.container.querySelectorAll("[data-vlist-table]").length).toBe(1);
		// The old fallback rendered a <pre>-like code panel; no real <table> either.
		expect(r.container.querySelectorAll("table").length).toBe(0);
		r.unmount();
	});

	it("paints one row per header + body row", async () => {
		const r = await renderTable(TABLE_MD);
		const rows = r.container.querySelectorAll("[data-vlist-table-row]");
		expect(rows.length).toBe(3);
		expect(rows[0]?.getAttribute("data-vlist-table-row")).toBe("header");
		expect(rows[1]?.getAttribute("data-vlist-table-row")).toBe("body");
		r.unmount();
	});

	it("stacks rows contiguously and sums to the predicted height", async () => {
		const r = await renderTable(TABLE_MD);
		const rows = [...r.container.querySelectorAll("[data-vlist-table-row]")];
		let expectedTop = 0;
		let total = 0;
		for (const row of rows) {
			// Each row begins exactly where the previous one ended — no gaps, no overlap.
			expect(pxOf(row, "top")).toBeCloseTo(expectedTop, 1);
			const height = pxOf(row, "height");
			expect(height).toBeGreaterThan(0);
			expectedTop += height;
			total += height;
		}
		// The painted stack is the predicted box (this table fits, so no scrollbar
		// reservation is involved).
		expect(total).toBeCloseTo(r.predictedHeight, 1);
		r.unmount();
	});

	it("renders every cell's text", async () => {
		const r = await renderTable(TABLE_MD);
		const text = r.container.textContent ?? "";
		for (const value of ["Name", "Size", "alpha", "beta", "22"]) {
			expect(text).toContain(value);
		}
		r.unmount();
	});

	it("aligns cells into shared column offsets across rows", async () => {
		const r = await renderTable(TABLE_MD);
		const rows = [...r.container.querySelectorAll("[data-vlist-table-row]")];
		// Collect the left offset of each row's Nth cell; all rows must agree.
		const leftsPerRow = rows.map((row) => [...row.children].map((cell) => pxOf(cell, "left")));
		const [first, ...rest] = leftsPerRow;
		expect(first?.length).toBe(2);
		for (const lefts of rest) expect(lefts).toEqual(first);
		// The second column starts to the right of the first.
		expect(first?.[1]).toBeGreaterThan(first?.[0] ?? 0);
		r.unmount();
	});

	it("marks alternating body rows as striped, never the header", async () => {
		const r = await renderTable(TABLE_MD);
		const rows = [...r.container.querySelectorAll("[data-vlist-table-row]")];
		expect(rows[0]?.hasAttribute("data-striped")).toBe(false);
		expect(rows[1]?.hasAttribute("data-striped")).toBe(true);
		expect(rows[2]?.hasAttribute("data-striped")).toBe(false);
		r.unmount();
	});

	it("scrolls horizontally instead of clipping when columns cannot fit", async () => {
		const wide =
			"| A | B | C |\n|---|---|---|\n" +
			`| ${"x".repeat(60)} | ${"y".repeat(60)} | ${"z".repeat(60)} |`;
		const r = await renderTable(wide, 200);
		const host = r.container.querySelector("[data-vlist-table]");
		if (!host) throw new Error("expected a table host");
		expect(host.getAttribute("style")).toMatch(/overflow-x:\s*auto/);
		r.unmount();
	});

	it("does not create a scroll container for a table that fits", async () => {
		const r = await renderTable(TABLE_MD);
		const host = r.container.querySelector("[data-vlist-table]");
		expect(host?.getAttribute("style")).toMatch(/overflow-x:\s*visible/);
		r.unmount();
	});

	it("grows the painted stack when a narrower width forces wrapping", async () => {
		const md = "| Description |\n|---|\n| a sentence long enough to wrap when narrow |";
		const wide = await renderTable(md, 900);
		const narrow = await renderTable(md, 220);
		expect(narrow.predictedHeight).toBeGreaterThan(wide.predictedHeight);
		// And the paint follows the prediction in both cases.
		for (const r of [wide, narrow]) {
			const rows = [...r.container.querySelectorAll("[data-vlist-table-row]")];
			const total = rows.reduce((sum, row) => sum + pxOf(row, "height"), 0);
			expect(total).toBeCloseTo(r.predictedHeight, 1);
		}
		wide.unmount();
		narrow.unmount();
	});
});

/**
 * Independent parity: the reserved row height must match the LINES ACTUALLY DRAWN.
 *
 * The assertions above compare the painted row boxes against the measure layer, but
 * both come from `layoutTable` — the renderer re-runs the very solver that produced
 * the prediction, so they agree by construction and a wrong line COUNT would sail
 * through. This block closes that gap by deriving the expectation from the DOM's own
 * `[data-vlist-line]` elements instead: each row must reserve exactly
 * `paintedLines × lineHeight + paddingY*2 + rowBorder`.
 *
 * That is the property the virtual list actually depends on. If a cell wrapped to
 * three lines while its row reserved two, rows would overlap on screen while every
 * same-source comparison still passed.
 *
 * Runs against real pretext (canvas stub for determinism), so cell wrapping is
 * decided by the same code path production uses.
 */
describe("reserved row height matches the lines actually painted", () => {
	/** Mantine Table defaults mirrored by DEFAULT_TABLE_METRICS (CONTRACT §3). */
	const PADDING_Y = 7;
	const ROW_BORDER = 1;

	async function assertRowsFitTheirLines(markdown: string, width: number) {
		const r = await renderTable(markdown, width);
		const rows = [...r.container.querySelectorAll("[data-vlist-table-row]")];
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			const lines = [...row.querySelectorAll("[data-vlist-line]")];
			expect(lines.length).toBeGreaterThan(0);
			// Every line box in a row shares the row's line pitch; the tallest cell
			// (most lines) is what the row height must cover.
			const lineHeight = pxOf(lines[0] as Element, "height");
			expect(lineHeight).toBeGreaterThan(0);
			let maxLines = 0;
			for (const cellEl of [...row.children]) {
				const cellLines = cellEl.querySelectorAll("[data-vlist-line]").length;
				if (cellLines > maxLines) maxLines = cellLines;
			}
			expect(pxOf(row, "height")).toBeCloseTo(
				maxLines * lineHeight + PADDING_Y * 2 + ROW_BORDER,
				1,
			);
		}
		r.unmount();
	}

	it("holds for a simple table that fits", async () => {
		await assertRowsFitTheirLines(TABLE_MD, CONTENT_WIDTH);
	});

	it("holds when a narrow width forces multi-line cells", async () => {
		await assertRowsFitTheirLines(
			"| Description | N |\n|---|---|\n| a sentence long enough to wrap several times over |  1 |",
			240,
		);
	});

	it("holds for a CJK table, which breaks per character", async () => {
		await assertRowsFitTheirLines(
			"| 项目 | 说明 |\n|---|---|\n| 路径别名 | 这是一段足够长的中文说明用于触发换行 |",
			260,
		);
	});

	it("holds for an overflowing table at min widths", async () => {
		await assertRowsFitTheirLines(
			`| A | B | C |\n|---|---|---|\n| ${"x".repeat(40)} | ${"y".repeat(40)} | ${"z".repeat(40)} |`,
			200,
		);
	});
});
