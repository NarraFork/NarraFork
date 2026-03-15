/**
 * Theme bridge: resolves Mantine CSS variables into PixiJS-compatible hex numbers.
 * Call resolvePixiTheme() to get a snapshot; cache it and re-resolve on theme change.
 */

export interface PixiTheme {
	accent: number;
	accentBorder: number;
	trackBg: number;
	canvasBg: number;
	tickDefault: number;
	tickActive: number;
	pillBg: number;
	pillBorder: number;
	dimmed: number;
	statusActive: number;
	statusMerged: number;
	statusDormant: number;
	statusFrozen: number;
	statusAbandoned: number;
	cardBg: number;
	cardBorder: number;
	cardActiveBorder: number;
	cardText: number;
	cardReviewBorder: number;
	narratorRunning: number;
	narratorDone: number;
	narratorError: number;
	narratorWaiting: number;
}

/** Parse a CSS color string (rgb, hex, etc.) into a 0xRRGGBB number. */
function cssColorToHex(css: string): number {
	// Lazy-init offscreen canvas (avoids errors if module is imported in non-browser env)
	if (!cssColorToHex._ctx) {
		const c = document.createElement("canvas");
		c.width = 1;
		c.height = 1;
		// biome-ignore lint/style/noNonNullAssertion: getContext("2d") on a fresh canvas never returns null
		cssColorToHex._ctx = c.getContext("2d", { willReadFrequently: true })!;
	}
	const ctx = cssColorToHex._ctx;
	ctx.clearRect(0, 0, 1, 1);
	ctx.fillStyle = css.trim();
	ctx.fillRect(0, 0, 1, 1);
	const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
	return (r << 16) | (g << 8) | b;
}
cssColorToHex._ctx = null as CanvasRenderingContext2D | null;

/** Read a Mantine CSS variable value from the document root. */
function getVar(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Resolve a Mantine CSS variable to a PixiJS hex number. */
function varToHex(name: string, fallback: number): number {
	const val = getVar(name);
	if (!val) return fallback;
	return cssColorToHex(val);
}

let cached: { scheme: string; theme: PixiTheme } | null = null;

/**
 * Resolve the current Mantine theme into PixiJS colors.
 * Results are cached per color scheme; call this freely in render loops.
 */
export function resolvePixiTheme(): PixiTheme {
	const scheme = document.documentElement.getAttribute("data-mantine-color-scheme") ?? "dark";
	if (cached && cached.scheme === scheme) return cached.theme;

	const theme: PixiTheme = {
		accent: varToHex("--mantine-color-indigo-5", 0x6366f1),
		accentBorder: varToHex("--mantine-color-indigo-7", 0x4f46e5),
		trackBg: varToHex(
			scheme === "dark" ? "--mantine-color-dark-6" : "--mantine-color-gray-1",
			scheme === "dark" ? 0x25262b : 0xf1f3f5,
		),
		canvasBg: varToHex(
			scheme === "dark" ? "--mantine-color-dark-7" : "--mantine-color-gray-0",
			scheme === "dark" ? 0x1a1b1e : 0xf8f9fa,
		),
		tickDefault: varToHex("--mantine-color-dimmed", 0x6b7280),
		tickActive: varToHex("--mantine-color-indigo-5", 0x6366f1),
		pillBg: varToHex(
			scheme === "dark" ? "--mantine-color-dark-5" : "--mantine-color-gray-2",
			scheme === "dark" ? 0x373a40 : 0xe9ecef,
		),
		pillBorder: varToHex(
			scheme === "dark" ? "--mantine-color-dark-4" : "--mantine-color-gray-4",
			scheme === "dark" ? 0x495057 : 0xced4da,
		),
		dimmed: varToHex("--mantine-color-dimmed", 0x909296),
		statusActive: varToHex("--mantine-color-green-5", 0x22c55e),
		statusMerged: varToHex("--mantine-color-blue-5", 0x3b82f6),
		statusDormant: varToHex("--mantine-color-yellow-5", 0xeab308),
		statusFrozen: varToHex("--mantine-color-cyan-5", 0x06b6d4),
		statusAbandoned: varToHex("--mantine-color-gray-5", 0x9ca3af),
		cardBg: varToHex(
			scheme === "dark" ? "--mantine-color-dark-6" : "--mantine-color-white",
			scheme === "dark" ? 0x25262b : 0xffffff,
		),
		cardBorder: varToHex(
			scheme === "dark" ? "--mantine-color-dark-4" : "--mantine-color-gray-4",
			scheme === "dark" ? 0x495057 : 0xced4da,
		),
		cardActiveBorder: varToHex("--mantine-color-indigo-6", 0x4f46e5),
		cardText: varToHex(
			scheme === "dark" ? "--mantine-color-dark-0" : "--mantine-color-dark-9",
			scheme === "dark" ? 0xc1c2c5 : 0x212529,
		),
		cardReviewBorder: varToHex("--mantine-color-yellow-6", 0xca8a04),
		narratorRunning: varToHex("--mantine-color-blue-5", 0x3b82f6),
		narratorDone: varToHex("--mantine-color-green-5", 0x22c55e),
		narratorError: varToHex("--mantine-color-red-5", 0xef4444),
		narratorWaiting: varToHex("--mantine-color-yellow-5", 0xeab308),
	};

	cached = { scheme, theme };
	return theme;
}

/** Invalidate the cache so the next resolvePixiTheme() re-reads CSS variables. */
export function invalidatePixiThemeCache(): void {
	cached = null;
}

/** Get the status color from the theme. */
export function themeStatusColor(theme: PixiTheme, status: string): number {
	switch (status) {
		case "active":
			return theme.statusActive;
		case "merged":
			return theme.statusMerged;
		case "dormant":
			return theme.statusDormant;
		case "frozen":
			return theme.statusFrozen;
		case "abandoned":
			return theme.statusAbandoned;
		default:
			return theme.dimmed;
	}
}
