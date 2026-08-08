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
 * Bounds and per-line clamping are reused from diff-core rather than redefined,
 * so both row producers answer to one set of limits.
 */

import { clampDiffLineContent, type DiffLine, MAX_DIFF_LINES, pairWordChanges } from "./diff-core";

export interface ParsedUnifiedDiff {
	lines: DiffLine[];
	/** Row count hit `MAX_DIFF_LINES` and parsing stopped early. */
	truncated: boolean;
	/** Patch declares a binary file; there are no text rows to render. */
	binary: boolean;
	/** Patch covered more than one file; only the first was parsed. */
	multiFile: boolean;
}

/** `@@ -oldStart,oldCount +newStart,newCount @@ optional heading` */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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
 * separator would ripple through all of them. The line-number gutter already
 * shows the jump between hunks.
 */
export function parseUnifiedDiff(patch: string): ParsedUnifiedDiff {
	const lines: DiffLine[] = [];
	let truncated = false;
	let binary = false;
	let multiFile = false;

	if (!patch) return { lines, truncated, binary, multiFile };

	let oldLineNo = 0;
	let newLineNo = 0;
	let inHunk = false;
	let sawFileStart = false;

	// Removed/added rows are buffered so a run of removals immediately followed by
	// a run of additions can be word-diffed pairwise, matching what the two-text
	// path does for a modification.
	let pendingRemoved: string[] = [];
	let pendingAdded: string[] = [];

	/** Emit one row; returns false once the row ceiling is reached. */
	const push = (line: DiffLine): boolean => {
		if (lines.length >= MAX_DIFF_LINES) {
			truncated = true;
			return false;
		}
		lines.push(line);
		return true;
	};

	/**
	 * Flush buffered removals/additions.
	 *
	 * Order is all removals then all additions — the shape git itself prints —
	 * while word changes still come from pairwise comparison, so a modified line
	 * keeps its intra-line marking.
	 */
	const flush = (): boolean => {
		if (pendingRemoved.length === 0 && pendingAdded.length === 0) return true;

		const paired = Math.min(pendingRemoved.length, pendingAdded.length);
		const wordChanges = pendingRemoved.map((removed, i) =>
			i < paired ? pairWordChanges(removed, pendingAdded[i] ?? "") : null,
		);

		for (let i = 0; i < pendingRemoved.length; i++) {
			if (
				!push({
					type: "removed",
					content: pendingRemoved[i] ?? "",
					wordChanges: wordChanges[i]?.removed,
					oldLineNo: oldLineNo + i,
				})
			) {
				return false;
			}
		}
		for (let i = 0; i < pendingAdded.length; i++) {
			if (
				!push({
					type: "added",
					content: pendingAdded[i] ?? "",
					wordChanges: i < paired ? wordChanges[i]?.added : undefined,
					newLineNo: newLineNo + i,
				})
			) {
				return false;
			}
		}

		oldLineNo += pendingRemoved.length;
		newLineNo += pendingAdded.length;
		pendingRemoved = [];
		pendingAdded = [];
		return true;
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
			if (!flush()) break;
			oldLineNo = Number(hunk[1]);
			newLineNo = Number(hunk[2]);
			inHunk = true;
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
		if (!flush()) break;
		const content = raw.startsWith(" ") ? raw.slice(1) : raw;
		if (
			!push({
				type: "context",
				content: clampDiffLineContent(content),
				oldLineNo,
				newLineNo,
			})
		) {
			break;
		}
		oldLineNo++;
		newLineNo++;
	}

	if (!binary) flush();

	return { lines, truncated, binary, multiFile };
}
