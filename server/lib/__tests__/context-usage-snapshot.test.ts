import { expect, test } from "bun:test";
import type { ContextUsageSnapshot } from "@shared/context-usage";
import { boundedContextSnapshot, validInputCharacters } from "../context-usage-snapshot";

const snapshot: ContextUsageSnapshot = {
	requestId: "r1",
	startedAt: "2026-01-01T00:00:00.000Z",
	source: "usage",
	percentage: 50,
	contextWindow: 1_000_000,
	occupiedTokens: 500_000,
	inputCharacters: { totalChars: 1_000_000, systemChars: 20_000, toolsChars: 80_000 },
	composition: null,
};

test("counter validation does not enumerate or copy foreign fields", () => {
	const counts = { totalChars: 100, systemChars: 10, toolsChars: 20 };
	Object.defineProperty(counts, "rawBody", {
		enumerable: true,
		get: () => {
			throw new Error("must not copy input body");
		},
	});
	expect(validInputCharacters(counts)).toEqual({
		totalChars: 100,
		systemChars: 10,
		toolsChars: 20,
	});
});

test("snapshot bounds apply after allowlisting, never after copying a giant foreign body", () => {
	const value = { ...snapshot };
	Object.defineProperty(value, "rawDump", {
		enumerable: true,
		get: () => {
			throw new Error("must not serialize unknown dump");
		},
	});
	expect(boundedContextSnapshot(value)).toEqual(snapshot);
	const counts = { ...snapshot.inputCharacters };
	Object.defineProperty(counts, "rawBody", {
		enumerable: true,
		get: () => {
			throw new Error("must not serialize unknown counter body");
		},
	});
	expect(
		boundedContextSnapshot({
			...snapshot,
			inputCharacters: counts as NonNullable<ContextUsageSnapshot["inputCharacters"]>,
		}),
	).toEqual(snapshot);
});

test("transient final classification is numeric, conserved and excluded from snapshots", () => {
	const counts = {
		totalChars: 100,
		systemChars: 10,
		toolsChars: 20,
		compositionSegments: [
			{ category: "system" as const, chars: 10 },
			{ category: "toolDefinition" as const, chars: 20 },
			{ category: "user" as const, chars: 70 },
		],
	};
	expect(validInputCharacters(counts)?.compositionSegments).toEqual(counts.compositionSegments);
	expect(boundedContextSnapshot({ ...snapshot, inputCharacters: counts })?.inputCharacters).toEqual(
		{ totalChars: 100, systemChars: 10, toolsChars: 20 },
	);
	for (const segments of [
		[{ category: "user" as const, chars: 100 }],
		[{ category: "system" as const, chars: 101 }],
		Array.from({ length: 2049 }, () => ({ category: "user" as const, chars: 0 })),
	]) {
		expect(
			validInputCharacters({ ...counts, compositionSegments: segments })?.compositionSegments,
		).toBeNull();
	}
	expect(
		validInputCharacters({ ...counts, compositionSegments: null })?.compositionSegments,
	).toBeNull();
});
