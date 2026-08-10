/**
 * parse-unified-diff.ts — Turn a git unified patch into the shared `DiffLine[]`.
 *
 * WHY THIS EXISTS
 *
 * `computeDiff` produces rows from TWO TEXTS. Git hands us the opposite: a patch
 * whose diff is already computed. The git panel therefore had no way to reach the
 * shared renderer and fell back to printing the raw patch as plain text — no
 * highlighting, no per-line tint, no line numbers.
 *
 * Reversing the patch back into two full texts is not an option: a patch only
 * carries its hunk context, so the "original" reconstructed from it is
 * incomplete, and the real file line numbers in `@@` headers would be thrown away
 * and recomputed from 1. Parsing straight into `DiffLine[]` keeps those numbers,
 * which makes the git gutter MORE accurate than the two-text path's.
 *
 * PURE: no React, no Mantine, no DOM, no frontend imports — enforced by the
 * enumerating `shared-core.guard.test.ts` in this directory.
 *
 * Per-line clamping is reused from diff-core rather than redefined. The parser
 * deliberately has NO row ceiling: the git modal now decides how many already-
 * parsed rows are visible and reveals the next 500 as the reader scrolls.
 */

import { clampDiffLineContent, type DiffLine, pairWordChanges } from "./diff-core";

/**
 * One hunk boundary, carried ALONGSIDE the rows rather than inside them.
 *
 * A `@@` header is not a diff row: `DiffLine["type"]` is a three-way union read by
 * the measure layer and the pretext adapter, so widening it for a separator would
 * ripple through every consumer. A parallel array keeps the row model untouched —
 * a renderer that ignores `hunks` behaves exactly as before.
 */
export interface ParsedDiffHunk {
	/** Index in `lines` of the first row this header precedes. */
	rowIndex: number;
	/** Trailing text of the `@@` line — usually the enclosing function signature. */
	heading: string;
	/** 1-based first line of the hunk on the old side. */
	oldStart: number;
	/** 1-based first line of the hunk on the new side. */
	newStart: number;
	/**
	 * The header's range text, verbatim: `-12,6 +12,7`.
	 *
	 * Kept as the original string rather than rebuilt from the parsed numbers.
	 * Reconstructing `-${oldStart} +${newStart}` silently DROPS the counts, so a
	 * separator would read `@@ -12 +12 @@` for a header that actually said
	 * `@@ -12,6 +12,7 @@` — a label shaped like a hunk header but carrying less
	 * information than the one it came from. Git also omits the count when it is 1,
	 * and only the source text knows which form was used.
	 */
	range: string;
}

export interface ParsedUnifiedDiff {
	lines: DiffLine[];
	/** Hunk boundaries in row order, for rendering separators. */
	hunks: ParsedDiffHunk[];
	/**
	 * Compatibility field for existing callers. Always false now that row
	 * visibility is controlled by the git modal instead of by parser truncation.
	 */
	truncated: boolean;
	/** Patch declares a binary file; there are no text rows to render. */
	binary: boolean;
	/** Patch covered more than one file; only the first was parsed. */
	multiFile: boolean;
}

/**
 * `@@ -oldStart,oldCount +newStart,newCount @@ optional heading`
 *
 * Group 1 captures the range verbatim (`-12,6 +12,7`) so a renderer can reprint it
 * exactly; groups 2 and 3 give the two start lines for numbering; group 4 is git's
 * context hint (the enclosing function), which the row model has no place for and
 * which was previously discarded.
 */
const HUNK_HEADER = /^@@ (-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?) @@ ?(.*)$/;

/**
 * Prefixes that carry patch metadata rather than file content.
 *
 * `---`/`+++` are deliberately NOT here: they must be matched before the
 * removed/added tests (see `isFileHeader`), not alongside the mode lines.
 */
const METADATA_PREFIXES = [
	"index ",
	"old mode ",
	"new mode ",
	"deleted file mode ",
	"new file mode ",
	"similarity index ",
	"dissimilarity index ",
	"rename from ",
	"rename to ",
	"copy from ",
	"copy to ",
];

/**
 * A patch file header, which shares its first character with a content row.
 *
 * THE TRAP THIS CLOSES: `--- a/src/x.ts` starts with `-` and `+++ b/src/x.ts`
 * starts with `+`. Testing for removed/added first would label the entire patch
 * header as content changes. Matching must also stay narrow — a lone `-` or a
 * `--` in real code is an ordinary removal — so the exact three-character marker
 * plus a space (or end of line) is required.
 */
function isFileHeader(line: string): boolean {
	return line === "---" || line === "+++" || line.startsWith("--- ") || line.startsWith("+++ ");
}

function isBinaryMarker(line: string): boolean {
	return line.startsWith("Binary files ") || line.startsWith("GIT binary patch");
}

/**
 * Parse the first file of a unified patch into renderable rows.
 *
 * Hunk headers intentionally produce NO row: `DiffLine["type"]` is a three-way
 * union consumed by the measure and pretext layers, and widening it for a
 * separator would ripple through all of them. They are reported in `hunks`
 * instead, so a renderer can draw a separator without the row model changing.
 */
export function parseUnifiedDiff(patch: string): ParsedUnifiedDiff {
	const lines: DiffLine[] = [];
	const hunks: ParsedDiffHunk[] = [];
	const truncated = false;
	let binary = false;
	let multiFile = false;

	if (!patch) return { lines, hunks, truncated, binary, multiFile };

	let oldLineNo = 0;
	let newLineNo = 0;
	let inHunk = false;
	let sawFileStart = false;

	// Removed/added rows are buffered so a run of removals immediately followed by
	// a run of additions can be word-diffed pairwise, matching what the two-text
	// path does for a modification.
	let pendingRemoved: string[] = [];
	let pendingAdded: string[] = [];

	/** Emit one row. Visibility is paged by the modal, never by this parser. */
	const push = (line: DiffLine): void => {
		lines.push(line);
	};

	/**
	 * Flush buffered removals/additions.
	 *
	 * Order is all removals then all additions — the shape git itself prints —
	 * while word changes still come from pairwise comparison, so a modified line
	 * keeps its intra-line marking.
	 */
	const flush = (): void => {
		if (pendingRemoved.length === 0 && pendingAdded.length === 0) return;

		const paired = Math.min(pendingRemoved.length, pendingAdded.length);
		const wordChanges = pendingRemoved.map((removed, i) =>
			i < paired ? pairWordChanges(removed, pendingAdded[i] ?? "") : null,
		);

		for (let i = 0; i < pendingRemoved.length; i++) {
			push({
				type: "removed",
				content: pendingRemoved[i] ?? "",
				wordChanges: wordChanges[i]?.removed,
				oldLineNo: oldLineNo + i,
			});
		}
		for (let i = 0; i < pendingAdded.length; i++) {
			push({
				type: "added",
				content: pendingAdded[i] ?? "",
				wordChanges: i < paired ? wordChanges[i]?.added : undefined,
				newLineNo: newLineNo + i,
			});
		}

		oldLineNo += pendingRemoved.length;
		newLineNo += pendingAdded.length;
		pendingRemoved = [];
		pendingAdded = [];
	};

	for (const raw of patch.split("\n")) {
		// A second `diff --git` means the patch spans files. Callers request a single
		// file, so stop rather than concatenating unrelated rows under one heading.
		if (raw.startsWith("diff --git")) {
			if (sawFileStart) {
				multiFile = true;
				break;
			}
			sawFileStart = true;
			continue;
		}

		if (isBinaryMarker(raw)) {
			binary = true;
			break;
		}

		// Must precede the removed/added tests.
		if (isFileHeader(raw)) continue;

		if (METADATA_PREFIXES.some((prefix) => raw.startsWith(prefix))) continue;

		const hunk = HUNK_HEADER.exec(raw);
		if (hunk) {
			flush();
			oldLineNo = Number(hunk[2]);
			newLineNo = Number(hunk[3]);
			inHunk = true;
			// `rowIndex` is the row this header sits ABOVE. Recorded before the hunk's
			// rows exist, so it equals the current length.
			hunks.push({
				rowIndex: lines.length,
				heading: (hunk[4] ?? "").trim(),
				oldStart: oldLineNo,
				newStart: newLineNo,
				range: hunk[1] ?? "",
			});
			continue;
		}

		// Anything before the first hunk is preamble (commit text, mode noise).
		if (!inHunk) continue;

		// Neither a change nor context — it annotates the preceding row.
		if (raw.startsWith("\\")) continue;

		if (raw.startsWith("-")) {
			pendingRemoved.push(clampDiffLineContent(raw.slice(1)));
			continue;
		}
		if (raw.startsWith("+")) {
			pendingAdded.push(clampDiffLineContent(raw.slice(1)));
			continue;
		}

		// Context row (leading space), or a bare empty line, which git emits for an
		// unchanged blank line.
		flush();
		const content = raw.startsWith(" ") ? raw.slice(1) : raw;
		push({
			type: "context",
			content: clampDiffLineContent(content),
			oldLineNo,
			newLineNo,
		});
		oldLineNo++;
		newLineNo++;
	}

	if (!binary) flush();

	// A binary patch emits no rows. Metadata-only hunks are also filtered so a
	// separator is never rendered with nothing underneath it.
	const anchored = binary ? [] : hunks.filter((h) => h.rowIndex < lines.length);

	return { lines, hunks: anchored, truncated, binary, multiFile };
}
