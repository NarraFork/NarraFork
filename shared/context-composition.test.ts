import { describe, expect, test } from "bun:test";
import {
	CONTEXT_CATEGORIES,
	contextCharacterPercent,
	emptyContextComposition,
	groupContextSegments,
	safeCharacters,
} from "./context-composition";

describe("context character composition", () => {
	test("groups all nine categories without modifying chronological segments", () => {
		const source = [
			{ category: "user" as const, chars: 12 },
			{ category: "system" as const, chars: 4 },
			{ category: "user" as const, chars: 8 },
		];
		const before = JSON.stringify(source);
		const grouped = groupContextSegments(source);
		expect(grouped.map((segment) => segment.category)).toEqual([...CONTEXT_CATEGORIES]);
		expect(grouped.find((segment) => segment.category === "user")?.chars).toBe(20);
		expect(grouped.find((segment) => segment.category === "attachment")?.chars).toBe(0);
		expect(JSON.stringify(source)).toBe(before);
	});
	test("shares use total characters rather than a token window", () => {
		expect(contextCharacterPercent(25, 100)).toBe(25);
		expect(contextCharacterPercent(9, 0)).toBe(0);
	});
	test("invalid character estimates are sanitized", () => {
		for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY])
			expect(safeCharacters(value)).toBe(0);
		expect(safeCharacters(3.9)).toBe(3);
	});
	test("pending response contains no invented historical counts", () => {
		const result = emptyContextComposition(true);
		expect(result.generation).toBeNull();
		expect(result.totalChars).toBe(0);
		expect(result.pending).toBe(true);
		expect(result.totals).toHaveLength(9);
		expect(result.segments).toEqual([]);
	});
});
