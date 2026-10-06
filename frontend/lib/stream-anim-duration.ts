/**
 * stream-anim-duration.ts — The single owner of the streaming fade-in duration.
 *
 * This lives in `frontend/lib/` rather than next to the animation logic in
 * `components/narrator/vlist/render/stream-token-anim.ts` because it has THREE
 * consumers that do not share a subtree:
 *
 *   1. the vlist render layer, which decides when a grapheme's span may be folded
 *      back into static text (it must not seal before the CSS animation ends);
 *   2. `AppRootLayout`, which publishes the user's preference to this module AND
 *      to the `--nf-stream-token-duration` CSS variable, from one value;
 *   3. `useLocalPref`, whose slider range must equal the bounds enforced here.
 *
 * Consumers 2 and 3 sit outside `vlist/`, and `vlist-isolation.guard.test.ts`
 * forbids any static import that reaches into it — the vlist must stay behind its
 * dynamic-import boundary so the initial bundle does not carry its module graph.
 * Keeping the duration here lets those consumers read it without breaching that
 * boundary; `stream-token-anim.ts` re-exports these names so the render layer's
 * own imports read naturally.
 *
 * Zero imports, no DOM, no React: safe for anything to depend on.
 */

/**
 * Default length of one grapheme's fade-in, and the value the CSS falls back to.
 *
 * MUST equal the `vlist-token-in` fallback in `vlist-markdown.css`. A test pins
 * the pair, because a mismatch is invisible: it only shows up as a fade that
 * snaps, which looks like a rendering glitch rather than a wrong number.
 */
export const DEFAULT_STREAM_ANIM_DURATION_MS = 320;

/**
 * Upper bound of the user-configurable duration.
 *
 * Not a safety limit: STREAM_ANIM_MAX_LIVE_SPANS (in stream-token-anim.ts) bounds
 * the span count no matter how long the window is, so a long duration cannot
 * reach the compositor-layer explosion that froze a tab before. It is a
 * legibility limit — the keyframe starts at `opacity: 0`, so this is also how
 * long freshly arrived text stays unreadable.
 *
 * ⚠️ Past roughly 1s the SPAN CAP, not the clock, governs how long a fade lasts.
 * Live spans ≈ output rate × duration, so at 5s a sustained ~150 graphemes/sec
 * (an ordinary fast stream) reaches the 768 cap and the oldest graphemes are
 * sealed EARLY — their fade truncates. That is the intended degradation (a
 * clipped fade on already-legible text beats a frozen tab), but it means a long
 * duration is a request, not a guarantee: fast output silently gets a shorter
 * fade than the setting says. Raising the cap to "fix" this would reintroduce the
 * freeze, so it is documented rather than removed.
 */
export const MAX_STREAM_ANIM_DURATION_MS = 5000;

/**
 * How long one grapheme's fade-in runs. User-configurable (Settings →
 * Appearance), so this is mutable module state rather than a constant.
 *
 * It MUST stay equal to the `vlist-token-in` duration actually in effect, which
 * is why one preference drives both this and the CSS variable (see
 * `setStreamAnimDurationMs`). This is the value that decides when a span may be
 * folded back into static text, so a CSS duration LONGER than this seals
 * mid-animation and reintroduces the very snap the animation module exists to
 * prevent — silently, since nothing else observes it.
 */
let streamAnimDuration = DEFAULT_STREAM_ANIM_DURATION_MS;

/** Current fade-in duration in ms. 0 means every frame seals immediately. */
export function streamAnimDurationMs(): number {
	return streamAnimDuration;
}

/**
 * Point the animation at a new duration. The caller is responsible for
 * publishing the SAME value to CSS (`--nf-stream-token-duration`); AppRootLayout
 * does both from one preference so the two cannot drift.
 *
 * Clamped here rather than trusted: a value above the bound would keep spans
 * alive long enough to hit the live-span cap during ordinary typing, which seals
 * the oldest graphemes early — a truncated fade, i.e. the defect the time-driven
 * seal exists to avoid. Non-finite input falls back to the default.
 */
export function setStreamAnimDurationMs(ms: number): void {
	if (!Number.isFinite(ms)) {
		streamAnimDuration = DEFAULT_STREAM_ANIM_DURATION_MS;
		return;
	}
	streamAnimDuration = Math.min(MAX_STREAM_ANIM_DURATION_MS, Math.max(0, Math.round(ms)));
}

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
 * and each rewrite re-anchors a running animation. One quantum must stay a small
 * FRACTION of the duration, or the resume step becomes a visible jump.
 *
 * Fixed at 32ms (~2 frames) for the 320ms default, and scaled down for shorter
 * user-configured durations by `streamAnimDelayQuantumMs` — at a 50ms duration a
 * 32ms quantum would be 64% of the whole animation, so a remounted grapheme would
 * resume at a wildly wrong progress instead of an imperceptibly stale one.
 */
export const STREAM_ANIM_DELAY_QUANTUM_MS = 32;

/**
 * The delay quantum in effect, capped at 1/10 of the current duration so the
 * quantization stays imperceptible at short durations. Floored at 1ms: a 0
 * quantum would divide by zero in `graphemeAnimAge`.
 */
export function streamAnimDelayQuantumMs(): number {
	return Math.max(1, Math.min(STREAM_ANIM_DELAY_QUANTUM_MS, Math.floor(streamAnimDuration / 10)));
}
