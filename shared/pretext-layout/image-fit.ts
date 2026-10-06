/**
 * image-fit.ts — Pure arithmetic for aspect-ratio image boxes (ZERO DOM).
 *
 * The vlist measure layer cannot ask the DOM (or an <img>) how tall an image
 * will paint, so an image's height must come from DATA: the intrinsic pixel
 * dimensions the server parsed at upload time and persisted with the message /
 * tool-call payload. Given those, the displayed box is a pure function of the
 * available column width — no measurement involved.
 *
 * Every consumer (chat image blocks, user-bubble attachments, tool-card media
 * caps) runs the SAME fit formula here, and the render layer paints the exact
 * numbers the measure layer reserved, so prediction and paint cannot drift.
 */

/** Intrinsic pixel size of an image, as persisted data. */
export interface ImageIntrinsicSize {
	width: number;
	height: number;
}

/** The box an image paints in, after fitting. */
export interface FittedImageBox {
	displayWidth: number;
	displayHeight: number;
}

/**
 * Coerce two unknown payload fields into a usable intrinsic size. Returns null
 * for anything missing or non-positive — callers fall back to the fixed
 * placeholder height in that case (old messages predate persisted dimensions).
 */
export function readImageIntrinsicSize(width: unknown, height: unknown): ImageIntrinsicSize | null {
	if (typeof width !== "number" || typeof height !== "number") return null;
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
	if (width <= 0 || height <= 0) return null;
	return { width, height };
}

/**
 * Fit an image into a `maxWidth` × `maxHeight` box, preserving aspect ratio.
 * Never upscales past the intrinsic size (a small icon stays small rather than
 * being blown up to the box).
 *
 * The CLAMPED dimension is the exact (floored) bound and the other is derived
 * as `floor(bound × other/this)` — deliberately NOT `floor(natural × scale)`:
 * `maxWidth / w × w` can land a hair under the integer in floating point
 * (975.999… → 975), which would shrink the box by a pixel the layout already
 * promised. Deriving from the exact bound keeps the reservation stable, and
 * since the derived dimension can only shrink, the box never exceeds either
 * bound. The ≤1px aspect error is absorbed by `object-fit: contain` at paint.
 */
export function fitImageBox(
	natural: ImageIntrinsicSize,
	maxWidth: number,
	maxHeight: number,
): FittedImageBox {
	// `Math.max(1, NaN)` is NaN, so a non-finite bound used to poison every
	// arithmetic path below and return NaN dimensions — which travel into
	// `PreparedFixedBlock.height` and make the whole frame NaN. A NaN width really
	// does arrive: an early render can pass an undetermined content width. Degrade
	// to the 1px floor instead, the same answer a zero/negative bound gets.
	const safeMaxWidth = Number.isFinite(maxWidth) ? Math.max(1, maxWidth) : 1;
	const safeMaxHeight = Number.isFinite(maxHeight) ? Math.max(1, maxHeight) : 1;
	if (natural.width <= safeMaxWidth && natural.height <= safeMaxHeight) {
		// Floored: `readImageIntrinsicSize` only checks "positive finite", so a
		// fractional intrinsic size (`width: 50.5`) would otherwise land in
		// `PreparedFixedBlock.height` and drift the layout by a sub-pixel — the exact
		// thing the integer rounding elsewhere in this function exists to prevent.
		return {
			displayWidth: Math.max(1, Math.floor(natural.width)),
			displayHeight: Math.max(1, Math.floor(natural.height)),
		};
	}
	const widthScale = safeMaxWidth / natural.width;
	const heightScale = safeMaxHeight / natural.height;
	if (widthScale <= heightScale) {
		const displayWidth = Math.max(1, Math.floor(safeMaxWidth));
		return {
			displayWidth,
			displayHeight: Math.max(1, Math.floor((displayWidth * natural.height) / natural.width)),
		};
	}
	const displayHeight = Math.max(1, Math.floor(safeMaxHeight));
	return {
		displayHeight,
		displayWidth: Math.max(1, Math.floor((displayHeight * natural.width) / natural.height)),
	};
}
