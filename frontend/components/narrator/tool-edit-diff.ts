import type { FileSelection } from "@shared/file-reference";
import {
	clampDiffLineContent,
	type DiffLine,
	normalizeDiffLineEndings,
} from "@shared/pretext-layout/diff-core";
import type { ParsedDiffHunk } from "@shared/pretext-layout/parse-unified-diff";
import type { ToolEditPreview } from "@shared/tool-edit-preview";
import { diffLines } from "diff";

const CONTEXT = 3;
const MAX_ROWS = 5_000;
const MAX_ROW_CHARS = 240_000;
const MAX_SOURCE_CHARS = 2 * 1024 * 1024;

export interface ToolEditDiff {
	lines: DiffLine[];
	hunks: ParsedDiffHunk[];
	truncated: boolean;
	unavailable: boolean;
	firstChange?: { oldLine: number; newLine: number };
}

/** Bounded, exact historical hunks. Long unchanged prefixes are never painted as diff rows. */
export function buildToolEditDiff(oldText: string, newText: string): ToolEditDiff {
	const result: ToolEditDiff = { lines: [], hunks: [], truncated: false, unavailable: false };
	if (oldText.length + newText.length > MAX_SOURCE_CHARS) return { ...result, unavailable: true };
	const changes = diffLines(normalizeDiffLineEndings(oldText), normalizeDiffLineEndings(newText), {
		timeout: 75,
		maxEditLength: 10_000,
	});
	if (!changes) return { ...result, unavailable: true };
	let oldLine = 1;
	let newLine = 1;
	let chars = 0;
	let hunk: ParsedDiffHunk | undefined;
	let oldCount = 0;
	let newCount = 0;
	const finishHunk = () => {
		if (hunk) {
			if (oldCount === 0) hunk.oldStart = Math.max(0, hunk.oldStart - 1);
			if (newCount === 0) hunk.newStart = Math.max(0, hunk.newStart - 1);
			hunk.range = `-${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount}`;
		}
		hunk = undefined;
		oldCount = newCount = 0;
	};
	const emit = (type: DiffLine["type"], text: string): boolean => {
		const content = clampDiffLineContent(text);
		if (result.lines.length >= MAX_ROWS || chars + content.length > MAX_ROW_CHARS) {
			result.truncated = true;
			return false;
		}
		if (!hunk) {
			hunk = {
				rowIndex: result.lines.length,
				heading: "",
				range: "",
				oldStart: oldLine,
				newStart: newLine,
			};
			result.hunks.push(hunk);
		}
		if (content !== text) result.truncated = true;
		result.lines.push({
			type,
			content,
			...(type !== "added" ? { oldLineNo: oldLine++ } : {}),
			...(type !== "removed" ? { newLineNo: newLine++ } : {}),
		});
		if (type !== "added") oldCount++;
		if (type !== "removed") newCount++;
		chars += content.length;
		return true;
	};
	outer: for (let i = 0; i < changes.length; i++) {
		const change = changes[i];
		if (!change) continue;
		const rows = change.value.split("\n");
		if (rows.at(-1) === "") rows.pop();
		if (change.added || change.removed) {
			result.firstChange ??= { oldLine, newLine };
			for (const row of rows) if (!emit(change.added ? "added" : "removed", row)) break outer;
			continue;
		}
		const preceding = i > 0;
		const following = i < changes.length - 1;
		if (preceding && following && rows.length <= CONTEXT * 2) {
			for (const row of rows) if (!emit("context", row)) break outer;
			continue;
		}
		const head = preceding ? Math.min(CONTEXT, rows.length) : 0;
		const tail = following ? Math.min(CONTEXT, rows.length - head) : 0;
		for (const row of rows.slice(0, head)) if (!emit("context", row)) break outer;
		finishHunk();
		const skipped = rows.length - head - tail;
		oldLine += skipped;
		newLine += skipped;
		for (const row of rows.slice(rows.length - tail)) {
			if (tail && !emit("context", row)) break outer;
		}
	}
	finishHunk();
	return result;
}

/** Fall back to the first actual changed line, never search the current disk or a tool input snippet. */
export function toolEditSelection(
	preview: ToolEditPreview,
	side: "old" | "new",
	diff: ToolEditDiff | null,
): FileSelection | undefined {
	const start =
		preview.location?.startLine ??
		(side === "old" ? diff?.firstChange?.oldLine : diff?.firstChange?.newLine);
	if (start == null || !Number.isSafeInteger(start) || start < 1) return undefined;
	const end = preview.location
		? side === "old"
			? preview.location.endLine
			: preview.location.newEndLine
		: start;
	return {
		startLineNumber: start,
		startColumn: 1,
		endLineNumber: Math.max(start, end ?? start) + 1,
		endColumn: 1,
	};
}
