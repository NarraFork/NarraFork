/**
 * RenderToolRun.livetail.test.tsx — a live reasoning row's tail is anchored to its
 * NEWEST end, i.e. right-aligned with the overflow clipped on the LEFT.
 *
 * ── The bug this locks down ───────────────────────────────────────────────────
 *
 * The tail cell has always carried `direction: rtl`, which is what moves the clip
 * off the newest characters. But it ALSO carried `unicode-bidi: plaintext` on the
 * same element, and plaintext derives the paragraph direction from the content's
 * first strong character — thereby ignoring `direction`. Reasoning text opens with
 * Han or latin (both Bidi_Class L), so every real row resolved as an LTR paragraph:
 * left-aligned, clipped on the RIGHT, hiding exactly the characters that had just
 * arrived. The declaration meant to protect the tail's internal ordering was
 * silently cancelling the anchoring it sat next to.
 *
 * The shape that satisfies both: `direction: rtl` on the CELL (anchor + clip side)
 * and an isolated `direction: ltr` run INSIDE it (natural ordering within one
 * bidi unit). This file pins that pairing, because either half alone is a
 * regression and neither is visible in a height or content assertion — the row
 * renders the same characters in the DOM whichever way it is aligned.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { measureActivityTrace } from "../measure/measure-tool-run";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderToolRun } from "./RenderToolRun";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

const WIDTH = 700;
/** Han-leading text: Bidi_Class L, which is what made plaintext resolve LTR. */
const TAIL = "这是刚刚到达的最新内容";
const ROW_KEY = "r-run0-0-step-0";

let parse: (html: string) => Element;

beforeAll(() => {
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

/** A one-row live reasoning trace carrying a tail, rendered to static markup. */
function liveTailRow(tail = TAIL): Element {
	const measured = measureActivityTrace(
		[{ title: "分析步骤", hasIcon: true, iconColor: "grape", key: ROW_KEY, shimmer: true }],
		WIDTH,
	);
	return parse(
		renderToStaticMarkup(
			<MantineProvider defaultColorScheme="dark">
				<RenderToolRun
					measured={measured}
					rowLiveTails={new Map([[ROW_KEY, { charCount: 1234, tail }]])}
					labels={{ liveTailChars: (formatted: string) => `${formatted} 字符` }}
				/>
			</MantineProvider>,
		),
	);
}

/**
 * The PRE-FIX tail cell, reproduced locally as a fixture.
 *
 * The negative controls at the bottom of this file run the same checks against it,
 * which is what proves those checks are not vacuous. Deliberately a local fixture
 * rather than a temporary edit to the real component: the checks are pure functions
 * of rendered markup, so a fixture establishes the same fact without writing a
 * known-broken version into a watched source tree.
 */
function preFixTailCell(tail = TAIL): Element {
	return parse(
		renderToStaticMarkup(
			<div
				style={{
					flex: 1,
					minWidth: 0,
					overflow: "hidden",
					whiteSpace: "nowrap",
					direction: "rtl",
					unicodeBidi: "plaintext",
				}}
			>
				{tail}
			</div>,
		),
	);
}

/** Inline styles of every element in the tree, lowercased and whitespace-free. */
function inlineStyles(root: Element): string[] {
	return Array.from(root.querySelectorAll("[style]")).map((el) =>
		String((el as unknown as HTMLElement).getAttribute("style") ?? "")
			.toLowerCase()
			.replace(/\s+/g, ""),
	);
}

/** True when no element in the tree lets its CONTENT decide the direction. */
function hasNoPlaintextBidi(root: Element): boolean {
	return inlineStyles(root).every((style) => !style.includes("unicode-bidi:plaintext"));
}

/** True when the tree carries an isolated LTR run (the natural-order carrier). */
function hasIsolatedLtrRun(root: Element): boolean {
	const inner = inlineStyles(root).find((style) => style.includes("unicode-bidi:isolate"));
	return inner?.includes("direction:ltr") === true;
}

/** The element whose inline style contains `needle`, or undefined. */
function styleContaining(root: Element, needle: string): string | undefined {
	return inlineStyles(root).find((style) => style.includes(needle));
}

describe("the live tail is anchored to its newest end", () => {
	it("renders the tail text at all (guards every assertion below)", () => {
		// Without this a broken render would make the style assertions vacuous.
		expect(liveTailRow().textContent).toContain(TAIL);
		expect(liveTailRow().textContent).toContain("1234 字符");
	});

	it("clips the tail cell on the LEFT via direction:rtl", () => {
		const cell = styleContaining(liveTailRow(), "direction:rtl");
		expect(cell).toBeDefined();
		// The clip only happens if the overflow is actually hidden on one line.
		expect(cell).toContain("overflow:hidden");
		expect(cell).toContain("white-space:nowrap");
	});

	// THE REGRESSION. `plaintext` re-derives the paragraph direction from the
	// content and so cancels the `direction: rtl` beside it — the row goes back to
	// left-aligned and clips the newest characters.
	it("never resolves the tail's direction from its CONTENT (unicode-bidi:plaintext)", () => {
		expect(hasNoPlaintextBidi(liveTailRow())).toBe(true);
	});

	it("keeps the tail's own characters in natural order via an ISOLATED ltr run", () => {
		// Isolation (not an override) is what leaves RTL scripts inside the reasoning
		// text rendering correctly while still anchoring the run to the right edge.
		expect(hasIsolatedLtrRun(liveTailRow())).toBe(true);
	});

	it("puts the ltr run INSIDE the rtl cell, not beside it", () => {
		const root = liveTailRow();
		const cell = Array.from(root.querySelectorAll("[style]")).find((el) =>
			String((el as unknown as HTMLElement).getAttribute("style") ?? "")
				.replace(/\s+/g, "")
				.includes("direction:rtl"),
		);
		expect(cell).toBeDefined();
		// The anchoring only works if the isolated unit is a DESCENDANT of the cell
		// whose direction reverses the inline start.
		const isolated = (cell as Element).querySelector("[style*='isolate']");
		expect(isolated).not.toBeNull();
		expect((isolated as Element).textContent).toBe(TAIL);
	});

	it("never forces textAlign on the cell, which would fight the rtl anchoring", () => {
		// Under `direction: rtl` the inline start already IS the right edge, so the
		// text sits flush against the newest end on its own.
		const cell = styleContaining(liveTailRow("短"), "direction:rtl");
		expect(cell).toBeDefined();
		expect(cell).not.toContain("text-align:left");
	});
});

/**
 * A SHORT tail must sit beside its size readout, not out at the row's right edge.
 *
 * The first version of the right-anchoring fix gave the tail cell `flex: 1` so it
 * would claim the row's leftover width. Combined with the RTL anchoring inside it,
 * that meant a tail which FITS was pushed to the far right, leaving a conspicuous
 * gap between "1234 字符…" and the words it describes — anchoring applied to a case
 * that never needed it. Hugging (`flex: 0 1 auto`) is what keeps both cases right,
 * and this describe block is the half that a width-agnostic style assertion misses.
 */
describe("a short tail hugs its prefix instead of drifting right", () => {
	it("gives the tail cell a HUGGING basis, never a growing one", () => {
		const cell = styleContaining(liveTailRow("短"), "direction:rtl");
		expect(cell).toBeDefined();
		// `flex: 0 1 auto` — shrink under pressure, never grow past the text.
		expect(cell).toContain("flex:01auto");
	});

	it("never lets the tail cell GROW (the gap regression)", () => {
		for (const tail of ["短", TAIL, TAIL.repeat(40)]) {
			const cell = styleContaining(liveTailRow(tail), "direction:rtl");
			expect(cell).toBeDefined();
			// A growing basis in any of its spellings would reintroduce the gap.
			expect(cell).not.toContain("flex:1");
			expect(cell).not.toContain("flex-grow:1");
		}
	});

	it("keeps a trailing spacer to absorb the leftover width", () => {
		// With a hugging tail, SOMETHING must eat the remainder or the flex line would
		// distribute it back into the cells. The spacer is that something, and it has a
		// zero basis so it never competes for shrink with a long tail.
		const root = liveTailRow("短");
		const spacer = inlineStyles(root).find(
			(style) => style.includes("flex:1") && style.includes("min-width:0"),
		);
		expect(spacer).toBeDefined();
	});

	it("still clips a LONG tail on the left (hugging did not cost the overflow case)", () => {
		const cell = styleContaining(liveTailRow(TAIL.repeat(40)), "direction:rtl");
		expect(cell).toBeDefined();
		expect(cell).toContain("overflow:hidden");
		expect(cell).toContain("direction:rtl");
		// `min-width: 0` is what actually permits the shrink below the text's width;
		// without it the cell would refuse to compress and would push the row wide.
		expect(cell).toContain("min-width:0");
	});

	it("leaves the size prefix unclipped whatever the tail does", () => {
		// The prefix tells the reader the run is still growing, so it must never be
		// the thing that gets truncated — at either tail length.
		for (const tail of ["短", TAIL.repeat(40)]) {
			const prefix = inlineStyles(liveTailRow(tail)).find(
				(style) => style.includes("flex-shrink:0") && style.includes("opacity:0.6"),
			);
			expect(prefix).toBeDefined();
		}
	});
});

/**
 * NEGATIVE CONTROLS — the two checks above must REJECT the pre-fix shape.
 *
 * Without these, `hasNoPlaintextBidi` / `hasIsolatedLtrRun` could silently become
 * tautologies (a typo'd selector, a style attribute that stops being emitted) and
 * the suite would keep passing while the row went back to hiding its newest text.
 */
describe("the anchoring checks reject the pre-fix shape", () => {
	it("flags a cell that lets its content pick the direction", () => {
		expect(hasNoPlaintextBidi(preFixTailCell())).toBe(false);
	});

	it("flags a cell with no isolated ltr run", () => {
		expect(hasIsolatedLtrRun(preFixTailCell())).toBe(false);
	});

	it("agrees with the fixed row on the parts that did NOT change", () => {
		// Both shapes clip on the left; the difference is only in how the paragraph
		// direction resolves. Asserting this keeps the controls above pointed at the
		// real defect rather than at an unrelated markup difference.
		expect(styleContaining(preFixTailCell(), "direction:rtl")).toContain("overflow:hidden");
	});
});
