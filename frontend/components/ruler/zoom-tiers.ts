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

/** Returns opacity (0–1) for cross-fade transitions between tiers.
 *  When progress > fadeInAt, next tier elements start fading in.
 *  When progress < fadeOutAt, current tier elements start fading out. */
export function getTransitionOpacity(progress: number, fadeInAt = 0.7, fadeOutAt = 0.3): number {
	if (progress > fadeInAt) {
		return (progress - fadeInAt) / (1 - fadeInAt);
	}
	if (progress < fadeOutAt) {
		return progress / fadeOutAt;
	}
	return 1;
}
