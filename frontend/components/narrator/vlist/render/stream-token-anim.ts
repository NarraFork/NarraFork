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
 * ── First sighting: mount vs. live birth ─────────────────────────────────────
 *
 * `peekBoundary` used to seal EVERY first sighting (boundary = full length) so a
 * reconnect / narrator switch never flashes a pre-existing body. That also sealed
 * blocks BORN during live streaming: a new paragraph gets its own key
 * (`…:${blockIndex}`), and its first frame was painted static — every new
 * paragraph's opening chunk popped in without the fade.
 *
 * The two cases are told apart by SCOPE. A key's scope is its prefix up to the
 * first ":" — the narratorId, given how callers build keys
 * (`${narratorId}:${spec.key}:${blockIndex}`; nanoid never contains ":"). The
 * store refcounts live entries per scope:
 *
 *   - COLD scope (no committed sibling): this is a mount — a fresh page, a
 *     narrator switch, a reload mid-stream. Seal everything, as before. The
 *     whole mount frame renders before any commit runs, so every block of it
 *     seals no matter how many arrive together.
 *   - WARM scope (a sibling block has committed): the stream is live and this
 *     key is a block that was just born (new paragraph / new text segment).
 *     Treat it as an append from offset 0 under the SAME STREAM_ANIM_MAX_APPEND
 *     clamp — a live birth animates, a big one (hidden-tab catch-up) animates
 *     only its trailing window.
 *
 * The refcount dies with the entries themselves (LRU eviction and clear()
 * included), so a scope whose entries are gone becomes cold again — eviction
 * once more seals, which is the safe direction.
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

/**
 * The duration lives in `frontend/lib/stream-anim-duration.ts`, not here: its
 * other consumers (AppRootLayout, which publishes the preference, and
 * useLocalPref, whose slider bounds must match) sit outside `vlist/`, and
 * `vlist-isolation.guard.test.ts` forbids reaching into this directory
 * statically. Re-exported so the render layer keeps importing one module.
 */
import {
	DEFAULT_STREAM_ANIM_DURATION_MS,
	MAX_STREAM_ANIM_DURATION_MS,
	STREAM_ANIM_DELAY_QUANTUM_MS,
	setStreamAnimDurationMs,
	streamAnimDelayQuantumMs,
	streamAnimDurationMs,
} from "@frontend/lib/stream-anim-duration";

export {
	DEFAULT_STREAM_ANIM_DURATION_MS,
	MAX_STREAM_ANIM_DURATION_MS,
	STREAM_ANIM_DELAY_QUANTUM_MS,
	setStreamAnimDurationMs,
	streamAnimDelayQuantumMs,
	streamAnimDurationMs,
};

/** Max number of animation keys retained before oldest entries are evicted. */
export const STREAM_ANIM_MAX_KEYS = 512;

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
 * How much leading text a "re-opened block" may share with what the key held
 * before. A couple of code units absorbs an incidental collision (both bodies
 * happening to open with "-", "#", a quote mark, or the same CJK character)
 * without admitting a genuine rewrite of the same paragraph, which normally keeps
 * its opening words.
 */
const RECYCLED_KEY_MAX_SHARED_PREFIX = 2;

/**
 * Does a non-append look like a RECYCLED KEY rather than a jump?
 *
 * A live row's keys derive from the constant `__streaming__` id plus a block
 * index, so turn N+1 reuses turn N's keys while this store is module-level and
 * has no per-turn reset (unlike `streaming-block-cache`, which rebuilds its
 * entry on the same condition). The new turn's block therefore finds the PREVIOUS
 * turn's text under its own key, fails `startsWith`, and was sealed as a jump —
 * so a new paragraph/heading/list item showed no fade on its FIRST delta and only
 * animated from the second one onwards, which is exactly the reported symptom.
 *
 * Three conditions, because SIZE alone does not separate the cases:
 *   - the new body is at typing scale (`<= STREAM_ANIM_MAX_APPEND`), the same
 *     per-frame intake bound an ordinary append is clamped to, so this branch can
 *     never mount more spans than the append path already may;
 *   - it is far shorter than what the key held before (a snapshot / retry / a
 *     front-truncated body arrives comparable or larger — that is exactly why it
 *     is dangerous);
 *   - it shares (almost) no leading text with the previous body. Size alone
 *     misreads a SHORT REWRITE of the same block: a retry that replaces 3000
 *     characters with "抱歉，重来。" passes both size tests, and animating it
 *     replays a fade over text the reader did not just watch being typed. A
 *     re-opened block is a different block, so it starts differently; a rewrite
 *     of the same paragraph normally keeps its opening words.
 */
function isRecycledKey(previousText: string, nextText: string): boolean {
	if (nextText.length > STREAM_ANIM_MAX_APPEND) return false;
	if (nextText.length * 2 > previousText.length) return false;
	return commonPrefixLength(previousText, nextText) <= RECYCLED_KEY_MAX_SHARED_PREFIX;
}

/**
 * Tracks, per animation key, the previous visible text (for the append split) and
 * the birth times of graphemes still animating (for time-driven sealing). Bounded
 * LRU so a finished stream's keys don't leak (Map preserves insertion order;
 * re-inserting on access moves a key to the newest slot).
 *
 * Also refcounts live entries per SCOPE: a first sighting under a warm scope is a
 * block born mid-stream and animates; under a cold scope it is a mount and seals.
 *
 * The scope is passed EXPLICITLY by callers (the narratorId — see
 * `StreamAnimScoped`). It used to be derived by slicing the key at its first ":",
 * which made the mount-vs-birth decision depend on the shape of a string built two
 * layers away (`${narratorId}:${spec.key}:${blockIndex}`). Reordering that
 * template or changing its separator would have silently degraded the scope to
 * "one per block", making every first sighting cold — i.e. every new paragraph
 * pops in without a fade, the exact defect the scope exists to fix, with no type
 * error and no failing test to announce it. An explicit argument cannot rot that
 * way: the key's shape and the scope are now independent facts.
 */
export class StreamAnimStore {
	private readonly entries = new Map<string, AnimEntry>();
	/** Live entry count per scope; an entry's scope warms only via OTHER keys. */
	private readonly scopeCounts = new Map<string, number>();
	/** Scope each live key was committed under, for eviction bookkeeping. */
	private readonly keyScopes = new Map<string, string>();
	private readonly maxKeys: number;

	constructor(maxKeys: number = STREAM_ANIM_MAX_KEYS) {
		this.maxKeys = Math.max(1, maxKeys);
	}

	/**
	 * A handle that carries one scope, so the render layer cannot forget to pass it
	 * (or pass a different one on peek than on commit — the two must agree or a
	 * birth is recorded under a scope nothing reads).
	 */
	scoped(scope: string): StreamAnimScoped {
		return new StreamAnimScoped(this, scope);
	}

	/**
	 * Compute the animation boundary (code-unit offset) for `fullText` under
	 * `animKey` WITHOUT mutating state. Safe to call during render (and under
	 * React StrictMode double-invocation). Semantics mirror the classic
	 * AnimatedMarkdownText:
	 *   - pure append (next starts with prev) → boundary = prev length, clamped to
	 *     the trailing STREAM_ANIM_MAX_APPEND window;
	 *   - NOT an append (rewrite / reset / front-truncation) → boundary =
	 *     fullText.length, i.e. sealed, nothing animates.
	 *
	 * First sightings split by scope (see the module header):
	 *   - COLD scope → boundary = fullText.length. This is a mount (fresh page,
	 *     narrator switch, reload mid-stream); animating would flash a body the
	 *     reader has already seen, and a large one would mount one blurred span
	 *     per grapheme — the tab-freezing shape this module refuses.
	 *   - WARM scope → the key is a block born mid-stream (a new paragraph / text
	 *     segment): boundary = 0 under the same append clamp, so its opening
	 *     chunk fades in instead of popping.
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
	peekBoundary(animKey: string, fullText: string, scope: string): number {
		const prev = this.entries.get(animKey);
		const warm = () => (this.scopeCounts.get(scope) ?? 0) > 0;
		if (prev === undefined) {
			// First sighting: K's own entry does not exist, so the scope count can
			// only come from SIBLINGS — exactly the mount-vs-birth distinction.
			if (!warm()) return fullText.length;
			return clampAnimBoundary(0, fullText.length);
		}
		if (!fullText.startsWith(prev.text)) {
			// Not an append. Two very different things land here (see isRecycledKey):
			// a block RE-OPENED under a recycled key, which is a live birth, and a
			// genuine jump (reconnect snapshot / retry / front-truncation), which must
			// seal or it mounts a blurred span per grapheme across the whole body.
			if (warm() && isRecycledKey(prev.text, fullText)) {
				return clampAnimBoundary(0, fullText.length);
			}
			return fullText.length;
		}
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
	 * is both the idle state and the cold-scope first-sighting (mount) state.
	 */
	peekFrame(animKey: string, fullText: string, now: number, scope: string): StreamAnimFrame {
		const animBoundary = this.peekBoundary(animKey, fullText, scope);
		const prev = this.entries.get(animKey);
		if (prev === undefined) {
			// First sighting. A cold scope sealed the boundary at the full length:
			// nothing animates, nothing to hold back from the static string. A warm
			// scope (a block born mid-stream) has boundary < length: its whole
			// (append-clamped) opening text is this frame's birth and animates.
			if (animBoundary >= fullText.length) {
				return { animBoundary, sealOffset: fullText.length, births: [], now };
			}
			const births = appendBirth([], animBoundary, now);
			return {
				animBoundary,
				sealOffset: births[0]?.offset ?? animBoundary,
				births,
				now,
			};
		}
		// A jump sealed the boundary at the full length: there is nothing new to
		// animate, but births already in flight are NOT dropped — the text they
		// belong to may still be present (a rewrite that only touched the tail),
		// and letting them finish is always safer than snapping them.
		if (animBoundary >= fullText.length) {
			const live = liveBirths(prev.births, now, fullText.length);
			return {
				animBoundary,
				sealOffset: live.length > 0 ? (live[0]?.offset ?? fullText.length) : fullText.length,
				births: live,
				now,
			};
		}
		// A RECYCLED key (see isRecycledKey): the entry's births belong to the block
		// this key held on a PREVIOUS turn, and the text they indexed is gone. Keeping
		// them would seal at a stale offset — the very hazard `liveBirths` guards for
		// shortened text, except here the offsets can still be in range and would
		// silently hide the new block's opening graphemes. The new text is one birth.
		if (!fullText.startsWith(prev.text)) {
			const births = appendBirth([], animBoundary, now);
			return {
				animBoundary,
				sealOffset: births[0]?.offset ?? animBoundary,
				births,
				now,
			};
		}
		// This frame's own append is a birth too — it is not in the store yet (that
		// happens on commit), but the split must already treat it as animating.
		const live = liveBirths(prev.births, now, fullText.length);
		const withCurrent = appendBirth(live, animBoundary, now);
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
	commitText(animKey: string, fullText: string, scope: string): void {
		this.commitFrame(animKey, fullText, 0, scope);
	}

	/**
	 * Commit `fullText` AND record the birth of whatever it appended.
	 *
	 * `now` must come from the same clock the matching `peekFrame` used, or a
	 * grapheme's age is nonsense and its animation resumes at the wrong progress.
	 * Births outside the window are dropped here, which is what keeps the list — and
	 * therefore the live span count — bounded.
	 */
	commitFrame(animKey: string, fullText: string, now: number, scope: string): void {
		const prev = this.entries.get(animKey);
		const boundary = this.peekBoundary(animKey, fullText, scope);
		// Births carry over only along an APPEND. A recycled key's births index text
		// from a previous turn that no longer exists, and carrying them would seal the
		// new block at a stale offset (see peekFrame's matching branch).
		const carried =
			prev && fullText.startsWith(prev.text) ? liveBirths(prev.births, now, fullText.length) : [];
		// Only genuine growth is a birth. A jump sealed the boundary at the full
		// length, and recording that as a birth would mark the ENTIRE body as freshly
		// animating on the next frame — the tab-freezing shape this module refuses.
		const births = boundary < fullText.length ? appendBirth(carried, boundary, now) : carried;
		// Re-insert to mark most-recently-used, then evict oldest over capacity.
		this.entries.delete(animKey);
		this.entries.set(animKey, { text: fullText, len: fullText.length, births });
		// Warm the scope only for a NEW key; overwriting an existing one must not
		// double-count (delete+set above leaves the refcount untouched).
		if (prev === undefined) {
			this.keyScopes.set(animKey, scope);
			this.scopeCounts.set(scope, (this.scopeCounts.get(scope) ?? 0) + 1);
		}
		if (this.entries.size > this.maxKeys) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) {
				this.entries.delete(oldest);
				// The evicted key's OWN scope, recorded when it was committed — not the
				// caller's current scope, which may belong to a different narrator.
				const evictedScope = this.keyScopes.get(oldest);
				this.keyScopes.delete(oldest);
				if (evictedScope !== undefined) {
					const count = (this.scopeCounts.get(evictedScope) ?? 1) - 1;
					if (count <= 0) this.scopeCounts.delete(evictedScope);
					else this.scopeCounts.set(evictedScope, count);
				}
			}
		}
	}

	/**
	 * Peek the boundary then commit `fullText` in one call. Convenience for
	 * non-React callers / tests; components should use peekFrame (render) +
	 * commitFrame (effect) so render stays pure.
	 */
	resolveBoundary(animKey: string, fullText: string, scope: string): number {
		const boundary = this.peekBoundary(animKey, fullText, scope);
		this.commitText(animKey, fullText, scope);
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

	/** Drop all keys (e.g. a hard reset). Scopes go cold with them. */
	clear(): void {
		this.entries.clear();
		this.scopeCounts.clear();
		this.keyScopes.clear();
	}
}

/**
 * A `StreamAnimStore` bound to one scope (a narratorId).
 *
 * The render layer holds one of these instead of passing the scope on every call:
 * `peekFrame` (render) and `commitFrame` (effect) MUST agree on the scope, or a
 * birth is recorded under a scope nothing reads and the block seals as a mount.
 * Binding it once makes disagreement unrepresentable rather than a convention.
 */
export class StreamAnimScoped {
	constructor(
		private readonly store: StreamAnimStore,
		private readonly scope: string,
	) {}

	peekBoundary(animKey: string, fullText: string): number {
		return this.store.peekBoundary(animKey, fullText, this.scope);
	}

	peekFrame(animKey: string, fullText: string, now: number): StreamAnimFrame {
		return this.store.peekFrame(animKey, fullText, now, this.scope);
	}

	commitFrame(animKey: string, fullText: string, now: number): void {
		this.store.commitFrame(animKey, fullText, now, this.scope);
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
	const duration = streamAnimDurationMs();
	for (const birth of births) {
		if (now - birth.ts >= duration) continue;
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
	if (elapsed >= streamAnimDurationMs()) return 0;
	// Quantized so a live span's inline style is stable across most frames; an
	// unquantized value would be rewritten every frame and re-anchor the animation.
	const quantum = streamAnimDelayQuantumMs();
	return Math.floor(elapsed / quantum) * quantum;
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
