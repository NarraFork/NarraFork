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
 *
 * ── Why retirement is driven by TIME, not by the append boundary ──────────────
 *
 * The first cut of this module had ONE water mark: the append boundary. Graphemes
 * at `offset >= boundary` got an animated span, everything before it was folded
 * into a plain string. Since the boundary advances on EVERY delta, a grapheme held
 * its span for exactly one frame — the next delta moved the boundary past it, the
 * span unmounted, and the text reappeared as part of the static string. Unmounting
 * an element kills its running CSS animation, so the character snapped from
 * wherever the blur had got to (~16ms of 320ms, i.e. ~5%) straight to the final
 * state.
 *
 * Visible symptom: during continuous plain-text output almost nothing appeared to
 * fade in. Only the LAST delta before the model paused animated fully, because
 * nothing came after it to evict its spans. Not an edge case — it was every
 * ordinary paragraph.
 *
 * The bug was conceptual: "is this text new?" is a per-frame property of content
 * position, while "is this character still animating?" is a one-shot fact about
 * WHEN it was born. So a frame now carries two water marks:
 *
 *   - the append boundary (content-driven) decides which graphemes are born now;
 *   - `sealOffset` (time-driven) decides which graphemes may be folded into the
 *     static string, and it lags the boundary by the animation's own duration.
 *
 * A grapheme therefore keeps one stable span for its whole 320ms and its animation
 * runs to completion. Sealing is invisible when it finally happens: the animation
 * has already reached its end state, which is what the plain text renders as.
 *
 * ── Why the live span count is bounded ───────────────────────────────────────
 *
 * Spans live for one animation duration, so their number is (output rate × 320ms)
 * — independent of body length. Normal typing keeps a few dozen alive. Two
 * separate caps guard the pathological cases, because this module has already
 * frozen a tab once (see STREAM_ANIM_MAX_APPEND): STREAM_ANIM_MAX_APPEND bounds
 * ONE frame's intake, and STREAM_ANIM_MAX_LIVE_SPANS bounds the accumulation
 * across the frames inside a single window.
 */

/** Max number of animation keys retained before oldest entries are evicted. */
export const STREAM_ANIM_MAX_KEYS = 512;

/**
 * How long one grapheme's fade-in runs.
 *
 * MUST equal the `vlist-token-in` duration in `vlist-markdown.css` (0.32s). This
 * is the value that decides when a span may be folded back into static text, so a
 * CSS duration LONGER than this seals mid-animation and reintroduces the very
 * snap this module exists to prevent — silently, since nothing else observes it.
 */
export const STREAM_ANIM_DURATION_MS = 320;

/**
 * Hard cap on graphemes animating simultaneously.
 *
 * The time window already bounds this at realistic output rates; the cap covers
 * the case the window cannot, namely many maximal frames landing inside one
 * window (a reconnect catch-up delivering STREAM_ANIM_MAX_APPEND per frame would
 * otherwise reach ~9.7k live spans). Past the cap the oldest graphemes are sealed
 * early: a truncated fade on text that is already legible, which is strictly
 * better than the compositor-layer explosion that froze the tab before.
 */
export const STREAM_ANIM_MAX_LIVE_SPANS = 768;

/**
 * Rounding applied to the resume offset handed to `animation-delay`.
 *
 * A grapheme's span can be REMOUNTED while it animates: as a line fills up, the
 * tail rewraps onto the next visual line, which changes the span's parent even
 * though its key is unchanged. React then unmounts and remounts it, and the
 * animation restarts from zero — the same character blurs in twice, which is most
 * visible exactly where it happens most, at the end of every line.
 *
 * A negative `animation-delay` makes the animation's progress a function of the
 * grapheme's AGE instead of its mount time, so a remount resumes where it left
 * off. The value is quantized because it is recomputed every frame: an exact
 * elapsed time would rewrite the inline style of every live span on every frame,
 * and each rewrite re-anchors a running animation. One quantum is a fraction of
 * the duration, so the resulting step is imperceptible mid-blur.
 */
export const STREAM_ANIM_DELAY_QUANTUM_MS = 32;

/**
 * Largest append (in code units) still treated as "freshly typed" and animated.
 *
 * A real delta is tens of characters. Anything far larger is a JUMP, not typing:
 * a reconnect snapshot, a fresh mount whose key already carried text, or a body
 * that was rewritten. Animating a jump mounts one blurred span PER GRAPHEME for
 * the whole body at once — tens of thousands of compositor layers each running a
 * `filter: blur()` keyframe, which froze the tab outright (the text sat at the
 * animation's `opacity: 0` start frame, so only inline-code chip backgrounds were
 * visible). Past this bound the frame is SEALED instead: the text simply appears.
 *
 * Chosen well above any plausible single delta and far below the point where the
 * span count costs anything.
 */
export const STREAM_ANIM_MAX_APPEND = 512;

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

/**
 * Bound the animated span of a frame to its trailing STREAM_ANIM_MAX_APPEND code
 * units. `boundary` is where new text starts; pushing it forward shrinks what
 * animates and never grows it, so a normal delta passes through untouched.
 */
export function clampAnimBoundary(boundary: number, totalLength: number): number {
	const floor = totalLength - STREAM_ANIM_MAX_APPEND;
	return boundary < floor ? floor : boundary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation boundary store — per animKey previous-text memory across frames
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One recorded birth: the graphemes from `offset` onwards became visible at `ts`.
 *
 * A frame appends at most one of these, so the list is naturally sorted by both
 * offset and timestamp — which is what lets `sealOffset` be a simple scan.
 */
interface AnimBirth {
	/** Code-unit offset where this frame's newly-appended text starts. */
	offset: number;
	/** When it was first rendered (ms, same clock as `resolveFrame`'s `now`). */
	ts: number;
}

interface AnimEntry {
	text: string;
	len: number;
	/** Births still inside the animation window, oldest first. */
	births: AnimBirth[];
}

/**
 * The two water marks a frame needs, plus the ages of the live spans.
 */
export interface StreamAnimFrame {
	/**
	 * Everything at `offset >= animBoundary` is text this frame has not shown
	 * before. Content-driven; identical to the old single boundary.
	 */
	animBoundary: number;
	/**
	 * Everything at `offset < sealOffset` has finished animating and may be folded
	 * into the static string. Time-driven, so it lags `animBoundary` by up to one
	 * animation duration. Between the two, spans persist and keep animating.
	 */
	sealOffset: number;
	/**
	 * Age (ms) of each live birth, for the negative `animation-delay` that lets a
	 * remounted span resume instead of restarting. Sorted by offset, so the age of
	 * a grapheme is the entry with the greatest `offset <= gid`.
	 */
	births: readonly AnimBirth[];
	/** Wall clock of this frame, so callers derive ages without re-reading it. */
	now: number;
}

/**
 * Tracks, per animation key, the previous visible text (for the append split) and
 * the birth times of graphemes still animating (for time-driven sealing). Bounded
 * LRU so a finished stream's keys don't leak (Map preserves insertion order;
 * re-inserting on access moves a key to the newest slot).
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
	 *   - pure append (next starts with prev) → boundary = prev length, clamped to
	 *     the trailing STREAM_ANIM_MAX_APPEND window;
	 *   - NOT an append (rewrite / reset / front-truncation) → boundary =
	 *     fullText.length, i.e. sealed, nothing animates.
	 *
	 * The non-append case used to animate from the common-prefix point, and that is
	 * what hung the tab. A jump is not typing, and it hits EVERY block of the body
	 * in the same frame — so a per-block window cannot bound it, only refusing to
	 * animate can. Causes seen in practice: a stale entry left by another narrator
	 * under the same `__streaming__`-derived key, a reconnect snapshot, a retry that
	 * rewrites the body, and the front-truncation `appendStreamingTextPreview`
	 * applies past its 120k cap. Each mounted one blurred span PER GRAPHEME for the
	 * whole body at once — tens of thousands of `filter: blur()` layers, with the
	 * text stuck at the keyframe's `opacity: 0` so only inline-code chip
	 * backgrounds were visible.
	 */
	peekBoundary(animKey: string, fullText: string): number {
		const prev = this.entries.get(animKey);
		if (prev === undefined) return fullText.length;
		// A jump is sealed outright; only genuine growth animates.
		if (!fullText.startsWith(prev.text)) return fullText.length;
		return clampAnimBoundary(prev.len, fullText.length);
	}

	/**
	 * The full frame state for `animKey` at `fullText`: the append boundary, the
	 * time-driven seal offset, and the live births for delay resumption.
	 *
	 * Pure — safe during render and under StrictMode double-invocation. The births
	 * recorded on a previous commit are read, never written; `commitFrame` is what
	 * advances them.
	 *
	 * `sealOffset` is the offset of the OLDEST birth still inside the animation
	 * window. Everything before it has finished animating, so folding it into the
	 * static string is invisible. When no birth is live the whole text seals, which
	 * is both the idle state and the first-sighting state.
	 */
	peekFrame(animKey: string, fullText: string, now: number): StreamAnimFrame {
		const animBoundary = this.peekBoundary(animKey, fullText);
		const prev = this.entries.get(animKey);
		// No history, or a jump that sealed the boundary at the full length: there is
		// nothing animating, so nothing to hold back from the static string. Reading
		// `animBoundary` rather than re-deriving the jump test keeps the two in step.
		if (prev === undefined || animBoundary >= fullText.length) {
			// A jump does NOT drop births already in flight: the text they belong to may
			// still be present (a rewrite that only touched the tail), and letting them
			// finish is always safer than snapping them.
			const live = prev ? liveBirths(prev.births, now, fullText.length) : [];
			return {
				animBoundary,
				sealOffset: live.length > 0 ? (live[0]?.offset ?? fullText.length) : fullText.length,
				births: live,
				now,
			};
		}
		// This frame's own append is a birth too — it is not in the store yet (that
		// happens on commit), but the split must already treat it as animating.
		const live = liveBirths(prev.births, now, fullText.length);
		const withCurrent =
			animBoundary < fullText.length ? appendBirth(live, animBoundary, now) : live;
		return {
			animBoundary,
			sealOffset: withCurrent.length > 0 ? (withCurrent[0]?.offset ?? animBoundary) : animBoundary,
			births: withCurrent,
			now,
		};
	}

	/**
	 * Record `fullText` as the latest committed text for `animKey`. Call once per
	 * commit (e.g. a layout effect), never during render. Maintains LRU order and
	 * evicts the oldest key past the capacity bound.
	 *
	 * Kept for callers that only need the append boundary; the streaming renderer
	 * uses `commitFrame`, which also advances the birth record.
	 */
	commitText(animKey: string, fullText: string): void {
		this.commitFrame(animKey, fullText, 0);
	}

	/**
	 * Commit `fullText` AND record the birth of whatever it appended.
	 *
	 * `now` must come from the same clock the matching `peekFrame` used, or a
	 * grapheme's age is nonsense and its animation resumes at the wrong progress.
	 * Births outside the window are dropped here, which is what keeps the list — and
	 * therefore the live span count — bounded.
	 */
	commitFrame(animKey: string, fullText: string, now: number): void {
		const prev = this.entries.get(animKey);
		const boundary = this.peekBoundary(animKey, fullText);
		const carried = prev ? liveBirths(prev.births, now, fullText.length) : [];
		// Only genuine growth is a birth. A jump sealed the boundary at the full
		// length, and recording that as a birth would mark the ENTIRE body as freshly
		// animating on the next frame — the tab-freezing shape this module refuses.
		const births = boundary < fullText.length ? appendBirth(carried, boundary, now) : carried;
		// Re-insert to mark most-recently-used, then evict oldest over capacity.
		this.entries.delete(animKey);
		this.entries.set(animKey, { text: fullText, len: fullText.length, births });
		if (this.entries.size > this.maxKeys) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
	}

	/**
	 * Peek the boundary then commit `fullText` in one call. Convenience for
	 * non-React callers / tests; components should use peekFrame (render) +
	 * commitFrame (effect) so render stays pure.
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

	/** Live birth count for a key (diagnostics + span-bound assertions). */
	birthCount(animKey: string): number {
		return this.entries.get(animKey)?.births.length ?? 0;
	}

	/** Drop all keys (e.g. a hard reset). */
	clear(): void {
		this.entries.clear();
	}
}

/**
 * Births still inside the animation window, oldest first.
 *
 * Also drops births that the current text can no longer contain: a rewrite may
 * leave an offset past the end, and keeping it would seal at an offset beyond the
 * text (hiding the static prefix entirely).
 */
function liveBirths(births: readonly AnimBirth[], now: number, textLength: number): AnimBirth[] {
	const out: AnimBirth[] = [];
	for (const birth of births) {
		if (now - birth.ts >= STREAM_ANIM_DURATION_MS) continue;
		if (birth.offset > textLength) continue;
		out.push(birth);
	}
	return out;
}

/**
 * Append one birth, then enforce the live-span cap by sealing the oldest.
 *
 * The cap counts GRAPHEMES (approximated by code units from the oldest live
 * offset), not births: one frame can deliver up to STREAM_ANIM_MAX_APPEND of them,
 * so a birth count limit would not bound the spans that actually get mounted.
 */
function appendBirth(live: readonly AnimBirth[], offset: number, ts: number): AnimBirth[] {
	const out = [...live];
	// A repeated offset within one window means the text did not grow; keep the
	// ORIGINAL timestamp so a re-render cannot restart an in-flight animation.
	const last = out[out.length - 1];
	if (last && last.offset === offset) return out;
	out.push({ offset, ts });
	// The newest birth's offset is the animating region's start; everything from
	// there to the text end is a span. Seal the oldest until that region fits.
	const newest = out[out.length - 1]?.offset ?? offset;
	while (out.length > 1 && newest - (out[0]?.offset ?? newest) > STREAM_ANIM_MAX_LIVE_SPANS) {
		out.shift();
	}
	return out;
}

/**
 * How long the grapheme at `gid` has been animating, in quantized ms.
 *
 * Its birth is the LATEST one at or before its offset: births are appended in
 * increasing offset order, so the last such entry is the frame that introduced it.
 * Returns 0 when no birth covers it (already sealed, or born this very frame),
 * which renders as no delay at all.
 */
export function graphemeAnimAge(births: readonly AnimBirth[], gid: number, now: number): number {
	let birth: AnimBirth | undefined;
	for (const candidate of births) {
		if (candidate.offset > gid) break;
		birth = candidate;
	}
	if (birth === undefined) return 0;
	const elapsed = now - birth.ts;
	if (!(elapsed > 0)) return 0;
	if (elapsed >= STREAM_ANIM_DURATION_MS) return 0;
	// Quantized so a live span's inline style is stable across most frames; an
	// unquantized value would be rewritten every frame and re-anchor the animation.
	return Math.floor(elapsed / STREAM_ANIM_DELAY_QUANTUM_MS) * STREAM_ANIM_DELAY_QUANTUM_MS;
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
	/** Leading text at offset < sealOffset — rendered as a plain (unkeyed) string. */
	staticText: string;
	/**
	 * Graphemes at offset >= sealOffset — each keeps its own span, keyed by global
	 * offset, for as long as its animation runs.
	 */
	animGraphemes: AnimGrapheme[];
}

/**
 * Split one fragment's text into a static prefix and a per-grapheme animated
 * suffix, using the fragment's GLOBAL start offset within its block and the
 * frame's SEAL offset.
 *
 * The split point is the seal offset, NOT the append boundary. That is the whole
 * fix: the boundary advances on every delta, so splitting there unmounted a span
 * one frame after it mounted and killed the animation it had barely started (see
 * the module header). The seal offset lags by the animation duration, so a
 * grapheme keeps ONE stable span for its entire fade and only becomes plain text
 * once the animation has already reached its end state.
 *
 * - fragEnd <= sealOffset  → all static (nothing here is animating)
 * - fragStart >= sealOffset → every grapheme keeps a span
 * - straddling             → prefix static, tail per-grapheme
 *
 * Grapheme boundaries are respected: a grapheme is animated when its own start
 * offset is >= sealOffset (so a multi-unit grapheme is never split mid-way).
 */
export function splitFragmentForAnim(
	fragmentText: string,
	fragGlobalStart: number,
	sealOffset: number,
): FragmentAnimSplit {
	const fragEnd = fragGlobalStart + fragmentText.length;
	if (fragEnd <= sealOffset) {
		return { staticText: fragmentText, animGraphemes: [] };
	}
	if (fragGlobalStart >= sealOffset) {
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
		if (globalStart < sealOffset) {
			staticText += g.text;
		} else {
			animGraphemes.push({ gid: globalStart, text: g.text });
		}
	}
	return { staticText, animGraphemes };
}
