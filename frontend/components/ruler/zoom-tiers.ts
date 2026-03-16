export type ZoomTierId = "L0" | "L1" | "L2" | "L3" | "L4";

export interface ZoomTier {
	id: ZoomTierId;
	minScale: number;
	maxScale: number;
}

/** L0 bird's eye: aggregated tick blocks + heatmap, no text
 *  L1 overview:   aggregated tick blocks + segment badges + active indicators
 *  L2 browse:     individual tick lines + SHA labels + collapsed cards
 *  L3 work:       individual ticks + full labels + expanded cards + connector lines
 *  L4 focus:      individual ticks + commit message + narrator panels inline */
export const ZOOM_TIERS: readonly ZoomTier[] = [
	{ id: "L0", minScale: 0, maxScale: 0.25 },
	{ id: "L1", minScale: 0.25, maxScale: 0.6 },
	{ id: "L2", minScale: 0.6, maxScale: 1.2 },
	{ id: "L3", minScale: 1.2, maxScale: 2.0 },
	{ id: "L4", minScale: 2.0, maxScale: Number.POSITIVE_INFINITY },
] as const;

/** Returns the current zoom tier and progress (0–1) within that tier. */
export function getZoomTierInfo(scale: number): { tier: ZoomTier; progress: number } {
	for (let i = ZOOM_TIERS.length - 1; i >= 0; i--) {
		const t = ZOOM_TIERS[i];
		if (scale >= t.minScale) {
			const range = t.maxScale === Number.POSITIVE_INFINITY ? t.minScale : t.maxScale - t.minScale;
			const progress =
				t.maxScale === Number.POSITIVE_INFINITY
					? Math.min((scale - t.minScale) / t.minScale, 1)
					: Math.min((scale - t.minScale) / range, 1);
			return { tier: t, progress };
		}
	}
	return { tier: ZOOM_TIERS[0], progress: 0 };
}

/** Returns opacity (0–1) for cross-fade transitions between tiers. */
export function getTransitionOpacity(progress: number, fadeInAt = 0.7, fadeOutAt = 0.3): number {
	if (progress > fadeInAt) {
		return (progress - fadeInAt) / (1 - fadeInAt);
	}
	if (progress < fadeOutAt) {
		return progress / fadeOutAt;
	}
	return 1;
}

// ---------------------------------------------------------------------------
// Distance-aware LOD: each chapter's LOD depends on the fisheye local scale
// ---------------------------------------------------------------------------

export type CardMode = "hidden" | "dot" | "compact" | "full";

/** Per-chapter card mode based on the fisheye local scale at its position. */
export function getCardModeForChapter(effectiveScale: number): CardMode {
	const tier = getZoomTierInfo(effectiveScale).tier.id;
	if (tier === "L0") return "hidden";
	if (tier === "L1") return "dot";
	if (tier === "L2") return "compact";
	return "full";
}

// ---------------------------------------------------------------------------
// Continuous morph: effectiveScale → interpolation factor t ∈ [0, 1]
// ---------------------------------------------------------------------------

/** Scale thresholds for the continuous morph.
 *  Aligned with zoom tiers so each phase is visible:
 *  - L0 (< 0.25): morph invisible
 *  - L1 (0.25–0.6): dot phase (growing circle)
 *  - L2 (0.6–1.2): pill phase (circle → capsule with title)
 *  - L3+ (> 1.2): card phase (pill → full card)
 */
const MORPH_INVISIBLE = 0.25; // below: hidden (matches L0 boundary)
const MORPH_DOT = 0.45; // dot fully formed (mid-L1)
const MORPH_PILL = 0.9; // pill fully formed (mid-L2)
/** Scale at which card is fully formed (L3 boundary). Exported for card-persistence logic. */
export const MORPH_CARD = 1.2;

/**
 * Map an effective scale (fisheye localScale) to a continuous morph factor `t` in [0, 1].
 *  0.0       → invisible
 *  0.0–0.3   → dot (growing circle)
 *  0.3–0.7   → pill (circle → capsule with title)
 *  0.7–1.0   → card (pill → full card)
 */
export function getMorphFactor(effectiveScale: number): number {
	if (effectiveScale <= MORPH_INVISIBLE) return 0;
	if (effectiveScale >= MORPH_CARD) return 1;
	// Piecewise linear mapping:
	// [MORPH_INVISIBLE, MORPH_DOT]  → [0, 0.3]
	// [MORPH_DOT, MORPH_PILL]       → [0.3, 0.7]
	// [MORPH_PILL, MORPH_CARD]      → [0.7, 1.0]
	if (effectiveScale < MORPH_DOT) {
		return 0.3 * ((effectiveScale - MORPH_INVISIBLE) / (MORPH_DOT - MORPH_INVISIBLE));
	}
	if (effectiveScale < MORPH_PILL) {
		return 0.3 + 0.4 * ((effectiveScale - MORPH_DOT) / (MORPH_PILL - MORPH_DOT));
	}
	return 0.7 + 0.3 * ((effectiveScale - MORPH_PILL) / (MORPH_CARD - MORPH_PILL));
}

/**
 * Compute the center-fade factor for a chapter at morph factor `t`.
 * Used by both React (SegmentCanvas) and PixiJS (RulerPixiLayer) to ensure
 * consistent positioning during the dot→pill→card transition.
 *
 * Returns 1 in dot/pill phase (element is centered), fades to 0 in card phase
 * (element snaps to top-left layout position).
 */
export function getCenterFade(t: number): number {
	return t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
}

/** Interpolated visual properties for a chapter element at morph factor `t`. */
export interface MorphStyle {
	width: number;
	height: number;
	borderRadius: number;
	/** 0 = hidden, 1 = fully visible */
	titleOpacity: number;
	/** Font size for the title (0 when hidden) */
	titleFontSize: number;
	/** Blend factor from pill to card appearance (0 = pure pill, 1 = full card).
	 *  Continuous value for cross-fade — replaces the old boolean showCardBody. */
	cardBlend: number;
	/** Overall element opacity */
	opacity: number;
}

// ---------------------------------------------------------------------------
// Keyframe-driven morph interpolation
// ---------------------------------------------------------------------------

/**
 * A single keyframe in the morph timeline.
 * `width` and `height` use a sentinel value of -1 to mean "use fullWidth/fullHeight".
 * All other fields are absolute values.
 *
 * Keyframes must be sorted by ascending `t`.
 */
interface MorphKeyframe {
	t: number;
	width: number;
	height: number;
	borderRadius: number;
	titleOpacity: number;
	titleFontSize: number;
	cardBlend: number;
	opacity: number;
}

/**
 * Morph keyframe table — the single source of truth for the dot→pill→card transition.
 *
 * Edit this table to tune the morph curve. Each row is a snapshot at a given `t`:
 *   t=0.00  invisible
 *   t=0.01  dot appears (tiny circle, half-transparent)
 *   t=0.30  dot fully formed (10px circle, opaque)
 *   t=0.38  pill begins (title starts fading in)
 *   t=0.70  pill fully formed (160×24 capsule, title visible)
 *   t=1.00  full card (fullWidth × fullHeight)
 *
 * Width/height = -1 means "resolve to fullWidth/fullHeight at runtime".
 */
export const MORPH_KEYFRAMES: readonly MorphKeyframe[] = [
	//  t      w     h    br   titleOp  fontSize  cardBlend  opacity
	{
		t: 0.0,
		width: 0,
		height: 0,
		borderRadius: 4,
		titleOpacity: 0,
		titleFontSize: 0,
		cardBlend: 0,
		opacity: 0,
	},
	{
		t: 0.01,
		width: 4,
		height: 4,
		borderRadius: 2,
		titleOpacity: 0,
		titleFontSize: 0,
		cardBlend: 0,
		opacity: 0.5,
	},
	{
		t: 0.3,
		width: 10,
		height: 10,
		borderRadius: 5,
		titleOpacity: 0,
		titleFontSize: 9,
		cardBlend: 0,
		opacity: 1,
	},
	{
		t: 0.38,
		width: 40,
		height: 14,
		borderRadius: 5,
		titleOpacity: 0,
		titleFontSize: 9,
		cardBlend: 0,
		opacity: 1,
	},
	{
		t: 0.5,
		width: 100,
		height: 20,
		borderRadius: 4,
		titleOpacity: 0.5,
		titleFontSize: 10,
		cardBlend: 1,
		opacity: 1,
	},
	{
		t: 0.7,
		width: 160,
		height: 24,
		borderRadius: 4,
		titleOpacity: 1,
		titleFontSize: 10,
		cardBlend: 1,
		opacity: 1,
	},
	{
		t: 1.0,
		width: -1,
		height: -1,
		borderRadius: 4,
		titleOpacity: 1,
		titleFontSize: 14,
		cardBlend: 1,
		opacity: 1,
	},
] as const;

/** Resolve a keyframe dimension value: -1 → fullSize, otherwise clamp to fullSize. */
function resolveDim(v: number, fullSize: number): number {
	return v === -1 ? fullSize : Math.min(v, fullSize);
}

/**
 * Linearly interpolate between two keyframes at progress `p` ∈ [0, 1].
 * Width/height sentinels (-1) are resolved against fullWidth/fullHeight before lerp.
 */
function lerpKf(a: MorphKeyframe, b: MorphKeyframe, p: number, fw: number, fh: number): MorphStyle {
	const aw = resolveDim(a.width, fw);
	const bw = resolveDim(b.width, fw);
	const ah = resolveDim(a.height, fh);
	const bh = resolveDim(b.height, fh);
	const w = aw + p * (bw - aw);
	const h = ah + p * (bh - ah);
	return {
		width: w,
		height: h,
		borderRadius: a.borderRadius + p * (b.borderRadius - a.borderRadius),
		titleOpacity: a.titleOpacity + p * (b.titleOpacity - a.titleOpacity),
		titleFontSize: a.titleFontSize + p * (b.titleFontSize - a.titleFontSize),
		cardBlend: a.cardBlend + p * (b.cardBlend - a.cardBlend),
		opacity: a.opacity + p * (b.opacity - a.opacity),
	};
}

// Pre-computed zero style — returned for t <= 0 without allocation.
const ZERO_STYLE: MorphStyle = {
	width: 0,
	height: 0,
	borderRadius: 4,
	titleOpacity: 0,
	titleFontSize: 0,
	cardBlend: 0,
	opacity: 0,
};

/**
 * Compute interpolated visual properties from morph factor `t`.
 * All values change continuously — no discrete jumps.
 *
 * Driven by `MORPH_KEYFRAMES`: finds the surrounding pair and lerps between them.
 */
export function getMorphStyle(t: number, fullWidth: number, fullHeight: number): MorphStyle {
	if (t <= 0) return ZERO_STYLE;

	const kf = MORPH_KEYFRAMES;
	// Clamp to table range
	const ct = Math.min(t, kf[kf.length - 1].t);

	// Find the surrounding keyframe pair (linear scan — table is small)
	for (let i = 0; i < kf.length - 1; i++) {
		if (ct <= kf[i + 1].t) {
			const a = kf[i];
			const b = kf[i + 1];
			const span = b.t - a.t;
			const p = span === 0 ? 1 : (ct - a.t) / span;
			return lerpKf(a, b, p, fullWidth, fullHeight);
		}
	}

	// t >= last keyframe — return final state
	const last = kf[kf.length - 1];
	return lerpKf(last, last, 0, fullWidth, fullHeight);
}
