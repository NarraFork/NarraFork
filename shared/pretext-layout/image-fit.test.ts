import { describe, expect, test } from "bun:test";
import { fitImageBox, readImageIntrinsicSize } from "./image-fit";

describe("readImageIntrinsicSize", () => {
	test("accepts positive finite numbers", () => {
		expect(readImageIntrinsicSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
	});
	test("rejects missing / wrong-type / non-positive / non-finite values", () => {
		expect(readImageIntrinsicSize(undefined, 100)).toBeNull();
		expect(readImageIntrinsicSize(100, undefined)).toBeNull();
		expect(readImageIntrinsicSize(null, null)).toBeNull();
		expect(readImageIntrinsicSize("100", 100)).toBeNull();
		expect(readImageIntrinsicSize(0, 100)).toBeNull();
		expect(readImageIntrinsicSize(100, -5)).toBeNull();
		expect(readImageIntrinsicSize(Number.NaN, 100)).toBeNull();
		expect(readImageIntrinsicSize(100, Number.POSITIVE_INFINITY)).toBeNull();
	});
});

describe("fitImageBox", () => {
	test("never upscales: a small image keeps its intrinsic size", () => {
		expect(fitImageBox({ width: 50, height: 50 }, 700, 400)).toEqual({
			displayWidth: 50,
			displayHeight: 50,
		});
	});

	test("floors a fractional intrinsic size in the never-upscale branch", () => {
		// `readImageIntrinsicSize` only demands "positive finite", so a fractional
		// dimension can reach here. Leaving it un-floored puts 50.5 into
		// `PreparedFixedBlock.height` and drifts the layout by a sub-pixel.
		expect(fitImageBox({ width: 50.5, height: 30.9 }, 700, 400)).toEqual({
			displayWidth: 50,
			displayHeight: 30,
		});
		// Sub-1px still yields a usable box rather than 0.
		expect(fitImageBox({ width: 0.4, height: 0.4 }, 700, 400)).toEqual({
			displayWidth: 1,
			displayHeight: 1,
		});
	});

	test("scales a wide strip by width, producing a short box", () => {
		// 12:1 banner in a 700px column. The EXACT value matters: the derived
		// dimension is `floor(bound × other/this)` (see the module header), so
		// asserting an inequality here would stop protecting the rounding direction
		// that argument is about.
		const fit = fitImageBox({ width: 1200, height: 100 }, 700, 400);
		expect(fit.displayWidth).toBe(700);
		expect(fit.displayHeight).toBe(Math.floor((700 * 100) / 1200)); // 58
	});

	test("clamps tall images by the height cap", () => {
		// 1:10 tall screenshot: width-limited height would be 7000 → capped to 400.
		const fit = fitImageBox({ width: 700, height: 7000 }, 700, 400);
		expect(fit.displayHeight).toBe(400);
		expect(fit.displayWidth).toBe(40);
	});

	test("width cap wins when it is the tighter constraint", () => {
		// 16:9 at 700px wide → 393 tall, under the 400 cap.
		const fit = fitImageBox({ width: 1600, height: 900 }, 700, 400);
		expect(fit.displayWidth).toBe(700);
		expect(fit.displayHeight).toBe(393);
	});

	test("never exceeds either bound and never returns zero", () => {
		const fit = fitImageBox({ width: 3, height: 30000 }, 700, 400);
		expect(fit.displayWidth).toBeGreaterThanOrEqual(1);
		expect(fit.displayWidth).toBeLessThanOrEqual(700);
		expect(fit.displayHeight).toBeGreaterThanOrEqual(1);
		expect(fit.displayHeight).toBeLessThanOrEqual(400);
	});

	test("degenerate bounds still produce a usable box", () => {
		const fit = fitImageBox({ width: 100, height: 100 }, 0, 0);
		expect(fit.displayWidth).toBeGreaterThanOrEqual(1);
		expect(fit.displayHeight).toBeGreaterThanOrEqual(1);
	});

	test("NON-FINITE bounds fall back to the 1px floor, never NaN", () => {
		// A NaN width genuinely arrives: an early render can pass an undetermined
		// content width. `Math.max(1, NaN)` is NaN, so this used to return NaN
		// dimensions, which propagate into PreparedFixedBlock.height and NaN the
		// whole frame — silently, since NaN compares false against every bound check.
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const byWidth = fitImageBox({ width: 1000, height: 500 }, bad, 400);
			expect(Number.isFinite(byWidth.displayWidth)).toBe(true);
			expect(Number.isFinite(byWidth.displayHeight)).toBe(true);
			expect(byWidth.displayWidth).toBeGreaterThanOrEqual(1);
			expect(byWidth.displayHeight).toBeGreaterThanOrEqual(1);

			const byHeight = fitImageBox({ width: 1000, height: 500 }, 700, bad);
			expect(Number.isFinite(byHeight.displayWidth)).toBe(true);
			expect(Number.isFinite(byHeight.displayHeight)).toBe(true);
			expect(byHeight.displayWidth).toBeGreaterThanOrEqual(1);
			expect(byHeight.displayHeight).toBeGreaterThanOrEqual(1);
		}
		// Both bounds unusable at once: still a 1px box, not NaN.
		const bothBad = fitImageBox({ width: 1000, height: 500 }, Number.NaN, Number.NaN);
		expect(bothBad.displayWidth).toBeGreaterThanOrEqual(1);
		expect(bothBad.displayHeight).toBeGreaterThanOrEqual(1);
		expect(Number.isFinite(bothBad.displayWidth)).toBe(true);
		expect(Number.isFinite(bothBad.displayHeight)).toBe(true);
	});

	test("NEGATIVE bounds behave like the 1px floor", () => {
		const fit = fitImageBox({ width: 1000, height: 500 }, -700, -400);
		expect(fit.displayWidth).toBeGreaterThanOrEqual(1);
		expect(fit.displayHeight).toBeGreaterThanOrEqual(1);
		// The floor is 1×1, so the ratio cannot be preserved; what matters is that
		// neither dimension is 0/negative/NaN.
		expect(fit.displayWidth).toBeLessThanOrEqual(1);
		expect(fit.displayHeight).toBeLessThanOrEqual(1);
	});
});
