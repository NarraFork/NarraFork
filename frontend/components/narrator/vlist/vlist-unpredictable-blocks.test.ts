/**
 * vlist-unpredictable-blocks.test.ts — The predicate that puts a row on the
 * post-paint height-correction path.
 *
 * The bug this guards: a mermaid row was never marked dynamic, so it kept the
 * 240px placeholder height. A diagram taller than that was clipped, and switching
 * one to "actual size" grew it inside a box that never re-measured — hiding every
 * row below it.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MeasuredElement, PreparedBlock } from "./prepared-block";
import {
	hasUnpredictableBlock,
	hostsUnpredictableBlock,
	UNKNOWN_HEIGHT_FORWARDING_KINDS,
} from "./vlist-unpredictable-blocks";

const BASE = { marginTop: 0, contentLeft: 0 } as const;

function unknown(
	tag: "mermaid" | "katex" | "image-unknown",
	intrinsicWidth?: number,
): PreparedBlock {
	return {
		...BASE,
		kind: "unknown",
		tag,
		placeholderHeight: 240,
		...(intrinsicWidth != null ? { intrinsicWidth } : {}),
	} as PreparedBlock;
}

function rule(): PreparedBlock {
	return { ...BASE, kind: "rule", height: 1 } as PreparedBlock;
}

function measured(blocks: PreparedBlock[]): MeasuredElement {
	return {
		height: 100,
		blocks,
		frame: { blocks: [], contentHeight: 100, usedWidth: 0 },
		contentWidth: 600,
		usedWidth: 600,
	};
}

describe("hasUnpredictableBlock", () => {
	it("is true for a mermaid block", () => {
		expect(hasUnpredictableBlock([unknown("mermaid")])).toBe(true);
	});

	it("is true for an image of unknown intrinsic size", () => {
		expect(hasUnpredictableBlock([unknown("image-unknown")])).toBe(true);
	});

	it("is FALSE for display math that katex-geometry measured exactly", () => {
		// Exactly measured math must stay on the pure path: routing it through a
		// ResizeObserver would let a committed row move with no user action behind it.
		expect(hasUnpredictableBlock([unknown("katex", 320)])).toBe(false);
	});

	it("is true for a katex block that could NOT be measured", () => {
		// No intrinsicWidth means the geometry is a guess, so it needs correcting.
		expect(hasUnpredictableBlock([unknown("katex")])).toBe(true);
	});

	it("is false for ordinary blocks and for an empty list", () => {
		expect(hasUnpredictableBlock([rule()])).toBe(false);
		expect(hasUnpredictableBlock([])).toBe(false);
	});

	it("finds an unpredictable block anywhere in the list", () => {
		expect(hasUnpredictableBlock([rule(), unknown("katex", 10), unknown("mermaid")])).toBe(true);
	});
});

describe("hostsUnpredictableBlock", () => {
	it("marks a markdown row hosting a mermaid diagram", () => {
		expect(hostsUnpredictableBlock("markdown", measured([unknown("mermaid")]))).toBe(true);
	});

	it("marks the other kinds that forward onUnknownHeight", () => {
		for (const kind of ["message-bubble", "reasoning", "plan-card"]) {
			expect(hostsUnpredictableBlock(kind, measured([unknown("mermaid")]))).toBe(true);
		}
	});

	it("does NOT mark a tool card, which never forwards a reporter", () => {
		// A tool card's bodies live in capped, internally scrolling boxes. Marking such
		// a row dynamic would drop its fixed-height clip and let the card size itself,
		// which is precisely what the cap exists to prevent.
		expect(hostsUnpredictableBlock("tool-call", measured([unknown("mermaid")]))).toBe(false);
		expect(hostsUnpredictableBlock("subagent-card", measured([unknown("mermaid")]))).toBe(false);
	});

	it("does not mark a forwarding kind with no unpredictable block", () => {
		expect(hostsUnpredictableBlock("markdown", measured([rule()]))).toBe(false);
	});

	it("does not mark a collapsed reasoning row (no body blocks measured)", () => {
		// Non-expanded reasoning measures to an empty block list, so a folded trace
		// stays on the pure path even though its expanded form could hold a diagram.
		expect(hostsUnpredictableBlock("reasoning", measured([]))).toBe(false);
	});

	it("keeps the forwarding-kind set minimal and explicit", () => {
		expect([...UNKNOWN_HEIGHT_FORWARDING_KINDS].sort()).toEqual([
			"markdown",
			"message-bubble",
			"plan-card",
			"reasoning",
		]);
	});
});

/**
 * Source-level, because the failure mode is silent: the two halves of the
 * exception (who may hold an override, and who reports one) live in different
 * files, and a diagram clipped to its placeholder looks like a rendering quirk
 * rather than a wiring bug.
 */
describe("wiring: both halves of the controlled exception use ONE rule", () => {
	const VLIST_DIR = import.meta.dir;
	const read = (rel: string) => readFileSync(join(VLIST_DIR, rel), "utf8");

	it("the shell admits unpredictable-block rows to the dynamic set", () => {
		const shell = read("PretextExactMessageList.tsx");
		const block = shell.slice(
			shell.indexOf("const dynamicRowKeys = useMemo("),
			shell.indexOf("const effectiveHeightOverrides"),
		);
		expect(block.length).toBeGreaterThan(0);
		expect(block).toContain("hostsUnpredictableBlock(item.spec.kind, item.measured)");
	});

	it("the render layer decides from the SAME helper, not its own copy", () => {
		const render = read("render/RenderMarkdown.tsx");
		expect(render).toContain("hasUnpredictableBlock(blocks)");
		// The duplicated local predicate is gone: two copies of "is this exactly
		// measured?" would eventually disagree, and either half disagreeing leaves a
		// row clipped or its height unrecorded.
		expect(render).not.toContain("function isExactlyMeasured(");
	});

	it("the row's reporter comes from the dynamic set itself", () => {
		// Previously a parallel disjunction of slot props, which could not see a
		// mermaid row at all.
		const shell = read("PretextExactMessageList.tsx");
		expect(shell).toContain("const isDynamicRow = dynamicRowKeys.has(item.spec.key)");
	});
});
