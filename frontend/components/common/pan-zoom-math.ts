/**
 * The pan/zoom gesture math shared by `PanZoomStage` (image viewer, diagrams) and the outline
 * mind map: zooming around a point so the pixel under it stays put, and one step of a two-finger
 * gesture that zooms around the fingers' midpoint and pans with it at the same time. Pure.
 *
 * A transform is `translate(tx, ty) scale(scale)` applied about an origin; `origin` is where that
 * origin sits on screen when `tx = ty = 0` (the stage's centre for `PanZoomStage`, its top-left
 * corner for the mind map), in the same coordinates as the points.
 */

export interface PanZoomTransform {
	scale: number;
	tx: number;
	ty: number;
}

export interface Point {
	x: number;
	y: number;
}

/** Wheel zoom per unit of `deltaY` (a mouse notch is about 100). */
export const WHEEL_ZOOM_STEP = 0.0015;

/** The zoom factor of a wheel event. */
export function wheelZoomFactor(deltaY: number, step = WHEEL_ZOOM_STEP): number {
	return Math.exp(-deltaY * step);
}

/** `t` zoomed to `nextScale` (already clamped) around `anchor`. */
export function zoomAround<T extends PanZoomTransform>(
	t: T,
	nextScale: number,
	anchor: Point,
	origin: Point,
): T {
	const ratio = nextScale / t.scale;
	const ox = origin.x + t.tx;
	const oy = origin.y + t.ty;
	return {
		...t,
		scale: nextScale,
		tx: t.tx + (anchor.x - ox) * (1 - ratio),
		ty: t.ty + (anchor.y - oy) * (1 - ratio),
	};
}

/**
 * One step of a two-finger gesture: zoom by `ratio` around the midpoint `mid` (clamped by
 * `clamp`) and pan by the midpoint's own movement `pan`, so what is under the fingers stays put.
 */
export function pinchStep<T extends PanZoomTransform>(
	t: T,
	ratio: number,
	mid: Point,
	pan: Point,
	origin: Point,
	clamp: (scale: number) => number,
): T {
	const next = zoomAround(t, clamp(t.scale * ratio), mid, origin);
	return { ...next, tx: next.tx + pan.x, ty: next.ty + pan.y };
}
