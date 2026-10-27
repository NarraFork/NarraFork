import { describe, expect, test } from "bun:test";
import { pinchStep, wheelZoomFactor, zoomAround } from "./pan-zoom-math";

/** Where a world point lands on screen under `t` (origin on screen at `o` when tx = ty = 0). */
function screen(
	t: { scale: number; tx: number; ty: number },
	o: { x: number; y: number },
	w: {
		x: number;
		y: number;
	},
) {
	return { x: o.x + t.tx + w.x * t.scale, y: o.y + t.ty + w.y * t.scale };
}

/** The world point under a screen point. */
function world(
	t: { scale: number; tx: number; ty: number },
	o: { x: number; y: number },
	s: {
		x: number;
		y: number;
	},
) {
	return { x: (s.x - o.x - t.tx) / t.scale, y: (s.y - o.y - t.ty) / t.scale };
}

describe("pan-zoom math", () => {
	test("zooming keeps the point under the anchor in place, for any origin", () => {
		for (const origin of [
			{ x: 0, y: 0 },
			{ x: 400, y: 300 },
		]) {
			const t = { scale: 1.3, tx: -40, ty: 25 };
			const anchor = { x: 512, y: 207 };
			const under = world(t, origin, anchor);
			for (const s of [0.2, 0.75, 2, 4]) {
				const next = zoomAround(t, s, anchor, origin);
				expect(next.scale).toBe(s);
				const p = screen(next, origin, under);
				expect(p.x).toBeCloseTo(anchor.x, 9);
				expect(p.y).toBeCloseTo(anchor.y, 9);
			}
		}
	});

	test("other fields of the transform are kept", () => {
		const next = zoomAround(
			{ scale: 1, tx: 0, ty: 0, extra: "kept" },
			2,
			{ x: 1, y: 1 },
			{
				x: 0,
				y: 0,
			},
		);
		expect(next.extra).toBe("kept");
	});

	test("a pinch step zooms around the midpoint and pans with it", () => {
		const origin = { x: 0, y: 0 };
		const t = { scale: 1, tx: 10, ty: 20 };
		const mid = { x: 300, y: 200 };
		const under = world(t, origin, mid);
		const pan = { x: 12, y: -7 };
		const next = pinchStep(t, 1.5, mid, pan, origin, (s) => s);
		expect(next.scale).toBe(1.5);
		const p = screen(next, origin, under);
		expect(p.x).toBeCloseTo(mid.x + pan.x, 9);
		expect(p.y).toBeCloseTo(mid.y + pan.y, 9);
	});

	test("a pinch step clamps the scale and still keeps the midpoint", () => {
		const origin = { x: 50, y: 50 };
		const t = { scale: 3.5, tx: 0, ty: 0 };
		const mid = { x: 120, y: 90 };
		const under = world(t, origin, mid);
		const next = pinchStep(t, 2, mid, { x: 0, y: 0 }, origin, (s) => Math.min(4, s));
		expect(next.scale).toBe(4);
		const p = screen(next, origin, under);
		expect(p.x).toBeCloseTo(mid.x, 9);
		expect(p.y).toBeCloseTo(mid.y, 9);
	});

	test("wheel zoom: up zooms in, down zooms out, opposite deltas cancel", () => {
		expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
		expect(wheelZoomFactor(100)).toBeLessThan(1);
		expect(wheelZoomFactor(0)).toBe(1);
		expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1, 12);
	});
});
