import { describe, expect, test } from "bun:test";
import {
	estimateSeqCenteredScrollTop,
	resolveBottomPinAction,
	resolveScrollTargetIndex,
} from "../../frontend/components/narrator/chunk-scroll-utils";

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

describe("estimateSeqCenteredScrollTop", () => {
	const prefix = buildPrefix([1000, 2000, 1000]);
	const chunk = { firstSeq: 100, lastSeq: 119, count: 20 };
	const clientHeight = 500;

	test("lands near the middle of the chunk for a middle seq", () => {
		const target = estimateSeqCenteredScrollTop(prefix, 1, chunk, 109, clientHeight);
		// chunkTop=1000, ratio=(109-100+0.5)/20=0.475 → 1000+950-250
		expect(target).toBe(1700);
	});

	test("tail seq estimates near the chunk tail instead of the chunk start", () => {
		const target = estimateSeqCenteredScrollTop(prefix, 1, chunk, 119, clientHeight);
		expect(target).toBeGreaterThan(2500);
		expect(target).toBeLessThan(3000);
	});

	test("out-of-range seq is clamped to the chunk range", () => {
		const before = estimateSeqCenteredScrollTop(prefix, 1, chunk, 20, clientHeight);
		const first = estimateSeqCenteredScrollTop(prefix, 1, chunk, 100, clientHeight);
		const after = estimateSeqCenteredScrollTop(prefix, 1, chunk, 999, clientHeight);
		const last = estimateSeqCenteredScrollTop(prefix, 1, chunk, 119, clientHeight);
		expect(before).toBe(first);
		expect(after).toBe(last);
	});
});

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

describe("resolveBottomPinAction — no-threshold bottom follow", () => {
	// Deliberate user scroll-ups are handled synchronously by input handlers, NOT
	// here. This function must never detach. It only:
	//  - pins at the real bottom (distance === 0)
	//  - refollows any positive gap while already pinned
	//  - leaves detached views detached until they truly reach the bottom

	test("real bottom pins, regardless of prior pin state", () => {
		expect(resolveBottomPinAction(0, true)).toBe("pin");
		expect(resolveBottomPinAction(0, false)).toBe("pin");
	});

	test("PINNED view refollows any positive gap, with no height threshold", () => {
		expect(resolveBottomPinAction(1, true)).toBe("refollow");
		expect(resolveBottomPinAction(48, true)).toBe("refollow");
		expect(resolveBottomPinAction(2000, true)).toBe("refollow");
	});

	test("DETACHED view does not re-pin until real bottom", () => {
		expect(resolveBottomPinAction(1, false)).toBe("none");
		expect(resolveBottomPinAction(48, false)).toBe("none");
		expect(resolveBottomPinAction(500, false)).toBe("none");
	});
});
