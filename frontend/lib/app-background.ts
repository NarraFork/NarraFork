/**
 * Custom background image ("wallpaper"): remote URL, applied behind the app.
 *
 * ## Shape of the feature
 *
 * The image goes on `<body>` together with a scrim gradient drawn over it, and the shell's
 * two surface variables are switched to `color-mix()` so panels become translucent and the
 * picture reads through them. Both values are percentages on variables, so the effect
 * follows the light/dark scheme and the chosen palette without re-applying anything.
 *
 * ## Why a scrim is not optional
 *
 * Text contrast would otherwise depend on whatever the user pasted — a bright photo behind
 * body text is unreadable no matter how good the panels look. The scrim is a solid layer of
 * the canvas colour at a user-controlled strength (default 52%), and the panel opacity is
 * floored in the UI so the worst combination still leaves text above AA.
 *
 * ## Validation
 *
 * Only `http:` and `https:` are accepted. `javascript:` and `data:` are rejected outright:
 * the first is an injection vector, the second would have to live in localStorage and blow
 * its quota. The URL is escaped before it reaches the `url()` value so a crafted string
 * cannot close the declaration.
 */

export type BackgroundSource = "url" | "file";

import { hideWallpaper, showWallpaper, type WallpaperResult } from "./wallpaper-layer";
import { loadWallpaperBlob } from "./wallpaper-store";

export interface BackgroundChoice {
	enabled: boolean;
	/** A remote URL, or a file previously saved in IndexedDB. */
	source: BackgroundSource;
	/** Display name of the picked file (file source only, for the UI). */
	fileName?: string;
	url: string;
	/** Pane opacity, percent. Higher = more opaque = less wallpaper visible. */
	opacity: number;
	/** Scrim strength over the image, percent. */
	scrim: number;
	/** Backdrop blur in px. Sharp images behind text are unreadable; 0 is allowed on purpose. */
	blur: number;
}

export const DEFAULT_BACKGROUND: BackgroundChoice = {
	enabled: false,
	source: "url",
	url: "",
	opacity: 80,
	scrim: 40,
	blur: 10,
};

/** Panel opacity never goes below this: below it, text over a photo stops being readable. */
export const MIN_OPACITY = 55;
export const MAX_URL_LENGTH = 2048;

const URL_PATTERN = /^https?:\/\//i;

export type UrlCheck = { ok: true } | { ok: false; reason: "empty" | "protocol" | "malformed" };

export function checkBackgroundUrl(raw: string): UrlCheck {
	const value = raw.trim();
	if (!value) return { ok: false, reason: "empty" };
	if (value.length > MAX_URL_LENGTH) return { ok: false, reason: "malformed" };
	if (!URL_PATTERN.test(value)) return { ok: false, reason: "protocol" };
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { ok: false, reason: "protocol" };
		}
		// A value that could terminate the `url("…")` declaration is never legitimate.
		if (/["\\\n\r]/.test(value)) return { ok: false, reason: "malformed" };
		return { ok: true };
	} catch {
		return { ok: false, reason: "malformed" };
	}
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseBackgroundChoice(raw: unknown): BackgroundChoice {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_BACKGROUND };
	const value = raw as Partial<Record<keyof BackgroundChoice, unknown>>;
	const source: BackgroundSource = value.source === "file" ? "file" : "url";
	const url = typeof value.url === "string" ? value.url.trim().slice(0, MAX_URL_LENGTH) : "";
	const usable = source === "file" ? true : Boolean(url) && checkBackgroundUrl(url).ok;
	return {
		// An unusable URL cannot be "enabled": otherwise a bad paste silently blanks the UI.
		enabled: usable ? Boolean(value.enabled) : false,
		source,
		...(typeof value.fileName === "string" ? { fileName: value.fileName.slice(0, 120) } : {}),
		url: source === "file" ? "" : usable ? url : "",
		opacity: clamp(value.opacity, MIN_OPACITY, 100, DEFAULT_BACKGROUND.opacity),
		scrim: clamp(value.scrim, 0, 90, DEFAULT_BACKGROUND.scrim),
		blur: clamp(value.blur, 0, 24, DEFAULT_BACKGROUND.blur),
	};
}

/**
 * Switch the active source without destroying the other one's configuration.
 *
 * Regression this exists for: picking a local file used to blank `url`, and switching back
 * to "URL" then had nothing to load — the wallpaper silently stopped appearing even though
 * the address was still on screen in the input.
 *
 * `enabled` follows the newly selected source: switching to a URL re-enables it when the
 * address is valid, switching to a file re-enables it when a file has been picked.
 */
export function switchBackgroundSource(
	choice: BackgroundChoice,
	source: BackgroundSource,
): BackgroundChoice {
	const enabled = source === "url" ? checkBackgroundUrl(choice.url).ok : Boolean(choice.fileName);
	return { ...choice, source, enabled };
}

export const BACKGROUND_PREF_KEY = "narrafork_background";

const listeners = new Set<() => void>();

export function subscribeBackground(listener: () => void): () => void {
	ensureStorageListener();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function notify(): void {
	for (const listener of listeners) listener();
}

let storageBound = false;

function ensureStorageListener(): void {
	if (storageBound || typeof window === "undefined") return;
	storageBound = true;
	window.addEventListener("storage", (event) => {
		if (event.key === null || event.key === BACKGROUND_PREF_KEY) notify();
	});
}

export function readStoredBackground(): BackgroundChoice {
	if (typeof localStorage === "undefined") return { ...DEFAULT_BACKGROUND };
	try {
		const raw = localStorage.getItem(BACKGROUND_PREF_KEY);
		return raw ? parseBackgroundChoice(JSON.parse(raw)) : { ...DEFAULT_BACKGROUND };
	} catch {
		return { ...DEFAULT_BACKGROUND };
	}
}

export function writeStoredBackground(choice: BackgroundChoice): void {
	try {
		localStorage.setItem(BACKGROUND_PREF_KEY, JSON.stringify(choice));
	} catch {
		// Storage is full or blocked; the applied look still works for this session.
	}
	notify();
}

/** Escape a validated URL for a CSS `url("…")` token. */
function cssUrl(url: string): string {
	const escaped = url.replace(/\\/g, "%5C").replace(/"/g, "%22");
	return `url("${escaped}")`;
}

export function applyBackground(root: HTMLElement, choice: BackgroundChoice): void {
	const usable = choice.enabled && checkBackgroundUrl(choice.url).ok;
	if (!usable) {
		root.removeAttribute("data-nf-bg");
		root.style.removeProperty("--nf-bg-image");
		root.style.removeProperty("--nf-bg-pane-opacity");
		root.style.removeProperty("--nf-bg-scrim");
		root.style.removeProperty("--nf-bg-blur");
		root.style.removeProperty("--nf-bg-body-opacity");
		return;
	}
	root.setAttribute("data-nf-bg", "on");
	root.style.setProperty("--nf-bg-image", cssUrl(choice.url));
	root.style.setProperty("--nf-bg-pane-opacity", `${clamp(choice.opacity, MIN_OPACITY, 100, 80)}%`);
	root.style.setProperty("--nf-bg-scrim", `${clamp(choice.scrim, 0, 90, 40)}%`);
	root.style.setProperty("--nf-bg-blur", `${clamp(choice.blur, 0, 24, 10)}px`);
	// The base layer under everything is lighter than the panels, so the wallpaper reads
	// through the background while text keeps sitting on the more opaque surfaces.
	root.style.setProperty(
		"--nf-bg-body-opacity",
		`${Math.max(45, clamp(choice.opacity, MIN_OPACITY, 100, 80) - 18)}%`,
	);
}

/**
 * Resolve the configured source into an actual image and put it on screen.
 *
 * Remote URLs go straight to an `<img>` (no Referer, see `wallpaper-layer.ts`); a picked
 * file is read back out of IndexedDB and served through an object URL this module owns.
 * Returns "error" when the image could not be loaded, which is the settings card's cue to
 * say so instead of leaving a silent flat background.
 */
export async function syncWallpaperLayer(
	choice: BackgroundChoice,
	options: { nonce?: number } = {},
): Promise<WallpaperResult> {
	if (!choice.enabled) {
		hideWallpaper();
		return "ok";
	}
	if (choice.source === "file") {
		const blob = await loadWallpaperBlob();
		if (!blob) {
			hideWallpaper();
			return "error";
		}
		return showWallpaper(
			{ src: URL.createObjectURL(blob), blur: choice.blur },
			{ objectUrl: true },
		);
	}
	if (!checkBackgroundUrl(choice.url).ok) {
		hideWallpaper();
		return "error";
	}
	let src = choice.url.trim();
	if (options.nonce) {
		// A reload must actually re-request the bytes; hosts commonly serve a cached copy
		// for the same URL, which looks like "the retry did nothing".
		src += `${src.includes("?") ? "&" : "?"}nf_reload=${options.nonce}`;
	}
	return showWallpaper({ src, blur: choice.blur });
}

/**
 * Apply the stored background as early as possible. The surface variables are synchronous
 * (so the first paint already has the right translucency); the image itself is async.
 */
export function applyInitialBackground(): void {
	if (typeof document === "undefined") return;
	const choice = readStoredBackground();
	applyBackground(document.documentElement, choice);
	void syncWallpaperLayer(choice);
}
