export interface PrecacheManifestEntry {
	integrity?: string;
	revision: string | null;
	size?: number;
	url: string;
}

export interface AppShellUrls {
	modulePreloads: string[];
	moduleScripts: string[];
	scripts: string[];
}

interface EmittedBundleEntry {
	fileName: string;
	source?: string | Uint8Array;
	type: string;
}

export type EmittedBundle = Record<string, EmittedBundleEntry>;

/** Read final HTML directly from a Vite/Rollup emitted bundle before it reaches disk. */
export function extractEmittedHtml(bundle: EmittedBundle, fileName = "index.html"): string | null {
	const entry =
		bundle[fileName] ?? Object.values(bundle).find((candidate) => candidate.fileName === fileName);
	if (entry?.type !== "asset" || entry.source == null) return null;

	return typeof entry.source === "string" ? entry.source : new TextDecoder().decode(entry.source);
}

function readAttributes(tag: string): Map<string, string> {
	const attributes = new Map<string, string>();
	const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	let match = attributePattern.exec(tag);

	while (match) {
		attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
		match = attributePattern.exec(tag);
	}

	return attributes;
}

/** Normalize a local HTML/manifest URL to Workbox's output-relative URL form. */
export function normalizePrecacheUrl(url: string): string | null {
	const trimmed = url.trim();
	if (!trimmed || trimmed.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
		return null;
	}

	const parsed = new URL(trimmed, "https://narrafork.invalid/");
	const normalized = parsed.pathname.replace(/^\/+/, "");
	return normalized || null;
}

/** Extract script and modulepreload assets from Vite's final generated HTML. */
export function extractAppShellUrls(html: string): AppShellUrls {
	const scripts = new Set<string>();
	const moduleScripts = new Set<string>();
	const modulePreloads = new Set<string>();
	const tagPattern = /<(script|link)\b[^>]*>/gi;

	for (const match of html.matchAll(tagPattern)) {
		const tagName = match[1].toLowerCase();
		const attributes = readAttributes(match[0]);

		if (tagName === "script") {
			const src = normalizePrecacheUrl(attributes.get("src") ?? "");
			if (!src) continue;
			scripts.add(src);
			if ((attributes.get("type") ?? "").toLowerCase() === "module") {
				moduleScripts.add(src);
			}
			continue;
		}

		const relTokens = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		if (!relTokens.includes("modulepreload")) continue;
		const href = normalizePrecacheUrl(attributes.get("href") ?? "");
		if (href) modulePreloads.add(href);
	}

	return {
		scripts: [...scripts],
		moduleScripts: [...moduleScripts],
		modulePreloads: [...modulePreloads],
	};
}

function isJavaScriptUrl(url: string): boolean {
	const normalized = normalizePrecacheUrl(url);
	return normalized != null && /\.(?:m?js)$/i.test(normalized);
}

/**
 * Assets whose bytes are static but whose ROLE depends on instance branding, and
 * which therefore must never be precached.
 *
 * `manifest.webmanifest` is generated per-request (instance name + icon URLs), and
 * index.html swings its icon links between these static defaults and
 * `/api/branding/*` depending on the configured colour. A precache entry pins one
 * build-time revision, so an installed PWA would keep serving the previous brand
 * indefinitely — silently, since precaching is working exactly as designed.
 *
 * Excluding them from `globPatterns` is NOT sufficient, which is the whole reason
 * this list exists: vite-plugin-pwa injects them through `additionalManifestEntries`
 * instead — `includeAssets` for the icons, and `manifest.webmanifest`
 * unconditionally whenever a `manifest` option is present. That path bypasses
 * `globPatterns` entirely. This filter runs in `manifestTransforms`, the one place
 * that sees the final list.
 */
const BRAND_DEPENDENT_PRECACHE_URLS = new Set([
	"manifest.webmanifest",
	"favicon.svg",
	"apple-touch-icon-180x180.png",
	"pwa-192x192.png",
	"pwa-512x512.png",
]);

/** Whether a precache URL points at a brand-dependent asset. */
export function isBrandDependentPrecacheUrl(url: string): boolean {
	const normalized = normalizePrecacheUrl(url);
	return normalized != null && BRAND_DEPENDENT_PRECACHE_URLS.has(normalized);
}

/**
 * Keep non-JS assets selected by Workbox, but restrict JS to files referenced by
 * the final HTML application shell. Route-only lazy chunks remain runtime-cached.
 *
 * Brand-dependent assets are dropped regardless of type — see
 * `BRAND_DEPENDENT_PRECACHE_URLS`.
 */
export function filterAppShellManifest<T extends PrecacheManifestEntry>(
	manifest: T[],
	html: string,
): T[] {
	const shell = extractAppShellUrls(html);
	const shellJavaScript = new Set([...shell.scripts, ...shell.modulePreloads]);

	return manifest.filter((entry) => {
		if (isBrandDependentPrecacheUrl(entry.url)) return false;
		if (!isJavaScriptUrl(entry.url)) return true;
		const normalized = normalizePrecacheUrl(entry.url);
		return normalized != null && shellJavaScript.has(normalized);
	});
}

/**
 * Build-time invariant: no brand-dependent asset survived into the precache.
 *
 * Asserted on the FINAL manifest rather than trusting the filter, because every
 * injection path here is outside our control (a vite-plugin-pwa upgrade could add
 * another one) and the failure is invisible at runtime.
 */
export function assertNoBrandAssetsArePrecached(manifest: PrecacheManifestEntry[]): void {
	const leaked = manifest.map((entry) => entry.url).filter(isBrandDependentPrecacheUrl);

	if (leaked.length > 0) {
		throw new Error(
			`PWA precache still contains brand-dependent assets: ${leaked.join(", ")}. ` +
				"Precaching them pins one instance's name and icon colour into every installed " +
				"app. Find the injection path (includeAssets / includeManifestIcons / the " +
				"unconditional manifest entry) and exclude it.",
		);
	}
}

function getPrecachedUrls(manifest: PrecacheManifestEntry[]): Set<string> {
	return new Set(
		manifest
			.map((entry) => normalizePrecacheUrl(entry.url))
			.filter((url): url is string => url != null),
	);
}

/** Build-time invariant: every final HTML modulepreload must be in SW precache. */
export function assertModulePreloadsArePrecached(
	html: string,
	manifest: PrecacheManifestEntry[],
): void {
	const precached = getPrecachedUrls(manifest);
	const missing = extractAppShellUrls(html).modulePreloads.filter((url) => !precached.has(url));

	if (missing.length > 0) {
		throw new Error(`PWA precache is missing modulepreload assets: ${missing.join(", ")}`);
	}
}

/** Build-time invariant for the final HTML entry scripts plus modulepreloads. */
export function assertAppShellJavaScriptIsPrecached(
	html: string,
	manifest: PrecacheManifestEntry[],
): void {
	assertModulePreloadsArePrecached(html, manifest);
	const precached = getPrecachedUrls(manifest);
	const missing = extractAppShellUrls(html).scripts.filter((url) => !precached.has(url));

	if (missing.length > 0) {
		throw new Error(`PWA precache is missing app shell scripts: ${missing.join(", ")}`);
	}
}
