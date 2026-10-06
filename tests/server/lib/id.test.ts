import { describe, expect, it } from "bun:test";
import { generateId, generateShortId } from "../../../server/lib/id";

describe("generateId", () => {
	it("returns a 21-char string by default", () => {
		const id = generateId();
		expect(id).toHaveLength(21);
		expect(typeof id).toBe("string");
	});

	it("respects custom size", () => {
		expect(generateId(10)).toHaveLength(10);
		expect(generateId(32)).toHaveLength(32);
	});

	it("generates unique ids", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateId()));
		expect(ids.size).toBe(100);
	});
});

describe("generateShortId", () => {
	it("returns an 8-char string by default", () => {
		expect(generateShortId()).toHaveLength(8);
	});

	it("respects custom size", () => {
		expect(generateShortId(6)).toHaveLength(6);
	});
});
