/**
 * file-diff-stats.ts — The `+N -N` line counts Write/Edit attach to their result.
 *
 * WHY THE SERVER COMPUTES THIS
 * ----------------------------
 * The client cannot. `truncateToolIO` projects `content` / `old_string` /
 * `new_string` down to an 8KB per-leaf budget before a tool call reaches the
 * browser, so a large Write or a long Edit arrives as a PREFIX — counting lines
 * there silently under-reports, with nothing to indicate the figure is wrong. A
 * Write is worse still: its input never carries the file's previous content, so
 * the client could only ever conclude "everything is new".
 *
 * Here both sides are in hand, so the number is right once and travels as
 * metadata.
 *
 * ⚠️ ABSENT MEANS UNKNOWN, NOT ZERO. Every helper returns `null` (→ the caller
 * omits both keys) when it cannot answer. `{ added: 0, removed: 0 }` is reserved
 * for a call that genuinely changed no lines. The renderer draws nothing for a
 * missing figure and nothing for a zero one, so the two look alike on screen —
 * but persisting 0 for "unknown" would make a large rewrite claim it changed
 * nothing, and later readers of the row could not tell the difference.
 */

import {
	countDiffLineStats,
	countTextLines,
	type DiffLineStats,
} from "@shared/pretext-layout/diff-core";

/**
 * Input ceiling (chars, both sides summed) for a WHOLE-FILE statistics diff.
 *
 * Deliberately far below `MAX_DIFF_INPUT_CHARS` (240KB): that bound was sized for
 * the render path, where a diff is computed in a browser tab for content the
 * reader is already looking at. This runs on the server's single JS thread — the
 * one carrying every HTTP request, WebSocket frame and the agent loop itself — and
 * a whole-file rewrite is the worst case for Myers' O(N·D). 64KB keeps ordinary
 * source files (well under 2000 lines) served while refusing the pathological
 * ones, which then simply show no figure.
 *
 * Only the whole-file callers pass it. An Edit's `old_string`/`new_string` pair is
 * bounded by what the model wrote and gets the default budget.
 */
export const MAX_WHOLE_FILE_STATS_CHARS = 64_000;

/**
 * Line stats for a whole-file replacement (Write, or Edit's overwrite mode).
 *
 * `previousContent === null` means the file did not exist, so every line is an
 * addition and no diff is needed at all.
 */
export function wholeFileLineStats(
	previousContent: string | null,
	nextContent: string,
): DiffLineStats | null {
	if (previousContent === null) return { added: countTextLines(nextContent), removed: 0 };
	return countDiffLineStats(previousContent, nextContent, {
		maxInputChars: MAX_WHOLE_FILE_STATS_CHARS,
	});
}

/**
 * Line stats for a string replacement.
 *
 * `occurrences` scales the per-occurrence figure for `replace_all`: the same
 * substitution applied N times changes N times as many lines, and reporting the
 * single-occurrence count for a 30-site rename would understate it by 30×. The
 * caller counts occurrences against the text it is about to modify, because that
 * is the only place the real number is known.
 */
export function replacementLineStats(
	oldString: string,
	newString: string,
	occurrences = 1,
): DiffLineStats | null {
	if (occurrences <= 0) return null;
	const perOccurrence = countDiffLineStats(oldString, newString);
	if (!perOccurrence) return null;
	return {
		added: perOccurrence.added * occurrences,
		removed: perOccurrence.removed * occurrences,
	};
}

/** How many times `needle` occurs in `haystack` (non-overlapping). */
export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/**
 * The metadata keys for a line-stat result, as a spreadable object.
 *
 * Returns `{}` for `null` so the keys stay ABSENT rather than being written as
 * zeroes — the distinction this module exists to preserve.
 */
export function lineStatsMetadata(stats: DiffLineStats | null): {
	linesAdded?: number;
	linesRemoved?: number;
} {
	return stats ? { linesAdded: stats.added, linesRemoved: stats.removed } : {};
}
