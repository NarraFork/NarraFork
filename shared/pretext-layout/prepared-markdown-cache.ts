/**
 * prepared-markdown-cache.ts — Width-INDEPENDENT memo for parsed markdown.
 *
 * Why this exists
 * ---------------
 * The exact list needs a precise TOTAL height to place the scrollbar and restore
 * scroll anchors, so every layout rebuild measures every item — not just the
 * mounted window. A width change therefore re-measures the whole document.
 *
 * That would be cheap if measuring were only the width-dependent part. It is not:
 * `measureElementCached` keys on `contentWidth`, so a width change misses on every
 * entry and re-runs the ENTIRE measure, including `parseMarkdownToPreparedBlocks`
 * (marked.lexer plus pretext's per-fragment precompute). Measured on a long
 * markdown body:
 *
 *     full measure 17.410ms  =  parse 16.313ms (94%)  +  accumulateFrame 0.037ms
 *
 * The parse is 94% of the cost and depends only on the TEXT — never on the width.
 * Re-running it per width is pure waste, and it is what made dragging a panel
 * divider janky (a 1000-message narrator cost ~1.2s per distinct width).
 *
 * Caching it turns a width change from O(parse + frame) into O(frame):
 * re-measuring the same body across widths went 19.104ms → 0.031ms (~620x) with
 * byte-identical heights.
 *
 * Two properties make this sound
 * ------------------------------
 * 1. `parseMarkdownToPreparedBlocks` is a pure function of `(markdown, math)`.
 * 2. `accumulateFrame` never writes to the blocks it reads; it returns a separate
 *    frame. The streaming path (`streaming-block-cache.ts`) already relies on
 *    exactly this to reuse prepared blocks across frames.
 *
 * ⚠️ The one real hazard: SHARED BLOCKS MUST NOT BE MUTATED.
 * A consumer that needs a different `marginTop` (the plan-detail body in
 * measure-tool-call) must re-wrap the block in a copy rather than assign to it.
 * Assigning would corrupt the cached array for every other consumer of the same
 * text. `prepared-markdown-cache.test.ts` pins this down.
 *
 * KaTeX revision
 * --------------
 * Math support arrives asynchronously, and the same markdown prepares
 * DIFFERENTLY once KaTeX is available (a formula stops being literal text). The
 * caller passes the current revision, which participates in the key, so entries
 * built before the runtime landed are never served afterwards.
 *
 * FONT revision — why every key carries one
 * -----------------------------------------
 * The prepared layer is not text-only: `prepareRichInline` / `prepareWithSegments`
 * bake each fragment's PIXEL WIDTH into the handle (this is where `naturalWidth`,
 * `minWidth` and `maxLineWidth` come from), and those widths come from canvas
 * `measureText` with whatever font was resolvable at that instant. So the cache
 * key must include the font GENERATION, not just the text — otherwise a body
 * prepared under a fallback face keeps its old wrap points while the DOM repaints
 * with the real one, and measurement diverges from render (the one failure mode
 * this whole subsystem exists to prevent).
 *
 * Before the cross-width memo, every resize re-parsed and therefore re-measured,
 * which hid the problem. Caching across widths exposes it.
 *
 * Today's app ships NO webfonts: `pretext-fonts.ts` resolves to the Mantine
 * system stacks (`-apple-system, …` / `ui-monospace, …`), there is no `@font-face`
 * rule or font `<link>` anywhere in `frontend/`, and the only bundled font faces
 * belong to `katex.min.css`, which is imported lazily alongside the KaTeX runtime
 * and already covered by `katex-runtime`'s webfont watch (it clears the glyph
 * caches and bumps the KaTeX revision). The revision below is therefore expected
 * to stay 0 in production — but it is plumbed rather than assumed, because the
 * assumption is one `@font-face` away from being wrong and the failure is silent.
 *
 * PURITY: this module cannot read `document.fonts` (see shared-core.guard). The
 * frontend owns the observation and pushes the generation in via
 * `setPreparedFontRevision`, the same injection shape the KaTeX runtime and the
 * glyph resolvers use.
 */

import { prepareWithSegments } from "@chenglou/pretext";
import type { MathSupport } from "./parse-markdown";
import { clearCellMinWidthCache, parseMarkdownToPreparedBlocks } from "./parse-markdown";
import type { PreparedBlock } from "./prepared-block";

/**
 * Retention ceiling in SOURCE CHARACTERS, with bulk-clear on overflow (the same
 * strategy, and the same reasoning, as `measure-cache.ts`): a rebuild scans the
 * document sequentially, so an LRU would evict exactly the entries the next
 * rebuild needs. The working set is one narrator's message bodies.
 *
 * Measured in characters rather than ENTRIES because the entries are not
 * comparable: a body may be anything from 20 chars to `MAX_CACHED_TEXT_LENGTH`
 * (256KB), so an entry cap of 16384 bounded retention at a theoretical 4GB — no
 * practical constraint at all, and the only two outcomes it allowed were "grow to
 * 16384 entries" or "suddenly drop everything".
 *
 * Source length is a PROXY for retained memory, not the memory itself: what a hit
 * keeps alive is the prepared fragment/segment arrays, which run roughly an order
 * of magnitude larger than the text they came from. 4M chars of source therefore
 * budgets tens of MB of prepared handles — the same order as `measureCache`'s
 * stated 40-130MB — while still holding thousands of typical message bodies
 * (1-2KB each), which is what a single narrator's working set actually looks like.
 */
const CACHE_CHAR_CEILING = 4 * 1024 * 1024;

/**
 * Skip caching very large bodies. The win is per-parse and these are rare, while
 * retaining their prepared fragment arrays is what would dominate memory.
 */
const MAX_CACHED_TEXT_LENGTH = 256 * 1024;

const cache = new Map<string, PreparedBlock[]>();
/** Sum of cached key lengths for `cache` — the retention proxy above. */
let cacheChars = 0;
let hits = 0;
let misses = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Font generation (see the FONT REVISION note in the header)
// ─────────────────────────────────────────────────────────────────────────────

let fontRevision = 0;

/**
 * Current font generation. Folded into both cache keys, and exported so the
 * frontend can fold it into its own measure-cache key (the prepared blocks and
 * the measured heights derived from them must invalidate together).
 */
export function getPreparedFontRevision(): number {
	return fontRevision;
}

/**
 * Publish a new font generation (frontend-only concern: `document.fonts.ready`,
 * or the same listener that bumps the KaTeX revision).
 *
 * Dropping the prepared entries here is necessary but NOT sufficient: heights
 * measured from them live in the frontend's `measureCache`, and the layout that
 * placed them is already committed. The caller must therefore also clear the
 * measure cache and rebuild — which is why this reports whether anything changed
 * rather than doing it silently.
 *
 * Returns true when the generation actually moved.
 */
export function setPreparedFontRevision(revision: number): boolean {
	if (revision === fontRevision) return false;
	fontRevision = revision;
	// Every entry was prepared under the previous generation, so all of it is
	// suspect — the widths are baked in and cannot be re-derived in place. The
	// parser's own advance memos (table min-widths, the math placeholder advance)
	// hold measurements from that face too, so they go with them.
	cache.clear();
	cacheChars = 0;
	segmentCache.clear();
	segmentCacheChars = 0;
	clearCellMinWidthCache();
	return true;
}

/**
 * Parsed + pretext-prepared blocks for `markdown`, memoised across widths.
 *
 * The result is SHARED and must be treated as immutable — see the mutation
 * warning above. `mathRevision` must change whenever `math` starts resolving
 * formulas differently (i.e. when the KaTeX runtime loads).
 */
export function getPreparedMarkdownBlocks(
	markdown: string,
	math: MathSupport | undefined,
	mathRevision: string | number,
): PreparedBlock[] {
	if (markdown.length === 0) return [];
	if (markdown.length > MAX_CACHED_TEXT_LENGTH) {
		misses++;
		return parseMarkdownToPreparedBlocks(markdown, math);
	}
	// `math ? "m" : "n"` and the revision both matter: the flag covers "no runtime
	// at all", the revision covers "a different runtime state". `fontRevision`
	// covers "the same text, measured against a different font" (header note).
	const key = `${math ? "m" : "n"}${mathRevision}\u0000f${fontRevision}\u0000${markdown}`;
	const found = cache.get(key);
	if (found !== undefined) {
		hits++;
		return found;
	}
	misses++;
	const blocks = parseMarkdownToPreparedBlocks(markdown, math);
	if (cacheChars + key.length > CACHE_CHAR_CEILING) {
		cache.clear();
		cacheChars = 0;
	}
	cache.set(key, blocks);
	cacheChars += key.length;
	return blocks;
}

/**
 * `prepareWithSegments` memo for PLAIN (non-markdown) bodies.
 *
 * User message bodies are pre-wrap plain text, so they skip the markdown parser
 * entirely — but they still pay pretext's per-segment precompute, which is also
 * width-independent and measured at ~1075µs per item (the second-largest cost
 * after markdown). Same contract as above: the result is shared and immutable.
 *
 * Keyed on `(fontRevision, font, whiteSpace, text)`. The font STRING alone is not
 * enough — it names a family stack, not the faces that were actually resolvable
 * when the widths were baked (header note). No KaTeX revision: there is no math
 * on this path.
 */
const segmentCache = new Map<string, ReturnType<typeof prepareWithSegments>>();
/** Sum of cached key lengths for `segmentCache`. */
let segmentCacheChars = 0;

export function getPreparedTextWithSegments(
	text: string,
	font: string,
	whiteSpace?: "pre-wrap",
): ReturnType<typeof prepareWithSegments> {
	const options = whiteSpace ? { whiteSpace } : undefined;
	if (text.length > MAX_CACHED_TEXT_LENGTH) {
		misses++;
		return options ? prepareWithSegments(text, font, options) : prepareWithSegments(text, font);
	}
	const key = `f${fontRevision}\u0000${font}\u0000${whiteSpace ?? ""}\u0000${text}`;
	const found = segmentCache.get(key);
	if (found !== undefined) {
		hits++;
		return found;
	}
	misses++;
	const prepared = options
		? prepareWithSegments(text, font, options)
		: prepareWithSegments(text, font);
	if (segmentCacheChars + key.length > CACHE_CHAR_CEILING) {
		segmentCache.clear();
		segmentCacheChars = 0;
	}
	segmentCache.set(key, prepared);
	segmentCacheChars += key.length;
	return prepared;
}

/**
 * Drop every entry (narrator switch / teardown / tests).
 *
 * Deliberately leaves `fontRevision` alone: it is a monotonic generation counter
 * describing the ENVIRONMENT, not cached content, and rewinding it would let a
 * stale key be minted again. `resetPreparedFontRevisionForTest` exists for tests
 * that need a clean baseline.
 */
export function resetPreparedMarkdownCache(): void {
	cache.clear();
	cacheChars = 0;
	segmentCache.clear();
	segmentCacheChars = 0;
	hits = 0;
	misses = 0;
}

/** Test seam: restore the font generation baseline along with the entries. */
export function resetPreparedFontRevisionForTest(): void {
	fontRevision = 0;
	resetPreparedMarkdownCache();
}

/** Diagnostics for tests and perf assertions. */
export function preparedMarkdownCacheStats(): {
	size: number;
	/** Retained source characters (the ceiling is measured in these). */
	chars: number;
	hits: number;
	misses: number;
} {
	return {
		size: cache.size + segmentCache.size,
		chars: cacheChars + segmentCacheChars,
		hits,
		misses,
	};
}

/** The retention ceiling, exported so tests can drive the bulk-clear path. */
export const PREPARED_CACHE_CHAR_CEILING = CACHE_CHAR_CEILING;
