import { describe, expect, test } from "bun:test";
import {
	type QuoteButtonBox,
	type QuoteButtonLayout,
	quoteButtonPosition,
} from "./quote-button-position";

const line = (top: number, left: number, right: number): QuoteButtonBox => ({
	top,
	left,
	right,
	bottom: top + 20,
});

// Three selected lines, 200..260, ending mid-line at x=300.
const forward = {
	union: { top: 200, left: 40, right: 900, bottom: 260 },
	end: line(240, 40, 300),
	backward: false,
};
const base: QuoteButtonLayout = {
	placement: "selection",
	selection: forward,
	bounds: { top: 50, left: 0, right: 1000, bottom: 700 },
	composer: { top: 600, left: 20, right: 980, bottom: 680 },
	viewport: { width: 1000, height: 800 },
	size: { width: 120, height: 28 },
};

function overlaps(position: { top: number } | null, from: number, to: number): boolean {
	return !!position && position.top < to && position.top + 28 > from;
}

describe("quoteButtonPosition", () => {
	test("forward: below the last selected line, centred on the selection end", () => {
		const position = quoteButtonPosition(base);
		expect(position).toEqual({ top: 266, left: 240 });
		expect(overlaps(position, 200, 260)).toBe(false);
	});

	test("backward: above the first selected line, at the selection start", () => {
		expect(
			quoteButtonPosition({
				...base,
				selection: { ...forward, end: line(200, 400, 900), backward: true },
			}),
		).toEqual({ top: 166, left: 340 });
	});

	test("flips to the other side when the preferred side has no room", () => {
		const nearComposer = quoteButtonPosition({
			...base,
			selection: {
				union: { top: 520, left: 40, right: 900, bottom: 580 },
				end: line(560, 40, 300),
				backward: false,
			},
		});
		expect(nearComposer).toEqual({ top: 486, left: 240 });
		const nearTop = quoteButtonPosition({
			...base,
			selection: {
				union: { top: 60, left: 40, right: 900, bottom: 120 },
				end: line(60, 400, 900),
				backward: true,
			},
		});
		expect(nearTop).toEqual({ top: 126, left: 340 });
	});

	test("a selection taller than the view is covered only at the edge near its moved end", () => {
		const tall = { top: 0, left: 40, right: 900, bottom: 900 };
		expect(
			quoteButtonPosition({
				...base,
				selection: { union: tall, end: line(880, 40, 300), backward: false },
			})?.top,
		).toBe(572);
		expect(
			quoteButtonPosition({
				...base,
				selection: { union: tall, end: line(0, 400, 900), backward: true },
			})?.top,
		).toBe(50);
	});

	test("hides once the selection scrolls out of the visible message area", () => {
		for (const union of [
			{ top: 0, left: 0, right: 10, bottom: 40 },
			{ top: 610, left: 0, right: 10, bottom: 630 },
		])
			expect(
				quoteButtonPosition({ ...base, selection: { union, end: union, backward: false } }),
			).toBeNull();
	});

	test("stays inside the panel and viewport horizontally", () => {
		const at = (end: QuoteButtonBox, bounds = base.bounds) =>
			quoteButtonPosition({
				...base,
				bounds,
				selection: { ...forward, end },
			})?.left;
		expect(at(line(240, 0, 10))).toBe(4);
		expect(at(line(240, 900, 995))).toBe(876);
		expect(at(line(240, 500, 510), { ...base.bounds, left: 500, right: 800 })).toBe(500);
	});

	test("touch: below the selection past its handles, both directions", () => {
		const touch = { ...base, placement: "touch" as const };
		expect(quoteButtonPosition(touch)).toEqual({ top: 290, left: 240 });
		// The platform menu owns the space above, so a backward selection still goes below.
		expect(
			quoteButtonPosition({
				...touch,
				selection: { ...forward, end: line(200, 400, 900), backward: true },
			}),
		).toEqual({ top: 290, left: 340 });
	});

	test("touch: no room below the handles → the composer's top edge", () => {
		expect(
			quoteButtonPosition({
				...base,
				placement: "touch",
				selection: {
					union: { top: 520, left: 40, right: 900, bottom: 560 },
					end: line(540, 40, 300),
					backward: false,
				},
			}),
		).toEqual({ top: 566, left: 860 });
	});

	test("falls back to the composer edge without a selection rect, hides without a composer", () => {
		expect(quoteButtonPosition({ ...base, selection: null })).toEqual({ top: 566, left: 860 });
		expect(
			quoteButtonPosition({
				...base,
				selection: null,
				composer: { top: 0, left: 0, right: 0, bottom: 0 },
			}),
		).toBeNull();
	});
});
