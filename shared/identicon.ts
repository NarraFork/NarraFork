/**
 * identicon.ts — deterministic per-narrator avatar glyph, zero storage, zero deps.
 *
 * A narrator (primary or subagent) gets a stable visual identity derived purely from
 * its id: a 5×5 mirrored grid (GitHub-style identicon) plus one palette colour. The
 * same id always yields the same glyph, so two subagents named "explore-1" and
 * "explore-2" — whose initials would collide — are told apart at a glance.
 *
 * Why not initials: subagent titles cluster on a few prefixes (explore/plan/review),
 * so the first two characters are nearly useless as a discriminator. A geometric
 * pattern keyed on the full id has far more distinguishable surface.
 *
 * Pure and synchronous: no canvas, no RNG state, no storage. The component renders
 * the returned cells as an inline SVG (or a data URI) at whatever size it needs.
 */

/** Grid is 5 columns × 5 rows; only the left 3 columns are hashed, then mirrored. */
export const IDENTICON_COLS = 5;
export const IDENTICON_ROWS = 5;
/** Columns actually derived from the hash before mirroring (cols 3,4 mirror 1,0). */
const HALF_COLS = 3;

/**
 * A perceptually spaced hue wheel is more useful than the Mantine 12 here: hue is one
 * continuous degree of freedom the hash can sweep, so near ids still land on distinct
 * colours. Saturation/lightness are pinned for dark+light theme legibility.
 */
const SATURATION = 65;
const LIGHTNESS = 50;

export interface Identicon {
	/** Row-major 5×5 booleans: true = filled with the foreground colour. */
	cells: boolean[];
	/** Foreground colour as an HSL triple, ready for `hsl(h s% l%)`. */
	hue: number;
	saturation: number;
	lightness: number;
}

/**
 * FNV-1a 32-bit — tiny, deterministic, good enough avalanche for id strings, and
 * dependency-free. We only need ~16 bits of entropy (15 cells + hue), so one 32-bit
 * hash is plenty; a second salted round decorrelates hue from the cell pattern.
 */
function fnv1a(input: string, seed: number): number {
	let h = seed >>> 0;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/**
 * Derive the identicon for a narrator id.
 *
 * Deterministic: identical input → identical output, forever. The grid is mirrored
 * horizontally, which is what makes the pattern read as a glyph rather than noise.
 */
export function identiconFromId(id: string): Identicon {
	const cellsHash = fnv1a(id, 0x811c9dc5);
	const hueHash = fnv1a(id, 0x811c9dc5 ^ 0x9e3779b9);

	const cells: boolean[] = new Array(IDENTICON_COLS * IDENTICON_ROWS).fill(false);
	let bit = 0;
	for (let row = 0; row < IDENTICON_ROWS; row++) {
		for (let col = 0; col < HALF_COLS; col++) {
			// Take one bit per left-half cell; 15 bits of the 32 are plenty.
			const filled = ((cellsHash >>> bit) & 1) === 1;
			bit++;
			const mirrorCol = IDENTICON_COLS - 1 - col;
			cells[row * IDENTICON_COLS + col] = filled;
			cells[row * IDENTICON_COLS + mirrorCol] = filled;
		}
	}

	// Guarantee the glyph is never blank (a 0-cell hash would paint an empty square,
	// which reads as a broken image rather than an identity).
	const anyFilled = cells.some(Boolean);
	if (!anyFilled) {
		// Light the centre column's middle cell — symmetric, so the mirror is itself.
		cells[2 * IDENTICON_COLS + 2] = true;
	}

	return {
		cells,
		hue: hueHash % 360,
		saturation: SATURATION,
		lightness: LIGHTNESS,
	};
}

/** Serialize to a compact SVG string (crisp edges, viewBox units = cells). */
export function identiconToSvg(icon: Identicon): string {
	const fg = `hsl(${icon.hue} ${icon.saturation}% ${icon.lightness}%)`;
	const rects: string[] = [];
	for (let row = 0; row < IDENTICON_ROWS; row++) {
		for (let col = 0; col < IDENTICON_COLS; col++) {
			if (icon.cells[row * IDENTICON_COLS + col]) {
				rects.push(`<rect x="${col}" y="${row}" width="1" height="1"/>`);
			}
		}
	}
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${IDENTICON_COLS} ${IDENTICON_ROWS}" ` +
		`shape-rendering="crispEdges"><g fill="${fg}">${rects.join("")}</g></svg>`
	);
}

/** Serialize to an SVG data URI for use as an <img>/Avatar src. Cached-safe: pure. */
export function identiconDataUri(id: string): string {
	const svg = identiconToSvg(identiconFromId(id));
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
