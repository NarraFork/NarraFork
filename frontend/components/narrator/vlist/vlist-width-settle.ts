/**
 * vlist-width-settle.ts — When a live width change may rebuild the layout.
 *
 * The rule: WHILE A POINTER IS DRAGGING, NEVER REBUILD. Commit on release.
 *
 * Why there is no cost estimate here
 * ---------------------------------
 * Earlier versions tried to spend the frame budget wisely by predicting how expensive
 * a rebuild would be, and every predictor was wrong in a new way:
 *
 *  1. `lastBuildMs > 12ms` — times the MEASUREMENT pass only. A realistic window
 *     measures ~2ms (40 messages → 1.8ms), so the gate declared every real session
 *     cheap and committed per frame, while the ~1600 mounted DOM nodes it did not
 *     measure were rebuilt on every one. The gate was effectively inert.
 *  2. `mountedRowCount > 12` — a row's cost varies ~30x with its content (long prose
 *     ~60 DOM units, code ~22, a one-line system card ~2). Two panels either side of a
 *     splitter gate independently, so the same row count landed on opposite sides of
 *     the threshold: one panel froze, the other kept re-laying out.
 *
 * The pattern is not that the thresholds were mistuned. The render happens inside
 * React's commit phase, its cost depends on content, fonts, style recalculation and
 * layout the list never sees, and it varies per machine — so any number computed here
 * is a guess dressed as a measurement, and a wrong guess silently disables the freeze.
 *
 * So this module no longer estimates. A drag defers, unconditionally. That is sound
 * without any cost model: during a gesture the reader is looking at the divider, not
 * reading text, so withholding a reflow costs them nothing — while performing one can
 * cost a frame. The only thing a cost model bought was letting cheap views rebuild
 * live mid-drag, which is invisible to the user anyway.
 *
 * Everything that is NOT a pointer drag still commits immediately (a window resize, a
 * programmatic panel toggle, a preference flip): those have no gesture to wait for.
 */

/**
 * Quiet period (ms) before a NON-POINTER width change commits.
 *
 * Only used when no pointer is down. A pointer drag is gated on the release event
 * instead, because a quiet period cannot distinguish "finished" from "paused mid-drag"
 * — a wall clock reads the same either way, which is how an earlier version committed
 * 3-4 times during a bursty or slow drag.
 */
export const WIDTH_SETTLE_DELAY_MS = 140;

/**
 * Backstop (ms) for a deferral held open while a pointer reads as down.
 *
 * Re-armed by every width change, so an ACTIVE drag never reaches it (moves arrive far
 * more often than this). It fires only when a pointer is held and the width has been
 * completely idle for this long — an abandoned gesture, or a release that landed
 * outside the window with no `pointercancel` to match it.
 *
 * When it fires it COMMITS. An earlier version re-armed instead, reasoning that a held
 * pointer is always a real drag; that turned a stuck pointer-down state into a
 * permanently wedged width, which is worse than the jank. Committing after three idle
 * seconds is safe and makes convergence unconditional.
 */
export const WIDTH_POINTER_BACKSTOP_MS = 3000;

/**
 * How many committed widths the cycle guard remembers.
 *
 * Four is the smallest window that can witness a REPEATED alternation (A B A B)
 * rather than a single there-and-back (A B A), which a legitimate resize produces all
 * the time. It also bounds the loop: a feedback cycle gets at most this many commits
 * before it is pinned. See `isWidthFeedbackCycle`.
 */
export const WIDTH_CYCLE_RING = 4;

/**
 * Record a committed width in the guard's ring (most recent LAST).
 *
 * Widths are rounded on the way in so the ring compares on the same integers as the
 * `changed` test — otherwise a fractional wobble would write two "different" entries
 * for one physical width and the alternation below could never be recognised.
 */
export function pushCommittedWidth(recent: readonly number[], width: number): readonly number[] {
	const next = [...recent, Math.round(width)];
	return next.length > WIDTH_CYCLE_RING ? next.slice(next.length - WIDTH_CYCLE_RING) : next;
}

/**
 * Whether committing `nextWidth` would continue a MEASUREMENT FEEDBACK CYCLE.
 *
 * The failure this rules out, reproduced against the real layout builder: an
 * `image_generation` block reserves its image area by aspect ratio against the live
 * column width, so its height GROWS as the column widens (measure-media.ts). Once any
 * element does that, "a scrollbar that appears can never become unnecessary" is false,
 * and the width feeds back on itself with no user present:
 *
 *     commit 333 → document 1656px ≤ viewport → no scrollbar → clientWidth +15
 *     commit 348 → document 1712px  > viewport →    scrollbar → clientWidth -15
 *
 * Measured on a 380x1656 viewport with eight generated-image messages: 59 commits in
 * 60 hops, alternating 333 ↔ 348 forever. 35361 (viewport, message-count) combinations
 * in the ordinary 360-560px range oscillate the same way, including a SINGLE image
 * message at 553x300 — this is a live 60fps rebuild spin, not a corner case.
 *
 * ── Feedback vs. a legitimate return to a previous width ─────────────────────
 *
 * Damping cannot simply refuse a width it has seen before: dragging a splitter back to
 * where it was is a real user action that must still apply. The two are separated
 * WITHOUT any content assumption, on two structural facts:
 *
 *  1. A pointer gesture is external input, and `gesture-end` is checked BEFORE this
 *     guard — so a drag (or drag back) always commits and always clears the ring.
 *     Feedback has no gesture: it runs entirely on observer → quiet timer.
 *  2. Feedback leaves the viewport's OUTER box untouched (see
 *     `isExternalGeometryChange`), so a host that resizes the box is recognised
 *     without a gesture and bypasses this guard entirely.
 *  3. Feedback is driven by a BINARY cause (the scrollbar is present or it is not), so
 *     it can only ever produce two widths, strictly alternating. Requiring the full
 *     A B A B pattern means a pointer-free resize (OS window chrome) has to land on
 *     exactly two alternating pixel widths four times in a row to be mistaken for it,
 *     and the next distinct width clears the ring again — `pushCommittedWidth` records
 *     it and the alternation test below stops matching.
 *
 * So the guard pins only a width that has already proven it oscillates, and any real
 * input — a gesture, a box resize, or a width the cycle could not have produced —
 * releases it.
 */
export function isWidthFeedbackCycle(recent: readonly number[], nextWidth: number): boolean {
	if (recent.length < WIDTH_CYCLE_RING) return false;
	const [a, b, c, d] = recent.slice(recent.length - WIDTH_CYCLE_RING);
	if (a === undefined || b === undefined || c === undefined || d === undefined) return false;
	// Two distinct widths, strictly alternating across the whole window...
	if (a === b || a !== c || b !== d) return false;
	// ...and this commit would be the next hop of that same alternation.
	return Math.round(nextWidth) === a;
}

/**
 * Whether the viewport's OUTER BOX changed size — i.e. the host resized this list.
 *
 * ── The failure this exists for ───────────────────────────────────────────────
 *
 * The cycle guard above separates feedback from real input on the assumption that real
 * input arrives as a POINTER GESTURE, which clears the ring. A dockview panel toggled
 * from a button (or a keyboard shortcut, or a layout restore) is real input with NO
 * gesture at all, and toggling it flips the list between exactly two widths — the same
 * A B A B shape the guard is built to recognise. Measured against the shipped guard:
 *
 *     toggle 1 open  → commit, ring [600]
 *     toggle 2 close → commit, ring [600 1000]
 *     toggle 3 open  → commit, ring [600 1000 600]
 *     toggle 4 close → commit, ring [600 1000 600 1000]
 *     toggle 5 open  → PINNED — and every toggle after it, forever
 *
 * The ring never drains, because `gesture-end` is its only reset and a programmatic
 * toggle never produces one. So the fifth toggle wedged the column at the wrong width
 * permanently, which is exactly the reported behaviour.
 *
 * ── Why the outer box is the right discriminator ──────────────────────────────
 *
 * A vertical scrollbar lives INSIDE the border box: its appearance moves `clientWidth`
 * and leaves `offsetWidth` alone. Every external cause — a sash drag, a panel toggle,
 * a window resize, a layout restore — resizes the box itself. So the two sources are
 * distinguishable structurally, with no gesture, no clock and no content assumption:
 *
 *     scrollbar feedback  → clientWidth moves, offsetWidth constant
 *     host resized us     → offsetWidth moves
 *
 * This only ever RELEASES the cycle guard; it never bypasses the pointer-drag
 * deferral, which is checked separately and still holds a sash drag to one commit on
 * release (a drag changes `offsetWidth` on every frame, so bypassing the deferral here
 * would reinstate the per-frame rebuild the freeze exists to prevent).
 *
 * Unmeasured (`undefined`) on either side means "cannot tell", which reports false and
 * leaves the guard in charge — the conservative direction, since a wrongly released
 * guard only costs the bounded oscillation it was added to stop.
 */
export function isExternalGeometryChange(
	boxWidth: number | undefined,
	committedBoxWidth: number | undefined,
): boolean {
	if (boxWidth === undefined || committedBoxWidth === undefined) return false;
	if (!Number.isFinite(boxWidth) || !Number.isFinite(committedBoxWidth)) return false;
	return Math.round(boxWidth) !== Math.round(committedBoxWidth);
}

/** What prompted this evaluation. */
export type WidthSettleTrigger =
	/** A ResizeObserver callback. */
	| "observer"
	/** A previously armed deferral timer came due. */
	| "timer"
	/** The pointer was released (or the gesture was cancelled). */
	| "gesture-end";

export interface WidthSettleDecision {
	/** Commit the new width to the layout now. */
	commit: boolean;
	/** Hold the new width and re-evaluate after `deferForMs`. */
	defer: boolean;
	/** Delay to arm when `defer` is set. */
	deferForMs: number;
}

export interface WidthSettleInput {
	/** The width the viewport just reported. */
	nextWidth: number;
	/** The width the committed layout was built with. */
	committedWidth: number;
	/** What prompted this evaluation. */
	trigger: WidthSettleTrigger;
	/**
	 * Whether a pointer is currently down anywhere in the document, read LIVE at
	 * decision time. This is the drag signal: an unrelated press costs nothing (a
	 * deferral only engages when a width change arrives at the same time), while a real
	 * sash or node drag is guaranteed to hold it.
	 */
	pointerDown: boolean;
	/**
	 * The last few COMMITTED widths, oldest first, maintained with
	 * `pushCommittedWidth`. Only read to recognise a measurement feedback cycle; absent
	 * or short means "not enough history", which can never pin a width.
	 */
	recentCommittedWidths?: readonly number[];
	/**
	 * The viewport's OUTER (border-box) width right now, e.g. `offsetWidth`.
	 *
	 * Paired with `committedBoxWidth` to recognise a host-driven resize that carries no
	 * pointer gesture — a dock panel toggled from a button is the case that mattered.
	 * See `isExternalGeometryChange`. Omit (both of them) to keep the previous
	 * behaviour, where only a gesture could release the cycle guard.
	 */
	boxWidth?: number;
	/** The outer width recorded when the committed width was last committed. */
	committedBoxWidth?: number;
	/** A live preview (even one only queued) still needs an explicit final commit. */
	hasPendingPreview?: boolean;
}

const NO_ACTION: WidthSettleDecision = { commit: false, defer: false, deferForMs: 0 };
const COMMIT: WidthSettleDecision = { commit: true, defer: false, deferForMs: 0 };

/**
 * Decide how to answer one observed width.
 *
 * A no-op width (nothing changed) does neither — this matters because a ResizeObserver
 * also fires for height-only changes, and answering those with a rebuild would
 * re-measure the document every time the composer grows a line.
 */
export function resolveWidthSettle(input: WidthSettleInput): WidthSettleDecision {
	// ⚠️ This early-out is the ANTI-OSCILLATION mechanism, not merely a no-op saving.
	//
	// Committing a width re-measures the document, which changes the total height,
	// which can add or remove the vertical scrollbar — and that changes the width
	// again, by ~15px, right back towards a value already committed. Answering the
	// second hop with another commit is a self-sustaining loop with no external input.
	// Comparing against the COMMITTED width means the return hop reads as "nothing
	// changed" and stops there, so an A→B→A feedback pair converges in two steps
	// (`vlist-width-settle-loop.test.ts` pins a bound on the commit count).
	//
	// Rounding also DELIBERATELY DISCARDS sub-pixel width changes. `clientWidth` is an
	// integer in every browser we target, so nothing real is lost; what it buys is
	// that a fractional wobble in a computed layout can never re-trigger the loop.
	const changed = Math.round(input.nextWidth) !== Math.round(input.committedWidth);
	if (!changed) {
		if (!input.hasPendingPreview) return NO_ACTION;
		// Returning to the starting width does not undo a preview's local geometry.
		// Nor does a queued preview count as a completed full-layout commit.
		if (input.trigger === "gesture-end" || input.trigger === "timer") return COMMIT;
		return {
			commit: false,
			defer: true,
			deferForMs: input.pointerDown ? WIDTH_POINTER_BACKSTOP_MS : WIDTH_SETTLE_DELAY_MS,
		};
	}

	// The gesture ended: this is the commit point the whole design waits for.
	//
	// Checked BEFORE the cycle guard on purpose — a pointer gesture is EXTERNAL input,
	// so dragging a splitter back to a width the guard just pinned must still apply.
	// The caller clears the ring on this path (see `pushCommittedWidth`'s contract in
	// the shell), which is what keeps damping off legitimate user action.
	if (input.trigger === "gesture-end") return COMMIT;

	// ⚠️ STRUCTURAL ANTI-OSCILLATION GUARD — the termination proof for the width loop.
	//
	// The `!changed` test above does NOT stop a feedback cycle: a commit moves
	// `committedWidth` onto the value just observed, so the return hop differs from the
	// new reference by just as much and commits again (pinned as a test). Safety used to
	// be argued from a MEASURE-layer claim — that height is monotone non-increasing in
	// width, so a scrollbar that appears can never become unnecessary. That claim has a
	// counterexample in the shipped code (image_generation reserves its image area by
	// aspect ratio, so it gets TALLER as the column widens), and with it the loop spins
	// at 60fps with no user input.
	//
	// This guard replaces that argument with a structural bound: a width that has
	// already alternated A B A B is not committed a fifth time, so any cycle costs at
	// most `WIDTH_CYCLE_RING` commits and then stops. It assumes NOTHING about content
	// shape, so a future non-monotone element cannot reopen the failure.
	//
	// Pinning is not a wedge: the width keeps painting at the last committed value, and
	// any external input releases it (a gesture takes the branch above; a resized outer
	// box takes the `isExternalGeometryChange` exemption; a genuinely new width breaks
	// the alternation the ring is matching on).
	//
	// The outer-box exemption is what makes a GESTURE-FREE host resize — a dock panel
	// toggled from a button — external input rather than "the fifth hop of a cycle".
	// Without it the ring filled with the panel's two widths and pinned the column
	// permanently from the fifth toggle on, because `gesture-end` is its only reset and
	// a programmatic toggle never produces one.
	if (
		!isExternalGeometryChange(input.boxWidth, input.committedBoxWidth) &&
		isWidthFeedbackCycle(input.recentCommittedWidths ?? [], input.nextWidth)
	) {
		return NO_ACTION;
	}

	// A timer that comes due is always a commit point, for one of two reasons:
	//  - no pointer: the quiet period elapsed, so the width genuinely settled.
	//  - pointer down: the BACKSTOP elapsed, meaning the width has been idle for
	//    seconds while something still reports a pointer as held. A live drag re-arms
	//    this constantly, so reaching it means the state is stuck; committing is what
	//    makes convergence unconditional.
	if (input.trigger === "timer") return COMMIT;

	// An observer callback during an active drag: never rebuild. No cost model is
	// consulted, deliberately — see the header comment.
	if (input.pointerDown) {
		return { commit: false, defer: true, deferForMs: WIDTH_POINTER_BACKSTOP_MS };
	}

	// No pointer involved: nothing to wait for beyond the width settling.
	return { commit: false, defer: true, deferForMs: WIDTH_SETTLE_DELAY_MS };
}

/**
 * Quantisation (px) of the viewport HEIGHT that reaches the layout build.
 *
 * Height is not a wrapping input, so it has almost nothing to do with measured
 * geometry — its single influence is the plan-detail cap (`0.85 x viewportHeight`, see
 * measure-tool-call.resolveDetailCap). But it was being fed into the build options
 * (and the rebuild effect's dependencies) at full pixel resolution, so every pixel of
 * height change re-measured the ENTIRE document:
 *
 *     msgs   height-only rebuild
 *     1000   5.1ms
 *     4000  17.7ms
 *     8000  41.2ms
 *
 * A sash drag changes both dimensions, so this bypassed the width gate completely and
 * is why a CONTINUOUS drag janked even after the pointer gating landed.
 *
 * Bucketing to 100px keeps the plan cap accurate to ~85px (it is a scroll-box ceiling
 * on one card, not a layout dimension) while making an ordinary drag emit zero or one
 * layout-visible height change instead of one per frame.
 *
 * The list still uses the EXACT height everywhere it matters — the mounted window,
 * scroll anchoring, bottom-pinning — because those read `viewportHeight` directly
 * rather than going through the build.
 */
export const VIEWPORT_HEIGHT_BUCKET_PX = 100;

/**
 * Layout-facing viewport height: the exact height snapped to a bucket.
 *
 * Rounds to NEAREST (not down) so a viewport sitting just under a boundary is not
 * described as a bucket shorter than it really is, and never returns 0 for a real
 * viewport — `resolveDetailCap` treats 0 as "unknown" and falls back to the fixed cap,
 * which would make a plan card change height when the list is first measured.
 */
export function bucketViewportHeight(viewportHeight: number): number {
	if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
	return Math.max(
		VIEWPORT_HEIGHT_BUCKET_PX,
		Math.round(viewportHeight / VIEWPORT_HEIGHT_BUCKET_PX) * VIEWPORT_HEIGHT_BUCKET_PX,
	);
}
