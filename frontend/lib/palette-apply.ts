/**
 * Publishes a chosen theme palette without touching the stock look.
 *
 * ## What "default" means
 *
 * No saved choice, and the explicit Default preset, leave Mantine's own dark scale and
 * light body/dimmed alone. Those are the colors a fresh install already paints. Slate and
 * the other presets are opt-in.
 *
 * ## Why this is a stylesheet, not inline styles
 *
 * Inline custom properties beat every stylesheet, including OLED
 * (`:root[data-mantine-color-scheme="dark"][data-oled="true"]`) and plugin themes
 * (`:root[data-plugin-theme]`). Writing `--mantine-color-dark-*` or `--mantine-color-indigo-*`
 * on `<html style>` is what made OLED gray and ignored the settings copy that says a plugin
 * theme pauses theme color.
 *
 * The injected sheet sets the dark ramp only under
 * `:root[data-mantine-color-scheme="dark"]:not([data-oled="true"])`, so OLED's pure black
 * on `dark-*` still wins. A non-null plugin-theme key removes the sheet entirely.
 *
 * The accent still goes through `createTheme` (`accentRampOverride`). Mantine precomputes
 * `-light` / `-contrast` in JS. The default indigo ramp is Mantine's own, so it is not
 * passed back in, and a plugin theme suppresses the override.
 */

import {
	type AccentRamp,
	DEFAULT_PALETTE,
	type PaletteChoice,
	parsePaletteChoice,
	type ResolvedPalette,
	resolvePalette,
} from "./palette-presets";
import { readActivePluginThemeKey } from "./plugin-theme-pref-store";

export const PALETTE_PREF_KEY = "narrafork_palette";
export const PALETTE_STYLE_ID = "nf-palette";

const HEX = /^#[0-9a-fA-F]{6}$/;

const INLINE_MANTINE = [
	...Array.from({ length: 10 }, (_, i) => `--mantine-color-dark-${i}`),
	...Array.from({ length: 10 }, (_, i) => `--mantine-color-indigo-${i}`),
];

const INLINE_NF = [
	"ink-950",
	"ink-900",
	"ink-850",
	"ink-800",
	"ink-700",
	"ink-600",
	"ink-300",
	"ink-200",
	"ink-100",
	"ink-980",
	"ink-990",
	"paper-50",
	"paper-0",
	"paper-100",
	"paper-200",
	"paper-300",
	"paper-500",
	"paper-600",
	"paper-700",
	"paper-900",
];

const listeners = new Set<() => void>();

/** Storage keys whose change should re-apply the palette. */
function isPaletteKey(key: string | null): boolean {
	return key === null || key === PALETTE_PREF_KEY;
}

function notify(): void {
	for (const listener of listeners) listener();
}

let storageBound = false;

function ensureStorageListener(): void {
	if (storageBound || typeof window === "undefined") return;
	storageBound = true;
	window.addEventListener("storage", (event) => {
		if (isPaletteKey(event.key)) notify();
	});
}

/** Subscribe to palette changes from any tab (and from this one). */
export function subscribePalette(listener: () => void): () => void {
	ensureStorageListener();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function readStoredPalette(): PaletteChoice {
	if (typeof localStorage === "undefined") return { ...DEFAULT_PALETTE };
	try {
		const raw = localStorage.getItem(PALETTE_PREF_KEY);
		return raw ? parsePaletteChoice(JSON.parse(raw)) : { ...DEFAULT_PALETTE };
	} catch {
		// A corrupt blob must not brick the app's colours; fall back to the default.
		return { ...DEFAULT_PALETTE };
	}
}

export function writeStoredPalette(choice: PaletteChoice): void {
	try {
		localStorage.setItem(PALETTE_PREF_KEY, JSON.stringify(choice));
	} catch {
		// Quota/private-mode failures are not worth surfacing: the UI already shows the
		// applied colours, they just will not survive a reload.
	}
	notify();
}

function decl(name: string, value: string | undefined): string | null {
	if (!value || !HEX.test(value)) return null;
	return `\t${name}: ${value};`;
}

function rule(selector: string, lines: Array<string | null>): string {
	const body = lines.filter((line): line is string => line !== null);
	if (body.length === 0) return "";
	return `${selector} {\n${body.join("\n")}\n}`;
}

/**
 * CSS for a chosen neutral, or "" when the choice is the stock Default preset.
 * Does not mention indigo: the accent ramp is applied through `createTheme`.
 * Dark slots are gated on `:not([data-oled="true"])`.
 */
export function buildPaletteCss(choice: PaletteChoice): string {
	if (choice.neutral === "default") return "";
	const { ink, paper } = resolvePalette(choice);
	const slots: Record<string, string | undefined> = {
		"0": ink["ink-100"],
		"1": ink["ink-200"],
		"2": ink["ink-300"],
		"3": ink["ink-300"],
		"4": ink["ink-600"],
		"5": ink["ink-800"],
		"6": ink["ink-900"],
		"7": ink["ink-950"],
		"8": ink["ink-980"],
		"9": ink["ink-990"],
	};
	const css = [
		rule(":root", [
			...Object.entries(ink).map(([token, value]) => decl(`--nf-${token}`, value)),
			...Object.entries(paper).map(([token, value]) => decl(`--nf-${token}`, value)),
		]),
		rule(':root[data-mantine-color-scheme="dark"]:not([data-oled="true"])', [
			...Object.entries(slots).map(([slot, value]) => decl(`--mantine-color-dark-${slot}`, value)),
		]),
		rule(':root[data-mantine-color-scheme="light"]:not([data-oled="true"])', [
			decl("--mantine-color-body", paper["paper-50"]),
			decl("--mantine-color-default", paper["paper-0"]),
			decl("--mantine-color-default-hover", paper["paper-100"]),
			decl("--mantine-color-dimmed", paper["paper-600"]),
			decl("--mantine-color-placeholder", paper["paper-600"]),
			decl("--mantine-color-text", paper["paper-900"]),
		]),
	].filter((block) => block.length > 0);
	return css.join("\n");
}

/** Empty while a plugin theme is on, so the settings copy matches the cascade. */
export function paletteCssFor(choice: PaletteChoice, pluginThemeKey: string | null): string {
	if (pluginThemeKey) return "";
	return buildPaletteCss(choice);
}

/**
 * Accent ramp to pass into `createTheme`, or null to keep Mantine's own indigo.
 * Null for the default indigo preset and whenever a plugin theme is active.
 */
export function accentRampOverride(
	choice: PaletteChoice,
	pluginThemeKey: string | null,
): AccentRamp | null {
	if (pluginThemeKey) return null;
	if (choice.accent === "indigo") return null;
	return resolvePalette(choice).accent;
}

function clearInlineOverrides(root: HTMLElement): void {
	for (const name of INLINE_MANTINE) root.style.removeProperty(name);
	for (const token of INLINE_NF) root.style.removeProperty(`--nf-${token}`);
}

function installPaletteStyle(css: string): void {
	if (typeof document === "undefined" || !document.head) return;
	const existing = document.getElementById(PALETTE_STYLE_ID);
	if (!css) {
		existing?.remove();
		return;
	}
	const style = existing instanceof HTMLStyleElement ? existing : document.createElement("style");
	style.id = PALETTE_STYLE_ID;
	style.textContent = css;
	if (!style.parentNode) document.head.appendChild(style);
}

/**
 * Apply `choice`. Pass `pluginThemeKey` from a subscriber; omit it to read storage.
 * Always drops inline `--mantine-color-dark-*` / `indigo-*` left by an older build.
 */
export function applyPalette(
	root: HTMLElement,
	choice: PaletteChoice,
	pluginThemeKey: string | null = readActivePluginThemeKey(),
): void {
	clearInlineOverrides(root);
	installPaletteStyle(paletteCssFor(choice, pluginThemeKey));
}

/**
 * Apply the stored palette before React mounts.
 *
 * A missing or default choice writes nothing, so the first paint is Mantine's own
 * scale. Called from `main.tsx` after the plugin-theme attribute is set.
 */
export function applyInitialPalette(): void {
	if (typeof document === "undefined") return;
	applyPalette(document.documentElement, readStoredPalette());
}

/** Blocking read used by tests and the settings UI. */
export function currentPalette(): { choice: PaletteChoice; resolved: ResolvedPalette } {
	const choice = readStoredPalette();
	return { choice, resolved: resolvePalette(choice) };
}
