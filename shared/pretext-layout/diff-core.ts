/**
 * diff-core.ts — The pure line/word diff model shared by every renderer.
 *
 * This is the single source of truth for "what does this edit look like": which
 * lines are context / removed / added, which original and new line numbers they
 * carry, and which words changed inside a modified pair.
 *
 * It lives in `shared/pretext-layout` because BOTH render paths need it and
 * neither may own it:
 *   - the chunked renderer (DiffView.tsx) draws it directly in React
 *   - the pretext virtual list needs it inside `tool-detail.ts`, a purity-guarded
 *     module that cannot import a React component file
 * Keeping one implementation is the point: two copies of diff semantics would
 * drift, and the two modes would then disagree about what an edit did.
 *
 * PURE: no React, no Mantine, no DOM, no frontend imports (enforced by
 * shared-core.guard.test.ts). Colours, gutters and fonts are the render layers'
 * business; this module only decides structure.
 *
 * Every bound here is deliberate — an Edit payload can be megabytes, and this
 * runs on the layout path:
 *   MAX_DIFF_INPUT_CHARS  — past this, skip the diff and show a bounded preview
 *   MAX_DIFF_LINES        — hard ceiling on emitted rows
 *   MAX_WORD_DIFF_CHARS   — per-line ceiling for the (quadratic) word diff
 *   MAX_DIFF_LINE_CHARS   — per-line content clamp
 *
 * `computeDiffCached` additionally memoizes the whole computation, because the
 * layout adapter re-classifies EVERY tool card on every rebuild (LOD step, width
 * change, each live patch) while the underlying Edit payload never changes. See
 * the cache block below.
 */

import { diffLines as computeLineDiff, diffWordsWithSpace } from "diff";

/** One word-level chunk inside a modified line. */
export interface DiffWordChange {
	value: string;
	added?: boolean;
	removed?: boolean;
}

/** One rendered diff row. */
export interface DiffLine {
	type: "context" | "removed" | "added";
	content: string;
	/** Word-level chunks for a modified line (paired removal/addition only). */
	wordChanges?: DiffWordChange[];
	/** 1-based line number in the OLD file (absent for added lines). */
	oldLineNo?: number;
	/** 1-based line number in the NEW file (absent for removed lines). */
	newLineNo?: number;
}

export const MAX_DIFF_LINES = 500;
export const MAX_DIFF_INPUT_CHARS = 240_000;
export const MAX_DIFF_HIGHLIGHT_CHARS = 80_000;
export const MAX_WORD_DIFF_CHARS = 4_000;
export const MAX_DIFF_LINE_CHARS = 4_000;

/** Normalize line endings so CRLF/CR vs LF never shows up as a content edit. */
export function normalizeDiffLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function clampLineContent(line: string): string {
	return line.length > MAX_DIFF_LINE_CHARS ? `${line.slice(0, MAX_DIFF_LINE_CHARS)} …` : line;
}

function splitIntoLines(value: string): string[] {
	if (!value) return [];
	const lines = value.split("\n");
	// diffLines keeps the trailing newline, which yields an empty final element.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.map(clampLineContent);
}

function appendPreviewLines(
	value: string,
	type: "removed" | "added",
	startLine: number,
	maxLines: number,
	result: DiffLine[],
) {
	let lineNo = startLine;
	let start = 0;
	while (start <= value.length && result.length < maxLines) {
		const newline = value.indexOf("\n", start);
		const end = newline === -1 ? value.length : newline;
		const rawContent = value.slice(start, end);
		result.push({
			type,
			content: clampLineContent(rawContent),
			oldLineNo: type === "removed" ? lineNo : undefined,
			newLineNo: type === "added" ? lineNo : undefined,
		});
		lineNo++;
		start = newline === -1 ? value.length + 1 : newline + 1;
	}
}

function buildLargeInputPreview(oldStr: string, newStr: string, startLine: number): DiffLine[] {
	const result: DiffLine[] = [
		{
			type: "context",
			content:
				"... diff input too large; showing a bounded preview without full diff computation ...",
		},
	];
	const perSide = Math.floor((MAX_DIFF_LINES - result.length) / 2);
	appendPreviewLines(oldStr, "removed", startLine, perSide, result);
	appendPreviewLines(newStr, "added", startLine, MAX_DIFF_LINES - result.length, result);
	return result;
}

/**
 * Compute the diff rows between two texts.
 *
 * @param startLine 1-based line number the OLD text starts at in its file
 */
export function computeDiff(oldStr: string, newStr: string, startLine = 1): DiffLine[] {
	const normalizedOldStr = normalizeDiffLineEndings(oldStr);
	const normalizedNewStr = normalizeDiffLineEndings(newStr);

	if (normalizedOldStr.length + normalizedNewStr.length > MAX_DIFF_INPUT_CHARS) {
		return buildLargeInputPreview(normalizedOldStr, normalizedNewStr, startLine);
	}

	const changes = computeLineDiff(normalizedOldStr, normalizedNewStr);
	const result: DiffLine[] = [];
	let oldLine = startLine;
	let newLine = startLine;
	const appendLine = (line: DiffLine): boolean => {
		if (result.length >= MAX_DIFF_LINES) return false;
		result.push(line);
		return true;
	};

	for (let i = 0; i < changes.length; i++) {
		if (result.length >= MAX_DIFF_LINES) break;
		const change = changes[i];
		if (!change) continue;

		if (!change.added && !change.removed) {
			for (const line of splitIntoLines(change.value)) {
				if (
					!appendLine({ type: "context", content: line, oldLineNo: oldLine, newLineNo: newLine })
				) {
					return result;
				}
				oldLine++;
				newLine++;
			}
			continue;
		}

		if (change.removed) {
			const next = changes[i + 1];
			if (next?.added) {
				// A modification: pair removed/added lines and diff them word-wise so
				// the render layer can tint only what actually changed.
				const removedLines = splitIntoLines(change.value);
				const addedLines = splitIntoLines(next.value);
				const maxPaired = Math.min(removedLines.length, addedLines.length);

				for (let j = 0; j < maxPaired; j++) {
					const removedLine = removedLines[j] ?? "";
					const addedLine = addedLines[j] ?? "";
					const shouldWordDiff = removedLine.length + addedLine.length <= MAX_WORD_DIFF_CHARS;
					const wc = shouldWordDiff ? diffWordsWithSpace(removedLine, addedLine) : null;
					if (
						!appendLine({
							type: "removed",
							content: removedLine,
							wordChanges: wc?.filter((c) => !c.added),
							oldLineNo: oldLine,
						})
					) {
						return result;
					}
					oldLine++;
					if (
						!appendLine({
							type: "added",
							content: addedLine,
							wordChanges: wc?.filter((c) => !c.removed),
							newLineNo: newLine,
						})
					) {
						return result;
					}
					newLine++;
				}
				for (let j = maxPaired; j < removedLines.length; j++) {
					if (
						!appendLine({ type: "removed", content: removedLines[j] ?? "", oldLineNo: oldLine })
					) {
						return result;
					}
					oldLine++;
				}
				for (let j = maxPaired; j < addedLines.length; j++) {
					if (!appendLine({ type: "added", content: addedLines[j] ?? "", newLineNo: newLine })) {
						return result;
					}
					newLine++;
				}
				i++; // the added chunk was consumed as this modification's other half
			} else {
				for (const line of splitIntoLines(change.value)) {
					if (!appendLine({ type: "removed", content: line, oldLineNo: oldLine })) return result;
					oldLine++;
				}
			}
			continue;
		}

		// A pure addition (no preceding removal).
		for (const line of splitIntoLines(change.value)) {
			if (!appendLine({ type: "added", content: line, newLineNo: newLine })) return result;
			newLine++;
		}
	}

	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Memoized entry point.
//
// Why this exists: `classifyToolDetail` runs for EVERY tool card on EVERY layout
// rebuild, and a rebuild is triggered by an LOD step, a width change, and each
// live lifecycle patch. The measurement cache does not help here — it caches the
// measured height, not the adapter output — so a session with a handful of large
// Edits paid a full `diffLines` + per-line `diffWordsWithSpace` for each of them
// on every patch (measured: ~79ms for one 400-line Edit).
//
// An Edit payload is immutable once persisted, so the memo hit rate is ~100%.
//
// Key construction must not itself be O(input): hashing a 240KB string on every
// lookup would just trade one cost for another. So the bucket key is built from
// the cheap invariants (startLine + both lengths + a fixed-size sample of head /
// middle / tail), and the ENTRY carries the original strings so a hit is
// confirmed by `===`. That comparison is a pointer check for the common case (the
// adapter re-reads the same parsed payload object), and a fast memcmp otherwise;
// a sample collision degrades to a recompute, never to a wrong diff.
// ─────────────────────────────────────────────────────────────────────────────

/** Bucket entries retained. Small: a 500-row diff with word changes is not tiny. */
const DIFF_CACHE_MAX_ENTRIES = 192;
/** Total retained rows, so many large diffs cannot pin an unbounded heap. */
const DIFF_CACHE_MAX_ROWS = 24_000;
/** Chars sampled per side when building a bucket key. */
const DIFF_CACHE_SAMPLE_CHARS = 32;

interface DiffCacheEntry {
	oldStr: string;
	newStr: string;
	lines: DiffLine[];
}

const diffCache = new Map<string, DiffCacheEntry>();
let diffCacheRows = 0;

/** Head + middle + tail sample of `value`, at a fixed cost regardless of length. */
function sampleForKey(value: string): string {
	if (value.length <= DIFF_CACHE_SAMPLE_CHARS * 3) return value;
	const mid = (value.length >> 1) - (DIFF_CACHE_SAMPLE_CHARS >> 1);
	return (
		value.slice(0, DIFF_CACHE_SAMPLE_CHARS) +
		value.slice(mid, mid + DIFF_CACHE_SAMPLE_CHARS) +
		value.slice(value.length - DIFF_CACHE_SAMPLE_CHARS)
	);
}

function diffCacheKey(oldStr: string, newStr: string, startLine: number): string {
	return `${startLine}\u0000${oldStr.length}\u0000${newStr.length}\u0000${sampleForKey(oldStr)}\u0000${sampleForKey(newStr)}`;
}

/** Drop least-recently-used entries until both bounds hold. */
function evictDiffCache() {
	while (
		diffCache.size > DIFF_CACHE_MAX_ENTRIES ||
		(diffCacheRows > DIFF_CACHE_MAX_ROWS && diffCache.size > 1)
	) {
		// Map iteration is insertion-ordered, and a hit re-inserts, so the first key
		// is the least recently used one.
		const oldest = diffCache.keys().next();
		if (oldest.done) return;
		const entry = diffCache.get(oldest.value);
		diffCache.delete(oldest.value);
		if (entry) diffCacheRows -= entry.lines.length;
	}
}

/**
 * `computeDiff` with a bounded memo on `(oldStr, newStr, startLine)`.
 *
 * The returned array is SHARED between callers and must be treated as read-only
 * (`DiffLine[]` is only ever read by the measure and render layers).
 */
export function computeDiffCached(oldStr: string, newStr: string, startLine = 1): DiffLine[] {
	const key = diffCacheKey(oldStr, newStr, startLine);
	const hit = diffCache.get(key);
	if (hit && hit.oldStr === oldStr && hit.newStr === newStr) {
		// Refresh recency.
		diffCache.delete(key);
		diffCache.set(key, hit);
		return hit.lines;
	}
	const lines = computeDiff(oldStr, newStr, startLine);
	if (hit) diffCacheRows -= hit.lines.length;
	diffCache.set(key, { oldStr, newStr, lines });
	diffCacheRows += lines.length;
	evictDiffCache();
	return lines;
}

/** Test hook: forget every memoized diff. */
export function resetDiffCache() {
	diffCache.clear();
	diffCacheRows = 0;
}

/** Test hook: current memo occupancy. */
export function diffCacheStats(): { entries: number; rows: number } {
	return { entries: diffCache.size, rows: diffCacheRows };
}

/**
 * Width (in characters) of ONE line-number column, so both columns align and the
 * gutter has a fixed width. Mirrors the chunked DiffView's own calculation.
 */
export function diffLineNoWidth(lines: readonly DiffLine[], lineNumberPrefix?: string): number {
	let maxNo = 1;
	for (const line of lines) {
		if (line.oldLineNo != null && line.oldLineNo > maxNo) maxNo = line.oldLineNo;
		if (line.newLineNo != null && line.newLineNo > maxNo) maxNo = line.newLineNo;
	}
	return Math.max(3, `${lineNumberPrefix ?? ""}${maxNo}`.length);
}

/** One right-aligned line-number cell, or blanks when the side has no number. */
export function formatDiffLineNumber(
	no: number | undefined,
	width: number,
	lineNumberPrefix?: string,
): string {
	if (no == null) return " ".repeat(width);
	const label = lineNumberPrefix ? `${lineNumberPrefix}${no}` : String(no);
	return label.padStart(width);
}

/** The `+`/`-`/` ` marker for a row. */
export function diffLineMarker(type: DiffLine["type"]): string {
	return type === "removed" ? "-" : type === "added" ? "+" : " ";
}

/**
 * The full fixed-width gutter text: `oldNo newNo±`. Every row produces the same
 * length, so the code column starts at the same offset on every line.
 */
export function formatDiffGutter(line: DiffLine, width: number, lineNumberPrefix?: string): string {
	const old = formatDiffLineNumber(line.oldLineNo, width, lineNumberPrefix);
	const nw = formatDiffLineNumber(line.newLineNo, width, lineNumberPrefix);
	return `${old} ${nw}${diffLineMarker(line.type)}`;
}

/**
 * Rebuild plausible source text from the diff rows for syntax highlighting, or
 * null when it would exceed the highlight budget. Both renderers highlight the
 * row CONTENT (markers and gutters excluded) so the grammar sees real code.
 */
export function buildDiffHighlightSource(lines: readonly DiffLine[]): string | null {
	let totalLength = 0;
	const sourceLines: string[] = [];
	for (const line of lines) {
		const nextLength = totalLength + (sourceLines.length > 0 ? 1 : 0) + line.content.length;
		if (nextLength > MAX_DIFF_HIGHLIGHT_CHARS) return null;
		sourceLines.push(line.content);
		totalLength = nextLength;
	}
	return sourceLines.join("\n");
}
