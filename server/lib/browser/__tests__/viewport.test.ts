import { describe, expect, test } from "bun:test";
import { normalizeViewport } from "../session";

describe("normalizeViewport", () => {
	test("rounds dimensions and keeps optional fields only when given", () => {
		expect(normalizeViewport({ width: 375.4, height: 812.6 })).toEqual({
			width: 375,
			height: 813,
		});
		expect(
			normalizeViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true }),
		).toEqual({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true });
	});

	test("rejects out-of-range or non-finite values", () => {
		expect(() => normalizeViewport({ width: 50, height: 600 })).toThrow(/width/);
		expect(() => normalizeViewport({ width: 800, height: 5000 })).toThrow(/height/);
		expect(() => normalizeViewport({ width: Number.NaN, height: 600 })).toThrow(/width/);
		expect(() => normalizeViewport({ width: 800, height: 600, deviceScaleFactor: 10 })).toThrow(
			/scale factor/,
		);
	});
});
