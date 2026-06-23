import { describe, expect, test } from "bun:test";
import { resolveScrollTargetIndex } from "../../frontend/components/narrator/chunk-scroll-utils";

/**
 * Builds a cumulative-height prefix array (length n+1) from per-chunk heights.
 * prefix[0] = 0, prefix[i+1] = prefix[i] + heights[i].
 */
function buildPrefix(heights: number[]): number[] {
	const prefix = new Array(heights.length + 1);
	prefix[0] = 0;
	for (let i = 0; i < heights.length; i++) prefix[i + 1] = prefix[i] + heights[i];
	return prefix;
}

describe("resolveScrollTargetIndex — edge clamping", () => {
	// Simulate the failing case: top chunks are SEVERELY under-estimated (tall
	// tool outputs / subagent cards render ~2000px but were seeded much smaller),
	// so the raw binary-search center would skip the earliest chunks.
	const heights = [2000, 2000, 2000, 200, 200, 200, 200, 200];
	const prefix = buildPrefix(heights); // total = 7000
	const chunkCount = heights.length;
	const clientHeight = 800;
	const scrollHeight = 7000;

	test("scrollTop at the very top clamps to the first chunk", () => {
		const target = resolveScrollTargetIndex(prefix, chunkCount, 0, clientHeight, scrollHeight);
		expect(target).toBe(0);
	});

	test("scrollTop within the edge threshold clamps to the first chunk", () => {
		const target = resolveScrollTargetIndex(prefix, chunkCount, 3, clientHeight, scrollHeight, 4);
		expect(target).toBe(0);
	});

	test("scrollTop at the very bottom clamps to the last chunk", () => {
		const maxScrollTop = scrollHeight - clientHeight; // 6200
		const target = resolveScrollTargetIndex(
			prefix,
			chunkCount,
			maxScrollTop,
			clientHeight,
			scrollHeight,
		);
		expect(target).toBe(chunkCount - 1);
	});

	test("mid-scroll uses the binary-searched center (no clamp)", () => {
		// viewportCenter = 3000 + 400 = 3400 → largest i with prefix[i] <= 3400.
		// prefix = [0,2000,4000,6000,6200,6400,6600,6800,7000] → i=1 (prefix[1]=2000).
		const target = resolveScrollTargetIndex(prefix, chunkCount, 3000, clientHeight, scrollHeight);
		expect(target).toBe(1);
	});

	test("empty list returns 0", () => {
		expect(resolveScrollTargetIndex([0], 0, 0, 800, 0)).toBe(0);
	});

	test("short history (whole list fits) — top still clamps to 0", () => {
		const shortHeights = [300, 300];
		const shortPrefix = buildPrefix(shortHeights);
		const target = resolveScrollTargetIndex(shortPrefix, 2, 0, 800, 600);
		expect(target).toBe(0);
	});
});
