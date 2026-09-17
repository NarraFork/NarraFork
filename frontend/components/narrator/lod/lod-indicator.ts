/**
 * lod-indicator.ts — pure decision logic for the render-LOD indicator.
 *
 * The indicator always looks and behaves the same way — a clickable gauge with
 * −/+ steppers — no matter what summoned it. Holding Alt over the message area
 * keeps it open; a gesture (alt+wheel / pinch) shows the same thing briefly and
 * lets it fade.
 *
 * The clickable form exists because alt+wheel is unusable on notched wheels and
 * unreachable on devices with no wheel at all: a click target does not depend on
 * how many detents a wheel reports.
 *
 * Kept DOM-free so the visibility/step decisions are unit-testable without a
 * React tree.
 */

import { MAX_RENDER_LOD, MIN_RENDER_LOD, type RenderLod } from "./RenderLodCtx";

/** Every selectable level, lowest detail first (matches the notch order). */
export const LOD_LEVELS: readonly RenderLod[] = [1, 2, 3, 4, 5];

/** Whether a keyboard event's key is the modifier that reveals the indicator. */
export function isAltKey(key: string): boolean {
	return key === "Alt";
}

export interface LodIndicatorVisibility {
	/** Whether the indicator should be on screen at all. */
	visible: boolean;
	/** Whether it should hold briefly and then fade itself out. */
	fades: boolean;
}

/**
 * Resolve whether the indicator is on screen and whether it auto-hides.
 *
 * There is deliberately only ONE appearance: the same gauge with the same −/+
 * steppers and the same clickable notches, whether it appeared because a gesture
 * changed the level or because Alt is being held. An indicator that changed shape
 * depending on how it was summoned read as two different widgets.
 *
 * Only longevity varies, and either input can hold it open:
 *   - `pinned` — Alt is down over this panel;
 *   - `hovered` — the pointer is inside the indicator itself. This one matters
 *     because picking a level is rarely a single click: after the first pick the
 *     pointer is still on the control, so auto-hiding there would yank the widget
 *     away mid-adjustment.
 *
 * `hovered` deliberately does NOT make it visible on its own — the pointer can
 * only be inside something already on screen, and letting hover imply visibility
 * would let a hover state that outlived its element keep an empty widget alive.
 */
export function resolveLodIndicatorVisibility({
	pinned,
	hovered,
	gestureVisible,
}: {
	pinned: boolean;
	hovered: boolean;
	gestureVisible: boolean;
}): LodIndicatorVisibility {
	return { visible: pinned || gestureVisible, fades: !pinned && !hovered };
}

/** The level a −/+ stepper would move to (clamped, so the ends are no-ops). */
export function resolveLodStepTarget(current: RenderLod, dir: 1 | -1): RenderLod {
	const next = current + dir;
	if (next < MIN_RENDER_LOD) return MIN_RENDER_LOD;
	if (next > MAX_RENDER_LOD) return MAX_RENDER_LOD;
	return next as RenderLod;
}

/** Whether a stepper is at its end and has nothing to do. */
export function isLodStepDisabled(current: RenderLod, dir: 1 | -1): boolean {
	return resolveLodStepTarget(current, dir) === current;
}

/** How many notches read as "filled" for a level (more detail = more filled). */
export function resolveLodFilledNotches(lod: RenderLod): number {
	return lod - MIN_RENDER_LOD + 1;
}
