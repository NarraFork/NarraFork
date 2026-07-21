import { describe, expect, test } from "bun:test";
import { looseNumber, normalizeNumber } from "../number-param";

describe("looseNumber schema", () => {
	test("accepts integers, floats, and string-encoded numbers", () => {
		const schema = looseNumber();
		expect(schema.safeParse(100).success).toBe(true);
		expect(schema.safeParse(3.7).success).toBe(true);
		expect(schema.safeParse("100").success).toBe(true);
		expect(schema.safeParse("3.7").success).toBe(true);
	});

	test("is optional (undefined passes)", () => {
		expect(looseNumber().safeParse(undefined).success).toBe(true);
	});

	test("accepts out-of-range and negative values without failing", () => {
		const schema = looseNumber();
		expect(schema.safeParse(-5).success).toBe(true);
		expect(schema.safeParse(999_999_999).success).toBe(true);
		expect(schema.safeParse(0).success).toBe(true);
	});

	test("carries an optional description", () => {
		expect(looseNumber("hello").description).toBe("hello");
	});
});

describe("normalizeNumber", () => {
	test("returns undefined for missing/non-finite input by default", () => {
		expect(normalizeNumber(undefined)).toBeUndefined();
		expect(normalizeNumber("abc")).toBeUndefined();
		expect(normalizeNumber(Number.NaN)).toBeUndefined();
		expect(normalizeNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
	});

	test("uses fallback for non-finite input when provided", () => {
		expect(normalizeNumber(undefined, { fallback: 10 })).toBe(10);
		expect(normalizeNumber("abc", { fallback: 7 })).toBe(7);
	});

	test("parses string-encoded numbers", () => {
		expect(normalizeNumber("42")).toBe(42);
		expect(normalizeNumber("42.6")).toBe(43);
	});

	test("rounds floats to integers by default", () => {
		expect(normalizeNumber(3.2)).toBe(3);
		expect(normalizeNumber(3.7)).toBe(4);
	});

	test("preserves floats when integer:false", () => {
		expect(normalizeNumber(3.7, { integer: false })).toBe(3.7);
	});

	test("clamps to min/max after rounding", () => {
		expect(normalizeNumber(0, { min: 1 })).toBe(1);
		expect(normalizeNumber(999, { max: 50 })).toBe(50);
		expect(normalizeNumber(-5, { min: 0, max: 100 })).toBe(0);
		expect(normalizeNumber(25, { min: 1, max: 30 })).toBe(25);
	});

	test("returns sentinel untouched, bypassing clamping", () => {
		expect(normalizeNumber(-1, { min: 1, max: 1000, sentinel: -1 })).toBe(-1);
		// A non-sentinel negative still gets clamped.
		expect(normalizeNumber(-2, { min: 1, max: 1000, sentinel: -1 })).toBe(1);
	});

	test("matches sentinel after rounding", () => {
		expect(normalizeNumber(-1.2, { min: 1, sentinel: -1 })).toBe(-1);
	});
});
