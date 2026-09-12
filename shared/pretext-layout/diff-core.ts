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
 *   MAX_DIFF_INPUT_CHARS  — retained source budget for the line-level diff
 *   MAX_DIFF_LINES        — hard ceiling on each viewport's projected rows
 *   MAX_WORD_DIFF_CHARS   — per-line ceiling for the (quadratic) word diff
 *   MAX_DIFF_LINE_CHARS   — per-line content clamp
 *
 * `createDiffDocument` memoizes source snapshots and line runs, because the layout
 * adapter re-classifies every tool card on rebuilds (LOD, width, live patches).
 * Each viewport projects its own bounded rows and word changes; none of those
 * reader-dependent objects belongs in the shared source cache.
 */

import { diffLines as computeLineDiff, diffWordsWithSpace } from "diff";
import {
	createSourceText,
	normalizeSourceText,
	type SourceTextRange,
	type SourceTextSnapshot,
	trimSourceText,
} from "./source-text";

export type { SourceTextRange } from "./source-text";

export interface DiffSourcePoint {
	side: "old" | "new";
	epoch: string;
	/** Zero-based normalized parameter coordinates, NOT file line numbers. */
	line: number;
	column: number;
	offset: number;
}

export interface DiffProjectedLine extends DiffLine {
	key: string;
	oldPoint?: DiffSourcePoint;
	newPoint?: DiffSourcePoint;
	/** Zero-based row in the shared document, independent of any viewport. */
	row: number;
}

export interface DiffSourceSnapshot extends SourceTextSnapshot {
	/** Offsets of retained lines; no per-line word diffs live in the document. */
	lineStarts: readonly number[];
}

export interface DiffRun {
	type: "context" | "removed" | "added" | "paired";
	startRow: number;
	rowCount: number;
	oldStart: number;
	newStart: number;
	count: number;
}

export interface DiffDocument {
	revision: string;
	focus: DiffSourcePoint | null;
	oldSource: DiffSourceSnapshot;
	newSource: DiffSourceSnapshot;
	runs: readonly DiffRun[];
	totalRows: number;
	/** Defined only when the file origin was provided by the caller. */
	startLine?: number;
	/** Missing source data / bounded calculation; NOT a viewport's row limit. */
	truncated: boolean;
	omission: "source-range" | "input-budget" | "diff-budget" | null;
}

export interface DiffDocumentInput {
	oldText: string;
	newText: string;
	oldRange?: SourceTextRange;
	newRange?: SourceTextRange;
	focusSide?: "old" | "new";
	startLine?: number;
}

export interface DiffProjection {
	lines: DiffProjectedLine[];
	focusIndex: number;
	anchorIndex: number;
	/** Resolved (possibly clamped/remapped) viewport anchor. */
	anchor: DiffSourcePoint | null;
	anchorLost: boolean;
	anchorLossReason: "range" | "epoch" | "side" | null;
	startRow: number;
	beforeRows: number;
	afterRows: number;
	totalRows: number;
	truncated: boolean;
}

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
export const normalizeDiffLineEndings = normalizeSourceText;

function clampLineContent(line: string): string {
	return line.length > MAX_DIFF_LINE_CHARS ? `${line.slice(0, MAX_DIFF_LINE_CHARS)} …` : line;
}

/**
 * Public wrapper over the per-line clamp.
 *
 * `parse-unified-diff.ts` builds `DiffLine` rows straight from a patch instead of
 * from two texts, so it needs the SAME per-line ceiling this module applies. A
 * second clamp implementation there would be a second rule to keep in sync.
 */
export function clampDiffLineContent(line: string): string {
	return clampLineContent(line);
}

/**
 * Word-level chunks for one modified line pair, or null when the pair is too
 * large to diff.
 *
 * Extracted so BOTH row producers share one definition of "what changed inside a
 * modified line": `projectDiffDocument` (two texts) and `parseUnifiedDiff` (a patch).
 * The word diff is quadratic, hence the `MAX_WORD_DIFF_CHARS` budget over the
 * combined length — returning null tells the caller to emit plain rows.
 */
export function pairWordChanges(
	removedLine: string,
	addedLine: string,
): { removed: DiffWordChange[]; added: DiffWordChange[] } | null {
	if (removedLine.length + addedLine.length > MAX_WORD_DIFF_CHARS) return null;
	const chunks = diffWordsWithSpace(removedLine, addedLine);
	return {
		removed: chunks.filter((c) => !c.added),
		added: chunks.filter((c) => !c.removed),
	};
}

function splitIntoLines(value: string): string[] {
	if (!value) return [];
	const lines = value.split("\n");
	// diffLines keeps the trailing newline, which yields an empty final element.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.map(clampLineContent);
}

function sourceSnapshot(
	text: string,
	range: SourceTextRange | undefined,
	limit: number,
): DiffSourceSnapshot {
	const source = range
		? trimSourceText({ text, range }, limit)
		: createSourceText(text, { epoch: "source", complete: true, limit });
	const normalized = normalizeSourceText(source.text);
	const lineStarts: number[] = [];
	if (normalized.length) {
		lineStarts.push(0);
		for (let i = 0; i < normalized.length - 1; i++) {
			if (normalized.charCodeAt(i) === 10) lineStarts.push(i + 1);
		}
	}
	const retainedRange = { ...source.range };
	if (retainedRange.remap) retainedRange.remap = Object.freeze({ ...retainedRange.remap });
	return Object.freeze({
		text: normalized,
		range: Object.freeze(retainedRange),
		lineStarts: Object.freeze(lineStarts),
	});
}

function lineEnd(source: DiffSourceSnapshot, line: number): number {
	const end = source.lineStarts[line + 1] ?? source.text.length;
	return source.text.charCodeAt(end - 1) === 10 ? end - 1 : end;
}

function lineContent(source: DiffSourceSnapshot, line: number): string {
	return source.text.slice(source.lineStarts[line] ?? 0, lineEnd(source, line));
}

function sourcePoint(
	source: DiffSourceSnapshot,
	side: DiffSourcePoint["side"],
	index: number,
	column?: number,
): DiffSourcePoint {
	const firstColumn = index === 0 ? source.range.startColumn : 0;
	const resolvedColumn = Math.max(
		firstColumn,
		Math.min(
			column ?? firstColumn,
			firstColumn + lineEnd(source, index) - (source.lineStarts[index] ?? 0),
		),
	);
	return {
		side,
		epoch: source.range.epoch,
		line: source.range.startLine + index,
		column: resolvedColumn,
		offset:
			source.range.startOffset + (source.lineStarts[index] ?? 0) + resolvedColumn - firstColumn,
	};
}

/** Stable across base-cache eviction; only bounded retained sources are hashed. */
function diffDocumentRevision(
	doc: DiffDocument,
	focusSide: DiffDocumentInput["focusSide"],
): string {
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	const mix = (value: number) => {
		first = Math.imul(first ^ value, 0x01000193);
		second = Math.imul(second ^ value, 0x5bd1e995);
	};
	const text = (value: string) => {
		mix(value.length);
		for (let i = 0; i < value.length; i++) mix(value.charCodeAt(i));
	};
	// Canonical field order also makes equivalent deserialized ranges stable.
	const range = (value: SourceTextRange) => [
		value.epoch,
		value.startOffset,
		value.endOffset,
		value.startLine,
		value.startColumn,
		value.endLine,
		value.endColumn,
		value.originKnown,
		value.complete,
		value.streaming ?? false,
		value.endsWithCR ?? false,
		value.remap
			? [
					value.remap.fromEpoch,
					value.remap.fromStartOffset,
					value.remap.fromEndOffset,
					value.remap.fromStartLine,
					value.remap.offsetDelta,
					value.remap.lineDelta,
					value.remap.columnDelta,
				]
			: null,
	];
	text(doc.oldSource.text);
	text(doc.newSource.text);
	text(
		JSON.stringify([
			range(doc.oldSource.range),
			range(doc.newSource.range),
			doc.startLine ?? null,
			focusSide ?? null,
			doc.focus,
			doc.omission,
			doc.totalRows,
		]),
	);
	return `diff:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

/** An open stream end is expected; only missing source bytes make a preview partial. */
function hasMissingSource(range: SourceTextRange): boolean {
	return !range.complete && !(range.streaming && range.originKnown && range.startOffset === 0);
}

/** One bounded source model, shared by inline and fullscreen; no viewport state. */
export function createDiffDocument(input: DiffDocumentInput): DiffDocument {
	// The usual hit samples a bounded key and confirms exact strings BEFORE scanning
	// coordinates/normalizing. Oversized original strings are never retained here.
	const rawKey =
		input.oldText.length + input.newText.length <= MAX_DIFF_INPUT_CHARS
			? `raw:${diffCacheKey(input.oldText, input.newText, input.startLine ?? 0)}\u0000${JSON.stringify([input.oldRange, input.newRange, input.focusSide])}`
			: null;
	const rawHit = rawKey === null ? undefined : documentCache.get(rawKey);
	if (rawKey !== null && rawHit?.oldText === input.oldText && rawHit.newText === input.newText) {
		documentCache.delete(rawKey);
		documentCache.set(rawKey, rawHit);
		return rawHit.doc;
	}
	const half = MAX_DIFF_INPUT_CHARS / 2;
	const oldLimit = Math.max(half, MAX_DIFF_INPUT_CHARS - input.newText.length);
	const newLimit = Math.max(half, MAX_DIFF_INPUT_CHARS - input.oldText.length);
	const oldSource = sourceSnapshot(input.oldText, input.oldRange, oldLimit);
	const newSource = sourceSnapshot(input.newText, input.newRange, newLimit);
	const key =
		rawKey ??
		`bounded:${diffCacheKey(oldSource.text, newSource.text, input.startLine ?? 0)}\u0000${JSON.stringify([oldSource.range, newSource.range, input.focusSide])}`;
	const hit = documentCache.get(key);
	if (!rawKey && hit?.oldText === oldSource.text && hit.newText === newSource.text) {
		documentCache.delete(key);
		documentCache.set(key, hit);
		return hit.doc;
	}
	const runs: DiffRun[] = [];
	let oldStart = 0;
	let newStart = 0;
	let totalRows = 0;
	const take = (type: DiffRun["type"], count: number) => {
		if (!count) return;
		const rowCount = type === "paired" ? count * 2 : count;
		runs.push({ type, count, rowCount, startRow: totalRows, oldStart, newStart });
		if (type !== "added") oldStart += count;
		if (type !== "removed") newStart += count;
		totalRows += rowCount;
	};
	let omission: DiffDocument["omission"] =
		input.oldText.length > oldLimit || input.newText.length > newLimit
			? "input-budget"
			: hasMissingSource(oldSource.range) || hasMissingSource(newSource.range)
				? "source-range"
				: null;
	const changes = computeLineDiff(oldSource.text, newSource.text, {
		timeout: DIFF_STATS_TIMEOUT_MS,
		maxEditLength: DIFF_STATS_MAX_EDIT_LENGTH,
	});
	if (changes) {
		for (let i = 0; i < changes.length; i++) {
			const change = changes[i];
			if (!change) continue;
			const next = changes[i + 1];
			if (change.removed && next?.added) {
				const pairs = Math.min(change.count, next.count);
				take("paired", pairs);
				take("removed", change.count - pairs);
				take("added", next.count - pairs);
				i++;
			} else take(change.added ? "added" : change.removed ? "removed" : "context", change.count);
		}
	} else {
		// The same replacement pairing, explicitly approximate rather than false context.
		omission = omission === "input-budget" ? omission : "diff-budget";
		const pairs = Math.min(oldSource.lineStarts.length, newSource.lineStarts.length);
		take("paired", pairs);
		take("removed", oldSource.lineStarts.length - pairs);
		take("added", newSource.lineStarts.length - pairs);
	}
	const doc: DiffDocument = {
		revision: "",
		focus: null,
		oldSource,
		newSource,
		runs,
		totalRows,
		startLine: input.startLine,
		truncated: omission !== null,
		omission,
	};
	if (input.focusSide) {
		const side =
			input.focusSide === "new" && !newSource.lineStarts.length ? "old" : input.focusSide;
		const source = side === "old" ? oldSource : newSource;
		if (source.lineStarts.length) {
			doc.focus = sourcePoint(source, side, source.lineStarts.length - 1, Number.MAX_SAFE_INTEGER);
		}
	} else {
		// Static/final data focus is the last changed new row, not a suffix of deletions.
		const changed = runs.findLast((run) => run.type === "added" || run.type === "paired");
		const removed = changed ? undefined : runs.findLast((run) => run.type === "removed");
		const target = changed ?? removed;
		if (target) {
			const side = changed ? "new" : "old";
			const source = changed ? newSource : oldSource;
			const index = (changed ? target.newStart : target.oldStart) + target.count - 1;
			doc.focus = sourcePoint(source, side, index, Number.MAX_SAFE_INTEGER);
		} else doc.focus = getDiffRowAnchor(doc, totalRows - 1);
	}
	// Cache residency is not a content version. Compute this only after both miss
	// paths, from the <=240k source snapshots rather than the original payload.
	doc.revision = diffDocumentRevision(doc, input.focusSide);
	for (const run of runs) Object.freeze(run);
	Object.freeze(runs);
	if (doc.focus) Object.freeze(doc.focus);
	Object.freeze(doc);
	const oldText = rawKey ? input.oldText : oldSource.text;
	const newText = rawKey ? input.newText : newSource.text;
	const cost = oldText.length + newText.length + oldSource.text.length + newSource.text.length;
	if (hit) documentCacheChars -= hit.cost;
	documentCache.set(key, { doc, oldText, newText, cost });
	documentCacheChars += cost;
	while (documentCache.size > DIFF_CACHE_MAX_ENTRIES || documentCacheChars > DIFF_CACHE_MAX_CHARS) {
		const oldest = documentCache.entries().next().value;
		if (!oldest) break;
		documentCache.delete(oldest[0]);
		documentCacheChars -= oldest[1].cost;
	}
	return doc;
}

function runForRow(doc: DiffDocument, row: number): DiffRun | undefined {
	let low = 0;
	let high = doc.runs.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((doc.runs[mid]?.startRow ?? 0) <= row) low = mid + 1;
		else high = mid;
	}
	return doc.runs[low - 1];
}

function rowPoints(doc: DiffDocument, row: number) {
	const run = runForRow(doc, row);
	if (!run || row < 0 || row >= doc.totalRows) return null;
	const relative = row - run.startRow;
	const index = run.type === "paired" ? relative % run.count : relative;
	const type =
		run.type === "paired" ? (relative < run.count ? "removed" : "added") : run.type;
	return {
		run,
		index,
		type,
		oldPoint:
			type === "added" ? undefined : sourcePoint(doc.oldSource, "old", run.oldStart + index),
		newPoint:
			type === "removed" ? undefined : sourcePoint(doc.newSource, "new", run.newStart + index),
	};
}

/** Cheap row → source mapping for scroll/virtualization, without word diff work. */
export function getDiffRowAnchor(
	doc: DiffDocument,
	row: number,
	sidePreference: "old" | "new" = "new",
): DiffSourcePoint | null {
	const points = rowPoints(doc, row);
	return (
		(sidePreference === "old" ? points?.oldPoint : points?.newPoint) ??
		points?.newPoint ??
		points?.oldPoint ??
		null
	);
}

/** Bounded measurement probe; does not materialize a projected row or word diff. */
export function readDiffRowContent(doc: DiffDocument, row: number): string | null {
	const points = rowPoints(doc, row);
	if (!points) return null;
	return clampLineContent(
		lineContent(
			points.newPoint ? doc.newSource : doc.oldSource,
			(points.newPoint ? points.run.newStart : points.run.oldStart) + points.index,
		),
	);
}

/** The shared gutter width comes from source coordinates, not a reader window. */
export function diffDocumentLineNoWidth(
	doc: DiffDocument,
	lineNumberPrefix?: string,
	minWidth = DIFF_LINE_NO_MIN_WIDTH,
): number {
	let max = 1;
	for (const source of [doc.oldSource, doc.newSource]) {
		const base = doc.startLine !== undefined && source.range.originKnown ? doc.startLine : 1;
		max = Math.max(max, source.range.startLine + Math.max(0, source.lineStarts.length - 1) + base);
	}
	return Math.max(minWidth, `${lineNumberPrefix ?? ""}${max}`.length);
}

export interface DiffPointResolution {
	row: number;
	point: DiffSourcePoint | null;
	lost: boolean;
	reason: DiffProjection["anchorLossReason"];
}

export function resolveDiffSourcePoint(
	doc: DiffDocument,
	anchor: DiffSourcePoint,
): DiffPointResolution {
	const source = anchor.side === "old" ? doc.oldSource : doc.newSource;
	const fallback = (reason: DiffPointResolution["reason"]): DiffPointResolution => ({
		row: doc.totalRows ? 0 : -1,
		point: getDiffRowAnchor(doc, 0),
		lost: true,
		reason,
	});
	if (!source.lineStarts.length) return fallback("side");
	let point = anchor;
	if (point.epoch !== source.range.epoch) {
		const remap = source.range.remap;
		if (
			!remap ||
			point.epoch !== remap.fromEpoch ||
			point.offset < remap.fromStartOffset ||
			point.offset > remap.fromEndOffset
		)
			return fallback("epoch");
		point = {
			...point,
			epoch: source.range.epoch,
			offset: point.offset + remap.offsetDelta,
			line: point.line + remap.lineDelta,
			column: point.column + (point.line === remap.fromStartLine ? remap.columnDelta : 0),
		};
	}
	const index = Math.max(
		0,
		Math.min(source.lineStarts.length - 1, point.line - source.range.startLine),
	);
	const resolved = sourcePoint(source, point.side, index, point.column);
	const lost = resolved.line !== point.line || resolved.column !== point.column;
	let low = 0;
	let high = doc.runs.length;
	const sideStart = point.side === "old" ? "oldStart" : "newStart";
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((doc.runs[mid]?.[sideStart] ?? 0) <= index) low = mid + 1;
		else high = mid;
	}
	const run = doc.runs[low - 1];
	if (!run) return fallback("side");
	const inRun = index - run[sideStart];
	const row =
		run.startRow +
		(run.type === "paired"
			? (point.side === "old" ? inRun : run.count + inRun)
			: inRun);
	return { row, point: resolved, lost, reason: lost ? "range" : null };
}

/** Each caller owns its <=500 rows, word diffs and reading anchor. Never cached. */
export function projectDiffDocument(
	doc: DiffDocument,
	options: { anchor?: DiffSourcePoint | null; startRow?: number; limit?: number } = {},
): DiffProjection {
	const requestedLimit = options.limit ?? MAX_DIFF_LINES;
	const limit = Number.isFinite(requestedLimit)
		? Math.max(1, Math.min(MAX_DIFF_LINES, Math.trunc(requestedLimit)))
		: MAX_DIFF_LINES;
	const wanted = options.anchor ?? doc.focus;
	const resolution = wanted
		? resolveDiffSourcePoint(doc, wanted)
		: { row: -1, point: null, lost: false, reason: null };
	const startRow = Math.max(
		0,
		Math.min(
			Math.max(0, doc.totalRows - limit),
			Math.trunc(options.startRow ?? resolution.row - Math.floor(limit / 2)),
		),
	);
	const endRow = Math.min(doc.totalRows, startRow + limit);
	const lines: DiffProjectedLine[] = [];
	const words = new Map<number, ReturnType<typeof pairWordChanges>>();
	for (let row = startRow; row < endRow; row++) {
		const points = rowPoints(doc, row);
		if (!points) continue;
		const { type, oldPoint, newPoint, run, index } = points;
		let wordChanges: DiffWordChange[] | undefined;
		if (run.type === "paired") {
			const key = run.startRow + index;
			if (!words.has(key))
				words.set(
					key,
					pairWordChanges(
						lineContent(doc.oldSource, run.oldStart + index),
						lineContent(doc.newSource, run.newStart + index),
					),
				);
			const pair = words.get(key);
			wordChanges = type === "removed" ? pair?.removed : pair?.added;
		}
		const point = newPoint ?? oldPoint;
		if (!point) continue;
		const number = (p: DiffSourcePoint | undefined, source: DiffSourceSnapshot) =>
			p
				? p.line + (doc.startLine !== undefined && source.range.originKnown ? doc.startLine : 1)
				: undefined;
		lines.push({
			type,
			content: clampLineContent(
				lineContent(
					newPoint ? doc.newSource : doc.oldSource,
					newPoint ? run.newStart + index : run.oldStart + index,
				),
			),
			wordChanges,
			oldLineNo: number(oldPoint, doc.oldSource),
			newLineNo: number(newPoint, doc.newSource),
			key: `${point.side}:${point.epoch}:${point.line}`,
			oldPoint,
			newPoint,
			row,
		});
	}
	const focusRow = doc.focus ? resolveDiffSourcePoint(doc, doc.focus).row : -1;
	const local = (row: number) => (row >= startRow && row < endRow ? row - startRow : -1);
	return {
		lines,
		focusIndex: local(focusRow),
		anchorIndex: local(resolution.row),
		anchor: resolution.point,
		anchorLost: resolution.lost,
		anchorLossReason: resolution.reason,
		startRow,
		beforeRows: startRow,
		afterRows: doc.totalRows - endRow,
		totalRows: doc.totalRows,
		truncated: doc.truncated || startRow > 0 || endRow < doc.totalRows,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared source-document cache.
//
// `classifyToolDetail` runs for every tool card on layout rebuilds. The source
// cache avoids redoing line-level diff work for unchanged inputs, while each
// viewport independently owns its bounded row/word projection. Source snapshots
// and runs are immutable, so a cache hit is reusable by multiple viewports.
//
// Eviction affects residency only, never the document's content revision.
//
// Key construction must not itself be O(input): hashing a 240KB string on every
// lookup would just trade one cost for another. So the bucket key is built from
// the cheap invariants (startLine + both lengths + a fixed-size sample of head /
// middle / tail), and the ENTRY carries the original strings so a hit is
// confirmed by `===`. That comparison is a pointer check for the common case (the
// adapter re-reads the same parsed payload object), and a fast memcmp otherwise;
// a sample collision degrades to a recompute, never to a wrong diff.
// ─────────────────────────────────────────────────────────────────────────────

/** Retained source documents; the separate character budget also bounds large edits. */
const DIFF_CACHE_MAX_ENTRIES = 192;
/** Chars sampled per side when building a bucket key. */
const DIFF_CACHE_SAMPLE_CHARS = 32;
/** Source/run cache only: no 500-row projections, words, geometry or reader state. */
const DIFF_CACHE_MAX_CHARS = MAX_DIFF_INPUT_CHARS * 10;
const documentCache = new Map<
	string,
	{ doc: DiffDocument; oldText: string; newText: string; cost: number }
>();
let documentCacheChars = 0;

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

// ─────────────────────────────────────────────────────────────────────────────
// Line-count statistics (`+N -N`).
// ─────────────────────────────────────────────────────────────────────────────

/** Added / removed line totals for one edit. */
export interface DiffLineStats {
	added: number;
	removed: number;
}

/**
 * Wall-clock budget (ms) for ONE statistics diff.
 *
 * `MAX_DIFF_INPUT_CHARS` bounds the input SIZE but says nothing about the cost:
 * Myers is O(N·D), and a whole-file rewrite is precisely the shape where D is
 * largest. This runs on the server's single JS thread (the one carrying the agent
 * loop), so an unbounded run would show up as "every request hangs" with no
 * signal pointing here.
 */
const DIFF_STATS_TIMEOUT_MS = 150;

/**
 * Edit-distance ceiling for one statistics diff.
 *
 * A second, deterministic bound beside the timeout: a slow machine must reach the
 * same verdict as a fast one, or the same payload would show line counts on one
 * host and none on another.
 */
const DIFF_STATS_MAX_EDIT_LENGTH = 20_000;

/**
 * Added / removed line counts between two texts, or null.
 *
 * ⚠️ `null` means "NO DATA", never "zero changes". It has two sources, and every
 * caller must treat both the same way — by omitting the figure entirely:
 *   1. the input exceeds `MAX_DIFF_INPUT_CHARS` (or the caller's smaller
 *      `maxInputChars`)
 *   2. the computation exceeded its budget (`timeout` / `maxEditLength` above,
 *      which make `diffLines` return `undefined`)
 *
 * Rendering `+0 -0` for either case would state that the call changed nothing,
 * which is a worse error than saying nothing at all.
 *
 * Independent of row projection: it accumulates the per-change `count`
 * and never runs the (quadratic) word diff, because nothing here needs to know
 * WHICH parts of a line changed.
 *
 * Line endings are normalized first, so a CRLF→LF conversion is not reported as
 * an edit to every line in the file.
 */
export function countDiffLineStats(
	oldStr: string,
	newStr: string,
	opts: { maxInputChars?: number } = {},
): DiffLineStats | null {
	const normalizedOld = normalizeDiffLineEndings(oldStr);
	const normalizedNew = normalizeDiffLineEndings(newStr);
	const limit = Math.min(opts.maxInputChars ?? MAX_DIFF_INPUT_CHARS, MAX_DIFF_INPUT_CHARS);
	if (normalizedOld.length + normalizedNew.length > limit) return null;
	if (normalizedOld === normalizedNew) return { added: 0, removed: 0 };
	const changes = computeLineDiff(normalizedOld, normalizedNew, {
		timeout: DIFF_STATS_TIMEOUT_MS,
		maxEditLength: DIFF_STATS_MAX_EDIT_LENGTH,
	});
	// Both abort paths surface as `undefined` — the budget was exceeded.
	if (!changes) return null;
	let added = 0;
	let removed = 0;
	for (const change of changes) {
		if (change.added) added += change.count;
		else if (change.removed) removed += change.count;
	}
	return { added, removed };
}

/** Line count of a standalone text (a newly created file is all additions). */
export function countTextLines(value: string): number {
	if (!value) return 0;
	return splitIntoLines(normalizeDiffLineEndings(value)).length;
}

/** Test hook: forget every memoized source document. */
export function resetDiffDocumentCache() {
	documentCache.clear();
	documentCacheChars = 0;
}

/** Test hook: source-cache occupancy; projected rows are never retained here. */
export function diffDocumentCacheStats(): { entries: number; chars: number } {
	return { entries: documentCache.size, chars: documentCacheChars };
}

/**
 * Default floor for one line-number column.
 *
 * It exists only so a diff whose numbers are all single-digit does not get a
 * ragged one-char column; it is NOT a readability requirement, so it is kept as
 * tight as alignment allows. Anything larger just pads blanks between the two
 * columns on small files.
 *
 * Changing it does not desynchronize the measure layer: `tool-detail.ts` computes
 * the width ONCE and stores it on the detail, and both the measure layer
 * (`diffGutterWidthChars`) and the renderer (`RenderToolCall`'s `lineNoWidth`)
 * read back that same stored number rather than recomputing it.
 */
export const DIFF_LINE_NO_MIN_WIDTH = 2;

/**
 * Width (in characters) of ONE line-number column, so both columns align and the
 * gutter has a fixed width. Mirrors the chunked DiffView's own calculation.
 *
 * @param minWidth Floor for the column. Defaults to `DIFF_LINE_NO_MIN_WIDTH`
 *   because the measure layer depends on that number. A caller that owns its own
 *   layout (the git panel, which is not measured) may pass a smaller floor so
 *   two-digit line numbers stop reserving a third padding column — on a phone that
 *   padding costs real horizontal room before the code even starts.
 */
export function diffLineNoWidth(
	lines: readonly DiffLine[],
	lineNumberPrefix?: string,
	minWidth: number = DIFF_LINE_NO_MIN_WIDTH,
): number {
	let maxNo = 1;
	for (const line of lines) {
		if (line.oldLineNo != null && line.oldLineNo > maxNo) maxNo = line.oldLineNo;
		if (line.newLineNo != null && line.newLineNo > maxNo) maxNo = line.newLineNo;
	}
	return Math.max(minWidth, `${lineNumberPrefix ?? ""}${maxNo}`.length);
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
export function formatDiffGutter(
	line: DiffLine,
	width: number,
	lineNumberPrefix?: string | { old?: string; new?: string },
): string {
	const oldPrefix = typeof lineNumberPrefix === "object" ? lineNumberPrefix.old : lineNumberPrefix;
	const newPrefix = typeof lineNumberPrefix === "object" ? lineNumberPrefix.new : lineNumberPrefix;
	const old = formatDiffLineNumber(line.oldLineNo, width, oldPrefix);
	const nw = formatDiffLineNumber(line.newLineNo, width, newPrefix);
	return `${old} ${nw}${diffLineMarker(line.type)}`;
}

/**
 * Rebuild plausible source text from the diff rows for syntax highlighting, or
 * null when it would exceed the highlight budget. Both renderers highlight the
 * row CONTENT (markers and gutters excluded) so the grammar sees real code.
 *
 * INTERLEAVED, so it is only correct for a single-sided diff. A TextMate grammar
 * is a line-by-line state machine: concatenating removed and added rows lets a
 * multi-line construct from one side leak into the other. Prefer
 * `buildDiffHighlightPlan`, which splits the sides; this remains for callers that
 * genuinely want one flat string.
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

/** Where one diff row's tokens live: which source, and which line inside it. */
export interface DiffHighlightRowRef {
	/** Index into `DiffHighlightPlan.sources`. */
	source: number;
	/** 0-based line index within that source. */
	line: number;
}

/**
 * Sources to tokenize, plus the row → (source, line) lookup.
 *
 * `sources` holds ONE entry when the diff touches only one side (every row then
 * belongs to the same reconstruction), and TWO when it mixes removals and
 * additions: `[oldSide, newSide]`.
 */
export interface DiffHighlightPlan {
	sources: string[];
	rows: DiffHighlightRowRef[];
}

/**
 * Plan syntax highlighting so each row is tokenized in the file it belongs to.
 *
 * WHY NOT ONE STRING
 *
 * A TextMate grammar carries state across lines (open block comment, unterminated
 * template literal, heredoc). `buildDiffHighlightSource` concatenates context,
 * removed and added rows into one document, so a construct opened on a REMOVED
 * line stays open over the rows that follow it — including unchanged context. A
 * diff that replaces `/* legacy note` with `// short note` therefore paints the
 * untouched `const value = 1;` below it entirely comment-grey, because the old
 * side's block comment is still open in the merged text.
 *
 * Reconstructing the two sides separately removes the interference: removed rows
 * are tokenized inside the OLD file, context and added rows inside the NEW file.
 * Context rows read the new side because that is the state the file is left in —
 * the same side GitHub's unified view highlights.
 *
 * COST
 *
 * Two sources mean two tokenizer passes, so the split is only made when the diff
 * actually mixes removals and additions — which is exactly when the interference
 * is possible. A pure addition, a pure deletion, or an unchanged region yields a
 * single source and the same work as before.
 *
 * The budget is checked against the SUM of what will be tokenized, so this can
 * never ask the highlighter to do more total work than `MAX_DIFF_HIGHLIGHT_CHARS`.
 */
export function buildDiffHighlightPlan(lines: readonly DiffLine[]): DiffHighlightPlan | null {
	let hasRemoved = false;
	let hasAdded = false;
	for (const line of lines) {
		if (line.type === "removed") hasRemoved = true;
		else if (line.type === "added") hasAdded = true;
		if (hasRemoved && hasAdded) break;
	}

	// Only one side is present, so the merged text IS that side: no interference to
	// remove, and no reason to pay for a second pass.
	if (!hasRemoved || !hasAdded) {
		const source = buildDiffHighlightSource(lines);
		if (source == null) return null;
		return {
			sources: [source],
			rows: lines.map((_, index) => ({ source: 0, line: index })),
		};
	}

	const oldLines: string[] = [];
	const newLines: string[] = [];
	const rows: DiffHighlightRowRef[] = [];
	let totalLength = 0;

	/** Append to one side, charging the shared budget. Returns false when over. */
	const take = (side: string[], content: string): boolean => {
		totalLength += (side.length > 0 ? 1 : 0) + content.length;
		if (totalLength > MAX_DIFF_HIGHLIGHT_CHARS) return false;
		side.push(content);
		return true;
	};

	for (const line of lines) {
		if (line.type === "removed") {
			if (!take(oldLines, line.content)) return null;
			rows.push({ source: 0, line: oldLines.length - 1 });
			continue;
		}
		if (line.type === "added") {
			if (!take(newLines, line.content)) return null;
			rows.push({ source: 1, line: newLines.length - 1 });
			continue;
		}
		// Context belongs to both files and must occupy a line in each, or the
		// following rows' indexes would drift out of step with their source.
		if (!take(oldLines, line.content)) return null;
		if (!take(newLines, line.content)) return null;
		rows.push({ source: 1, line: newLines.length - 1 });
	}

	return { sources: [oldLines.join("\n"), newLines.join("\n")], rows };
}
