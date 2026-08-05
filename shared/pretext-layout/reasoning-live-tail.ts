/**
 * reasoning-live-tail.ts — The "1234 字符…<尾部>" label for a LIVE reasoning row
 * folded into the L1/L2 activity trace.
 *
 * ── The problem this solves ───────────────────────────────────────────────────
 *
 * A folded reasoning row shows `segment.title` when the step has one, and
 * otherwise the first non-blank LINE of its body. Both are settled-PREFIX views,
 * which is right for a finished step and wrong for the one still being written: a
 * body streamed under a single `**title**` never closes its step, so the row
 * freezes on that title while the model keeps writing. Measured on the real path:
 * 200 consecutive deltas produced ONE distinct row title.
 *
 * The reader wants the opposite for the live row — the NEWEST characters. So the
 * live row is labelled with the accumulated size plus a trailing slice, and the
 * window scrolls with the stream instead of hiding its end:
 *
 *     1234 字符…（尾部）
 *
 * ── Cost: O(1) per frame, not O(len) ─────────────────────────────────────────
 *
 * This runs on EVERY streaming delta (the fold re-adapts the live row each frame —
 * see render-units.ts), so anything that walks the accumulated text turns a long
 * turn into O(len²) — the exact shape `reasoning-segments-cache.ts` was written to
 * remove, and what `low-lod-streaming-cost.test.ts` guards. Therefore the tail is
 * taken from a BOUNDED slice of the end (`text.slice(-window)`) and only that
 * slice is whitespace-collapsed. `text.length` is O(1), so the size prefix is free.
 *
 * ⚠️ The result must reach the renderer through the DRAW-TIME channel, never
 * through the measured payload: a trace row's measured `title` feeds the
 * measurement cache key (`traceRevision`'s `|tt:` signature) and an activity
 * trace's key — `activity-<firstMsgId>-<i>` — carries no `__streaming__` marker,
 * so it is cached like any settled element. A per-frame-changing measured title
 * would mint a cache entry per delta (the bounded-cache guard in
 * `low-lod-streaming-cost.test.ts`), while a field the revision ignores would be
 * served STALE from the cache. Painting it at draw time is what satisfies both,
 * and it is height-neutral: the row is one fixed 18.8px truncating line whatever
 * text it carries.
 *
 * Pure: no DOM, no timers.
 */

/**
 * Characters of trailing text supplied after the size prefix.
 *
 * This is a SUPPLY budget, not a display width. The row is one fixed-height line
 * whose overflow is clipped on the LEFT (`direction: rtl`, see the renderer), so
 * handing over more text than fits costs nothing visually — the excess slides out
 * of view on the old side while the newest characters stay pinned at the right
 * edge. Under-supplying, by contrast, leaves visible empty space on a wide row,
 * which is exactly what a too-small budget produced.
 *
 * So this is sized for the WIDEST realistic row (a full-width desktop trace at
 * 12px: roughly 200 latin chars, and CJK is about half that per character), and
 * narrow columns simply clip more. It stays a constant either way, which is what
 * keeps the per-frame cost independent of the accumulated reply.
 */
export const TAIL_CHARS = 220;

/**
 * Below this accumulated length the ordinary title/first-line view already shows
 * the content, so no tail label is produced.
 *
 * 80 matches `truncateTitle`'s cap — the most a settled row can display — so the
 * switch happens exactly when the ordinary view starts hiding text.
 *
 * Deliberately NOT tied to `TAIL_CHARS`: that is a supply budget for the widest
 * row, while this is the point at which the settled label becomes lossy. Between
 * the two, switching to a tail is still the right call — the label gains the live
 * size readout and keeps tracking the end — it simply has no text to clip yet.
 */
export const TAIL_MIN_CHARS = 80;

/**
 * How much of the raw end to inspect when building a `TAIL_CHARS` tail.
 *
 * Whitespace collapsing shrinks the slice, so the source window must be wider
 * than the target; 3x absorbs even heavily broken prose (newlines + indentation)
 * while staying a constant-size slice. Reading only this much is what keeps the
 * per-frame cost independent of the accumulated reply.
 */
const SOURCE_WINDOW = TAIL_CHARS * 3;

/** The live-tail label parts. */
export interface ReasoningLiveTail {
	/** Total characters accumulated in this reasoning run so far. */
	charCount: number;
	/** Trailing slice of the accumulated text — always the true end. */
	tail: string;
}

/**
 * Build the live-tail label for an in-flight reasoning body, or null when the
 * text is short enough that the ordinary title already shows all of it.
 *
 * @param text     the WHOLE accumulated reasoning text of the live run
 * @param minChars length below which no tail label is produced
 */
export function resolveReasoningLiveTail(
	text: string,
	minChars: number = TAIL_MIN_CHARS,
): ReasoningLiveTail | null {
	// O(1): no walk of the accumulated body.
	const charCount = text.length;
	if (charCount <= minChars) return null;

	// Collapse whitespace within a BOUNDED end window so a tail spanning a line or
	// paragraph break still reads as one line (the row cannot render newlines).
	const flatEnd = dropLeadingLoneSurrogate(text.slice(-SOURCE_WINDOW)).replace(/\s+/g, " ").trim();
	const tail =
		flatEnd.length > TAIL_CHARS ? dropLeadingLoneSurrogate(flatEnd.slice(-TAIL_CHARS)) : flatEnd;
	if (tail.length === 0) return null;
	return { charCount, tail };
}

/**
 * Drop a leading orphaned surrogate left behind by slicing at a fixed code-UNIT
 * offset.
 *
 * `slice(-n)` counts UTF-16 units, so it can land between the two halves of an
 * astral character (emoji, some CJK extension ideographs, mathematical alphanumerics)
 * and the tail then opens on a replacement glyph. Neither `trim()` nor the whitespace
 * collapse removes it — a lone surrogate is not whitespace.
 *
 * Only the LEADING half needs handling: the source is a suffix of the accumulated
 * text, so the end is either a complete character or the not-yet-arrived half of one
 * still being streamed (which the next delta completes).
 *
 * ⚠️ Deliberately a code-unit test rather than `Intl.Segmenter` / `[...text]`: this
 * runs on every streaming delta and must stay O(1). A trailing check is also avoided
 * for the same reason — it would say nothing the next frame does not fix.
 */
function dropLeadingLoneSurrogate(text: string): string {
	const first = text.charCodeAt(0);
	// A low surrogate at position 0 lost its high half to the slice.
	if (first >= 0xdc00 && first <= 0xdfff) return text.slice(1);
	// A high surrogate whose low half is missing (only possible at the very end of a
	// one-unit slice, but cheap to rule out).
	if (first >= 0xd800 && first <= 0xdbff && text.length === 1) return "";
	return text;
}

/**
 * Render-identity signature of every live tail an element's `data` carries, or ""
 * when it carries none (every settled row, i.e. almost all of them).
 *
 * Why the ROW MEMO needs this
 * --------------------------
 * The tail rides the freshly adapted `spec.data` and is read at DRAW TIME, never
 * through the measured payload (see the header comment). That keeps the measurement
 * cache flat — but it also puts the tail outside everything a row memo compares: a
 * folded activity trace's `measured` comes back from the cache as the SAME object,
 * its `spec.key` (`activity-<firstMsgId>-<i>`) is constant, and the row's height
 * never moves because the tail is height-neutral. All three compare equal, the memo
 * skips the re-render, and the new tail never reaches the DOM — the live row would
 * freeze exactly as it did before the tail existed, one layer further down.
 *
 * `charCount` is a sufficient identity: the tail is a suffix of a monotonically
 * growing body, so the count advances whenever the visible text does. Comparing
 * `spec.data` by reference instead would re-render the entire mounted window on every
 * rebuild — the 22.3ms/frame regression the row memo exists to prevent.
 *
 * Cost: one pass over the element's own rows, only reading two fields. Settled
 * elements short-circuit to "" without allocating.
 */
export function liveTailSignature(data: unknown): string {
	const items = (data as { items?: unknown } | null | undefined)?.items;
	if (!Array.isArray(items)) return "";
	let signature = "";
	for (const item of items) {
		const tail = (item as { liveTail?: unknown } | null | undefined)?.liveTail;
		if (tail == null || typeof tail !== "object") continue;
		const charCount = (tail as { charCount?: unknown }).charCount;
		if (typeof charCount !== "number") continue;
		signature = signature.length === 0 ? `${charCount}` : `${signature},${charCount}`;
	}
	return signature;
}
