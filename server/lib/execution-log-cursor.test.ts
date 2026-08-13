import { describe, expect, test } from "bun:test";
import { decodeExecutionLogCursor, encodeExecutionLogCursor } from "./execution-log-cursor";

describe("execution log cursor", () => {
	test("round-trips a cursor", () => {
		const cursor = { startedAt: "2026-07-17T12:00:00.000Z", id: "toolcall-1" };
		expect(decodeExecutionLogCursor(encodeExecutionLogCursor(cursor))).toEqual(cursor);
	});

	test("accepts second-precision timestamps", () => {
		// `started_at` falls back to `created_at`, and older rows were written without
		// milliseconds — rejecting those would make their pages unreachable.
		const cursor = { startedAt: "2026-03-12T22:32:56Z", id: "legacy-row" };
		expect(decodeExecutionLogCursor(encodeExecutionLogCursor(cursor))).toEqual(cursor);
	});

	test("rejects a malformed or hostile cursor", () => {
		expect(decodeExecutionLogCursor(undefined)).toBeNull();
		expect(decodeExecutionLogCursor("")).toBeNull();
		expect(decodeExecutionLogCursor("not-base64!!")).toBeNull();
		expect(decodeExecutionLogCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
		expect(decodeExecutionLogCursor("A".repeat(600))).toBeNull();
		// Right shape, wrong version.
		expect(
			decodeExecutionLogCursor(
				Buffer.from(
					JSON.stringify({ v: 2, startedAt: "2026-07-17T12:00:00.000Z", id: "x" }),
				).toString("base64url"),
			),
		).toBeNull();
		// Not a real date.
		expect(
			decodeExecutionLogCursor(
				Buffer.from(JSON.stringify({ v: 1, startedAt: "not-a-date", id: "x" })).toString(
					"base64url",
				),
			),
		).toBeNull();
	});

	test("refuses to encode invalid input", () => {
		expect(() => encodeExecutionLogCursor({ startedAt: "yesterday", id: "x" })).toThrow();
		expect(() =>
			encodeExecutionLogCursor({ startedAt: "2026-07-17T12:00:00.000Z", id: "" }),
		).toThrow();
	});
});
