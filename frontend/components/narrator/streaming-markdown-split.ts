/**
 * Streaming markdown "stable prefix" splitter.
 *
 * During streaming the message text grows token-by-token. Re-parsing and
 * re-rendering the *entire* accumulated markdown on every animation frame is
 * O(n²) and pins the main thread (see the perf trace that motivated this).
 *
 * Strategy: split the growing text into
 *   - a **stable prefix**: whole top-level blocks that are already "sealed" and
 *     whose rendered output will never change as more text arrives. Rendered
 *     once and memoised, so most frames skip it entirely (no re-render, no reflow).
 *   - an **active tail**: the last, not-yet-sealed block(s). Re-parsed every frame.
 *
 * Correctness first (avoiding reflow of already-rendered content above is the
 * top priority). Markdown has several "reach back and rewrite already-emitted
 * content" traps — setext heading promotion, list loose/tight recomputation,
 * table body accretion, link/footnote reference definitions. So the split is
 * deliberately conservative:
 *   - cut points only ever land at a blank-line boundary (start of a line that
 *     follows a blank line) — this severs paragraph lazy-continuation / setext
 *     promotion contexts;
 *   - blank lines *inside* fenced code are never treated as boundaries;
 *   - we keep a buffer of the last N top-level blocks in the tail, so
 *     "the next block triggers a rewrite" cases (loose/tight lists, setext,
 *     table separator recognition) resolve inside the tail, not the prefix;
 *   - if the last kept block is a list / table / definition, we back off further;
 *   - if the prefix would contain a link/footnote reference definition, we
 *     disable splitting for that message entirely (the tail's `[ref]`/`[^n]`
 *     usages would break when parsed independently — reference `defined` state
 *     is parser-global and would be lost);
 *   - the prefix length is monotonic (append-only): it can only grow, never
 *     shrink, so already-rendered content never retreats/jitters.
 *
 * This is a lightweight, dependency-free line scan (O(n)); it deliberately does
 * NOT run remark on the hot path, so we don't trade one full-text parse per
 * frame for another.
 */

export interface StreamingSplit {
	/** Sealed leading blocks. "" when nothing is stable yet. */
	stablePrefix: string;
	/** The remainder (active, re-rendered every frame). */
	tail: string;
}

/** Number of trailing top-level blocks to always keep in the tail as a buffer. */
const BUFFER_BLOCKS = 2;

/** A code fence opener: up to 3 leading spaces, then ``` or ~~~ (>=3). */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * A link reference definition or GFM footnote definition at the start of a
 * (top-level) line: `[label]: ...` or `[^id]: ...`, up to 3 leading spaces.
 * Presence of one of these in the prefix means the prefix must not be parsed
 * separately from the tail, so splitting is disabled for that message.
 */
const DEFINITION_RE = /^ {0,3}\[(?:\^[^\]]+|[^\]]+)\]:/;

/** Leading marker of an (unordered/ordered) list item. */
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]\s|\d{1,9}[.)]\s)/;

interface Line {
	/** Raw line text (without the trailing newline). */
	text: string;
	/** Offset in the source string where this line starts. */
	start: number;
	/** True when this line is blank (only whitespace) and NOT inside a fence. */
	isBlankBoundary: boolean;
}

/**
 * Scan `text` into lines, tracking fenced-code state so that blank lines inside
 * a fence are not marked as block boundaries.
 */
function scanLines(text: string): Line[] {
	const lines: Line[] = [];
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;

	// Walk the string, emitting one Line per \n-terminated segment (and the
	// trailing segment). Callers normalise CRLF to LF before calling.
	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || text[i] === "\n") {
			const raw = text.slice(lineStart, i);
			const fenceMatch = FENCE_RE.exec(raw);
			let blankBoundary = false;

			if (fenceMatch) {
				const marker = fenceMatch[1];
				const ch = marker[0];
				if (!inFence) {
					inFence = true;
					fenceChar = ch;
					fenceLen = marker.length;
				} else if (ch === fenceChar && marker.length >= fenceLen && fenceMatch[2].trim() === "") {
					// Closing fence: same marker char, length >= opener, nothing after.
					inFence = false;
					fenceChar = "";
					fenceLen = 0;
				}
			} else if (!inFence && raw.trim() === "") {
				blankBoundary = true;
			}

			lines.push({ text: raw, start: lineStart, isBlankBoundary: blankBoundary });
			lineStart = i + 1;
			if (i === text.length) break;
		}
	}
	return lines;
}

/**
 * Given the scanned lines, return candidate cut offsets: the start of the first
 * non-blank line *after* each run of blank-line boundaries. Each candidate is a
 * safe "start of a top-level block" position.
 */
function blankBoundaryCandidates(lines: Line[]): number[] {
	const candidates: number[] = [];
	let prevWasBlank = false;
	for (const line of lines) {
		if (line.isBlankBoundary) {
			prevWasBlank = true;
			continue;
		}
		if (prevWasBlank) {
			// This non-blank line starts a new top-level block; the cut point is
			// the start of this line (everything before it is a complete block).
			candidates.push(line.start);
		}
		prevWasBlank = false;
	}
	return candidates;
}

/**
 * The first line of the block immediately preceding `cutOffset` — used to decide
 * whether the last kept block is a list / table / definition (needs back-off).
 * We look at the block that ends at `cutOffset`, i.e. its starting line.
 */
function classifyLastKeptBlock(
	lines: Line[],
	cutOffset: number,
): { isList: boolean; isTable: boolean; isDefinition: boolean } {
	// Find the last non-blank line strictly before cutOffset, then walk back to
	// the start of that block (first non-blank line after a blank boundary).
	let endIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].start >= cutOffset) break;
		if (!lines[i].isBlankBoundary) endIdx = i;
	}
	if (endIdx < 0) return { isList: false, isTable: false, isDefinition: false };

	// Walk back to the block start.
	let startIdx = endIdx;
	while (startIdx > 0 && !lines[startIdx - 1].isBlankBoundary) startIdx--;

	const firstLine = lines[startIdx].text;
	const isList = LIST_ITEM_RE.test(firstLine);
	const isDefinition = DEFINITION_RE.test(firstLine);
	// A table shows up as one or more lines containing an unescaped pipe; the
	// separator row (| --- |) may not have arrived yet, so detect by pipes in
	// the block's lines.
	let isTable = false;
	for (let i = startIdx; i <= endIdx; i++) {
		if (lines[i].text.includes("|")) {
			isTable = true;
			break;
		}
	}
	return { isList, isTable, isDefinition };
}

/** True when the substring `text[0, end)` contains a link/footnote definition. */
function prefixHasDefinition(lines: Line[], end: number): boolean {
	for (const line of lines) {
		if (line.start >= end) break;
		if (line.isBlankBoundary) continue;
		if (DEFINITION_RE.test(line.text)) return true;
	}
	return false;
}

/**
 * Compute the stable-prefix / active-tail split for a growing streaming text.
 *
 * @param fullText        the current accumulated text
 * @param prevStablePrefix the previous split's stable prefix (monotonic guard);
 *   pass "" on the first call. If the new text no longer starts with it (stream
 *   reset / rewrite), the guard is dropped and the split recomputed from scratch.
 * @returns split where `stablePrefix + tail` equals the CRLF-normalised text
 */
export function splitStableAndTail(fullText: string, prevStablePrefix = ""): StreamingSplit {
	const text = fullText.replace(/\r\n?/g, "\n");

	// Monotonic guard: the previous prefix stays stable only if the new text
	// still starts with it (append-only). On reset/rewrite, drop it.
	const prevLen =
		prevStablePrefix.length > 0 && text.startsWith(prevStablePrefix) ? prevStablePrefix.length : 0;

	const lines = scanLines(text);
	const candidates = blankBoundaryCandidates(lines);

	// Need at least BUFFER_BLOCKS boundaries to have any sealed prefix, because
	// we drop the last BUFFER_BLOCKS blocks into the tail.
	let cut = 0;
	if (candidates.length >= BUFFER_BLOCKS) {
		// Candidate index to use: drop the last BUFFER_BLOCKS blocks. The block
		// boundaries are candidates[]; using candidates[len-BUFFER_BLOCKS] keeps
		// everything before that boundary as prefix.
		let idx = candidates.length - BUFFER_BLOCKS;
		// Back off while the last kept block is a list / table / definition.
		while (idx >= 0) {
			const candidateCut = candidates[idx];
			const cls = classifyLastKeptBlock(lines, candidateCut);
			if (cls.isList || cls.isTable || cls.isDefinition) {
				idx--;
				continue;
			}
			cut = candidateCut;
			break;
		}
	}

	// Cross-block definition guard: if the prefix would contain a link/footnote
	// reference definition, disable splitting entirely (parse must stay whole).
	if (cut > 0 && prefixHasDefinition(lines, cut)) {
		cut = 0;
	}

	// Monotonic guard: prefix only grows.
	if (prevLen > cut) cut = prevLen;

	// Safety: never cut inside the string beyond its length.
	if (cut > text.length) cut = text.length;

	if (cut <= 0) {
		return { stablePrefix: "", tail: text };
	}

	// Slice the normalised text (offsets were computed against it). Markdown
	// rendering is insensitive to CRLF-vs-LF, and stablePrefix + tail === text.
	return {
		stablePrefix: text.slice(0, cut),
		tail: text.slice(cut),
	};
}

/**
 * True when `text` ends inside an unclosed fenced code block. The active tail
 * uses this to decide it is NOT safe to feed to the animation renderer this
 * frame (an incomplete ``` fence would be mis-tokenised), falling back to a
 * plain/static render until the fence closes.
 */
export function hasUnclosedFence(text: string): boolean {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;
	for (const raw of lines) {
		const m = FENCE_RE.exec(raw);
		if (!m) continue;
		const marker = m[1];
		const ch = marker[0];
		if (!inFence) {
			inFence = true;
			fenceChar = ch;
			fenceLen = marker.length;
		} else if (ch === fenceChar && marker.length >= fenceLen && m[2].trim() === "") {
			inFence = false;
			fenceChar = "";
			fenceLen = 0;
		}
	}
	return inFence;
}
