/**
 * `diffHunks` — the card's multi-window diff for StructSed.
 *
 * The old single window ran from the first to the last difference, so its size was the
 * distance between edits rather than their size. These cases pin the replacement: one
 * hunk per changed region, sized by the change, each with its own origin per side.
 */

import { describe, expect, test } from "bun:test";
import { changeLineStats, diffHunks, diffMetadata } from "../struct-sed/apply";
import { DIFF_CONTEXT_LINES, MAX_DIFF_HUNK_LINES, MAX_DIFF_HUNKS } from "../struct-sed/commands";

function numbered(count: number, prefix = "l"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

describe("diffHunks", () => {
	test("identical texts produce no diff", () => {
		expect(diffHunks("a\nb", "a\nb")).toBeNull();
	});

	test("one edit is one hunk with context on both sides", () => {
		const before = numbered(20);
		const after = [...before];
		after[9] = "CHANGED";
		const diff = diffHunks(before.join("\n"), after.join("\n"));
		expect(diff?.hunks).toHaveLength(1);
		const hunk = diff?.hunks[0];
		expect(hunk?.oldStart).toBe(10 - DIFF_CONTEXT_LINES);
		expect(hunk?.newStart).toBe(10 - DIFF_CONTEXT_LINES);
		expect(hunk?.oldText.split("\n")).toHaveLength(1 + DIFF_CONTEXT_LINES * 2);
		expect(hunk?.newText).toContain("CHANGED");
	});

	test("a move yields a removal hunk and an insertion hunk with separate origins", () => {
		// Lines 5-6 moved to after line 40: the insertion's new-side lines sit two lines
		// earlier than its old-side lines, because the removal came first.
		const before = numbered(50);
		const moved = before.slice(4, 6);
		const after = [...before.slice(0, 4), ...before.slice(6, 40), ...moved, ...before.slice(40)];
		const diff = diffHunks(before.join("\n"), after.join("\n"));
		expect(diff?.hunks).toHaveLength(2);
		const [removal, insertion] = diff?.hunks ?? [];
		expect(removal?.oldText).toContain("l5\nl6");
		expect(removal?.newText).not.toContain("l5");
		expect(insertion?.oldStart).toBe(41 - DIFF_CONTEXT_LINES);
		expect(insertion?.newStart).toBe(41 - DIFF_CONTEXT_LINES - 2);
		expect(insertion?.newText).toContain("l40\nl5\nl6\nl41");
	});

	test("edits whose context would touch merge into one hunk", () => {
		const before = numbered(30);
		const after = [...before];
		after[9] = "A";
		after[9 + DIFF_CONTEXT_LINES * 2] = "B";
		const diff = diffHunks(before.join("\n"), after.join("\n"));
		expect(diff?.hunks).toHaveLength(1);
		expect(diff?.hunks[0]?.newText).toContain("A");
		expect(diff?.hunks[0]?.newText).toContain("B");
	});

	test("edits far apart stay separate hunks", () => {
		const before = numbered(60);
		const after = [...before];
		after[5] = "A";
		after[50] = "B";
		expect(diffHunks(before.join("\n"), after.join("\n"))?.hunks).toHaveLength(2);
	});

	test("hunks past the cap are counted, not silently dropped", () => {
		const before = numbered((MAX_DIFF_HUNKS + 4) * 20);
		const after = before.map((line, i) => (i % 20 === 10 ? `${line}!` : line));
		const diff = diffHunks(before.join("\n"), after.join("\n"));
		expect(diff?.hunks).toHaveLength(MAX_DIFF_HUNKS);
		expect(diff?.omittedHunks).toBe(4);
	});

	test("a hunk larger than the line ceiling is cut and flagged", () => {
		const before = numbered(MAX_DIFF_HUNK_LINES + 100);
		const after = numbered(MAX_DIFF_HUNK_LINES + 100, "x");
		const hunk = diffHunks(before.join("\n"), after.join("\n"))?.hunks[0];
		expect(hunk?.truncated).toBe(true);
		expect(hunk?.oldText.split("\n")).toHaveLength(MAX_DIFF_HUNK_LINES);
	});

	test("an edit at the very start or end clamps its context to the file", () => {
		const before = numbered(10);
		const atStart = ["NEW", ...before];
		const head = diffHunks(before.join("\n"), atStart.join("\n"))?.hunks[0];
		expect(head).toMatchObject({ oldStart: 1, newStart: 1 });
		const atEnd = [...before, "NEW"];
		const tail = diffHunks(before.join("\n"), atEnd.join("\n"))?.hunks[0];
		expect(tail?.newText.endsWith("NEW")).toBe(true);
	});
});

describe("diffMetadata", () => {
	test("carries hunks and line stats, never the retired single-window fields", () => {
		const meta = diffMetadata("a\nb\nc", "a\nB\nc") as Record<string, unknown>;
		expect(Array.isArray(meta.diffHunks)).toBe(true);
		expect(meta.diffBefore).toBeUndefined();
		expect(meta.linesAdded).toBe(1);
		expect(meta.linesRemoved).toBe(1);
	});

	test("the hunk fallback for stats withholds a figure it cannot complete", () => {
		// A cut hunk means some changed lines were never counted; understating is worse
		// than omitting.
		const diff = {
			hunks: [{ oldText: "a", newText: "b", oldStart: 1, newStart: 1, truncated: true as const }],
		};
		const huge = "x".repeat(3_000_000);
		expect(changeLineStats(huge, `${huge}y`, diff)).toBeNull();
	});
});
