import { describe, expect, test } from "bun:test";
import {
	CONTEXT_USAGE_SNAPSHOT_MAX_BYTES,
	type ContextUsageSnapshot,
	parseContextUsageSnapshot,
} from "./context-usage";

const snapshot: ContextUsageSnapshot = {
	requestId: "request-1",
	startedAt: "2026-01-01T00:00:00.000Z",
	source: "upstream",
	percentage: 92.6,
	contextWindow: 1_000_000,
	occupiedTokens: 926_000,
	inputCharacters: { totalChars: 1_000_000, systemChars: 20_000, toolsChars: 80_000 },
	composition: {
		generation: "generation-1",
		revision: "revision-1",
		pageCount: 1,
		totalChars: 100_000,
		totals: [
			{ category: "system", chars: 20_000 },
			{ category: "toolDefinition", chars: 80_000 },
		],
	},
};

describe("bounded request occupancy snapshots", () => {
	test("reads structured metadata and its persisted JSON without changing billing semantics", () => {
		expect(parseContextUsageSnapshot(snapshot)).toEqual(snapshot);
		expect(parseContextUsageSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
	});

	test("unknown body fields are not read or forwarded", () => {
		const value = { ...snapshot };
		Object.defineProperty(value, "rawDump", {
			enumerable: true,
			get: () => {
				throw new Error("must not read body");
			},
		});
		expect(parseContextUsageSnapshot(value)).toEqual(snapshot);
		expect(
			parseContextUsageSnapshot({
				...snapshot,
				composition: { ...snapshot.composition, rawBody: "large" },
			}),
		).toEqual(snapshot);
	});

	test("preserves a bounded request prefix without forwarding body fields", () => {
		if (!snapshot.composition) throw new Error("Fixture requires a composition");
		const value = {
			...snapshot,
			composition: {
				...snapshot.composition,
				fixedPrefix: {
					previous: [{ category: "toolDefinition" as const, chars: 80_003 }],
					current: [{ category: "toolDefinition" as const, chars: 80_000 }],
				},
			},
		};
		expect(parseContextUsageSnapshot(value)).toEqual(value);
		expect(
			parseContextUsageSnapshot({
				...value,
				composition: {
					...value.composition,
					fixedPrefix: { previous: [], current: [{ category: "user", chars: 1 }] },
				},
			}),
		).toBeNull();
	});

	test("unknown calibration is null, not a fabricated partial denominator", () => {
		const value = { ...snapshot, inputCharacters: null, composition: null };
		expect(parseContextUsageSnapshot(value)).toEqual(value);
	});

	test("rejects malformed, oversized and non-finite metadata", () => {
		for (const value of [
			null,
			[],
			"not JSON",
			" ".repeat(CONTEXT_USAGE_SNAPSHOT_MAX_BYTES + 1),
			{ ...snapshot, requestId: "" },
			{ ...snapshot, requestId: "x".repeat(129) },
			{ ...snapshot, startedAt: "not a date" },
			{ ...snapshot, source: "billing" },
			{ ...snapshot, percentage: Number.NaN },
			{ ...snapshot, occupiedTokens: Number.POSITIVE_INFINITY },
			{ ...snapshot, contextWindow: 0 },
			{ ...snapshot, occupiedTokens: -1 },
			{ ...snapshot, inputCharacters: { totalChars: 1, systemChars: 2, toolsChars: 0 } },
			{ ...snapshot, inputCharacters: { totalChars: 1.5, systemChars: 0, toolsChars: 0 } },
		])
			expect(parseContextUsageSnapshot(value)).toBeNull();
	});

	test("rejects malformed classifications without walking unbounded lists", () => {
		for (const composition of [
			{ ...snapshot.composition, totals: Array(10).fill({ category: "system", chars: 1 }) },
			{ ...snapshot.composition, totalChars: 100_001 },
			{
				...snapshot.composition,
				totalChars: 2,
				totals: [
					{ category: "system", chars: 1 },
					{ category: "system", chars: 1 },
				],
			},
			{ ...snapshot.composition, totalChars: 1, totals: [{ category: "bad", chars: 1 }] },
			{ ...snapshot.composition, pageCount: -1 },
		])
			expect(parseContextUsageSnapshot({ ...snapshot, composition })).toBeNull();
	});
});
