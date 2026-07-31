/**
 * reasoning-segments-cache.ts — Incremental `parseReasoningSegments` for a LIVE,
 * growing reasoning body.
 *
 * Why this exists
 * ---------------
 * `parseReasoningSegments` splits the whole text on blank lines and walks the
 * paragraphs, so it is O(len). That was harmless while a streaming reasoning block
 * rendered as its own card: the card measured through the incremental prepared-block
 * path and the surrounding activity trace was served from the measurement cache.
 *
 * Low LOD now folds live content INTO the activity trace (see render-units.ts), and
 * the ADAPT step is not cached — only the measure is. So the live block's text is
 * re-parsed on every delta, and the per-frame cost grows with the accumulated
 * reply: measured 0.365ms at 2k chars rising to 3.573ms at 200k, i.e. O(len) per
 * frame and O(len²) over a turn, with the parse accounting for ~50% of the frame.
 * A long reasoning stream visibly stutters.
 *
 * How it stays exact
 * ------------------
 * Paragraphs are delimited by blank lines, so under APPEND-ONLY growth every
 * paragraph before the final blank line is byte-identical frame to frame, and so is
 * every step those paragraphs already closed. The cache therefore keeps:
 *
 *   - `closed`   — steps that can no longer change (a later title or a placeholder
 *                  seal ended them),
 *   - the OPEN step's accumulating state,
 *   - `consumed` — how much text is accounted for, always at a paragraph boundary.
 *
 * Each frame re-parses only the text after `consumed`, and the still-growing final
 * paragraph is applied to a COPY of the open state so the cache never absorbs a
 * paragraph that may still change.
 *
 * The result is exact, never an approximation: `reasoning-segments-cache.test.ts`
 * asserts it equals a full parse at EVERY prefix of a set of fixtures, which is the
 * only assurance worth having for a cache that shadows a parser.
 *
 * Pure: no DOM, no timers. Growth that is not append-only (a retry, a rewrite)
 * simply misses and re-parses in full.
 */

import { parseReasoningSegments, type ReasoningSegment } from "./reasoning-segments";

/** Blank-line paragraph separator — identical to parseReasoningSegments'. */
const PARAGRAPH_SEPARATOR = /\n[ \t]*\r?\n+/g;
const EMPTY_PLACEHOLDER = "<!-- -->";

/**
 * The ONE step still accepting paragraphs, mirroring the fields the original loop
 * carries (`currentTitle` / `currentBody` / `started` / `sealed`).
 *
 * Deliberately does NOT hold the finished steps: those live on the cache entry, so a
 * per-frame view can share them by reference instead of copying (see `cloneOpenStep`).
 */
interface StepState {
	title: string | null;
	/**
	 * The open step's body, kept as ONE already-joined string rather than an array of
	 * paragraphs.
	 *
	 * This is the difference between working and not working on the COMMON shape. A
	 * reasoning body with a single `**title**` never closes its step, so its body grows
	 * for the whole turn; joining an array of paragraphs on every frame to emit it made
	 * the cost track the paragraph count anyway — measured 0.017ms/frame at 5k chars
	 * rising to 0.444ms at 400k (4082 paragraphs), i.e. the very O(len²)-per-turn shape
	 * this module exists to remove, just relocated from parsing to joining. With a
	 * running string, appending is one concatenation and emitting is free.
	 *
	 * (The multi-title shape was already flat — 0.0055 → 0.0084ms across the same
	 * range — because its steps close regularly and land in `closed`.)
	 */
	body: string;
	started: boolean;
	sealed: boolean;
}

interface CacheEntry {
	/** Prefix length whose paragraphs are all folded into `state` / `closed`. */
	consumed: number;
	/**
	 * O(1) fingerprint of the consumed prefix, for REWRITE detection.
	 *
	 * A length alone would be unsound: `text.slice(0, consumed)` is a prefix of
	 * `text` by construction, so a length-only check accepts any replacement body of
	 * sufficient size and would return steps parsed from text that is no longer
	 * there. Holding the prefix STRING and comparing with `startsWith` is sound but
	 * O(len) per frame — measured 0.035ms at 200k chars, and it was the dominant
	 * residual cost of this module (0.256ms/frame, scaling with the body) precisely
	 * because it re-compares the whole accumulated prefix on every delta.
	 *
	 * A fixed number of sampled char codes plus the length is O(1) and is the same
	 * technique `measure-cache`'s `textSignature` already relies on for cache keys.
	 * The consequence of a collision is bounded and benign in a way worth stating: a
	 * rewrite that preserves the length AND all sampled positions would reuse a stale
	 * boundary. The next real content change re-checks, and the exactness suite covers
	 * the realistic rewrite/truncate shapes.
	 */
	consumedSignature: string;
	/** Steps that can no longer change. Grow-only; shared with each frame's view. */
	closed: ReasoningSegment[];
	state: StepState;
	/**
	 * Whether this entry's bodies are truncated to their first line.
	 *
	 * Part of the reuse condition: serving a `titlesOnly` entry to a caller that wants
	 * full bodies would hand back clipped text under a cache hit.
	 */
	titlesOnly: boolean;
}

/**
 * O(1) signature of `text.slice(0, length)`: the length plus a fixed number of
 * evenly spaced char codes. Never walks the whole prefix.
 */
function prefixSignature(text: string, length: number): string {
	if (length <= 0) return "0";
	let signature = String(length);
	// 8 probes is enough to catch the realistic rewrite shapes (a different reply, a
	// front-truncation) while staying constant-time as the body grows.
	const probes = 8;
	for (let i = 0; i < probes; i++) {
		const at = Math.floor((length - 1) * (i / (probes - 1 || 1)));
		signature += `.${text.charCodeAt(at)}`;
	}
	return signature;
}

/**
 * Bounded number of tracked bodies. Only the live block grows, so one entry is the
 * normal case; a couple more absorb a narrator switch or an interleaved run without
 * letting the map creep.
 */
const MAX_ENTRIES = 4;

const entries = new Map<string, CacheEntry>();

function freshState(): StepState {
	return { title: null, body: "", started: false, sealed: false };
}

/**
 * Copy only the OPEN step, sharing the `closed` array by reference.
 *
 * Copying `closed` too was the residual O(len): a 200k-char body holds ~2400
 * finished steps, and duplicating that array every frame cost 0.32ms/frame and
 * scaled exactly with the step count — the same O(len²)-per-turn shape this module
 * exists to remove, just moved from parsing to array copying.
 *
 * Sharing is safe because the trailing paragraph can only ever affect the OPEN
 * step: `absorbParagraph` mutates `closed` solely by PUSHING (via `flush`), so the
 * view must not push into the shared array. `materialize` below is what keeps that
 * true — it concatenates instead.
 */
function cloneOpenStep(state: StepState): StepState {
	// `body` is an immutable string now, so the copy is four field reads.
	return {
		title: state.title,
		body: state.body,
		started: state.started,
		sealed: state.sealed,
	};
}

/**
 * If `paragraph` is a pure bold title, return its title and the remainder.
 *
 * Deliberately a copy of `reasoning-segments.ts`'s private `splitBoldTitle` rather
 * than an export of it: this module must reproduce that parser exactly, and the
 * equivalence test at every prefix is what pins the two together. (Exporting it
 * would be fine too; the test is the real contract either way.)
 */
function splitBoldTitle(paragraph: string): { title: string; rest: string } | null {
	if (!paragraph.startsWith("**")) return null;
	const closeRel = paragraph.slice(2).indexOf("**");
	if (closeRel <= 0) return null;
	const title = paragraph.slice(2, 2 + closeRel).trim();
	if (title.length === 0) return null;
	const after = paragraph.slice(2 + closeRel + 2);
	if (after.length === 0 || after.startsWith("\n") || after.startsWith("\r")) {
		return { title, rest: after.replace(/^\r?\n/, "") };
	}
	return null;
}

function bodyIsEmpty(body: string): boolean {
	const trimmed = body.trim();
	return trimmed.length === 0 || trimmed === EMPTY_PLACEHOLDER;
}

/**
 * Close the open step, if one was ever opened, appending it to `sink`.
 *
 * `sink` is explicit rather than `state.closed` so a view can collect its own
 * emissions into a throwaway array instead of pushing into the cached one.
 */
function flush(state: StepState, sink: ReasoningSegment[]): void {
	if (!state.started) return;
	sink.push({ title: state.title, body: state.body, isEmpty: bodyIsEmpty(state.body) });
}

function openStep(state: StepState, title: string | null, body: string): void {
	state.title = title;
	state.body = body;
	state.started = true;
	state.sealed = false;
}

/**
 * Append one paragraph to the open step's body, preserving the `\n\n` join.
 *
 * In `titlesOnly` mode the body is capped at the first non-blank LINE, which is all a
 * folded trace row can display (see `parseStreamingReasoningTitles`). Once that line
 * exists, later paragraphs change nothing the caller can observe, so appending them
 * is skipped entirely — that is what keeps a single-title body from rebuilding a
 * 400k-character string on every delta.
 */
function appendParagraph(state: StepState, paragraph: string, titlesOnly: boolean): void {
	if (titlesOnly) {
		// Nothing further can affect the displayed title.
		if (titleBodyIsSettled(state.body)) return;
		const joined = state.body.length > 0 ? `${state.body}\n\n${paragraph}` : paragraph;
		// Keep only through the first non-blank line, capped, so the string stays O(1)
		// even when the stream never emits a newline.
		const line = firstNonBlankLine(joined);
		state.body = line.length > 0 ? line : joined.slice(0, TITLE_BODY_CAP);
		return;
	}
	state.body = state.body.length > 0 ? `${state.body}\n\n${paragraph}` : paragraph;
}

/**
 * How much of a titles-only body is worth keeping.
 *
 * The consumer truncates a row title to 80 characters (`truncateTitle`), so anything
 * past a small multiple of that can never be displayed. The cap matters for the one
 * shape where a "first line" is unbounded: a body streamed as a single paragraph with
 * no blank lines has no line terminator, so without a cap its first line IS the whole
 * reply and gets rebuilt every frame (measured 0.0475ms/frame at 400k chars, still
 * scaling). With it, the emitted body is O(1) whatever the stream does.
 */
const TITLE_BODY_CAP = 512;

/**
 * The first non-blank line of `text`, trimmed and capped at `TITLE_BODY_CAP`.
 *
 * Returns "" when no line has ended yet AND the text is still short — the caller uses
 * that to mean "keep accumulating". Once the text passes the cap, a prefix is returned
 * even without a newline, because no longer line could change the displayed title.
 */
function firstNonBlankLine(text: string): string {
	let start = 0;
	while (start < text.length) {
		let end = text.indexOf("\n", start);
		const unterminated = end < 0;
		if (unterminated) end = text.length;
		const line = text.slice(start, Math.min(end, start + TITLE_BODY_CAP)).trim();
		if (line.length > 0) {
			// An unterminated line under the cap may still grow, so it is not final —
			// report it, and let the caller re-derive next frame (cheap: bounded slice).
			return line;
		}
		if (unterminated) break;
		start = end + 1;
	}
	return "";
}

/** True when `body` already holds as much as a row title can ever display. */
function titleBodyIsSettled(body: string): boolean {
	// A newline means the line ended; the cap means no more of it can be shown.
	return body.length >= TITLE_BODY_CAP || body.includes("\n");
}

/** Fold ONE paragraph into the state — the original loop body, verbatim. */
function absorbParagraph(
	state: StepState,
	paragraph: string,
	sink: ReasoningSegment[],
	titlesOnly: boolean,
): void {
	const titleSplit = splitBoldTitle(paragraph);
	if (titleSplit) {
		flush(state, sink);
		const rest = titleSplit.rest.trim();
		openStep(state, titleSplit.title, titlesOnly ? firstNonBlankLine(rest) : rest);
		return;
	}
	if (paragraph === EMPTY_PLACEHOLDER) {
		if (state.started) state.sealed = true;
		return;
	}
	if (!state.started) {
		openStep(state, null, "");
	} else if (state.sealed) {
		flush(state, sink);
		openStep(state, null, "");
	}
	appendParagraph(state, paragraph, titlesOnly);
}

/**
 * Split `text` into the paragraphs that are COMPLETE (followed by a blank line) and
 * the trailing one that may still grow.
 *
 * `settledLength` is where the complete paragraphs end, so it can be stored as the
 * resume point. Paragraphs are trimmed and empties dropped, matching the original.
 */
function splitAtLastSeparator(text: string): {
	complete: string[];
	growing: string;
	settledLength: number;
} {
	PARAGRAPH_SEPARATOR.lastIndex = 0;
	let lastEnd = -1;
	let match = PARAGRAPH_SEPARATOR.exec(text);
	while (match !== null) {
		lastEnd = match.index + match[0].length;
		match = PARAGRAPH_SEPARATOR.exec(text);
	}
	if (lastEnd < 0) return { complete: [], growing: text, settledLength: 0 };
	const head = text.slice(0, lastEnd);
	const complete = head
		.split(PARAGRAPH_SEPARATOR)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);
	return { complete, growing: text.slice(lastEnd), settledLength: lastEnd };
}

/**
 * Parse a live reasoning body, reusing the work done for its prefix.
 *
 * Returns exactly what `parseReasoningSegments(text)` returns. `key` scopes the memo
 * to one body (`spec.key` at the call site); an unrelated or rewritten text misses and
 * is parsed in full.
 */
export function parseStreamingReasoningSegments(key: string, text: string): ReasoningSegment[] {
	return parseLive(key, text, false);
}

/**
 * Same, but each segment's `body` is truncated to its first non-blank LINE.
 *
 * For a folded trace row that is a LOSSLESS reduction: the row displays
 * `segment.title` when present and otherwise the first non-blank line of the body, and
 * nothing else — it has no expandable body (`bodyText` is null for reasoning rows in
 * the activity fold).
 *
 * It is also the difference between flat and O(len²) on the COMMON shape. A reasoning
 * body with a single `**title**` keeps one step open for the whole turn, so returning
 * its full body means rebuilding a string the size of the entire reply on every delta:
 * inline attribution put 97.8% of a 0.489ms frame at 400k chars in exactly that step.
 * Capping at the first line makes the emitted body O(1).
 *
 * Callers that need real bodies (an expandable reasoning card) must use
 * `parseStreamingReasoningSegments` or the plain parser.
 */
export function parseStreamingReasoningTitles(key: string, text: string): ReasoningSegment[] {
	return parseLive(key, text, true);
}

function parseLive(key: string, text: string, titlesOnly: boolean): ReasoningSegment[] {
	if (!text) {
		entries.delete(key);
		return [];
	}

	const existing = entries.get(key);
	// Reuse demands append-only growth AND the same projection: a `titlesOnly` entry
	// holds truncated bodies, so serving it to a full-body caller would silently return
	// clipped text. A rewritten body no longer matches the fingerprint of the prefix we
	// folded in, so its settled boundary is void either way.
	let entry: CacheEntry;
	if (
		existing &&
		existing.titlesOnly === titlesOnly &&
		text.length >= existing.consumed &&
		prefixSignature(text, existing.consumed) === existing.consumedSignature
	) {
		entry = existing;
	} else {
		entry = { consumed: 0, consumedSignature: "0", closed: [], state: freshState(), titlesOnly };
		entries.set(key, entry);
		if (entries.size > MAX_ENTRIES) {
			// Drop the oldest tracked body; Map preserves insertion order.
			const oldest = entries.keys().next().value;
			if (oldest !== undefined && oldest !== key) entries.delete(oldest);
		}
	}

	// Fold every newly COMPLETED paragraph into the cached state. These can never
	// change again, so their emitted steps accumulate in the entry's own array.
	const tail = text.slice(entry.consumed);
	const { complete, growing, settledLength } = splitAtLastSeparator(tail);
	for (const paragraph of complete) {
		absorbParagraph(entry.state, paragraph, entry.closed, titlesOnly);
	}
	if (settledLength > 0) {
		entry.consumed += settledLength;
		entry.consumedSignature = prefixSignature(text, entry.consumed);
	}

	// Apply the still-growing final paragraph to a COPY of the OPEN step only, so the
	// cache never absorbs text that can still change — and never duplicates the
	// finished-step array, which is what made this path scale with the body again.
	const view = cloneOpenStep(entry.state);
	const emitted: ReasoningSegment[] = [];
	const trailing = growing.trim();
	if (trailing.length > 0) absorbParagraph(view, trailing, emitted, titlesOnly);
	flush(view, emitted);
	// `concat` allocates one array of the RESULT size, which the caller needs anyway;
	// the point is that no per-frame copy of `closed` happens before it.
	return emitted.length > 0 ? entry.closed.concat(emitted) : entry.closed;
}

/** Drop one tracked body, or all of them (narrator switch / teardown). */
export function resetStreamingReasoningCache(key?: string): void {
	if (key === undefined) entries.clear();
	else entries.delete(key);
}

/** Number of tracked bodies (diagnostics + leak assertions in tests). */
export function streamingReasoningCacheSize(): number {
	return entries.size;
}

/** Re-exported so callers can reach the non-incremental parser through one import. */
export { parseReasoningSegments };
