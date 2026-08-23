/**
 * Per-instance branding: the instance name and icon accent colour.
 *
 * Exists because several NarraFork deployments are commonly open in one browser
 * (a work instance, a home instance, a test instance). When a window is not
 * focused — or the app is installed as a PWA — the tab title, the installed app
 * name and the icon are the ONLY things that distinguish them, and all three are
 * identical out of the box.
 *
 * Both fields are optional throughout. An unconfigured instance must keep working
 * exactly as before, so every entry point resolves absent/blank/invalid input to
 * the NarraFork defaults rather than erroring. That asymmetry is deliberate: the
 * settings WRITE path validates strictly (an admin who typed a bad colour should
 * be told), while every READ path is forgiving (a bad stored value must never
 * cost the instance its icon).
 *
 * Shared between server and frontend so the default colour has exactly one
 * definition — the frontend needs it to decide whether to request a recoloured
 * icon at all, and the server needs it to short-circuit recolouring.
 */

/** Name used when no instance name is configured. */
export const DEFAULT_BRAND_NAME = "NarraFork";

/** NarraFork indigo — the accent colour baked into the shipped icon assets. */
export const DEFAULT_BRAND_ICON_COLOR = "#4c6ef5";

/**
 * Maximum instance name length.
 *
 * Bounded by where the name has to FIT, not by storage: a browser tab title, a
 * PWA `short_name` (which launchers truncate aggressively) and a 60px-tall app
 * header. A longer name is not a data problem, it is an unreadable one.
 */
export const BRAND_NAME_MAX_LENGTH = 40;

/** Strict form accepted by the settings write path: `#rgb` or `#rrggbb`. */
export const BRAND_ICON_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export interface BrandingInput {
	name?: string;
	iconColor?: string;
}

export interface ResolvedBranding {
	/** Always non-empty — falls back to `DEFAULT_BRAND_NAME`. */
	name: string;
	/** Always a lowercase `#rrggbb` string. */
	iconColor: string;
	/**
	 * True when either field differs from the NarraFork default.
	 *
	 * Drives two things: whether to request recoloured icons from the server
	 * (skipping the request entirely for default installs), and whether to show
	 * the "powered by NarraFork" line under a renamed header.
	 */
	customized: boolean;
}

/**
 * Normalize an instance name for display.
 *
 * Strips control characters and collapses internal whitespace before measuring
 * length, so a name padded with tabs/newlines cannot smuggle in extra characters
 * or break the single-line header layout. A blank result means "not configured".
 */
export function normalizeBrandName(raw: string | undefined | null): string {
	if (typeof raw !== "string") return "";
	// Control characters are filtered by code point rather than by a character-class
	// regex: writing them as literals in a pattern trips Biome's
	// noControlCharactersInRegex, and an escape-based pattern here would be a lint
	// suppression on the one line whose whole job is to remove them.
	let stripped = "";
	for (const char of raw) {
		const code = char.codePointAt(0) ?? 0;
		stripped += code < 0x20 || code === 0x7f ? " " : char;
	}
	const cleaned = stripped.replace(/\s+/g, " ").trim();
	if (!cleaned) return "";
	return cleaned.slice(0, BRAND_NAME_MAX_LENGTH);
}

/**
 * Normalize an icon colour to lowercase `#rrggbb`, expanding the `#rgb` short
 * form. Anything unparseable yields an empty string, which callers treat as
 * "not configured" — see the module header on why this never throws.
 */
export function normalizeBrandIconColor(raw: string | undefined | null): string {
	if (typeof raw !== "string") return "";
	const trimmed = raw.trim().toLowerCase();
	if (!BRAND_ICON_COLOR_PATTERN.test(trimmed)) return "";
	if (trimmed.length === 4) {
		const [, r, g, b] = trimmed;
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	return trimmed;
}

/** Parse `#rgb`/`#rrggbb` into 8-bit RGB components, or null when unparseable. */
export function parseHexColor(hex: string): [number, number, number] | null {
	const normalized = normalizeBrandIconColor(hex);
	if (!normalized) return null;
	return [
		Number.parseInt(normalized.slice(1, 3), 16),
		Number.parseInt(normalized.slice(3, 5), 16),
		Number.parseInt(normalized.slice(5, 7), 16),
	];
}

/** Resolve stored (possibly absent or invalid) branding into displayable values. */
export function resolveBranding(input: BrandingInput | undefined | null): ResolvedBranding {
	const name = normalizeBrandName(input?.name) || DEFAULT_BRAND_NAME;
	const iconColor = normalizeBrandIconColor(input?.iconColor) || DEFAULT_BRAND_ICON_COLOR;
	return {
		name,
		iconColor,
		customized: name !== DEFAULT_BRAND_NAME || iconColor !== DEFAULT_BRAND_ICON_COLOR,
	};
}

/**
 * Recolour the brand SVG by substituting its single accent fill.
 *
 * The shipped `favicon.svg` paints the rounded square with one
 * `fill="#4c6ef5"`; everything else is white strokes and dots. So a literal
 * replacement is sufficient and — unlike the PNG path — needs no pixel work,
 * which is why the settings UI can preview a colour without a round trip.
 */
export function recolorBrandSvg(svg: string, iconColor: string): string {
	const target = normalizeBrandIconColor(iconColor) || DEFAULT_BRAND_ICON_COLOR;
	if (target === DEFAULT_BRAND_ICON_COLOR) return svg;
	return svg.replaceAll(DEFAULT_BRAND_ICON_COLOR, target);
}
