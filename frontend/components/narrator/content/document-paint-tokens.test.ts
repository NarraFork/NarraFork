import { describe, expect, test } from "bun:test";
import { documentPaintTokens } from "./document-paint-tokens";

describe("visible token coverage while Worker is pending", () => {
	test("missing tokens still paint exact visible source with explicit pending", () => {
		expect(documentPaintTokens(100, 120, [])).toEqual([
			{ start: 100, end: 120, color: "inherit", fontStyle: undefined, pending: true },
		]);
	});
	test("preserves confirmed colours and only marks the appended/unconfirmed region pending", () => {
		const retained = [
			{ start: 100, end: 110, color: "#abc" },
			{ start: 110, end: 120, color: "#def", fontStyle: 2 },
		];
		expect(documentPaintTokens(100, 125, [], retained)).toEqual([
			{ start: 100, end: 110, color: "#abc", fontStyle: undefined, pending: true },
			{ start: 110, end: 120, color: "#def", fontStyle: 2, pending: true },
			{ start: 120, end: 125, color: "inherit", fontStyle: undefined, pending: true },
		]);
	});
	test("fresh Worker corrections override old colours while holes keep their confirmed style", () => {
		const result = documentPaintTokens(
			100,
			120,
			[{ start: 105, end: 110, color: "#new" }],
			[{ start: 100, end: 120, color: "#old" }],
		);
		expect(result).toEqual([
			{ start: 100, end: 105, color: "#old", fontStyle: undefined, pending: true },
			{ start: 105, end: 110, color: "#new", fontStyle: undefined },
			{ start: 110, end: 120, color: "#old", fontStyle: undefined, pending: true },
		]);
	});
	test("clips huge physical-line tokens to the actual horizontal viewport interval", () => {
		expect(documentPaintTokens(500000, 500050, [{ start: 0, end: 1000000, color: "red" }])).toEqual(
			[{ start: 500000, end: 500050, color: "red", fontStyle: undefined }],
		);
	});
});
