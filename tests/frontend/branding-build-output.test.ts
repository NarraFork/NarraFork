/**
 * branding-build-output.test.ts — Assertions on the BUILT artifacts.
 *
 * The source-text guards in `branding-boot.test.ts` protect the config; this file
 * protects the outcome, which is what actually reaches users. The distinction
 * mattered in practice: excluding the brand assets from `globPatterns` looked
 * correct and passed every config-level check, while the built service worker still
 * precached all five of them — vite-plugin-pwa injects them through
 * `additionalManifestEntries`, which Workbox applies after `manifestTransforms`.
 *
 * Skipped when `dist/frontend` has not been built, so a plain `bun test` on a fresh
 * clone does not fail on a missing artifact.
 */

import { describe, expect, test } from "bun:test";

const SW_PATH = "dist/frontend/src-sw.js";
const HTML_PATH = "dist/frontend/index.html";
const MANIFEST_PATH = "dist/frontend/manifest.webmanifest";

const hasBuild = await Bun.file(SW_PATH).exists();

/** Assets that must never carry a build-time revision in the precache. */
const BRAND_ASSETS = [
	"manifest.webmanifest",
	"favicon.svg",
	"apple-touch-icon-180x180.png",
	"pwa-192x192.png",
	"pwa-512x512.png",
];

interface PrecacheEntry {
	url: string;
	revision: string | null;
}

async function readPrecacheEntries(): Promise<PrecacheEntry[]> {
	const source = await Bun.file(SW_PATH).text();
	// The injected manifest is the one array literal of {revision, url} objects.
	const match = source.match(/\[\{"revision"[\s\S]*?\}\]/);
	expect(match).not.toBeNull();
	return JSON.parse(match?.[0] ?? "[]") as PrecacheEntry[];
}

describe.skipIf(!hasBuild)("built service worker precache", () => {
	test("contains no brand-dependent asset", async () => {
		const entries = await readPrecacheEntries();
		const leaked = entries
			.map((entry) => entry.url.replace(/^\.?\//, ""))
			.filter((url) => BRAND_ASSETS.includes(url));
		expect(leaked).toEqual([]);
	});

	test("still precaches the app shell", async () => {
		// The goal is to stop pinning brand assets, not to weaken offline support.
		const entries = await readPrecacheEntries();
		const urls = entries.map((entry) => entry.url);
		expect(urls.some((url) => url.endsWith("index.html"))).toBe(true);
		expect(urls.some((url) => url.includes("registerSW"))).toBe(true);
		expect(urls.filter((url) => url.endsWith(".js")).length).toBeGreaterThan(10);
	});
});

describe.skipIf(!hasBuild)("built web manifest", () => {
	test("is emitted even though VitePWA no longer owns it", async () => {
		expect(await Bun.file(MANIFEST_PATH).exists()).toBe(true);
	});

	test("is a valid installable manifest on its own", async () => {
		// It has to stand alone: a deployment serving dist/ from a static host gets this
		// file verbatim, without the server's per-instance rewrite.
		const manifest = (await Bun.file(MANIFEST_PATH).json()) as {
			name: string;
			short_name: string;
			icons: Array<{ src: string; sizes: string }>;
			theme_color: string;
			start_url: string;
		};
		expect(manifest.name).toBeTruthy();
		expect(manifest.short_name).toBeTruthy();
		expect(manifest.start_url).toBe("/");
		expect(manifest.theme_color).toBe("#1a1b1e");
		expect(manifest.icons.map((icon) => icon.sizes)).toContain("512x512");
	});

	test("is linked from the built HTML", async () => {
		// Turning off VitePWA's manifest also removed its <link> injection. Without a
		// replacement the app silently stops being installable.
		const html = await Bun.file(HTML_PATH).text();
		const links = html.match(/<link rel="manifest"[^>]*>/g) ?? [];
		expect(links).toHaveLength(1);
		expect(links[0]).toContain('href="/manifest.webmanifest"');
	});
});

describe.skipIf(!hasBuild)("built static brand assets", () => {
	test("are still emitted, only their precache entries were dropped", async () => {
		// index.html points at these for unbranded instances, and the server reads them
		// as the source for recolouring.
		for (const file of [
			"dist/frontend/favicon.svg",
			"dist/frontend/pwa-192x192.png",
			"dist/frontend/pwa-512x512.png",
			"dist/frontend/apple-touch-icon-180x180.png",
		]) {
			expect(await Bun.file(file).exists()).toBe(true);
		}
	});
});
