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
// Distance-aware LOD: each chapter's LOD depends on scale + distance from zoom center
// ---------------------------------------------------------------------------

export type CardMode = "hidden" | "dot" | "compact" | "full";

/**
 * Distance boost: chapters near the zoom center get a higher effective scale.
 * boost = 1.0 at maxDist, 1.5 at distance 0.
 */
function distanceBoost(
	chapterWorldX: number,
	zoomCenterWorldX: number,
	viewportWorldWidth: number,
): number {
	const dist = Math.abs(chapterWorldX - zoomCenterWorldX);
	const maxDist = viewportWorldWidth * 1.5;
	if (maxDist <= 0 || dist >= maxDist) return 1.0;
	const t = 1 - dist / maxDist;
	return 1.0 + t * 0.5;
}

/** Per-chapter card mode based on effective scale (global scale × distance boost). */
export function getCardModeForChapter(
	globalScale: number,
	chapterMainWorldPos: number,
	zoomCenterWorldX: number,
	viewportWorldWidth: number,
): CardMode {
	const boost = distanceBoost(chapterMainWorldPos, zoomCenterWorldX, viewportWorldWidth);
	const effectiveScale = globalScale * boost;
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
 *  - L0 (< 0.25): SegmentCanvas not rendered → morph invisible
 *  - L1 (0.25–0.6): dot phase (growing circle)
 *  - L2 (0.6–1.2): pill phase (circle → capsule with title)
 *  - L3+ (> 1.2): card phase (pill → full card)
 */
const MORPH_INVISIBLE = 0.25; // below: hidden (matches L0 boundary)
const MORPH_DOT = 0.45; // dot fully formed (mid-L1)
const MORPH_PILL = 0.9; // pill fully formed (mid-L2)
const MORPH_CARD = 1.2; // card fully formed (L3 boundary)

/**
 * Map effectiveScale to a continuous morph factor `t` in [0, 1].
 *  0.0       → invisible
 *  0.0–0.3   → dot (growing circle)
 *  0.3–0.7   → pill (circle → capsule with title)
 *  0.7–1.0   → card (pill → full card)
 */
export function getMorphFactor(
	globalScale: number,
	chapterMainWorldPos: number,
	zoomCenterWorldX: number,
	viewportWorldWidth: number,
): number {
	const boost = distanceBoost(chapterMainWorldPos, zoomCenterWorldX, viewportWorldWidth);
	const s = globalScale * boost;
	if (s <= MORPH_INVISIBLE) return 0;
	if (s >= MORPH_CARD) return 1;
	// Piecewise linear mapping:
	// [MORPH_INVISIBLE, MORPH_DOT]  → [0, 0.3]
	// [MORPH_DOT, MORPH_PILL]       → [0.3, 0.7]
	// [MORPH_PILL, MORPH_CARD]      → [0.7, 1.0]
	if (s < MORPH_DOT) {
		return 0.3 * ((s - MORPH_INVISIBLE) / (MORPH_DOT - MORPH_INVISIBLE));
	}
	if (s < MORPH_PILL) {
		return 0.3 + 0.4 * ((s - MORPH_DOT) / (MORPH_PILL - MORPH_DOT));
	}
	return 0.7 + 0.3 * ((s - MORPH_PILL) / (MORPH_CARD - MORPH_PILL));
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
	/** Whether to show the full card body (status badges, narrator info, etc.) */
	showCardBody: boolean;
	/** Overall element opacity */
	opacity: number;
}

/**
 * Compute interpolated visual properties from morph factor `t`.
 * All values change continuously — no discrete jumps.
 */
export function getMorphStyle(t: number, fullWidth: number, fullHeight: number): MorphStyle {
	if (t <= 0) {
		return {
			width: 0,
			height: 0,
			borderRadius: 4,
			titleOpacity: 0,
			titleFontSize: 0,
			showCardBody: false,
			opacity: 0,
		};
	}

	// --- Dot phase: t ∈ (0, 0.3] ---
	// Circle grows from 4px to 10px
	if (t <= 0.3) {
		const p = t / 0.3; // 0→1 within dot phase
		const size = 4 + p * 6; // 4→10
		return {
			width: size,
			height: size,
			borderRadius: size / 2,
			titleOpacity: 0,
			titleFontSize: 0,
			showCardBody: false,
			opacity: 0.5 + p * 0.5, // 0.5→1.0
		};
	}

	// --- Pill phase: t ∈ (0.3, 0.7] ---
	// Width: 10 → fullWidth, Height: 10 → 24, borderRadius: 5 → 4
	// Title fades in
	if (t <= 0.7) {
		const p = (t - 0.3) / 0.4; // 0→1 within pill phase
		const w = 10 + p * (Math.min(fullWidth, 160) - 10);
		const h = 10 + p * 14; // 10→24
		return {
			width: w,
			height: h,
			borderRadius: 5 - p * 1, // 5→4
			titleOpacity: Math.max(0, (p - 0.2) / 0.8), // starts at p=0.2, full at p=1
			titleFontSize: 9 + p * 1, // 9→10
			showCardBody: false,
			opacity: 1,
		};
	}

	// --- Card phase: t ∈ (0.7, 1.0] ---
	// Width: pill-max → fullWidth, Height: 24 → fullHeight
	// Card body fades in
	const p = (t - 0.7) / 0.3; // 0→1 within card phase
	const pillMaxW = Math.min(fullWidth, 160);
	return {
		width: pillMaxW + p * (fullWidth - pillMaxW),
		height: 24 + p * (fullHeight - 24),
		borderRadius: 4,
		titleOpacity: 1,
		titleFontSize: 10 + p * 4, // 10→14
		showCardBody: p > 0.3,
		opacity: 1,
	};
}
