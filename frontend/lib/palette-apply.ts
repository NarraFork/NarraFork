/**
 * Publishes the chosen theme palette onto `<html>` and keeps it in localStorage.
 *
 * ## Why CSS variables rather than a Mantine theme rebuild for the neutrals
 *
 * Mantine emits its dark ramp as `--mantine-color-dark-0..9` and every dark surface reads
 * one of those slots (`body` → dark-7, `default` → dark-6, borders → dark-4). Writing the
 * same custom properties inline on `<html>` wins over Mantine's stylesheet, so a preset
 * change is one style recalc with **zero React re-render** — the same mechanism OLED mode
 * uses, and the reason this stays cheap on a long transcript.
 *
 * The accent cannot work this way: `--mantine-color-indigo-light` and `-contrast` are
 * precomputed `rgba()`/contrast values inside Mantine's resolver, so the accent has to go
 * through `createTheme` (see `CoreProviders`). That rebuild is allowed to re-render.
 *
 * ## Storage
 *
 * Device-scoped, like `narrafork_oled` and the typography settings: no server round-trip, no
 * migration, and a settings page that updates instantly. Cross-tab sync comes free from the
 * `storage` event.
 */

import {
	DEFAULT_PALETTE,
	type PaletteChoice,
	parsePaletteChoice,
	type ResolvedPalette,
	resolvePalette,
} from "./palette-presets";

export const PALETTE_PREF_KEY = "narrafork_palette";

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

/**
 * Write the resolved palette onto the document element.
 *
 * `--mantine-color-dark-8/9` are derived here rather than taken from a token: they only
 * feed `color="dark.8"` style uses and the filled variants, and carrying two extra ladder
 * rungs in `tokens.css` for them would widen the public token surface for no benefit.
 */
export function applyPalette(
	root: HTMLElement,
	choice: PaletteChoice,
	resolved: ResolvedPalette = resolvePalette(choice),
): void {
	for (const [token, value] of Object.entries(resolved.ink)) {
		root.style.setProperty(`--nf-${token}`, value);
	}
	for (const [token, value] of Object.entries(resolved.paper)) {
		root.style.setProperty(`--nf-${token}`, value);
	}

	const slots: Record<string, string> = {
		"0": resolved.ink["ink-100"],
		"1": resolved.ink["ink-200"],
		"2": resolved.ink["ink-300"],
		"3": resolved.ink["ink-300"],
		"4": resolved.ink["ink-600"],
		"5": resolved.ink["ink-800"],
		"6": resolved.ink["ink-900"],
		"7": resolved.ink["ink-950"],
		"8": resolved.ink["ink-980"],
		"9": resolved.ink["ink-990"],
	};
	for (const [slot, value] of Object.entries(slots)) {
		if (value) root.style.setProperty(`--mantine-color-dark-${slot}`, value);
	}

	const { accent } = resolved;
	for (let i = 0; i < accent.length; i += 1) {
		root.style.setProperty(`--mantine-color-indigo-${i}`, accent[i]);
	}
}

/**
 * Apply the stored palette before React mounts.
 *
 * Without this the first paint shows the default colours and then swaps, which on a full
 * page reload reads as a flash of the wrong theme. Called from `main.tsx` next to the
 * plugin-theme bootstrap for the same reason.
 */
export function applyInitialPalette(): void {
	if (typeof document === "undefined") return;
	const choice = readStoredPalette();
	applyPalette(document.documentElement, choice);
}

/** Blocking read used by tests and the settings UI. */
export function currentPalette(): { choice: PaletteChoice; resolved: ResolvedPalette } {
	const choice = readStoredPalette();
	return { choice, resolved: resolvePalette(choice) };
}
