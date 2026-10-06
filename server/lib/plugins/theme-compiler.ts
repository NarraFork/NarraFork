/**
 * Plugin theme compiler.
 *
 * Turns validated, whitelisted theme design tokens into scoped CSS rules that
 * override Mantine CSS variables — plus optional region backgrounds and
 * nine-slice frames — under a `[data-plugin-theme="<pluginId>__<themeId>"]`
 * selector. The output is meant
 * to be injected into the *host document* stylesheet, so this module is a hard
 * security boundary: every value is re-asserted here (defense in depth) and any
 * token that fails is silently dropped rather than emitted. Plugins never
 * supply raw CSS — only tokens — so there is no selector, `url()`, `@import`,
 * or expression surface to smuggle through.
 *
 * Performance: shade generation and string building run once at catalog-refresh
 * time and the result is cached. Nothing here runs on a render or theme-switch
 * path.
 */

import {
	THEME_BACKGROUND_REGIONS,
	THEME_BORDER_SURFACES,
	THEME_FONT_FAMILIES,
	THEME_FRAME_TARGETS,
	THEME_GRADIENT_SURFACES,
	THEME_TEXT_SURFACES,
	type ThemeContribution,
	type ThemeFontFace,
	type ThemeFontReference,
	type ThemeFontValue,
	type ThemeTokens,
} from "./manifest";

/**
 * Hard cap on a single compiled theme's CSS text (UTF-8 bytes ≈ chars here).
 *
 * Sized from a measured worst case rather than a guess: every one of the ~29
 * surfaces carrying a gradient, a background image, a nine-slice frame, a text
 * color and a border, with long asset paths, tripled across the shared base plus
 * a light and a dark variant. That measures ~124 KB, so 192 KB leaves room for a
 * surface list that grows again without silently dropping themes.
 *
 * The cap still matters — it bounds what one plugin can inject into the host
 * stylesheet — but it is deliberately generous, because exceeding it drops the
 * *whole* theme rather than emitting a truncated stylesheet, and a half-styled app
 * is worse than a large one. The CSS is built once at catalog-refresh time and
 * cached, so size costs a one-time string build and a document `<style>` payload,
 * not per-render work.
 */
export const MAX_COMPILED_THEME_CSS_LENGTH = 196_608;

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_COLOR_PATTERN =
	/^rgba?\(\s*\d{1,3}\s*[, ]\s*\d{1,3}\s*[, ]\s*\d{1,3}\s*(?:[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/;
const DIMENSION_PATTERN = /^(\d{1,4}(?:\.\d{1,3})?)(px|rem|em)$/;
const COLOR_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Range clamps for box-model token families (magnitude in the given unit). */
const DIMENSION_BOUNDS: Record<"spacing" | "fontSize" | "radius", { min: number; max: number }> = {
	spacing: { min: 0.25, max: 64 },
	fontSize: { min: 8, max: 32 },
	radius: { min: 0, max: 32 },
};

/** Relative scale ladder applied to a base dimension for xs..xl variables. */
const SIZE_LADDER: Array<{ key: string; factor: number }> = [
	{ key: "xs", factor: 0.6 },
	{ key: "sm", factor: 0.8 },
	{ key: "md", factor: 1 },
	{ key: "lg", factor: 1.3 },
	{ key: "xl", factor: 1.6 },
];

/** Re-assert a color value at compile time (defense in depth). */
function isSafeColor(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length <= 64 &&
		(HEX_COLOR_PATTERN.test(value) || RGB_COLOR_PATTERN.test(value))
	);
}

/** Parse + clamp a box-model dimension; returns null when out of policy. */
function parseDimension(
	value: string,
	family: "spacing" | "fontSize" | "radius",
): { magnitude: number; unit: string } | null {
	if (typeof value !== "string" || value.length > 16) return null;
	const match = DIMENSION_PATTERN.exec(value);
	if (!match) return null;
	const magnitude = Number(match[1]);
	const unit = match[2];
	if (!Number.isFinite(magnitude)) return null;
	// Bounds are expressed in px terms; for rem/em treat 1 unit ≈ 16px.
	const px = unit === "px" ? magnitude : magnitude * 16;
	const bounds = DIMENSION_BOUNDS[family];
	if (px < bounds.min || px > bounds.max) return null;
	return { magnitude, unit };
}

/**
 * Expand a #hex/rgb() base color into a 10-shade Mantine-style scale using HSL
 * lightness interpolation. Zero dependencies. Index 6 is kept close to the
 * supplied base (Mantine's canonical "filled" shade). Shades run light→dark.
 */
export function generateShades(baseColor: string): string[] {
	const rgb = colorToRgb(baseColor);
	if (!rgb) {
		// Should never happen (caller validates), but fail safe to a flat scale.
		return Array.from({ length: 10 }, () => baseColor);
	}
	const { h, s } = rgbToHsl(rgb.r, rgb.g, rgb.b);
	// Target lightness per shade (0 = lightest tint … 9 = darkest shade).
	const lightness = [0.96, 0.9, 0.8, 0.68, 0.56, 0.46, 0.42, 0.36, 0.29, 0.22];
	return lightness.map((l) => {
		// Reduce saturation for the very light tints so they don't look neon.
		const shadeSat = l > 0.85 ? Math.min(s, 0.6) : s;
		const { r, g, b } = hslToRgb(h, shadeSat, l);
		return rgbToHex(r, g, b);
	});
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

function colorToRgb(value: string): Rgb | null {
	if (HEX_COLOR_PATTERN.test(value)) {
		let hex = value.slice(1);
		if (hex.length === 3 || hex.length === 4) {
			hex = hex
				.slice(0, 3)
				.split("")
				.map((c) => c + c)
				.join("");
		} else {
			hex = hex.slice(0, 6);
		}
		const int = Number.parseInt(hex, 16);
		if (Number.isNaN(int)) return null;
		return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
	}
	if (RGB_COLOR_PATTERN.test(value)) {
		const nums = value.match(/\d{1,3}/g);
		if (!nums || nums.length < 3) return null;
		const [r, g, b] = nums.map((n) => Math.min(255, Number(n)));
		return { r, g, b };
	}
	return null;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	const d = max - min;
	if (d !== 0) {
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case rn:
				h = (gn - bn) / d + (gn < bn ? 6 : 0);
				break;
			case gn:
				h = (bn - rn) / d + 2;
				break;
			default:
				h = (rn - gn) / d + 4;
				break;
		}
		h /= 6;
	}
	return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
	if (s === 0) {
		const v = Math.round(l * 255);
		return { r: v, g: v, b: v };
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const hue = (t: number): number => {
		let tt = t;
		if (tt < 0) tt += 1;
		if (tt > 1) tt -= 1;
		if (tt < 1 / 6) return p + (q - p) * 6 * tt;
		if (tt < 1 / 2) return q;
		if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
		return p;
	};
	return {
		r: Math.round(hue(h + 1 / 3) * 255),
		g: Math.round(hue(h) * 255),
		b: Math.round(hue(h - 1 / 3) * 255),
	};
}

function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Resolve a color entry (single base or full scale) into a 10-shade scale. */
function resolveScale(entry: string | string[]): string[] | null {
	if (typeof entry === "string") {
		if (!isSafeColor(entry)) return null;
		return generateShades(entry);
	}
	if (Array.isArray(entry) && entry.length === 10 && entry.every(isSafeColor)) {
		return entry;
	}
	return null;
}

/** The primary color name emitted when a theme sets `primaryColor`. */
const PRIMARY_COLOR_NAME = "primary";

/** A validated background for one region. */
interface RegionBackground {
	image: string;
	size?: "cover" | "contain" | "auto";
	position?: "center" | "top" | "bottom" | "left" | "right";
	repeat?: "no-repeat" | "repeat";
	overlay?: "none" | "scrim-light" | "scrim-dark";
	opacity?: number;
}

/** A validated nine-slice frame for one target. */
interface TargetFrame {
	image: string;
	slice: number;
	width?: number;
	repeat?: "stretch" | "repeat" | "round" | "space";
	fill?: boolean;
}

/** A validated border + corner spec for one surface. */
interface SurfaceBorder {
	width?: number;
	style?: "solid" | "dashed" | "dotted" | "double" | "none";
	color?: string;
	inset?: boolean;
	radius?: number;
	radiusTopLeft?: number;
	radiusTopRight?: number;
	radiusBottomRight?: number;
	radiusBottomLeft?: number;
	edges?: Array<"top" | "right" | "bottom" | "left">;
}

/** A validated structured gradient for one surface. */
interface SurfaceGradient {
	from: string;
	to: string;
	via?: string;
	viaAt?: number;
	angle?: number;
}

/** The subset of ThemeTokens fields that form one color-scheme's token set. */
interface SchemeTokens {
	primaryColor?: string;
	body?: string;
	text?: string;
	colors?: Record<string, string | string[]>;
	spacing?: string;
	fontSize?: string;
	radius?: string;
	backgrounds?: Record<string, RegionBackground>;
	frames?: Record<string, TargetFrame>;
	gradients?: Record<string, SurfaceGradient>;
	textColors?: Record<string, string>;
	borders?: Record<string, SurfaceBorder>;
	fontFamily?: ThemeFontValue;
	fontFamilyHeadings?: ThemeFontValue;
	fontFamilyMonospace?: ThemeFontValue;
	shadow?: number;
}

/** Identifies the exact package so background image URLs can be built. */
export interface ThemeAssetContext {
	version: string;
	hash: string;
}

interface CompiledThemeFonts {
	css: string;
	families: ReadonlyMap<string, string>;
}

function isThemeFontReference(value: ThemeFontValue): value is ThemeFontReference {
	return typeof value === "object" && value !== null;
}

function themeFontFamilyName(themeId: string, fontId: string, hash: string): string | null {
	if (!/^[a-f0-9]{64}$/.test(hash)) return null;
	if (!/^[A-Za-z0-9._-]+$/.test(themeId) || !/^[A-Za-z0-9._-]+$/.test(fontId)) return null;
	return `nf-theme-${hash.slice(0, 16)}-${themeId}-${fontId}`;
}

function compileThemeFonts(
	fonts: readonly ThemeFontFace[],
	pluginId: string,
	themeId: string,
	assetContext: ThemeAssetContext | undefined,
): CompiledThemeFonts | null {
	if (fonts.length === 0) return { css: "", families: new Map() };
	if (!assetContext || fonts.length > 4) return null;
	const families = new Map<string, string>();
	const rules: string[] = [];
	for (const font of fonts) {
		if (families.has(font.id) || !font.source.toLowerCase().endsWith(".woff2")) return null;
		if (
			font.weight.min < 100 ||
			font.weight.max > 900 ||
			font.weight.min > font.weight.max ||
			!Number.isInteger(font.weight.min) ||
			!Number.isInteger(font.weight.max)
		) {
			return null;
		}
		if (font.style !== "normal" && font.style !== "italic") return null;
		if (font.display !== "swap" && font.display !== "fallback" && font.display !== "optional") {
			return null;
		}
		const url = themeAssetUrl(pluginId, assetContext, font.source);
		const family = themeFontFamilyName(themeId, font.id, assetContext.hash);
		if (!url || !family) return null;
		families.set(font.id, `"${family}"`);
		rules.push(
			`@font-face{font-family:"${family}";src:url("${url}") format("woff2");font-style:${font.style};font-weight:${font.weight.min} ${font.weight.max};font-display:${font.display};}`,
		);
	}
	return { css: rules.join(""), families };
}

function resolveFontFamily(
	value: ThemeFontValue | undefined,
	families: ReadonlyMap<string, string>,
): string | null {
	if (!value) return null;
	if (typeof value === "string") return FONT_FAMILIES.has(value) ? value : null;
	if (!isThemeFontReference(value) || !FONT_FAMILIES.has(value.fallback)) return null;
	const family = families.get(value.font);
	return family ? `${family}, ${value.fallback}` : null;
}

/**
 * The single canonical map from a whitelisted surface name to the descendant
 * selector (relative to the theme scope selector) it paints. `body` targets the
 * theme scope root itself; every other name targets a stable host class. Never an
 * arbitrary selector.
 *
 * Backgrounds, gradients, frames and text colors all resolve through this one
 * table, so a name can never mean different elements to different token groups.
 * Each group then restricts itself to the subset of names it accepts.
 *
 * Mantine renders these static classes whenever `withStaticClasses` is on (the
 * host default). `Card` renders a `Paper` internally, so `paper` also matches
 * cards — hence the pinned emission order below.
 */
const SURFACE_TARGET: Record<string, string> = {
	body: "",
	app: " .nf-app-shell",
	main: " .nf-app-shell-main",
	navbar: " .mantine-AppShell-navbar",
	header: " .mantine-AppShell-header",
	footer: " .mantine-AppShell-footer",
	paper: " .mantine-Paper-root",
	card: " .mantine-Card-root",
	modal: " .mantine-Modal-content",
	input: " .mantine-Input-input",
	inputFocus: " .mantine-Input-input:focus",
	// Sidebar navigation. `navLinkActive` uses Mantine's own active data attribute
	// rather than a class, which is how the host marks the current route.
	navLink: " .mantine-NavLink-root",
	navLinkHover: " .mantine-NavLink-root:hover",
	navLinkActive: " .mantine-NavLink-root[data-active]",
	divider: " .mantine-Divider-root",
	// Content chrome: inline/blocked code, tables, badges, menus, tooltips.
	code: " .mantine-Code-root",
	table: " .mantine-Table-table",
	tableHeader: " .mantine-Table-th",
	badge: " .mantine-Badge-root",
	menu: " .mantine-Menu-dropdown",
	menuItem: " .mantine-Menu-item",
	menuItemHover: " .mantine-Menu-item:hover",
	tooltip: " .mantine-Tooltip-tooltip",
	// Scrollbars. Mantine's ScrollArea renders real elements (not the WebKit
	// pseudo-elements), so these are ordinary class targets.
	scrollbar: " .mantine-ScrollArea-scrollbar",
	scrollbarThumb: " .mantine-ScrollArea-thumb",
	actionIcon: " .mantine-ActionIcon-root",
	actionIconHover: " .mantine-ActionIcon-root:hover:not(:disabled):not([data-disabled])",
	button: " .mantine-Button-root",
	buttonHover: " .mantine-Button-root:hover:not(:disabled):not([data-disabled])",
	buttonActive: " .mantine-Button-root:active:not(:disabled):not([data-disabled])",
};

/**
 * Pinned emission order for every per-surface rule group.
 *
 * CSS has no specificity tiebreak between `.mantine-Paper-root` and
 * `.mantine-Card-root` on the same element (a Card *is* a Paper), and
 * `buttonHover` must come after `button` to win. Source order decides, so it is
 * pinned here instead of relying on object key order from a manifest.
 */
const SURFACE_ORDER = [
	// Broadest containers first.
	"body",
	"app",
	"main",
	"paper",
	"card",
	"modal",
	"navbar",
	"header",
	"footer",
	// Content chrome.
	"divider",
	"code",
	"table",
	"tableHeader",
	"badge",
	"menu",
	"tooltip",
	"scrollbar",
	"scrollbarThumb",
	// Interactive elements, each immediately followed by its states so the state
	// rule always wins on source order.
	"navLink",
	"navLinkHover",
	"navLinkActive",
	"menuItem",
	"menuItemHover",
	"input",
	"inputFocus",
	"actionIcon",
	"actionIconHover",
	"button",
	"buttonHover",
	"buttonActive",
] as const;

/** Enum whitelists — any value outside these is dropped (defense in depth). */
const BG_SIZE = new Set(["cover", "contain", "auto"]);
const BG_POSITION = new Set(["center", "top", "bottom", "left", "right"]);
const BG_REPEAT = new Set(["no-repeat", "repeat"]);
const BG_OVERLAY = new Set(["none", "scrim-light", "scrim-dark"]);
const FRAME_REPEAT = new Set(["stretch", "repeat", "round", "space"]);
const BORDER_STYLES = new Set(["solid", "dashed", "dotted", "double", "none"]);
const BORDER_EDGES = new Set(["top", "right", "bottom", "left"]);
/** Fixed edge emission order, so output is deterministic regardless of input order. */
const BORDER_EDGE_ORDER = ["top", "right", "bottom", "left"] as const;
const FONT_FAMILIES: ReadonlySet<string> = new Set<string>(THEME_FONT_FAMILIES);
/** Bounds re-asserted at compile time; mirror the manifest schema. */
const FRAME_MIN_SLICE = 1;
const FRAME_MAX_SLICE = 64;
const SHADOW_MIN = 0;
const SHADOW_MAX = 48;
/** Disallowed characters in an asset path (backslash, query/fragment, colon). */
const UNSAFE_ASSET_CHARS = new Set(["\\", "?", "#", ":"]);

/**
 * Whether a package-relative asset path is safe: no control chars, no backslash /
 * query / fragment / colon, no absolute path, no `.`/`..` traversal segment.
 * Defense-in-depth on top of the manifest's `manifestPathSchema`.
 */
function isSafeAssetPath(imagePath: string): boolean {
	if (imagePath.length === 0 || imagePath.startsWith("/")) return false;
	for (const ch of imagePath) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
		if (UNSAFE_ASSET_CHARS.has(ch)) return false;
	}
	return !imagePath.split("/").some((seg) => seg === "." || seg === "..");
}

/** Build the same-origin theme-asset URL for a package-relative image path. */
function themeAssetUrl(pluginId: string, ctx: ThemeAssetContext, imagePath: string): string | null {
	// Re-assert path safety at compile time; reject traversal / absolute / scheme.
	if (!isSafeAssetPath(imagePath)) return null;
	if (!/^[a-f0-9]{64}$/.test(ctx.hash)) return null;
	const encodedPath = imagePath.split("/").map(encodeURIComponent).join("/");
	return `/api/plugins/ui/${encodeURIComponent(pluginId)}/${encodeURIComponent(ctx.version)}/${ctx.hash}/theme-asset/${encodedPath}`;
}

/**
 * The scrim gradient for an overlay tone, layered above the image to keep text
 * readable. The scrim is a flat wash of the theme's body color; `strength`
 * (0..1) controls its alpha. Higher strength = more muted background.
 */
function overlayLayer(overlay: string | undefined, strength: number): string | null {
	if (overlay !== "scrim-light" && overlay !== "scrim-dark") return null;
	const pct = Math.round(strength * 100);
	const wash = `color-mix(in srgb, var(--mantine-color-body) ${pct}%, transparent)`;
	return `linear-gradient(${wash}, ${wash})`;
}

/**
 * Assemble a `linear-gradient()` from structured stops.
 *
 * Every component is re-validated here (defense in depth): colors must pass
 * `isSafeColor`, the angle and middle-stop position must be integers in range.
 * The plugin never supplies gradient *syntax*, only these values, so there is no
 * way to smuggle a second declaration or an extra function call through.
 */
function gradientValue(gradient: SurfaceGradient): string | null {
	if (!isSafeColor(gradient.from) || !isSafeColor(gradient.to)) return null;
	const angle =
		typeof gradient.angle === "number" &&
		Number.isInteger(gradient.angle) &&
		gradient.angle >= 0 &&
		gradient.angle <= 360
			? gradient.angle
			: 180;
	const stops: string[] = [`${gradient.from} 0%`];
	if (gradient.via !== undefined) {
		if (!isSafeColor(gradient.via)) return null;
		const at =
			typeof gradient.viaAt === "number" &&
			Number.isInteger(gradient.viaAt) &&
			gradient.viaAt >= 0 &&
			gradient.viaAt <= 100
				? gradient.viaAt
				: 50;
		stops.push(`${gradient.via} ${at}%`);
	}
	stops.push(`${gradient.to} 100%`);
	return `linear-gradient(${angle}deg, ${stops.join(", ")})`;
}

/**
 * Build the per-surface paint rules: gradients and region background images
 * composed into a single `background-image` layer stack.
 *
 * They must be built together because CSS gives them one property. Emitting them
 * from separate passes would make the later rule silently erase the earlier one,
 * so a theme declaring both a gradient and an image on the same surface would
 * lose one at random depending on key order.
 *
 * Layer order is top-most first, matching CSS: scrim (readability wash) sits
 * above the image, and the gradient sits *below* the image so a photo stays
 * visible while the gradient shows through its transparent areas and acts as the
 * base wash. Only emitting `background-image` (never the `background` shorthand)
 * is what lets a gradient land on Mantine controls whose own rule uses the
 * shorthand: the scope selector is more specific, so it overrides the shorthand's
 * implicit `background-image: none` while leaving `background-color` intact.
 */
function buildSurfacePaintRules(
	backgrounds: Record<string, RegionBackground> | undefined,
	gradients: Record<string, SurfaceGradient> | undefined,
	scopeSelector: string,
	pluginId: string,
	ctx: ThemeAssetContext | undefined,
): string {
	if (!backgrounds && !gradients) return "";
	let out = "";
	for (const surface of SURFACE_ORDER) {
		const target = SURFACE_TARGET[surface];
		if (target === undefined) continue; // not a whitelisted surface

		// Region backgrounds accept only the region subset, and need an asset
		// context to build the same-origin URL.
		const bg = backgrounds?.[surface];
		const bgIsRegion = bg !== undefined && THEME_BACKGROUND_REGIONS.includes(surface as never);
		const url =
			bgIsRegion && ctx && typeof bg.image === "string"
				? themeAssetUrl(pluginId, ctx, bg.image)
				: null;

		// Gradients accept the wider surface set (including interactive controls).
		const gradientToken = gradients?.[surface];
		const gradientIsAllowed =
			gradientToken !== undefined && THEME_GRADIENT_SURFACES.includes(surface as never);
		const gradient = gradientIsAllowed ? gradientValue(gradientToken) : null;

		if (!url && !gradient) continue;

		const layers: string[] = [];
		const decls: string[] = [];

		if (url) {
			const overlay = bg?.overlay && BG_OVERLAY.has(bg.overlay) ? bg.overlay : "none";
			// `opacity` (0..1) is the scrim strength: how much the body color mutes
			// the image for readability. Defaults to a moderate wash when set.
			const strength =
				typeof bg?.opacity === "number" && bg.opacity >= 0 && bg.opacity <= 1
					? Math.round(bg.opacity * 100) / 100
					: 0.6;
			const scrim = overlayLayer(overlay, strength);
			if (scrim) layers.push(scrim);
			layers.push(`url("${url}")`);
		}
		if (gradient) layers.push(gradient);

		decls.push(`background-image: ${layers.join(", ")};`);

		if (url) {
			const size = bg?.size && BG_SIZE.has(bg.size) ? bg.size : "cover";
			const position = bg?.position && BG_POSITION.has(bg.position) ? bg.position : "center";
			const repeat = bg?.repeat && BG_REPEAT.has(bg.repeat) ? bg.repeat : "no-repeat";
			// Per-layer values, in the same order as the layer list. The gradient (and
			// the scrim) always cover the box; only the image honors the declared
			// sizing, so its slot has to line up with its position in the stack.
			const sizes = layers.map((layer) => (layer.startsWith('url("') ? size : "cover"));
			const positions = layers.map((layer) => (layer.startsWith('url("') ? position : "center"));
			const repeats = layers.map((layer) => (layer.startsWith('url("') ? repeat : "no-repeat"));
			decls.push(`background-size: ${sizes.join(", ")};`);
			decls.push(`background-position: ${positions.join(", ")};`);
			decls.push(`background-repeat: ${repeats.join(", ")};`);
		} else {
			decls.push("background-size: cover;");
			decls.push("background-repeat: no-repeat;");
		}

		out += `${scopeSelector}${target} {\n\t${decls.join("\n\t")}\n}\n`;
	}
	return out;
}

/**
 * Build per-surface text-color rules. Global `text` cannot express "white text on
 * a dark title bar", which every chrome-style theme needs.
 *
 * `color` is emitted with the host's own variable also reassigned, because many
 * Mantine descendants read `--mantine-color-text` rather than inheriting `color`.
 */
function buildTextColorRules(
	textColors: Record<string, string> | undefined,
	scopeSelector: string,
): string {
	if (!textColors) return "";
	let out = "";
	for (const surface of SURFACE_ORDER) {
		const value = textColors[surface];
		if (value === undefined) continue;
		if (!THEME_TEXT_SURFACES.includes(surface as never)) continue;
		if (!isSafeColor(value)) continue;
		const target = SURFACE_TARGET[surface];
		if (target === undefined || target === "") continue;
		out += `${scopeSelector}${target} {\n\tcolor: ${value};\n\t--mantine-color-text: ${value};\n}\n`;
	}
	return out;
}

/** Re-assert a clamped integer; returns null when out of policy. */
function clampedInt(value: unknown, min: number, max: number): number | null {
	if (typeof value !== "number" || !Number.isInteger(value)) return null;
	if (value < min || value > max) return null;
	return value;
}

/**
 * Build per-surface border and corner-radius rules.
 *
 * This is the one token group that may affect layout, and that is a deliberate
 * trade. Recreating real application chrome needs genuine hairline rules and
 * per-corner radii — a tab strip, a grouped-list header, a sunken code panel — and
 * none of that is expressible with repaint-only tokens. Themes that want to stay
 * layout-neutral set `inset: true`, which emits the stroke as an inset
 * `box-shadow` ring: it paints inside the element, respects the corner radius, and
 * measured identically to no border at all in a real browser.
 *
 * Bounded regardless of path: widths clamp to 8px, radii to 48px, the style is an
 * enum and the color goes through `isSafeColor`.
 */
function buildBorderRules(
	borders: Record<string, SurfaceBorder> | undefined,
	scopeSelector: string,
): string {
	if (!borders) return "";
	let out = "";
	for (const surface of SURFACE_ORDER) {
		const border = borders[surface];
		if (!border) continue;
		if (!THEME_BORDER_SURFACES.includes(surface as never)) continue;
		const target = SURFACE_TARGET[surface];
		if (target === undefined) continue;

		const decls: string[] = [];
		const width = clampedInt(border.width, 0, 8);
		const style = border.style && BORDER_STYLES.has(border.style) ? border.style : "solid";
		const color = border.color && isSafeColor(border.color) ? border.color : null;

		// `box-shadow` can only draw a solid ring. Honoring `inset` for a patterned
		// style would silently turn a declared `dashed` into a solid line, so a
		// patterned stroke falls back to a real border instead of quietly lying.
		const insetCapable = border.inset === true && (style === "solid" || style === "double");

		if (width !== null && width > 0 && color && style !== "none") {
			if (insetCapable) {
				// Layout-neutral path: an inset ring instead of a real border. Kept as
				// its own declaration so it composes with the shadow ladder rather than
				// being overwritten by it.
				decls.push(`box-shadow: inset 0 0 0 ${width}px ${color};`);
			} else {
				const edges = Array.isArray(border.edges)
					? border.edges.filter((edge) => BORDER_EDGES.has(edge))
					: null;
				if (edges && edges.length > 0) {
					// Per-edge rules, so a header can carry a bottom rule only.
					for (const edge of BORDER_EDGE_ORDER) {
						if (!edges.includes(edge)) continue;
						decls.push(`border-${edge}: ${width}px ${style} ${color};`);
					}
				} else {
					decls.push(`border: ${width}px ${style} ${color};`);
				}
			}
		} else if (style === "none" || width === 0) {
			// An explicit way to remove a host border (a flat, chrome-less look).
			decls.push("border: 0 solid transparent;");
		}

		// Corners. Per-corner values win over the uniform radius where both are set.
		const uniform = clampedInt(border.radius, 0, 48);
		const corners: Array<[string, unknown]> = [
			["top-left", border.radiusTopLeft],
			["top-right", border.radiusTopRight],
			["bottom-right", border.radiusBottomRight],
			["bottom-left", border.radiusBottomLeft],
		];
		const perCorner = corners
			.map(([name, raw]) => {
				const value = clampedInt(raw, 0, 48) ?? uniform;
				return value === null ? null : ([name, value] as const);
			})
			.filter((entry): entry is readonly [string, number] => entry !== null);
		if (perCorner.length === 4) {
			// All four known: emit the shorthand so it beats any host longhand.
			const [tl, tr, br, bl] = perCorner.map(([, v]) => v);
			decls.push(`border-radius: ${tl}px ${tr}px ${br}px ${bl}px;`);
		} else {
			for (const [name, value] of perCorner) {
				decls.push(`border-${name}-radius: ${value}px;`);
			}
		}

		if (decls.length === 0) continue;
		out += `${scopeSelector}${target} {\n\t${decls.join("\n\t")}\n}\n`;
	}
	return out;
}

/** Re-assert a slice/width magnitude; returns null when out of policy. */
function parseFrameSlice(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value)) return null;
	if (value < FRAME_MIN_SLICE || value > FRAME_MAX_SLICE) return null;
	return value;
}

/**
 * Build nine-slice frame rules for one token set, scoped under `scopeSelector`.
 * Emits one rule per target, in the pinned `FRAME_TARGET_ORDER` so overlapping
 * selectors resolve predictably.
 *
 * Layout safety is structural, not advisory: the only box-model property emitted
 * is `border-width: 0`, with the visual thickness carried by
 * `border-image-width`. That paints the frame inside the existing border box, so
 * the content box is untouched and a frame can never reflow the host. Neither a
 * non-zero `border-width` nor `border-image-outset` is expressible here — outset
 * paints outside the border box and is clipped by any `overflow: hidden`
 * ancestor (Mantine's Button sets it on itself), so it would be unreliable.
 */
function buildFrameRules(
	frames: Record<string, TargetFrame> | undefined,
	scopeSelector: string,
	pluginId: string,
	ctx: ThemeAssetContext | undefined,
): string {
	if (!frames || !ctx) return "";
	let out = "";
	for (const name of SURFACE_ORDER) {
		const frame = frames[name];
		if (!frame || typeof frame.image !== "string") continue;
		if (!THEME_FRAME_TARGETS.includes(name as never)) continue;
		const target = SURFACE_TARGET[name];
		if (target === undefined || target === "") continue; // not a framable target
		const url = themeAssetUrl(pluginId, ctx, frame.image);
		if (!url) continue;
		const slice = parseFrameSlice(frame.slice);
		if (slice === null) continue;
		// Width defaults to the slice size, which renders the source art 1:1.
		const width = parseFrameSlice(frame.width) ?? slice;
		const repeat = frame.repeat && FRAME_REPEAT.has(frame.repeat) ? frame.repeat : "stretch";
		const fill = frame.fill === true ? " fill" : "";
		const decls = [
			"border-style: solid;",
			"border-width: 0;",
			`border-image-source: url("${url}");`,
			`border-image-slice: ${slice}${fill};`,
			`border-image-width: ${width}px;`,
			`border-image-repeat: ${repeat};`,
		];
		out += `${scopeSelector}${target} {\n\t${decls.join("\n\t")}\n}\n`;
	}
	return out;
}

/**
 * Build the CSS-variable declaration lines for one token set. Every value is
 * re-asserted here (defense in depth); unsafe/out-of-range values are dropped.
 */
function buildDeclarations(
	tokens: SchemeTokens,
	fontFamilies: ReadonlyMap<string, string> = new Map(),
): string[] {
	const declarations: string[] = [];

	// Named custom color scales.
	if (tokens.colors) {
		for (const [name, entry] of Object.entries(tokens.colors)) {
			if (!COLOR_NAME_PATTERN.test(name) || name.length > 32) continue;
			const scale = resolveScale(entry);
			if (!scale) continue;
			scale.forEach((shade, i) => {
				declarations.push(`--mantine-color-${name}-${i}: ${shade};`);
			});
		}
	}

	// Primary color: generate a scale, publish it as a named color and alias the
	// Mantine primary-color variables so components pick it up.
	if (tokens.primaryColor && isSafeColor(tokens.primaryColor)) {
		const scale = generateShades(tokens.primaryColor);
		scale.forEach((shade, i) => {
			declarations.push(`--mantine-color-${PRIMARY_COLOR_NAME}-${i}: ${shade};`);
			declarations.push(`--mantine-primary-color-${i}: ${shade};`);
		});
		declarations.push(`--mantine-primary-color-filled: ${scale[6]};`);
		declarations.push(`--mantine-primary-color-filled-hover: ${scale[7]};`);
		declarations.push(`--mantine-primary-color-light: ${scale[0]};`);
		declarations.push(`--mantine-primary-color-light-hover: ${scale[1]};`);
	}

	if (tokens.body && isSafeColor(tokens.body)) {
		declarations.push(`--mantine-color-body: ${tokens.body};`);
	}
	if (tokens.text && isSafeColor(tokens.text)) {
		declarations.push(`--mantine-color-text: ${tokens.text};`);
	}

	// Box-model tokens: derive the xs..xl ladder from a clamped base.
	appendDimensionLadder(declarations, "spacing", tokens.spacing, "spacing");
	appendDimensionLadder(declarations, "fontSize", tokens.fontSize, "font-size");
	appendDimensionLadder(declarations, "radius", tokens.radius, "radius");

	// Font families are either generic CSS keywords or references to package-declared
	// WOFF2 faces. The plugin never supplies a CSS family name or a URL directly.
	const bodyFont = resolveFontFamily(tokens.fontFamily, fontFamilies);
	if (bodyFont) declarations.push(`--mantine-font-family: ${bodyFont};`);
	const headingFont = resolveFontFamily(tokens.fontFamilyHeadings, fontFamilies);
	if (headingFont) declarations.push(`--mantine-font-family-headings: ${headingFont};`);
	const monoFont = resolveFontFamily(tokens.fontFamilyMonospace, fontFamilies);
	if (monoFont) declarations.push(`--mantine-font-family-monospace: ${monoFont};`);

	appendShadowLadder(declarations, tokens.shadow);

	return declarations;
}

/**
 * Derive the xs..xl `--mantine-shadow-*` ladder from a clamped blur radius.
 *
 * The theme supplies only a strength; the host owns the geometry and the color.
 * A theme cannot author a raw `box-shadow`, which takes unbounded lengths and
 * could paint far outside its element or be used to draw fake host chrome.
 */
function appendShadowLadder(declarations: string[], shadow: number | undefined): void {
	if (typeof shadow !== "number" || !Number.isInteger(shadow)) return;
	if (shadow < SHADOW_MIN || shadow > SHADOW_MAX) return;
	for (const { key, factor } of SIZE_LADDER) {
		const blur = Math.round(shadow * factor * 100) / 100;
		// Offset and spread stay proportional to the blur, and the alpha is fixed by
		// the host so a theme cannot emit an opaque full-bleed shadow.
		const offsetY = Math.round(blur * 0.35 * 100) / 100;
		declarations.push(`--mantine-shadow-${key}: 0 ${offsetY}px ${blur}px rgba(0, 0, 0, 0.18);`);
	}
}

/** Wrap declaration lines in a scoped rule, or "" when there are none. */
function ruleFrom(selector: string, declarations: string[]): string {
	if (declarations.length === 0) return "";
	return `${selector} {\n\t${declarations.join("\n\t")}\n}\n`;
}

/**
 * Compile validated theme tokens into scoped CSS. Returns an empty string when
 * the tokens produce no safe declarations.
 *
 * Dual (light/dark) themes: when `colorScheme === "both"` and the tokens carry
 * `light` and/or `dark` sub-sets, the top-level tokens become a scheme-agnostic
 * base rule (`[data-plugin-theme=x]`) and each variant adds a more specific rule
 * (`[data-plugin-theme=x][data-mantine-color-scheme=light|dark]`) that overrides
 * the base for that scheme. This lets one theme follow the system light/dark
 * setting. Single-scheme themes keep the original single-rule behavior.
 */
export function compileThemeTokens(
	tokens: ThemeTokens,
	pluginId: string,
	themeId: string,
	colorScheme: "light" | "dark" | "both",
	assetContext?: ThemeAssetContext,
	fontFamilies: ReadonlyMap<string, string> = new Map(),
): string {
	const { light, dark, ...base } = tokens as ThemeTokens & {
		light?: SchemeTokens;
		dark?: SchemeTokens;
	};
	const hasVariants = colorScheme === "both" && (light !== undefined || dark !== undefined);

	if (!hasVariants) {
		// Original single-rule path (also covers "both" with a single palette).
		const selector = buildSelector(pluginId, themeId, colorScheme);
		const css =
			ruleFrom(selector, buildDeclarations(base, fontFamilies)) +
			buildSurfacePaintRules(base.backgrounds, base.gradients, selector, pluginId, assetContext) +
			buildFrameRules(base.frames, selector, pluginId, assetContext) +
			buildTextColorRules(base.textColors, selector) +
			buildBorderRules(base.borders, selector);
		return css.length === 0 || css.length > MAX_COMPILED_THEME_CSS_LENGTH ? "" : css;
	}

	// Dual theme: shared base rule + per-scheme override rules (variables,
	// backgrounds and frames all follow the base/light/dark scoping).
	const baseSel = buildSelector(pluginId, themeId, "both");
	const lightSel = buildSelector(pluginId, themeId, "light");
	const darkSel = buildSelector(pluginId, themeId, "dark");
	const parts: string[] = [
		ruleFrom(baseSel, buildDeclarations(base, fontFamilies)),
		buildSurfacePaintRules(base.backgrounds, base.gradients, baseSel, pluginId, assetContext),
		buildFrameRules(base.frames, baseSel, pluginId, assetContext),
		buildTextColorRules(base.textColors, baseSel),
		buildBorderRules(base.borders, baseSel),
	];
	if (light) {
		parts.push(ruleFrom(lightSel, buildDeclarations(light, fontFamilies)));
		parts.push(
			buildSurfacePaintRules(light.backgrounds, light.gradients, lightSel, pluginId, assetContext),
		);
		parts.push(buildFrameRules(light.frames, lightSel, pluginId, assetContext));
		parts.push(buildTextColorRules(light.textColors, lightSel));
		parts.push(buildBorderRules(light.borders, lightSel));
	}
	if (dark) {
		parts.push(ruleFrom(darkSel, buildDeclarations(dark, fontFamilies)));
		parts.push(
			buildSurfacePaintRules(dark.backgrounds, dark.gradients, darkSel, pluginId, assetContext),
		);
		parts.push(buildFrameRules(dark.frames, darkSel, pluginId, assetContext));
		parts.push(buildTextColorRules(dark.textColors, darkSel));
		parts.push(buildBorderRules(dark.borders, darkSel));
	}
	const css = parts.filter((p) => p.length > 0).join("");
	if (css.length === 0 || css.length > MAX_COMPILED_THEME_CSS_LENGTH) return "";
	return css;
}

function appendDimensionLadder(
	declarations: string[],
	family: "spacing" | "fontSize" | "radius",
	value: string | undefined,
	cssPrefix: string,
): void {
	if (!value) return;
	const parsed = parseDimension(value, family);
	if (!parsed) return;
	for (const { key, factor } of SIZE_LADDER) {
		const scaled = Math.round(parsed.magnitude * factor * 1000) / 1000;
		declarations.push(`--mantine-${cssPrefix}-${key}: ${scaled}${parsed.unit};`);
	}
}

/**
 * Build the theme scope selector. The data attribute value is the stable
 * identity `<pluginId>__<themeId>`; both parts are already constrained by the
 * manifest schema (plugin id + contribution id patterns), so no user-controlled
 * characters can break out of the attribute selector, but we still assert the
 * safe character set as a final guard.
 */
export function buildThemeKey(pluginId: string, themeId: string): string {
	return `${pluginId}__${themeId}`;
}

function buildSelector(
	pluginId: string,
	themeId: string,
	colorScheme: "light" | "dark" | "both",
): string {
	const key = buildThemeKey(pluginId, themeId);
	// Final guard: the key must only contain the constrained character set.
	if (!/^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/.test(key)) {
		throw new Error("invalid theme key");
	}
	const base = `:root[data-plugin-theme="${key}"]`;
	if (colorScheme === "both") return base;
	return `${base}[data-mantine-color-scheme="${colorScheme}"]`;
}

/** Compile a full theme contribution. Returns empty string on no-op. */
export function compileThemeContribution(
	contribution: ThemeContribution,
	pluginId: string,
	assetContext?: ThemeAssetContext,
): string {
	const fonts = compileThemeFonts(
		contribution.fonts ?? [],
		pluginId,
		contribution.id,
		assetContext,
	);
	if (!fonts) return "";
	const tokenCss = compileThemeTokens(
		contribution.tokens,
		pluginId,
		contribution.id,
		contribution.colorScheme,
		assetContext,
		fonts.families,
	);
	if (!tokenCss) return "";
	const css = `${fonts.css}${tokenCss}`;
	return css.length <= MAX_COMPILED_THEME_CSS_LENGTH ? css : "";
}
