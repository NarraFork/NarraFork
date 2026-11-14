/**
 * Theme colour presets and the generator behind "custom".
 *
 * ## What this module owns
 *
 * The neutral surface ladder (`--nf-ink-*` / `--nf-paper-*`) and the accent ramp Mantine
 * needs for its primary colour. Everything here is pure: no DOM, no storage, no React, so
 * it runs in the settings UI, in the pre-hydration path and under `bun test` alike.
 *
 * ## Why the ladder is fixed and only the hue moves
 *
 * A user picks one colour; we take its hue and keep the measured lightness ladder from
 * `styles/tokens.css`. Scaling brightness from the picked colour instead would make the
 * same "step 3" land at wildly different contrast for a yellow and a blue — a light
 * yellow at L 0.54 is fine and a dark blue at L 0.54 is not, in Y terms. Locking L and
 * varying only H/C keeps every hierarchy relationship intact, and the contrast pass below
 * then nudges the few steps whose Y drifted out of tolerance.
 *
 * ## The default preset is literal, not generated
 *
 * `default` returns the exact token values from `styles/tokens.css`. Regenerating them
 * would round-trip through OKLCH and land a shade off, which would make "reset to
 * default" visibly different from a fresh install.
 */

/** Contrast helpers. `#rrggbb` only; the palette never produces shorthand. */
function toRgb(hex: string): [number, number, number] {
	const value = hex.replace("#", "");
	return [
		Number.parseInt(value.slice(0, 2), 16),
		Number.parseInt(value.slice(2, 4), 16),
		Number.parseInt(value.slice(4, 6), 16),
	];
}

function channelToLinear(channel: number): number {
	const c = channel / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
	const [r, g, b] = toRgb(hex);
	return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

export function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la > lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

// --- OKLCH -----------------------------------------------------------------

interface Oklch {
	L: number;
	C: number;
	H: number;
}

function srgbToLinear(channel: number): number {
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
	return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

export function hexToOklch(hex: string): Oklch {
	const [r, g, b] = toRgb(hex).map((v) => srgbToLinear(v / 255));
	const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
	const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
	const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
	const [lc, mc, sc] = [l, m, s].map((v) => Math.cbrt(v));
	const L = 0.2104542553 * lc + 0.793617785 * mc - 0.0040720468 * sc;
	const a = 1.9779984951 * lc - 2.428592205 * mc + 0.4505937099 * sc;
	const bb = 0.0259040371 * lc + 0.7827717662 * mc - 0.808675766 * sc;
	return {
		L,
		C: Math.hypot(a, bb),
		H: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
	};
}

/** Convert back to `#rrggbb`, reducing chroma until the colour fits in sRGB. */
export function oklchToHex(L: number, C: number, H: number): string {
	const rad = (H * Math.PI) / 180;
	let chroma = Math.max(0, C);
	for (let attempt = 0; attempt < 48; attempt += 1) {
		const a = Math.cos(rad) * chroma;
		const b = Math.sin(rad) * chroma;
		const lc = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
		const mc = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
		const sc = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
		const rgb = [
			4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
			-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
			-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
		].map(linearToSrgb);
		if (rgb.every((v) => v >= -0.001 && v <= 1.001)) {
			return `#${rgb
				.map((v) =>
					Math.round(Math.min(1, Math.max(0, v)) * 255)
						.toString(16)
						.padStart(2, "0"),
				)
				.join("")}`;
		}
		chroma *= 0.92;
	}
	// Chroma 0 is always in gamut; this is only reached by pathological input.
	return oklchToHex(L, 0, H);
}

// --- ladders ---------------------------------------------------------------

/** Steps measured from the current palette (`styles/tokens.css`), kept in OKLCH. */
const INK_STEPS: ReadonlyArray<{ token: string; L: number; C: number }> = [
	{ token: "ink-950", L: 0.179, C: 0.0041 },
	{ token: "ink-900", L: 0.252, C: 0.0058 },
	{ token: "ink-850", L: 0.283, C: 0.007 },
	{ token: "ink-800", L: 0.312, C: 0.0083 },
	{ token: "ink-700", L: 0.347, C: 0.0103 },
	{ token: "ink-600", L: 0.563, C: 0.0196 },
	{ token: "ink-300", L: 0.769, C: 0.0096 },
	{ token: "ink-200", L: 0.826, C: 0.009 },
	{ token: "ink-100", L: 0.949, C: 0.0029 },
];

const PAPER_STEPS: ReadonlyArray<{ token: string; L: number; C: number }> = [
	{ token: "paper-50", L: 0.956, C: 0.004 },
	{ token: "paper-0", L: 0.991, C: 0.0013 },
	{ token: "paper-100", L: 0.932, C: 0.0054 },
	{ token: "paper-200", L: 0.91, C: 0.0068 },
	{ token: "paper-300", L: 0.887, C: 0.0095 },
	{ token: "paper-500", L: 0.559, C: 0.0195 },
	{ token: "paper-600", L: 0.502, C: 0.0136 },
	{ token: "paper-700", L: 0.371, C: 0.0147 },
	{ token: "paper-900", L: 0.241, C: 0.0097 },
];

/** Mantine's own indigo ramp in OKLCH — the proven accent shape, re-hueable. */
const ACCENT_STEPS: ReadonlyArray<{ L: number; C: number }> = [
	{ L: 0.961, C: 0.018 },
	{ L: 0.92, C: 0.038 },
	{ L: 0.841, C: 0.079 },
	{ L: 0.747, C: 0.13 },
	{ L: 0.68, C: 0.163 },
	{ L: 0.628, C: 0.191 },
	{ L: 0.59, C: 0.205 },
	{ L: 0.557, C: 0.208 },
	{ L: 0.526, C: 0.199 },
	{ L: 0.484, C: 0.188 },
];

/** Literal palette, so `default` is byte-identical to `tokens.css`. */
const DEFAULT_INK: Record<string, string> = {
	"ink-980": "#0d0d0f",
	"ink-990": "#09090b",
	"ink-950": "#111113",
	"ink-900": "#212225",
	"ink-850": "#272a2d",
	"ink-800": "#2e3135",
	"ink-700": "#363a3f",
	"ink-600": "#6e7681",
	"ink-300": "#b0b4ba",
	"ink-200": "#c3c6cc",
	"ink-100": "#edeef0",
};

const DEFAULT_PAPER: Record<string, string> = {
	"paper-50": "#f0f0f3",
	"paper-0": "#fcfcfd",
	"paper-100": "#e8e8ec",
	"paper-200": "#e0e1e6",
	"paper-300": "#d9d9e0",
	"paper-500": "#6f7480",
	"paper-600": "#60646c",
	"paper-700": "#3c4048",
	"paper-900": "#1c2024",
};

const DEFAULT_ACCENT: readonly string[] = [
	"#edf2ff",
	"#dbe4ff",
	"#bac8ff",
	"#91a7ff",
	"#748ffc",
	"#5c7cfa",
	"#4c6ef5",
	"#4263eb",
	"#3b5bdb",
	"#364fc7",
];

// --- contrast guarantees ---------------------------------------------------

interface ContrastRule {
	fg: string;
	bg: string;
	min: number;
	/** Which direction to move `fg` while searching for a passing value. */
	lighter: boolean;
}

const INK_RULES: ReadonlyArray<ContrastRule> = [
	{ fg: "ink-100", bg: "ink-900", min: 4.5, lighter: true },
	{ fg: "ink-300", bg: "ink-900", min: 4.5, lighter: true },
	{ fg: "ink-600", bg: "ink-900", min: 3, lighter: true },
];

const PAPER_RULES: ReadonlyArray<ContrastRule> = [
	{ fg: "paper-900", bg: "paper-0", min: 4.5, lighter: false },
	{ fg: "paper-600", bg: "paper-0", min: 4.5, lighter: false },
	{ fg: "paper-500", bg: "paper-0", min: 3, lighter: false },
];

/**
 * Nudge steps until the rules hold. Bounded (40 × 0.004 L) so a pathological hue can never
 * spin here; the worst case moves a step by 0.16 L, which is still visible rather than
 * silently failing the accessibility contract.
 */
function enforceContrast(
	colors: Map<string, string>,
	steps: ReadonlyArray<{ token: string; L: number }>,
	rules: ReadonlyArray<ContrastRule>,
	hues: Map<string, { C: number; H: number }>,
): void {
	for (const rule of rules) {
		for (let attempt = 0; attempt < 40; attempt += 1) {
			const fg = colors.get(rule.fg);
			const bg = colors.get(rule.bg);
			if (!fg || !bg || contrastRatio(fg, bg) >= rule.min) break;
			const step = steps.find((s) => s.token === rule.fg);
			const tone = hues.get(rule.fg);
			if (!step || !tone) break;
			const nextL = Math.min(1, Math.max(0, step.L + (rule.lighter ? 0.004 : -0.004)));
			(step as { L: number }).L = nextL;
			colors.set(rule.fg, oklchToHex(nextL, tone.C, tone.H));
		}
	}
}

function buildLadder(
	steps: ReadonlyArray<{ token: string; L: number; C: number }>,
	hue: number,
	chromaScale: number,
	rules: ReadonlyArray<ContrastRule>,
	chromaFloor: number,
): Record<string, string> {
	const colors = new Map<string, string>();
	const tones = new Map<string, { C: number; H: number }>();
	const worked = steps.map((s) => ({ ...s }));
	for (const step of worked) {
		/*
		 * The default ladder is nearly neutral (C ≈ 0.004 on the canvas), so multiplying it
		 * by a preset's strength alone produces differences nobody can see — the swatches all
		 * read as black. The floor gives each preset a visible tint without touching the
		 * lightness ladder (contrast is still guaranteed by the rules below).
		 */
		const C = Math.max(step.C, chromaFloor) * chromaScale;
		tones.set(step.token, { C, H: hue });
		colors.set(step.token, oklchToHex(step.L, C, hue));
	}
	enforceContrast(colors, worked, rules, tones);
	return Object.fromEntries(colors);
}

/** Accent ramp, corrected so a white label on shade 8 (Mantine's dark filled) passes AA. */
function buildAccent(hue: number, chromaScale: number): AccentRamp {
	const worked = ACCENT_STEPS.map((s) => ({ ...s }));
	const build = () => worked.map((s) => oklchToHex(s.L, s.C * chromaScale, hue)) as AccentRamp;
	let ramp = build();
	for (let attempt = 0; attempt < 40; attempt += 1) {
		// Shade 8 is what a filled button paints in the dark scheme.
		if (contrastRatio("#ffffff", ramp[8]) >= 4.5) break;
		worked[8] = { ...worked[8], L: Math.max(0.3, worked[8].L - 0.006) };
		worked[7] = { ...worked[7], L: Math.max(0.32, worked[7].L - 0.006) };
		ramp = build();
	}
	return ramp;
}

// --- presets ---------------------------------------------------------------

export type NeutralPresetId =
	| "default"
	| "graphite"
	| "midnight"
	| "tokyo"
	| "warm"
	| "forest"
	| "contrast"
	| "classic"
	| "github"
	| "catppuccin";

export interface NeutralPreset {
	id: NeutralPresetId;
	/** Hue in OKLCH degrees. Ignored when `literal` is present. */
	hue: number;
	/** Multiplier on the measured chroma; 0 gives a pure grey. Ignored with `literal`. */
	chroma: number;
	/**
	 * A hand-tuned ladder taken from an established design system. Used verbatim so the
	 * product looks like the reference rather than an approximation of it. Values were
	 * checked against the same contrast floors as the generated palettes — the two
	 * exceptions are documented at the preset (border weights were raised to reach 3:1,
	 * because Radix and Catppuccin ship deliberately faint borders).
	 */
	literal?: { ink: Record<string, string>; paper: Record<string, string> };
}

export const NEUTRAL_PRESETS: ReadonlyArray<NeutralPreset> = [
	{ id: "default", hue: 264, chroma: 1 },
	{ id: "graphite", hue: 250, chroma: 0 },
	{ id: "midnight", hue: 265, chroma: 1.25 },
	{ id: "tokyo", hue: 278, chroma: 1.6 },
	{ id: "warm", hue: 70, chroma: 1.1 },
	{ id: "forest", hue: 160, chroma: 1.1 },
	{ id: "contrast", hue: 264, chroma: 0.9 },
	{
		id: "classic",
		hue: 264,
		chroma: 1,
		/** The blue-black default before the Radix-based palette landed. Kept so the previous look stays one click away. */
		literal: {
			ink: {
				"ink-950": "#0b0e14",
				"ink-900": "#191d26",
				"ink-850": "#22262f",
				"ink-800": "#2c3240",
				"ink-700": "#39404f",
				"ink-600": "#657086",
				"ink-300": "#8a93a5",
				"ink-200": "#b7bfce",
				"ink-100": "#e7ebf3",
			},
			paper: {
				"paper-50": "#f6f7f9",
				"paper-0": "#ffffff",
				"paper-100": "#eef1f5",
				"paper-200": "#e6eaf1",
				"paper-300": "#d8dee8",
				"paper-500": "#7e8a9e",
				"paper-600": "#5e6878",
				"paper-700": "#414a5a",
				"paper-900": "#141821",
			},
		},
	},
	{
		id: "github",
		hue: 220,
		chroma: 0.5,
		/**
		 * GitHub Primer dark / light. Two deliberate changes: the canvas is one step darker
		 * (1.09 → 1.12) so panels clear the separation floor, and the border moved from
		 * #30363d to an accessible 3.77:1. Everything else is Primer verbatim.
		 */
		literal: {
			ink: {
				"ink-950": "#0a0d12",
				"ink-900": "#161b22",
				"ink-850": "#21262d",
				"ink-800": "#262c35",
				"ink-700": "#30363d",
				"ink-600": "#6e7681",
				"ink-300": "#8b949e",
				"ink-200": "#c9d1d9",
				"ink-100": "#e6edf3",
			},
			paper: {
				"paper-50": "#f6f8fa",
				"paper-0": "#ffffff",
				"paper-100": "#eaeef2",
				"paper-200": "#e1e4e8",
				"paper-300": "#d0d7de",
				"paper-500": "#8c959f",
				"paper-600": "#59636e",
				"paper-700": "#424a53",
				"paper-900": "#1f2328",
			},
		},
	},
	{
		id: "catppuccin",
		hue: 260,
		chroma: 0.6,
		/**
		 * Catppuccin Mocha / Latte. Canvas nudged one step darker (1.07 → 1.12) and the
		 * overlay/rule split apart so the ladder stays monotonic. Latte's text ramp misses AA on its own surface
		 * (`subtext0` is 4.37:1), so muted/secondary/text were shifted one step darker;
		 * the border likewise raised to 3.31:1.
		 */
		literal: {
			ink: {
				"ink-950": "#0a0a12",
				"ink-900": "#181825",
				"ink-850": "#1e1e2e",
				"ink-800": "#26263a",
				"ink-700": "#313244",
				"ink-600": "#6c7086",
				"ink-300": "#7f849c",
				"ink-200": "#a6adc8",
				"ink-100": "#cdd6f4",
			},
			paper: {
				"paper-50": "#e6e9ef",
				"paper-0": "#eff1f5",
				"paper-100": "#dce0e8",
				"paper-200": "#ccd0da",
				"paper-300": "#bcc0cc",
				"paper-500": "#7b83a1",
				"paper-600": "#5c5f77",
				"paper-700": "#4c4f69",
				"paper-900": "#363a52",
			},
		},
	},
];

export type AccentPresetId = "indigo" | "blue" | "teal" | "green" | "amber" | "violet" | "rose";

export interface AccentPreset {
	id: AccentPresetId;
	hue: number;
	chroma: number;
}

export const ACCENT_PRESETS: ReadonlyArray<AccentPreset> = [
	{ id: "indigo", hue: 268, chroma: 1 },
	{ id: "blue", hue: 250, chroma: 1 },
	{ id: "teal", hue: 195, chroma: 1 },
	{ id: "green", hue: 145, chroma: 1 },
	{ id: "amber", hue: 75, chroma: 1 },
	{ id: "violet", hue: 300, chroma: 1 },
	{ id: "rose", hue: 12, chroma: 1 },
];

export interface PaletteChoice {
	neutral: NeutralPresetId | "custom";
	neutralCustom: string;
	accent: AccentPresetId | "custom";
	accentCustom: string;
}

export const DEFAULT_PALETTE: PaletteChoice = {
	neutral: "default",
	neutralCustom: "#16181d",
	accent: "indigo",
	accentCustom: "#4c6ef5",
};

/** Mantine requires exactly ten shades, so the ramp is typed as a tuple. */
export type AccentRamp = [
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
];

export interface ResolvedPalette {
	ink: Record<string, string>;
	paper: Record<string, string>;
	/** Ten-step ramp for Mantine's `primaryColor`. */
	accent: AccentRamp;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function isHex(value: string | undefined): value is string {
	return typeof value === "string" && HEX.test(value);
}

/** Chroma used for a custom pick: enough to read as a tint, never as a neon wash. */
const CUSTOM_CHROMA = 1;

export function resolvePalette(choice: PaletteChoice): ResolvedPalette {
	let ink: Record<string, string>;
	let paper: Record<string, string>;

	if (choice.neutral === "default") {
		ink = { ...DEFAULT_INK };
		paper = { ...DEFAULT_PAPER };
	} else if (choice.neutral === "custom" && isHex(choice.neutralCustom)) {
		const picked = hexToOklch(choice.neutralCustom);
		// A grey pick has no meaningful hue (H is numerical noise), so it must stay neutral
		// instead of picking up a tint from the chroma floor.
		const strength = picked.C < 0.002 ? 0 : CUSTOM_CHROMA;
		ink = buildLadder(INK_STEPS, picked.H, strength, INK_RULES, 0.012);
		paper = buildLadder(PAPER_STEPS, picked.H, strength, PAPER_RULES, 0.006);
	} else {
		const preset = NEUTRAL_PRESETS.find((p) => p.id === choice.neutral) ?? NEUTRAL_PRESETS[0];
		if (preset.literal) {
			// Hand-tuned palettes (GitHub, Catppuccin, the old default) are used verbatim:
			// generating them from hue/chroma would reproduce an approximation instead of
			// the design system the user picked.
			ink = { ...preset.literal.ink };
			paper = { ...preset.literal.paper };
		} else {
			ink = buildLadder(INK_STEPS, preset.hue, preset.chroma, INK_RULES, 0.012);
			paper = buildLadder(PAPER_STEPS, preset.hue, preset.chroma, PAPER_RULES, 0.006);
		}
	}

	// Two rungs below the canvas, used only by Mantine's filled variants (`dark.8/9`).
	// Derived from the canvas so a custom hue does not leave those slots on the old blue.
	if (choice.neutral !== "default") {
		const deepest = hexToOklch(ink["ink-950"]);
		ink["ink-980"] = oklchToHex(deepest.L * 0.877, deepest.C, deepest.H);
		ink["ink-990"] = oklchToHex(deepest.L * 0.742, deepest.C, deepest.H);
	}

	let accent: AccentRamp;
	if (choice.accent === "indigo") {
		accent = [...DEFAULT_ACCENT] as AccentRamp;
	} else if (choice.accent === "custom" && isHex(choice.accentCustom)) {
		accent = buildAccent(hexToOklch(choice.accentCustom).H, CUSTOM_CHROMA);
	} else {
		const preset = ACCENT_PRESETS.find((p) => p.id === choice.accent) ?? ACCENT_PRESETS[0];
		accent = buildAccent(preset.hue, preset.chroma);
	}

	return { ink, paper, accent };
}

/** Parse a stored choice, falling back field-by-field so a partial/old blob still works. */
export function parsePaletteChoice(raw: unknown): PaletteChoice {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_PALETTE };
	const value = raw as Partial<Record<keyof PaletteChoice, unknown>>;
	const neutral =
		typeof value.neutral === "string" &&
		(value.neutral === "custom" || NEUTRAL_PRESETS.some((p) => p.id === value.neutral))
			? (value.neutral as PaletteChoice["neutral"])
			: DEFAULT_PALETTE.neutral;
	const accent =
		typeof value.accent === "string" &&
		(value.accent === "custom" || ACCENT_PRESETS.some((p) => p.id === value.accent))
			? (value.accent as PaletteChoice["accent"])
			: DEFAULT_PALETTE.accent;
	return {
		neutral,
		neutralCustom: isHex(value.neutralCustom as string)
			? (value.neutralCustom as string)
			: DEFAULT_PALETTE.neutralCustom,
		accent,
		accentCustom: isHex(value.accentCustom as string)
			? (value.accentCustom as string)
			: DEFAULT_PALETTE.accentCustom,
	};
}
