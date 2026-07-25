/**
 * Plugin theme compiler.
 *
 * Turns validated, whitelisted theme design tokens into a single scoped CSS
 * rule that overrides Mantine CSS variables under a
 * `[data-plugin-theme="<pluginId>__<themeId>"]` selector. The output is meant
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

import type { ThemeContribution, ThemeTokens } from "./manifest";

/** Hard cap on a single compiled theme's CSS text (UTF-8 bytes ≈ chars here). */
export const MAX_COMPILED_THEME_CSS_LENGTH = 16_384;

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
}

/** Identifies the exact package so background image URLs can be built. */
export interface ThemeAssetContext {
	version: string;
	hash: string;
}

/**
 * Map each whitelisted region to the descendant selector (relative to the theme
 * scope selector) it paints. `body` targets the theme scope root itself; the
 * others target a stable host class. Never an arbitrary selector.
 */
const REGION_TARGET: Record<string, string> = {
	body: "",
	app: " .nf-app-shell",
	main: " .nf-app-shell-main",
	navbar: " .mantine-AppShell-navbar",
	header: " .mantine-AppShell-header",
};

/** Enum whitelists — any value outside these is dropped (defense in depth). */
const BG_SIZE = new Set(["cover", "contain", "auto"]);
const BG_POSITION = new Set(["center", "top", "bottom", "left", "right"]);
const BG_REPEAT = new Set(["no-repeat", "repeat"]);
const BG_OVERLAY = new Set(["none", "scrim-light", "scrim-dark"]);
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
 * Build region background rules for one token set, scoped under `scopeSelector`.
 * Emits one rule per region targeting its whitelisted descendant selector. All
 * values are enum/number-validated; the image URL is host-built and same-origin.
 */
function buildBackgroundRules(
	backgrounds: Record<string, RegionBackground> | undefined,
	scopeSelector: string,
	pluginId: string,
	ctx: ThemeAssetContext | undefined,
): string {
	if (!backgrounds || !ctx) return "";
	let out = "";
	for (const [region, bg] of Object.entries(backgrounds)) {
		const target = REGION_TARGET[region];
		if (target === undefined) continue; // not a whitelisted region
		if (!bg || typeof bg.image !== "string") continue;
		const url = themeAssetUrl(pluginId, ctx, bg.image);
		if (!url) continue;
		const size = bg.size && BG_SIZE.has(bg.size) ? bg.size : "cover";
		const position = bg.position && BG_POSITION.has(bg.position) ? bg.position : "center";
		const repeat = bg.repeat && BG_REPEAT.has(bg.repeat) ? bg.repeat : "no-repeat";
		const overlay = bg.overlay && BG_OVERLAY.has(bg.overlay) ? bg.overlay : "none";
		// `opacity` (0..1) is the scrim strength: how much the body color mutes the
		// image for readability. Defaults to a moderate wash when an overlay is set.
		const strength =
			typeof bg.opacity === "number" && bg.opacity >= 0 && bg.opacity <= 1
				? Math.round(bg.opacity * 100) / 100
				: 0.6;
		const scrim = overlayLayer(overlay, strength);
		// Layer order: scrim (if any) sits above the image.
		const imageLayer = scrim ? `${scrim}, url("${url}")` : `url("${url}")`;
		const decls = [
			`background-image: ${imageLayer};`,
			`background-size: ${size};`,
			`background-position: ${position};`,
			`background-repeat: ${repeat};`,
		];
		out += `${scopeSelector}${target} {\n\t${decls.join("\n\t")}\n}\n`;
	}
	return out;
}

/**
 * Build the CSS-variable declaration lines for one token set. Every value is
 * re-asserted here (defense in depth); unsafe/out-of-range values are dropped.
 */
function buildDeclarations(tokens: SchemeTokens): string[] {
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

	return declarations;
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
			ruleFrom(selector, buildDeclarations(base)) +
			buildBackgroundRules(base.backgrounds, selector, pluginId, assetContext);
		return css.length === 0 || css.length > MAX_COMPILED_THEME_CSS_LENGTH ? "" : css;
	}

	// Dual theme: shared base rule + per-scheme override rules (variables and
	// backgrounds both follow the base/light/dark scoping).
	const baseSel = buildSelector(pluginId, themeId, "both");
	const lightSel = buildSelector(pluginId, themeId, "light");
	const darkSel = buildSelector(pluginId, themeId, "dark");
	const parts: string[] = [
		ruleFrom(baseSel, buildDeclarations(base)),
		buildBackgroundRules(base.backgrounds, baseSel, pluginId, assetContext),
	];
	if (light) {
		parts.push(ruleFrom(lightSel, buildDeclarations(light)));
		parts.push(buildBackgroundRules(light.backgrounds, lightSel, pluginId, assetContext));
	}
	if (dark) {
		parts.push(ruleFrom(darkSel, buildDeclarations(dark)));
		parts.push(buildBackgroundRules(dark.backgrounds, darkSel, pluginId, assetContext));
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
	return compileThemeTokens(
		contribution.tokens,
		pluginId,
		contribution.id,
		contribution.colorScheme,
		assetContext,
	);
}
