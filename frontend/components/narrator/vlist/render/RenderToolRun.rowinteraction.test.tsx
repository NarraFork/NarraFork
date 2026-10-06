/**
 * RenderToolRun.rowinteraction.test.tsx — a folded trace row and the tool card it
 * DRILLS INTO are ONE interactive block.
 *
 * WHY THIS EXISTS
 * The interaction slot used to receive only the row's title LINE, so the full card a
 * reader revealed by clicking the chevron rendered as an un-wrapped sibling next to
 * it: no right-click menu, no left-swipe, no selection outline. Drilling in therefore
 * LOST affordances the collapsed row already had — the reader had to collapse the row
 * again to reach the very menu that acts on the call they were looking at.
 *
 * The slot now receives the row's whole block, so these tests pin two things a
 * geometry test cannot see:
 *   1. containment — the revealed card is a DESCENDANT of the interaction surface, so
 *      the surface's `onContextMenu` / touch listeners see events from inside it;
 *   2. height neutrality — regrouping the DOM did not move the measured geometry, and
 *      the revealed bodies still start at the row's fixed title height.
 *
 * Static markup, no DOM harness: containment and declared geometry are pure output of
 * `measured.rows` plus the injected slots, so `renderToStaticMarkup` is the cheapest
 * faithful probe. The real menu/swipe behaviour of the surface itself is covered by
 * TraceRowInteraction.test.tsx; here the surface is a marker div, which keeps this
 * file about the WIRING rather than about Mantine's menu internals.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { classifyToolDetail } from "@shared/pretext-layout/tool-detail";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeasuredToolCall } from "../measure/measure-tool-call";
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
	detail: classifyToolDetail({
		toolUseId: "tu-1",
		toolName: "Read",
		category: "read",
		outputJson: OUTPUT,
	}),
};

/**
 * Row identities are what gate the interaction slot (see TraceRowView).
 *
 * The MEASURE-layer shape (`AdapterTraceRowIdentity`) carries message coordinates
 * plus a `toolUseId` — never a `blockId`: the adapter cannot know whether a tool is
 * filed under `tc-` or `sa-` (that depends on child messages it never sees), so the
 * shell resolves the real blockId through the selection index. These tests key their
 * marker surfaces off `toolUseId` for the same reason.
 */
function traceRows(cardOnIndex?: number) {
	return [0, 1].map((i) => ({
		title: `Read · file${i}.ts`,
		hasIcon: true,
		iconColor: "gray",
		key: `t-${i}`,
		canDrillDown: true,
		identity: { messageId: "m1", blockIndex: i, toolUseId: `tu-${i}` },
		...(cardOnIndex === i ? { card: CARD } : {}),
	}));
}

/**
 * The shell's `rowCard` slot, reduced to what this test needs. `cardMeasured` is a
 * union (a subagent row drills into its own card), so the tool branch narrows on
 * the row's `cardKind` discriminant — exactly as the shell does.
 */
const rowCard = (row: MeasuredTraceRow) =>
	row.cardMeasured && row.cardKind === "tool-call" ? (
		<RenderToolCall measured={row.cardMeasured as MeasuredToolCall} />
	) : null;

/**
 * Stand-in for the shell's `TraceRowInteraction` wrapper: a marked element around
 * whatever the render layer hands the slot. Real menu / swipe gating lives in
 * TraceRowInteraction.test.tsx.
 */
const rowInteraction = (row: MeasuredTraceRow, rowBody: React.ReactNode) => (
	<div data-row-surface={row.identity?.toolUseId ?? ""}>{rowBody}</div>
);

function render(node: React.ReactNode): Element {
	return parse(
		renderToStaticMarkup(<MantineProvider defaultColorScheme="dark">{node}</MantineProvider>),
	);
}

function surfaces(root: Element): Element[] {
	return Array.from(root.querySelectorAll("[data-row-surface]"));
}

/** The interaction surface belonging to one row's blockId. */
function surfaceFor(root: Element, blockId: string): Element {
	const found = surfaces(root).find((el) => el.getAttribute("data-row-surface") === blockId);
	if (!found) throw new Error(`no interaction surface for ${blockId}`);
	return found;
}

/**
 * The revealed card's own node, found by the text only its header carries.
 *
 * Deliberately the DEEPEST element holding that text: an ancestor chain all reports
 * the same `textContent`, and only the innermost one lets the walk below say which
 * surface the card actually sits in.
 */
function cardHeaderNode(root: Element): Element {
	const candidates = Array.from(root.querySelectorAll("*")).filter((el) =>
		(el.textContent ?? "").includes("src/index.ts"),
	);
	const deepest = candidates.filter(
		(el, _i, all) => !all.some((other) => other !== el && el.contains(other)),
	)[0];
	if (!deepest) throw new Error("the drilled-in card did not render");
	return deepest;
}

/** blockId of the nearest interaction surface above `node`, or null if none. */
function nearestSurfaceId(node: Element): string | null {
	let el: Element | null = node;
	while (el) {
		const id = el.getAttribute?.("data-row-surface");
		if (id != null) return id;
		el = el.parentElement;
	}
	return null;
}

/** True when some element under `root` declares exactly `height` px inline. */
function declaresHeight(root: Element, height: number): boolean {
	for (const el of root.querySelectorAll("div")) {
		const style = String((el as unknown as HTMLElement).getAttribute("style") ?? "");
		if (style.replace(/\s+/g, "").includes(`height:${height}px`)) return true;
	}
	return false;
}

describe("RenderToolRun — the drilled-in card joins the row's interaction surface", () => {
	it("nests the revealed card INSIDE the row's interaction surface", () => {
		const measured = measureActivityTrace(traceRows(1), WIDTH, { expandedIndices: [1] }, {}, 2);
		const root = render(
			<RenderToolRun measured={measured} rowCard={rowCard} rowInteraction={rowInteraction} />,
		);
		const surface = surfaceFor(root, "tu-1");
		// The card's header summary and its body text must both be inside the surface,
		// or a right-click / swipe landing on them never reaches its handlers.
		expect(surface.textContent).toContain("src/index.ts");
		expect(surface.textContent).toContain("line 5");
	});

	it("attributes the card to its OWN row's surface, walking up from the card node", () => {
		const measured = measureActivityTrace(traceRows(1), WIDTH, { expandedIndices: [1] }, {}, 2);
		const root = render(
			<RenderToolRun measured={measured} rowCard={rowCard} rowInteraction={rowInteraction} />,
		);
		expect(surfaces(root)).toHaveLength(2);
		// Asserted from the CARD upwards rather than from the surface's text downwards:
		// a surface that wraps only the title line still "contains" the row title, so a
		// text-based check on the surface passes even when the card escaped it. The
		// nearest surface ancestor of the card node is the only unambiguous statement —
		// and it must be this row's, never its neighbour's (which would make the menu
		// act on the wrong tool call).
		const cardNode = cardHeaderNode(root);
		expect(nearestSurfaceId(cardNode)).toBe("tu-1");
	});

	it("wraps the row even when nothing is revealed (collapsed rows keep their menu)", () => {
		const measured = measureActivityTrace(traceRows(), WIDTH, {}, {}, 2);
		const root = render(<RenderToolRun measured={measured} rowInteraction={rowInteraction} />);
		expect(surfaces(root)).toHaveLength(2);
		expect(surfaceFor(root, "tu-0").textContent).toContain("Read · file0.ts");
	});

	it("leaves a row without an identity plain (no surface to select through)", () => {
		const rows = traceRows().map(({ identity: _drop, ...row }) => row);
		const measured = measureActivityTrace(rows, WIDTH, {}, {}, 2);
		const root = render(<RenderToolRun measured={measured} rowInteraction={rowInteraction} />);
		expect(surfaces(root)).toHaveLength(0);
		// The row itself still paints — only the interaction surface is absent.
		expect(root.textContent).toContain("Read · file0.ts");
	});

	it("is height-neutral: the surface does not change the measured geometry", () => {
		const measured = measureActivityTrace(traceRows(1), WIDTH, { expandedIndices: [1] }, {}, 2);
		const withSurface = render(
			<RenderToolRun measured={measured} rowCard={rowCard} rowInteraction={rowInteraction} />,
		);
		const withoutSurface = render(<RenderToolRun measured={measured} rowCard={rowCard} />);
		// The outer trace box keeps the predicted height either way — the whole point
		// of routing interaction through a slot rather than through the geometry.
		expect(declaresHeight(withSurface, measured.height)).toBe(true);
		expect(declaresHeight(withoutSurface, measured.height)).toBe(true);
		// And so does the opened row's own block.
		const openedHeight = measured.rows[1]?.blockHeight ?? 0;
		expect(openedHeight).toBeGreaterThan(TRACE_ROW_HEIGHT);
		expect(declaresHeight(withSurface, openedHeight)).toBe(true);
	});

	it("starts the drilled-in card at the row block's top (the card replaces the title row)", () => {
		// A drilled-in row does NOT paint its summary title row: the nested card fills
		// the whole block from top:0, its own header morphing into the slot the title
		// row used to occupy. Grouping the card with the (absent) title line means the
		// grouping box is a positioned ancestor of the same height — so the card sits
		// flush at the block's top instead of sliding under a row that is not there.
		const measured = measureActivityTrace(traceRows(1), WIDTH, { expandedIndices: [1] }, {}, 2);
		const root = render(
			<RenderToolRun measured={measured} rowCard={rowCard} rowInteraction={rowInteraction} />,
		);
		const surface = surfaceFor(root, "tu-1");
		const grouping = surface.firstElementChild as unknown as HTMLElement | null;
		const groupingStyle = String(grouping?.getAttribute("style") ?? "").replace(/\s+/g, "");
		expect(groupingStyle).toContain("position:relative");
		expect(groupingStyle).toContain(`height:${measured.rows[1]?.blockHeight}px`);
		// No summary title row is painted for the drilled-in row…
		expect(surface.querySelector("[data-nf-trace-titlerow]")).toBeNull();
		// …and the card's box starts at the block's top (top:0), full width, no indent.
		const bodyBox = Array.from(surface.querySelectorAll("div")).find((el) => {
			const style = String((el as unknown as HTMLElement).getAttribute("style") ?? "").replace(
				/\s+/g,
				"",
			);
			return (
				style.includes("position:absolute") &&
				(style.includes("top:0px") || style.includes("top:0;"))
			);
		});
		expect(bodyBox).toBeDefined();
		expect(bodyBox?.textContent).toContain("src/index.ts");
	});

	it("keeps the drilled-in card's header keyboard-reachable (the ONLY way back out)", () => {
		// The summary title row carried role/tabIndex/onKeyDown, and a drilled-in row no
		// longer paints it — so the card's own header is the only remaining control that
		// can collapse the row. Without these attributes the drill-down became a one-way
		// door for keyboard and screen-reader readers.
		const measured = measureActivityTrace(traceRows(1), WIDTH, { expandedIndices: [1] }, {}, 2);
		const root = render(
			<RenderToolRun
				measured={measured}
				rowCard={(row) =>
					row.cardMeasured ? (
						<RenderToolCall measured={row.cardMeasured as MeasuredToolCall} onToggle={() => {}} />
					) : null
				}
			/>,
		);
		const header = root.querySelector("[data-nf-card-header]");
		expect(header).not.toBeNull();
		expect(header?.getAttribute("role")).toBe("button");
		expect(header?.getAttribute("tabindex")).toBe("0");
		// The card is measured force-open, so the header announces itself as expanded.
		expect(header?.getAttribute("aria-expanded")).toBe("true");
	});

	it("leaves a non-toggleable card header out of the tab order", () => {
		// No `onToggle` → nothing to activate, so claiming `role="button"` would put a
		// dead stop in the tab order of a list that already has many.
		const measured = measureActivityTrace(traceRows(1), WIDTH, { expandedIndices: [1] }, {}, 2);
		const root = render(<RenderToolRun measured={measured} rowCard={rowCard} />);
		const header = root.querySelector("[data-nf-card-header]");
		expect(header).not.toBeNull();
		expect(header?.getAttribute("role")).toBeNull();
		expect(header?.getAttribute("tabindex")).toBeNull();
	});

	it("tags every row with its own key so the header morph finds THIS row, not the first", () => {
		// The collapse morph locates the remounted title line by
		// `[data-nf-trace-row="<rowKey>"] [data-nf-trace-titlerow]`. If the per-row tag
		// were missing (or every row shared one value), a trace-level querySelector
		// returns the FIRST row's line — the animation then plays on the row ABOVE the
		// one being collapsed. These two rows carry keys `t-0` / `t-1`; pin that each
		// resolves to its own title line.
		const measured = measureActivityTrace(traceRows(), WIDTH, {}, {}, 2);
		const root = render(<RenderToolRun measured={measured} rowCard={rowCard} />);
		const tagged = Array.from(root.querySelectorAll("[data-nf-trace-row]"));
		expect(tagged.map((el) => el.getAttribute("data-nf-trace-row"))).toEqual(["t-0", "t-1"]);
		// Each tagged row's own title line is reachable within it — and is that row's.
		for (const key of ["t-0", "t-1"]) {
			const row = root.querySelector(`[data-nf-trace-row="${key}"]`);
			const title = row?.querySelector("[data-nf-trace-titlerow]");
			expect(title?.textContent).toContain(`file${key === "t-0" ? 0 : 1}.ts`);
		}
	});
});
