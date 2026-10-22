import type { DiffLine, DiffWordChange } from "@shared/pretext-layout/diff-core";
import type { ParsedDiffHunk } from "@shared/pretext-layout/parse-unified-diff";

/** One side of a split-diff row. `null` on the row means that side has no line. */
export interface SplitDiffSide {
	type: "context" | "removed" | "added";
	content: string;
	lineNo?: number;
	wordChanges?: DiffWordChange[];
	/** Index into the unified `lines` array, for syntax-token lookup. */
	sourceIndex: number;
}

export type SplitDiffEntry =
	| { kind: "hunk"; hunk: ParsedDiffHunk }
	| { kind: "row"; left: SplitDiffSide | null; right: SplitDiffSide | null };

function sideOf(line: DiffLine, edge: "old" | "new", sourceIndex: number): SplitDiffSide {
	return {
		type: line.type === "context" ? "context" : edge === "old" ? "removed" : "added",
		content: line.content,
		lineNo: edge === "old" ? line.oldLineNo : line.newLineNo,
		wordChanges: line.type === "context" ? undefined : line.wordChanges,
		sourceIndex,
	};
}

/**
 * Pair unified diff rows the way GitHub's split view does.
 *
 * Context is copied to both columns. A run of removals followed by a run of
 * additions is zipped, and the shorter side stays blank. A context row ends the
 * run, so a deletion and an addition on opposite sides of unchanged text are not
 * paired. Hunk headers stay full-width markers at the row they precede.
 */
export function alignUnifiedDiffToSplit(
	lines: readonly DiffLine[],
	hunks: readonly ParsedDiffHunk[] = [],
): SplitDiffEntry[] {
	const hunksAt = new Map<number, ParsedDiffHunk[]>();
	for (const hunk of hunks) {
		const bucket = hunksAt.get(hunk.rowIndex);
		if (bucket) bucket.push(hunk);
		else hunksAt.set(hunk.rowIndex, [hunk]);
	}

	const entries: SplitDiffEntry[] = [];
	const emitHunks = (index: number) => {
		const bucket = hunksAt.get(index);
		if (!bucket) return;
		for (const hunk of bucket) entries.push({ kind: "hunk", hunk });
	};

	let index = 0;
	/** Take a consecutive run. The first row's hunk was already emitted when `firstAlreadyEmitted`. */
	const take = (type: "removed" | "added", firstAlreadyEmitted: boolean) => {
		const taken: { line: DiffLine; sourceIndex: number }[] = [];
		let emitted = firstAlreadyEmitted;
		while (index < lines.length && lines[index]?.type === type) {
			if (!emitted) emitHunks(index);
			emitted = false;
			const line = lines[index];
			if (!line) break;
			taken.push({ line, sourceIndex: index });
			index += 1;
		}
		return taken;
	};

	while (index < lines.length) {
		emitHunks(index);
		const line = lines[index];
		if (!line) break;
		if (line.type === "context") {
			entries.push({
				kind: "row",
				left: sideOf(line, "old", index),
				right: sideOf(line, "new", index),
			});
			index += 1;
			continue;
		}
		const removed = take("removed", true);
		const added = take("added", removed.length === 0);
		const count = Math.max(removed.length, added.length);
		for (let pair = 0; pair < count; pair += 1) {
			const left = removed[pair];
			const right = added[pair];
			entries.push({
				kind: "row",
				left: left ? sideOf(left.line, "old", left.sourceIndex) : null,
				right: right ? sideOf(right.line, "new", right.sourceIndex) : null,
			});
		}
	}

	for (const [rowIndex, bucket] of hunksAt) {
		if (rowIndex < lines.length) continue;
		for (const hunk of bucket) entries.push({ kind: "hunk", hunk });
	}
	return entries;
}
