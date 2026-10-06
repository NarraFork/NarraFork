import { describe, expect, test } from "bun:test";
import { decodeUsageHistoryCursor, encodeUsageHistoryCursor } from "./usage-history-cursor";

describe("usage history cursor", () => {
	test("round-trips the createdAt/id boundary", () => {
		const cursor = { createdAt: "2026-07-17T12:34:56.789Z", id: "request-b" };
		expect(decodeUsageHistoryCursor(encodeUsageHistoryCursor(cursor))).toEqual(cursor);
	});

	test("rejects malformed payloads", () => {
		expect(decodeUsageHistoryCursor("not-base64-json")).toBeNull();
		expect(
			decodeUsageHistoryCursor(
				Buffer.from(
					JSON.stringify({ v: 2, createdAt: "2026-07-17T00:00:00.000Z", id: "x" }),
				).toString("base64url"),
			),
		).toBeNull();
	});

	test("accepts only canonical UTC ISO-8601 timestamps with milliseconds", () => {
		const invalidDates = [
			"0",
			"July 17, 2026",
			"2026-7-17T00:00:00.000Z",
			"2026-07-17T00:00:00Z",
			"2026-07-17T00:00:00.000+00:00",
			"2026-07-17T01:00:00.000+01:00",
			"2026-02-30T00:00:00.000Z",
		];

		for (const createdAt of invalidDates) {
			const encoded = Buffer.from(JSON.stringify({ v: 1, createdAt, id: "x" })).toString(
				"base64url",
			);
			expect(decodeUsageHistoryCursor(encoded)).toBeNull();
			expect(() => encodeUsageHistoryCursor({ createdAt, id: "x" })).toThrow(
				"Invalid usage history cursor",
			);
		}
	});

	test("rejects oversized values", () => {
		expect(
			encodeUsageHistoryCursor({ createdAt: "2026-07-17T00:00:00.000Z", id: "x" }),
		).toBeTruthy();
		expect(
			decodeUsageHistoryCursor(
				Buffer.from(
					JSON.stringify({
						v: 1,
						createdAt: "2026-07-17T00:00:00.000Z",
						id: "x".repeat(129),
					}),
				).toString("base64url"),
			),
		).toBeNull();
		expect(() =>
			encodeUsageHistoryCursor({ createdAt: "2026-07-17T00:00:00.000Z", id: "" }),
		).toThrow();
	});
});
