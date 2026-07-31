/**
 * RenderToolRun.drilldown.test.tsx — a drilled-in trace row actually PAINTS its
 * nested tool card, at exactly the height the measure layer reserved.
 *
 * The measure tests prove the geometry and the adapter tests prove the payload
 * arrives. This is the chain between them: real measure → real render, asserting
 * that a folded low-LOD row can reveal a full tool card in place, that the card
 * body is inside the row's own absolutely-positioned box, and that a collapsed row
 * paints nothing extra (the property that keeps a several-hundred-row fold cheap).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type MeasuredTraceRow,
	measureActivityTrace,
	TRACE_ROW_HEIGHT,
} from "../measure/measure-tool-run";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderToolCall } from "./RenderToolCall";
import { RenderToolRun } from "./RenderToolRun";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

let parse: (html: string) => Element;

beforeAll(() => {
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

const WIDTH = 700;
const OUTPUT = Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n");

/** The card the adapter hands a drilled-in row (a plain Read with a code body). */
const CARD = {
	toolName: "Read",
	summary: "src/index.ts",
	category: "read" as const,
	status: "success" as const,
	toolUseId: "tu-1",
	detail: { kind: "capped" as const, cap: "code" as const, text: OUTPUT, hasLabel: true },
};

function traceRows(cardOnIndex?: number) {
	return [0, 1].map((i) => ({
		title: `Read · file${i}.ts`,
		hasIcon: true,
		iconColor: "gray",
		key: `t-${i}`,
		canDrillDown: true,
		...(cardOnIndex === i ? { card: CARD } : {}),
	}));
}

/** The shell's `rowCard` slot, reduced to what this test needs. */
const rowCard = (row: MeasuredTraceRow) =>
	row.cardMeasured ? <RenderToolCall measured={row.cardMeasured} /> : null;

function render(node: React.ReactNode): Element {
	return parse(
		renderToStaticMarkup(<MantineProvider defaultColorScheme="dark">{node}</MantineProvider>),
	);
}

/**
 * True when some element declares exactly `height` px inline.
 *
 * Two details this hides. Position: MantineProvider emits its CSS-variable
 * `<style>` tags ahead of the tree, so the trace box is not `firstElementChild`.
 * Spacing: React serializes inline styles WITHOUT a space after the colon
 * (`height:230.4px`), while a hand-written expectation naturally reads
 * `height: 230.4px` — so the comparison is made whitespace-insensitive rather than
 * pinned to one serializer's formatting.
 */
function declaresHeight(root: Element, height: number): boolean {
	for (const el of root.querySelectorAll("div")) {
		const style = String((el as unknown as HTMLElement).getAttribute("style") ?? "");
		if (style.replace(/\s+/g, "").includes(`height:${height}px`)) return true;
	}
	return false;
}

describe("RenderToolRun — trace row drill-down", () => {
	it("paints the nested card body when a row is opened", () => {
		const measured = measureActivityTrace(traceRows(1), WIDTH, { expandedIndices: [1] }, {}, 2);
		const root = render(<RenderToolRun measured={measured} rowCard={rowCard} />);
		// The card's header summary and its capped body text both reach the DOM.
		expect(root.textContent).toContain("src/index.ts");
		expect(root.textContent).toContain("line 5");
	});

	it("paints nothing extra while the rows are collapsed", () => {
		const measured = measureActivityTrace(traceRows(), WIDTH, {}, {}, 2);
		const root = render(<RenderToolRun measured={measured} rowCard={rowCard} />);
		// Row titles yes; card chrome / body no.
		expect(root.textContent).toContain("Read · file0.ts");
		expect(root.textContent).not.toContain("src/index.ts");
		expect(root.textContent).not.toContain("line 5");
	});

	it("keeps the outer box at the measured height (no post-paint correction)", () => {
		const measured = measureActivityTrace(traceRows(1), WIDTH, { expandedIndices: [1] }, {}, 2);
		const root = render(<RenderToolRun measured={measured} rowCard={rowCard} />);
		expect(declaresHeight(root, measured.height)).toBe(true);
		// The opened row's own box carries the row + body height, and the card is
		// nested inside it rather than pushing siblings around.
		const openedRow = measured.rows[1];
		expect(openedRow?.blockHeight).toBeGreaterThan(TRACE_ROW_HEIGHT);
	});

	it("without a rowCard slot the row reveals nothing (slot is the only route)", () => {
		const measured = measureActivityTrace(traceRows(1), WIDTH, { expandedIndices: [1] }, {}, 2);
		const root = render(<RenderToolRun measured={measured} />);
		expect(root.textContent).not.toContain("src/index.ts");
		// The reserved height stays, so a missing slot is a blank box — never a
		// silently different geometry.
		expect(declaresHeight(root, measured.height)).toBe(true);
	});

	it("a drillable row draws a chevron rather than the inert dot", () => {
		const drill = render(
			<RenderToolRun measured={measureActivityTrace(traceRows(), WIDTH, {}, {}, 2)} />,
		);
		const plain = render(
			<RenderToolRun
				measured={measureActivityTrace(
					traceRows().map(({ canDrillDown: _drop, ...row }) => row),
					WIDTH,
					{},
					{},
					2,
				)}
			/>,
		);
		// The dot is the non-expandable marker; a drillable row replaces it with an
		// svg chevron in the same fixed 12px slot.
		expect(plain.textContent).toContain("•");
		expect(drill.textContent).not.toContain("•");
		expect(drill.querySelectorAll("svg").length).toBeGreaterThan(
			plain.querySelectorAll("svg").length,
		);
	});
});
