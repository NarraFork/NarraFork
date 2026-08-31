/**
 * branding-boot.test.ts — Guards for the branding failure modes that produce NO error.
 *
 * Everything asserted here is a source-text invariant across files that cannot
 * import each other. `index.html`'s boot script is plain inline JS with the storage
 * keys written as literals; the PWA precache config is data consumed by a build
 * plugin. Break either and the app still builds, still runs, and still passes every
 * other test — it just quietly serves the previous brand, which is the exact defect
 * this feature exists to remove.
 *
 * Asserting on source text is the established approach here (see
 * `frontend/lib/safe-area.test.ts`, which reads AppRootLayout the same way).
 */

import { describe, expect, test } from "bun:test";
import {
	BRAND_APPLE_TOUCH_ICON_URL,
	BRAND_FAVICON_URL,
	BRAND_ICON_COLOR_STORAGE_KEY,
	BRAND_NAME_STORAGE_KEY,
	DEFAULT_APPLE_TOUCH_ICON_URL,
	DEFAULT_FAVICON_URL,
} from "../../frontend/lib/branding";

const INDEX_HTML = await Bun.file("frontend/index.html").text();
const VITE_CONFIG = await Bun.file("frontend/vite.config.ts").text();
const SERVICE_WORKER = await Bun.file("frontend/src-sw.ts").text();
const MAIN_TSX = await Bun.file("frontend/main.tsx").text();
// The provider tree lives in App.tsx, not the entry — see that file's header for why
// (an invalid Fast Refresh boundary in main.tsx turned every edit into a full reload).
const APP_TSX = await Bun.file("frontend/App.tsx").text();
const SERVER_MAIN = await Bun.file("server/main.ts").text();

/** Brand assets whose bytes are static but whose ROLE changes with the settings. */
const BRAND_STATIC_PATHS = [
	"/favicon.svg",
	"/apple-touch-icon-180x180.png",
	"/pwa-192x192.png",
	"/pwa-512x512.png",
] as const;

/**
 * The actual glob pattern strings, not the surrounding source text.
 *
 * The block carries a comment naming the very files that must NOT be listed (it
 * explains why they were removed), so a raw substring search over the slice reports
 * a match for every one of them. Extracting the quoted entries keeps the assertion
 * about configuration rather than prose.
 */
function globPatternStrings(): string[] {
	const block = VITE_CONFIG.slice(
		VITE_CONFIG.indexOf("globPatterns"),
		VITE_CONFIG.indexOf("maximumFileSizeToCacheInBytes"),
	);
	expect(block.length).toBeGreaterThan(0);
	// Drop comment lines first, then read the remaining quoted strings.
	const withoutComments = block
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");
	return [...withoutComments.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("index.html boot script", () => {
	test("reads the same localStorage keys lib/branding.ts writes", () => {
		// The keys are duplicated as literals because inline HTML cannot import the
		// module. A rename on one side leaves the tab showing the default name for the
		// duration of every page load, with nothing to indicate why.
		expect(INDEX_HTML).toContain(BRAND_NAME_STORAGE_KEY);
		expect(INDEX_HTML).toContain(BRAND_ICON_COLOR_STORAGE_KEY);
	});

	test("applies the cached name to document.title", () => {
		expect(INDEX_HTML).toMatch(/document\.title\s*=\s*bn/);
	});

	test("points the icon links at the branding endpoints when a colour is cached", () => {
		expect(INDEX_HTML).toContain(BRAND_FAVICON_URL);
		expect(INDEX_HTML).toContain(BRAND_APPLE_TOUCH_ICON_URL);
	});

	test("still ships the static default icon links for unbranded instances", () => {
		// The boot script only rewrites these when a custom colour is cached, so the
		// defaults must remain the markup's starting state.
		expect(INDEX_HTML).toContain(`rel="icon" href="${DEFAULT_FAVICON_URL}"`);
		expect(INDEX_HTML).toContain(`rel="apple-touch-icon" href="${DEFAULT_APPLE_TOUCH_ICON_URL}"`);
	});

	test("keeps every icon href relative so a prefixed mount resolves them", () => {
		// A rooted href addresses the origin root, which behind a reverse-proxy subpath
		// or code-server's `/proxy/<port>/` is the proxy, not us. The icons 404 and the
		// only symptom is a missing favicon — no error anyone would trace back here.
		for (const url of [
			BRAND_FAVICON_URL,
			BRAND_APPLE_TOUCH_ICON_URL,
			DEFAULT_FAVICON_URL,
			DEFAULT_APPLE_TOUCH_ICON_URL,
		]) {
			expect(url.startsWith("/")).toBe(false);
		}
		// And the markup must not reintroduce one.
		expect(INDEX_HTML).not.toMatch(/rel="(?:icon|apple-touch-icon)" href="\//);
	});

	test("guards its storage access", () => {
		// localStorage throws in some embedded/private contexts; an unguarded read here
		// would abort the boot script and take the colour-scheme handling with it.
		const brandingBlock = INDEX_HTML.slice(INDEX_HTML.indexOf(BRAND_NAME_STORAGE_KEY));
		expect(brandingBlock).toContain("catch");
	});
});

describe("PWA precache configuration", () => {
	test("closes every additionalManifestEntries injection path", () => {
		// `globPatterns` is NOT the only way into the precache: vite-plugin-pwa pushes
		// `includeAssets` and the `manifest.icons` (via `includeManifestIcons`) straight
		// into `additionalManifestEntries`, bypassing the globs entirely. Leaving either
		// on precaches the brand icons with a build-time revision, which is exactly the
		// silent pin this feature has to avoid.
		expect(VITE_CONFIG).toMatch(/includeAssets:\s*\[\s*\]/);
		expect(VITE_CONFIG).toMatch(/includeManifestIcons:\s*false/);
	});

	test("does not let VitePWA own the manifest", () => {
		// With `manifest: <object>`, VitePWA appends a manifest.webmanifest precache
		// entry unconditionally, and Workbox applies additionalManifestEntries AFTER
		// manifestTransforms — so our filter and our assertion both run too early to
		// see it. `manifest: false` is the only way to remove it; the manifest is
		// emitted by `webManifestAsset()` instead.
		expect(VITE_CONFIG).toMatch(/manifest:\s*false/);
		expect(VITE_CONFIG).toContain("webManifestAsset(");
	});

	test("the replacement plugin emits the manifest and its link", () => {
		// Turning off VitePWA's manifest also removes the emitted file AND the
		// <link rel="manifest">. Losing either makes the app non-installable, which is a
		// quiet failure: nothing errors, the install prompt simply never appears.
		expect(VITE_CONFIG).toContain('fileName: "manifest.webmanifest"');
		expect(VITE_CONFIG).toContain('rel="manifest"');
	});

	test("asserts on the final manifest rather than trusting the config", () => {
		// Belt and braces for the injection paths that remain outside our control: a
		// future vite-plugin-pwa could add another one, and the failure would be
		// invisible at runtime.
		expect(VITE_CONFIG).toContain("assertNoBrandAssetsArePrecached");
	});

	test("does not list brand assets in globPatterns either", () => {
		expect(globPatternStrings()).not.toContain("manifest.webmanifest");
		expect(globPatternStrings()).not.toContain("favicon.svg");
		expect(globPatternStrings()).not.toContain("apple-touch-icon-180x180.png");
		expect(globPatternStrings()).not.toContain("pwa-*.png");
	});

	test("still precaches the app shell", () => {
		// The point is to stop pinning BRAND assets, not to weaken offline support for
		// the shell itself.
		expect(globPatternStrings()).toContain("index.html");
		expect(globPatternStrings()).toContain("assets/**/*.js");
	});
});

describe("service worker runtime caching", () => {
	test("excludes brand assets from every same-origin cache route", () => {
		// `narrafork-static-media` is CacheFirst with 30-day retention: without the
		// exclusion, changing the icon colour appears to do nothing for a month.
		expect(SERVICE_WORKER).toContain("isBrandAssetPath");
		const routeGuards = SERVICE_WORKER.match(/!isBrandAssetPath\(url\.pathname\)/g) ?? [];
		expect(routeGuards.length).toBe(2);
	});

	test("its brand path set covers every static brand asset plus the manifest", () => {
		// App-relative (no leading slash): a Service Worker sees full pathnames, which
		// carry the mount prefix, so the set is compared against the path with that
		// prefix stripped. Listing rooted paths here would make the exclusion miss
		// under a prefix and silently CacheFirst the brand icons for 30 days.
		for (const path of [...BRAND_STATIC_PATHS, "/manifest.webmanifest"]) {
			expect(SERVICE_WORKER).toContain(`"${path.replace(/^\//, "")}"`);
		}
	});

	test("strips the mount prefix before classifying a path", () => {
		// Without this the worker compares `/proxy/7778/api/health` against `/api/…`,
		// concludes it is not API traffic, and caches API responses — stale data with
		// no error anywhere.
		expect(SERVICE_WORKER).toContain("appRelativePath");
		expect(SERVICE_WORKER).toContain("self.registration.scope");
	});
});

describe("server cache headers", () => {
	test("brand assets are served no-cache so revalidation can pick up a change", () => {
		const noCacheBlock = SERVER_MAIN.slice(
			SERVER_MAIN.indexOf("NO_CACHE_FRONTEND_PATHS"),
			SERVER_MAIN.indexOf("function getFrontendCacheControl"),
		);
		expect(noCacheBlock.length).toBeGreaterThan(0);
		for (const path of [...BRAND_STATIC_PATHS, "/manifest.webmanifest"]) {
			expect(noCacheBlock).toContain(`"${path}"`);
		}
	});

	test("the branded manifest is served from BOTH static-serving branches", () => {
		// A compiled binary serves embedded assets while a source run serves
		// dist/frontend. Wiring only one makes branding work in dev and silently stop
		// working in the shipped binary, or the reverse.
		const calls = SERVER_MAIN.match(/serveBrandedManifest\(c\.req\.path,/g) ?? [];
		expect(calls.length).toBe(2);
	});
});

describe("app shell wiring", () => {
	test("useBranding is mounted so every route including login applies it", () => {
		expect(APP_TSX).toContain("useBranding()");
	});

	test("the entry renders <App />, so the assertion above covers the mounted tree", () => {
		// Without this, moving the tree to a third file would leave the check above green
		// while `useBranding()` was no longer reachable from what actually mounts.
		expect(MAIN_TSX).toContain("<App history={history} />");
	});
});
