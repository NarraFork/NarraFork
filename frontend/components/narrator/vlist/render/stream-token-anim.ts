/**
 * stream-token-anim.ts — Pure logic for the vlist streaming per-grapheme fade-in.
 *
 * The vlist renders each markdown line as a set of absolutely-positioned pretext
 * fragment spans, and the streaming tail rebuilds this subtree every frame. To
 * animate ONLY newly-appended text (like the classic MarkdownContent path does),
 * we cannot rely on component/instance survival — instead we derive a stable
 * "animation boundary" (a character offset into a block's visible text) from the
 * previous frame, and split each fragment into a static prefix + per-grapheme
 * animated suffix keyed by the grapheme's GLOBAL offset within the block.
 *
 * Grapheme spans keyed by global offset mean: already-shown graphemes reuse the
 * same key (no re-mount, no re-animate) while freshly-appended graphemes mount
 * new and play their one-shot CSS animation exactly once.
 *
 * ZERO DOM: this module never touches layout — heights are unaffected. It only
 * decides which text ranges get the animation class; the animation itself uses
 * compositor-only properties (opacity/transform/filter) in CSS.
 */

/** Max number of animation keys retained before oldest entries are evicted. */
export const STREAM_ANIM_MAX_KEYS = 512;

// ─────────────────────────────────────────────────────────────────────────────
// Grapheme segmentation (mirrors MarkdownContent.segmentMarkdownText)
// ─────────────────────────────────────────────────────────────────────────────

type GraphemeSegmenter = {
	segment(text: string): Iterable<{ segment: string; index: number }>;
};

let graphemeSegmenter: GraphemeSegmenter | null | undefined;

function getGraphemeSegmenter(): GraphemeSegmenter | null {
	if (graphemeSegmenter !== undefined) return graphemeSegmenter;
	try {
		if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
			graphemeSegmenter = null;
			return graphemeSegmenter;
		}
		graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	} catch {
		// Older WebViews may expose Intl but not Segmenter. The code-point fallback
		// below still keeps surrogate pairs together and is deterministic.
		graphemeSegmenter = null;
	}
	return graphemeSegmenter;
}

export interface Grapheme {
	/** The grapheme text. */
	text: string;
	/** Code-unit offset of this grapheme within the segmented string. */
	start: number;
	/** Code-unit end offset (start + text.length). */
	end: number;
}

/** Split `text` at grapheme boundaries, with a code-point fallback. */
export function segmentGraphemes(text: string): Grapheme[] {
	const segmenter = getGraphemeSegmenter();
	if (segmenter) {
		return Array.from(segmenter.segment(text), ({ segment, index }) => ({
			text: segment,
			start: index,
			end: index + segment.length,
		}));
	}
	const out: Grapheme[] = [];
	let offset = 0;
	for (const segment of Array.from(text)) {
		out.push({ text: segment, start: offset, end: offset + segment.length });
		offset += segment.length;
	}
	return out;
}

/** Length (in code units) of the common leading prefix of two strings. */
export function commonPrefixLength(previous: string, next: string): number {
	const limit = Math.min(previous.length, next.length);
	let offset = 0;
	while (offset < limit && previous.charCodeAt(offset) === next.charCodeAt(offset)) offset++;
	return offset;
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation boundary store — per animKey previous-text memory across frames
// ─────────────────────────────────────────────────────────────────────────────

interface AnimEntry {
	text: string;
	len: number;
}

/**
 * Tracks the previous visible text per animation key so a frame can compute the
 * "everything at offset >= boundary is newly appended" split. Bounded LRU so a
 * finished stream's keys don't leak (Map preserves insertion order; re-inserting
 * on access moves a key to the newest slot).
 */
export class StreamAnimStore {
	private readonly entries = new Map<string, AnimEntry>();
	private readonly maxKeys: number;

	constructor(maxKeys: number = STREAM_ANIM_MAX_KEYS) {
		this.maxKeys = Math.max(1, maxKeys);
	}

	/**
	 * Compute the animation boundary (code-unit offset) for `fullText` under
	 * `animKey` WITHOUT mutating state. Safe to call during render (and under
	 * React StrictMode double-invocation). Semantics mirror the classic
	 * AnimatedMarkdownText:
	 *   - first sighting of a key → boundary = fullText.length (no animation, so
	 *     a reconnect / narrator switch doesn't flash the whole block);
	 *   - pure append (next starts with prev) → boundary = prev length;
	 *   - otherwise (rewrite/reset) → boundary = common-prefix length.
	 */
	peekBoundary(animKey: string, fullText: string): number {
		const prev = this.entries.get(animKey);
		if (prev === undefined) return fullText.length;
		if (fullText.startsWith(prev.text)) return prev.len;
		return commonPrefixLength(prev.text, fullText);
	}

	/**
	 * Record `fullText` as the latest committed text for `animKey`. Call once per
	 * commit (e.g. a layout effect), never during render. Maintains LRU order and
	 * evicts the oldest key past the capacity bound.
	 */
	commitText(animKey: string, fullText: string): void {
		// Re-insert to mark most-recently-used, then evict oldest over capacity.
		this.entries.delete(animKey);
		this.entries.set(animKey, { text: fullText, len: fullText.length });
		if (this.entries.size > this.maxKeys) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
	}

	/**
	 * Peek the boundary then commit `fullText` in one call. Convenience for
	 * non-React callers / tests; components should use peekBoundary (render) +
	 * commitText (effect) so render stays pure.
	 */
	resolveBoundary(animKey: string, fullText: string): number {
		const boundary = this.peekBoundary(animKey, fullText);
		this.commitText(animKey, fullText);
		return boundary;
	}

	/** Test/inspection helper. */
	size(): number {
		return this.entries.size;
	}

	/** Drop all keys (e.g. a hard reset). */
	clear(): void {
		this.entries.clear();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Fragment split — static prefix + per-grapheme animated suffix
// ─────────────────────────────────────────────────────────────────────────────

export interface AnimGrapheme {
	/** Stable key = grapheme's global code-unit offset within the block. */
	gid: number;
	text: string;
}

export interface FragmentAnimSplit {
	/** Leading text at offset < boundary — rendered as a plain (unkeyed) string. */
	staticText: string;
	/** Graphemes at offset >= boundary — each animated, keyed by global offset. */
	animGraphemes: AnimGrapheme[];
}

/**
 * Split one fragment's text into a static prefix and per-grapheme animated
 * suffix, using the fragment's GLOBAL start offset within its block and the
 * frame's animation boundary.
 *
 * - fragEnd <= boundary  → all static (no graphemes to animate)
 * - fragStart >= boundary → all graphemes animate
 * - straddling           → prefix static, tail per-grapheme animated
 *
 * Grapheme boundaries are respected: a grapheme is animated when its own start
 * offset is >= boundary (so a multi-unit grapheme is never split mid-way).
 */
export function splitFragmentForAnim(
	fragmentText: string,
	fragGlobalStart: number,
	boundary: number,
): FragmentAnimSplit {
	const fragEnd = fragGlobalStart + fragmentText.length;
	if (fragEnd <= boundary) {
		return { staticText: fragmentText, animGraphemes: [] };
	}
	if (fragGlobalStart >= boundary) {
		const graphemes = segmentGraphemes(fragmentText).map((g) => ({
			gid: fragGlobalStart + g.start,
			text: g.text,
		}));
		return { staticText: "", animGraphemes: graphemes };
	}
	// Straddling: walk graphemes, routing each by its global start offset.
	let staticText = "";
	const animGraphemes: AnimGrapheme[] = [];
	for (const g of segmentGraphemes(fragmentText)) {
		const globalStart = fragGlobalStart + g.start;
		if (globalStart < boundary) {
			staticText += g.text;
		} else {
			animGraphemes.push({ gid: globalStart, text: g.text });
		}
	}
	return { staticText, animGraphemes };
}
