import { describe, expect, test } from "bun:test";
import type { DiffLine } from "@shared/pretext-layout/diff-core";
import type { ParsedDiffHunk } from "@shared/pretext-layout/parse-unified-diff";
import { alignUnifiedDiffToSplit, type SplitDiffEntry } from "./split-diff";

function row(type: DiffLine["type"], content: string, lineNo: number): DiffLine {
	return type === "removed"
		? { type, content, oldLineNo: lineNo }
		: type === "added"
			? { type, content, newLineNo: lineNo }
			: { type, content, oldLineNo: lineNo, newLineNo: lineNo + 10 };
}

function rows(entries: SplitDiffEntry[]) {
	return entries.filter((entry) => entry.kind === "row");
}

const hunk = (rowIndex: number, range: string): ParsedDiffHunk => ({
	rowIndex,
	heading: "function example",
	oldStart: 1,
	newStart: 1,
	range,
});

describe("alignUnifiedDiffToSplit", () => {
	test("copies context to both sides and zips a following edit", () => {
		const lines = [row("context", "keep", 1), row("removed", "old", 2), row("added", "new", 12)];
		const paired = rows(alignUnifiedDiffToSplit(lines, [hunk(0, "-1,3 +11,3")]));

		expect(paired.map((entry) => [entry.left?.content, entry.right?.content])).toEqual([
			["keep", "keep"],
			["old", "new"],
		]);
		expect(paired[0]?.left).toMatchObject({ type: "context", lineNo: 1, sourceIndex: 0 });
		expect(paired[0]?.right).toMatchObject({ type: "context", lineNo: 11, sourceIndex: 0 });
		expect(paired[1]?.left).toMatchObject({ type: "removed", lineNo: 2 });
		expect(paired[1]?.right).toMatchObject({ type: "added", lineNo: 12 });
	});

	test("leaves a blank cell when a removal run is longer than the additions", () => {
		const lines = [row("removed", "a", 1), row("removed", "b", 2), row("added", "c", 1)];
		const paired = rows(alignUnifiedDiffToSplit(lines));

		expect(
			paired.map((entry) => [entry.left?.content ?? null, entry.right?.content ?? null]),
		).toEqual([
			["a", "c"],
			["b", null],
		]);
		expect(paired[1]?.right).toBeNull();
	});

	test("does not pair a deletion with an addition across context", () => {
		const lines = [
			row("removed", "gone", 4),
			row("context", "middle", 5),
			row("added", "fresh", 16),
		];
		const paired = rows(alignUnifiedDiffToSplit(lines));

		expect(
			paired.map((entry) => [entry.left?.content ?? null, entry.right?.content ?? null]),
		).toEqual([
			["gone", null],
			["middle", "middle"],
			[null, "fresh"],
		]);
	});

	test("renders pure additions and pure deletions against an empty side", () => {
		const added = rows(alignUnifiedDiffToSplit([row("added", "only", 1), row("added", "more", 2)]));
		expect(added.map((entry) => [entry.left, entry.right?.content])).toEqual([
			[null, "only"],
			[null, "more"],
		]);

		const removed = rows(alignUnifiedDiffToSplit([row("removed", "drop", 8)]));
		expect(removed[0]?.left?.content).toBe("drop");
		expect(removed[0]?.right).toBeNull();
	});

	test("keeps word changes on the side that owns the line", () => {
		const removed: DiffLine = {
			type: "removed",
			content: "const a = 1",
			oldLineNo: 3,
			wordChanges: [{ value: "const " }, { value: "a", removed: true }, { value: " = 1" }],
		};
		const added: DiffLine = {
			type: "added",
			content: "const b = 1",
			newLineNo: 3,
			wordChanges: [{ value: "const " }, { value: "b", added: true }, { value: " = 1" }],
		};
		const paired = rows(alignUnifiedDiffToSplit([removed, added]));
		expect(paired[0]?.left?.wordChanges).toBe(removed.wordChanges);
		expect(paired[0]?.right?.wordChanges).toBe(added.wordChanges);
	});

	test("inserts hunk markers before the row they precede, including a trailing marker", () => {
		const lines = [row("context", "body", 2)];
		const entries = alignUnifiedDiffToSplit(lines, [hunk(0, "-2,1 +12,1"), hunk(4, "-9,1 +9,1")]);

		expect(entries.map((entry) => entry.kind)).toEqual(["hunk", "row", "hunk"]);
		expect(entries[0]).toMatchObject({ kind: "hunk", hunk: { range: "-2,1 +12,1" } });
		expect(entries[2]).toMatchObject({ kind: "hunk", hunk: { range: "-9,1 +9,1" } });
	});
});
