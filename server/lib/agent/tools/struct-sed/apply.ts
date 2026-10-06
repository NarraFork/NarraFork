/**
 * Pure text transforms behind StructSed: applying one command, and building the previews
 * and card diffs from before/after text.
 *
 * Nothing here touches IO or the tool context, so it is unit-tested directly and shared by
 * both the dry-run preview and the applied write.
 */

import { countDiffLineStats, type DiffLineStats } from "@shared/pretext-layout/diff-core";
import { diffArrays } from "diff";
import {
	appendAfter,
	deleteRange,
	EditOpError,
	insertBefore,
	type LineRange,
	type MovePlacement,
	relocateRange,
	replaceRange,
	substituteInRange,
} from "../../structural/edit-ops";
import { normalizeLineEndings } from "../encoding";
import { lineStatsMetadata, wholeFileLineStats } from "../file-diff-stats";
import {
	type Command,
	DIFF_CONTEXT_LINES,
	MAX_DIFF_EDIT_LENGTH,
	MAX_DIFF_HUNK_LINES,
	MAX_DIFF_HUNKS,
	MAX_PREVIEW_LINES,
} from "./commands";

/** Apply the command to LF-normalized text. Throws `EditOpError` on an invalid request. */
export function applyCommand(
	command: Command,
	text: string,
	range: LineRange,
	args: {
		content?: string;
		pattern?: string;
		replacement?: string;
		flags?: string;
		/** Resolved destination for copy/move; absent means end of file. */
		anchor?: LineRange;
		placement?: MovePlacement;
	},
): { text: string; replacements?: number } {
	switch (command) {
		case "delete":
			return { text: deleteRange(text, range) };
		case "copy":
		case "move":
			return {
				text: relocateRange(text, range, {
					...(args.anchor ? { anchor: args.anchor } : {}),
					placement: args.placement ?? "after",
					removeSource: command === "move",
				}),
			};
		case "replace": {
			if (typeof args.content !== "string") {
				throw new EditOpError("command=replace requires `content`.");
			}
			return { text: replaceRange(text, range, normalizeLineEndings(args.content)) };
		}
		case "insert": {
			if (typeof args.content !== "string") {
				throw new EditOpError("command=insert requires `content`.");
			}
			return { text: insertBefore(text, range, normalizeLineEndings(args.content)) };
		}
		case "append": {
			if (typeof args.content !== "string") {
				throw new EditOpError("command=append requires `content`.");
			}
			return { text: appendAfter(text, range, normalizeLineEndings(args.content)) };
		}
		case "substitute": {
			if (typeof args.pattern !== "string" || !args.pattern) {
				throw new EditOpError("command=substitute requires `pattern`.");
			}
			if (typeof args.replacement !== "string") {
				throw new EditOpError("command=substitute requires `replacement`.");
			}
			const result = substituteInRange(text, range, args.pattern, args.replacement, {
				...(args.flags ? { flags: args.flags } : {}),
			});
			return { text: result.text, replacements: result.replacements };
		}
	}
}

/**
 * One changed region of the card's diff: its lines on each side plus context, and where
 * each side starts in its own file.
 *
 * The sides start at different lines whenever an earlier hunk inserted or removed lines,
 * which is the normal case for the second half of a move — hence two origins.
 */
export interface DiffHunk {
	oldText: string;
	newText: string;
	/** 1-based line of `oldText`'s first line in the file before the change. */
	oldStart: number;
	/** 1-based line of `newText`'s first line in the file after the change. */
	newStart: number;
	/** Set when a side exceeded `MAX_DIFF_HUNK_LINES` and was cut. */
	truncated?: true;
}

/** The card's diff: every changed region, each with its own context window. */
export interface DiffHunks {
	hunks: DiffHunk[];
	/** Changed regions left out past `MAX_DIFF_HUNKS`; absent when none were. */
	omittedHunks?: number;
}

/** A changed line range, `[start, end)` on each side, 0-based. */
interface ChangeSpan {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

/**
 * Every region that changed between two texts, each with `DIFF_CONTEXT_LINES` of context.
 *
 * Replaces a single first-to-last-difference window. That window's length was the
 * DISTANCE between edits, not their size: a 14-line move across 370 lines produced a
 * 390-line window, which either exceeded the span limit (no diff at all) or blew past the
 * per-field broadcast budget and reached the card as a truncated leaf (an empty card).
 * Hunks are as long as the change, so the same move is two ~20-line hunks.
 *
 * Computed from the two texts, never from the command's range, so move/copy, substitute
 * and batches are all handled uniformly. Returns null only when nothing changed.
 */
export function diffHunks(before: string, after: string): DiffHunks | null {
	const b = before.split("\n");
	const a = after.split("\n");

	// Trim the common prefix and suffix first: the line diff below then runs on the
	// changed middle only, which is what keeps it cheap for a surgical edit in a big file.
	let head = 0;
	while (head < b.length && head < a.length && b[head] === a[head]) head++;
	let bTail = b.length;
	let aTail = a.length;
	while (bTail > head && aTail > head && b[bTail - 1] === a[aTail - 1]) {
		bTail--;
		aTail--;
	}
	if (bTail === head && aTail === head) return null;

	const spans = changeSpans(b, a, head, bTail, aTail);
	const groups = groupSpans(spans);
	const kept = groups.slice(0, MAX_DIFF_HUNKS);
	const hunks = kept.map((group) => buildHunk(b, a, group));
	const omitted = groups.length - kept.length;
	return { hunks, ...(omitted > 0 ? { omittedHunks: omitted } : {}) };
}

/** Changed spans inside the trimmed middle, in absolute 0-based line indices. */
function changeSpans(
	b: readonly string[],
	a: readonly string[],
	head: number,
	bTail: number,
	aTail: number,
): ChangeSpan[] {
	const changes = diffArrays(b.slice(head, bTail), a.slice(head, aTail), {
		maxEditLength: MAX_DIFF_EDIT_LENGTH,
	});
	// Too many edits to diff within budget: one span covering the whole changed middle is
	// still a correct (if coarse) diff, where dropping it would hide the change.
	if (!changes) return [{ oldStart: head, oldEnd: bTail, newStart: head, newEnd: aTail }];

	const spans: ChangeSpan[] = [];
	let oldAt = head;
	let newAt = head;
	let open: ChangeSpan | null = null;
	for (const change of changes) {
		const count = change.count ?? change.value.length;
		if (!change.added && !change.removed) {
			if (open) spans.push(open);
			open = null;
			oldAt += count;
			newAt += count;
			continue;
		}
		open ??= { oldStart: oldAt, oldEnd: oldAt, newStart: newAt, newEnd: newAt };
		if (change.removed) {
			oldAt += count;
			open.oldEnd = oldAt;
		} else {
			newAt += count;
			open.newEnd = newAt;
		}
	}
	if (open) spans.push(open);
	return spans;
}

/**
 * Merge spans whose context windows would touch, so no line is shown twice and two
 * nearby edits read as one hunk (the usual unified-diff rule).
 */
function groupSpans(spans: readonly ChangeSpan[]): ChangeSpan[] {
	const groups: ChangeSpan[] = [];
	for (const span of spans) {
		const last = groups[groups.length - 1];
		if (last && span.oldStart - last.oldEnd <= DIFF_CONTEXT_LINES * 2) {
			last.oldEnd = span.oldEnd;
			last.newEnd = span.newEnd;
		} else {
			groups.push({ ...span });
		}
	}
	return groups;
}

function buildHunk(b: readonly string[], a: readonly string[], span: ChangeSpan): DiffHunk {
	// Context is equal on both sides by construction (the lines outside a span match), so
	// the same offset applies to each.
	const lead = Math.min(DIFF_CONTEXT_LINES, span.oldStart, span.newStart);
	const trail = Math.min(DIFF_CONTEXT_LINES, b.length - span.oldEnd, a.length - span.newEnd);
	const oldFrom = span.oldStart - lead;
	const newFrom = span.newStart - lead;
	const oldLines = b.slice(oldFrom, span.oldEnd + trail);
	const newLines = a.slice(newFrom, span.newEnd + trail);
	const cut = oldLines.length > MAX_DIFF_HUNK_LINES || newLines.length > MAX_DIFF_HUNK_LINES;
	return {
		oldText: oldLines.slice(0, MAX_DIFF_HUNK_LINES).join("\n"),
		newText: newLines.slice(0, MAX_DIFF_HUNK_LINES).join("\n"),
		oldStart: oldFrom + 1,
		newStart: newFrom + 1,
		...(cut ? { truncated: true as const } : {}),
	};
}

/**
 * Added/removed line counts for an actual before → after rewrite.
 *
 * MUST compare the real two texts. An earlier version passed `selected region` vs
 * `content ?? ""`, which is only right for `replace`/`delete`: `substitute` has no
 * `content`, so an 89-line selection with one token rewritten reported `-89` — the
 * whole range looked deleted while the card showed a one-line edit. `insert`/`append`
 * have the mirror-image bug (region vs inserted text pretends the kept lines vanished),
 * and `copy`/`move` have no single "replacement text" at all.
 *
 * Whole-file first (same budget Edit uses on the main thread). When that exceeds the
 * budget, fall back to summing the hunks — the common case for a surgical substitute in a
 * large file, which is exactly when the wrong figure used to appear. A cut hunk makes the
 * sum incomplete, so the figure is withheld rather than understated.
 */
export function changeLineStats(
	before: string,
	after: string,
	hunks?: DiffHunks | null,
): DiffLineStats | null {
	const whole = wholeFileLineStats(before, after);
	if (whole) return whole;
	const diff = hunks === undefined ? diffHunks(before, after) : hunks;
	if (!diff || diff.omittedHunks || diff.hunks.some((hunk) => hunk.truncated)) return null;
	let added = 0;
	let removed = 0;
	for (const hunk of diff.hunks) {
		const stats = countDiffLineStats(hunk.oldText, hunk.newText);
		if (!stats) return null;
		added += stats.added;
		removed += stats.removed;
	}
	return { added, removed };
}

/**
 * The card's diff metadata for a change, or `{}` when it should not carry one.
 *
 * Shared by the preview and the applied write so BOTH show a diff; they differ only by
 * the preview banner. Also carries `linesAdded`/`linesRemoved` from the same before/after
 * pair, so the header figure cannot drift from the painted diff. Absent (not zero) when
 * the count cannot be established — see `changeLineStats`.
 */
export function diffMetadata(
	before: string,
	after: string,
): {
	diffHunks?: DiffHunk[];
	diffOmittedHunks?: number;
	linesAdded?: number;
	linesRemoved?: number;
} {
	const diff = diffHunks(before, after);
	return {
		...(diff ? { diffHunks: diff.hunks } : {}),
		...(diff?.omittedHunks ? { diffOmittedHunks: diff.omittedHunks } : {}),
		...lineStatsMetadata(changeLineStats(before, after, diff)),
	};
}

/** A bounded excerpt of the changed region, so a preview cannot flood the context. */
export function previewRegion(text: string, range: LineRange): string {
	const lines = normalizeLineEndings(text).split("\n");
	const start = Math.max(1, range.startLine);
	const end = Math.min(lines.length, range.endLine);
	const shown = lines.slice(start - 1, Math.min(end, start - 1 + MAX_PREVIEW_LINES));
	const numbered = shown.map(
		(line: string, i: number) => `${String(start + i).padStart(6)}│${line}`,
	);
	const omitted = end - start + 1 - shown.length;
	if (omitted > 0) numbered.push(`       … ${omitted} more line${omitted === 1 ? "" : "s"}`);
	return numbered.join("\n");
}
