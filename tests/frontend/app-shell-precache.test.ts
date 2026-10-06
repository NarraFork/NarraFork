import { describe, expect, test } from "bun:test";
import {
	assertAppShellJavaScriptIsPrecached,
	assertModulePreloadsArePrecached,
	assertNoBrandAssetsArePrecached,
	extractAppShellUrls,
	extractEmittedHtml,
	filterAppShellManifest,
	isBrandDependentPrecacheUrl,
	type PrecacheManifestEntry,
} from "../../frontend/build/app-shell-precache";

const FINAL_HTML = `
<!doctype html>
<html>
	<head>
		<link href="/assets/framework-a1.js" rel="modulepreload">
		<link rel="modulepreload stylesheet" href="./assets/router-b2.js">
		<link rel="stylesheet" href="/assets/index.css">
		<link rel="modulepreload" href="https://cdn.example.com/external.js">
	</head>
	<body>
		<script src="/registerSW.js"></script>
		<script crossorigin type="module" src="/assets/index-c3.js"></script>
	</body>
</html>`;

function entry(url: string): PrecacheManifestEntry {
	return { url, revision: "revision", size: 100 };
}

describe("PWA app shell precache", () => {
	test("reads final HTML from the emitted bundle before it is written to disk", () => {
		const stringBundle = {
			"index.html": {
				fileName: "index.html",
				source: FINAL_HTML,
				type: "asset",
			},
		};
		const byteBundle = {
			"nested-key": {
				fileName: "index.html",
				source: new TextEncoder().encode(FINAL_HTML),
				type: "asset",
			},
		};

		expect(extractEmittedHtml(stringBundle)).toBe(FINAL_HTML);
		expect(extractEmittedHtml(byteBundle)).toBe(FINAL_HTML);
		expect(
			extractEmittedHtml({
				"index.html": { fileName: "index.html", type: "chunk" },
			}),
		).toBeNull();
	});

	test("uses final hashed script and modulepreload names from emitted HTML", () => {
		const emittedHtml = extractEmittedHtml({
			"index.html": {
				fileName: "index.html",
				source: `
					<link rel="modulepreload" href="/assets/framework-Bs7K1x2Q.js">
					<script type="module" src="/assets/index-Cm9P4r8V.js"></script>
				`,
				type: "asset",
			},
		});
		if (emittedHtml == null) throw new Error("Expected emitted index.html");

		const manifest = [
			entry("assets/index-Cm9P4r8V.js"),
			entry("assets/framework-Bs7K1x2Q.js"),
			entry("assets/index-old-hash.js"),
			entry("assets/route-narrator-lazy.js"),
		];

		expect(filterAppShellManifest(manifest, emittedHtml).map(({ url }) => url)).toEqual([
			"assets/index-Cm9P4r8V.js",
			"assets/framework-Bs7K1x2Q.js",
		]);
	});

	test("extracts final module scripts and modulepreload URLs", () => {
		expect(extractAppShellUrls(FINAL_HTML)).toEqual({
			scripts: ["registerSW.js", "assets/index-c3.js"],
			moduleScripts: ["assets/index-c3.js"],
			modulePreloads: ["assets/framework-a1.js", "assets/router-b2.js"],
		});
	});

	test("drops brand-dependent assets whatever injected them", () => {
		// These arrive via `additionalManifestEntries` (includeAssets, and the
		// unconditional manifest entry), so they are already past `globPatterns` by the
		// time this filter runs. Precaching them pins one instance's name and icon
		// colour into every installed app, with no runtime symptom.
		const manifest = [
			entry("index.html"),
			entry("assets/index-c3.js"),
			entry("manifest.webmanifest"),
			entry("favicon.svg"),
			entry("apple-touch-icon-180x180.png"),
			entry("pwa-192x192.png"),
			entry("pwa-512x512.png"),
		];

		expect(filterAppShellManifest(manifest, FINAL_HTML).map(({ url }) => url)).toEqual([
			"index.html",
			"assets/index-c3.js",
		]);
	});

	test("recognizes brand assets through leading-slash and relative forms", () => {
		// Workbox URL forms vary by injection path; matching only the bare name would
		// let "/favicon.svg" through.
		for (const url of ["favicon.svg", "/favicon.svg", "./manifest.webmanifest"]) {
			expect(isBrandDependentPrecacheUrl(url)).toBe(true);
		}
		expect(isBrandDependentPrecacheUrl("assets/logo.svg")).toBe(false);
	});

	test("asserts no brand asset survived into the final precache", () => {
		expect(() => assertNoBrandAssetsArePrecached([entry("index.html")])).not.toThrow();
		expect(() =>
			assertNoBrandAssetsArePrecached([entry("index.html"), entry("manifest.webmanifest")]),
		).toThrow("manifest.webmanifest");
	});

	test("keeps shell JS and existing CSS/font/icon rules without lazy route chunks", () => {
		// `assets/logo.svg` stands in for a non-JS asset here. It used to be
		// `favicon.svg`, which is no longer precached at all now that the icon paths
		// are brand-dependent (see the globPatterns comment in frontend/vite.config.ts)
		// — keeping it would have implied a precache entry that does not exist. The
		// behaviour under test is unchanged: the filter drops only JS that the final
		// HTML does not reference.
		const manifest = [
			entry("index.html"),
			entry("registerSW.js"),
			entry("assets/index-c3.js"),
			entry("assets/framework-a1.js"),
			entry("assets/router-b2.js"),
			entry("assets/route-narrator-lazy.js"),
			entry("assets/index.css"),
			entry("assets/app.woff2"),
			entry("assets/logo.svg"),
		];

		expect(filterAppShellManifest(manifest, FINAL_HTML).map(({ url }) => url)).toEqual([
			"index.html",
			"registerSW.js",
			"assets/index-c3.js",
			"assets/framework-a1.js",
			"assets/router-b2.js",
			"assets/index.css",
			"assets/app.woff2",
			"assets/logo.svg",
		]);
	});

	test("asserts every final modulepreload is included in SW precache", () => {
		const complete = [
			entry("assets/index-c3.js"),
			entry("assets/framework-a1.js"),
			entry("assets/router-b2.js"),
		];
		expect(() => assertModulePreloadsArePrecached(FINAL_HTML, complete)).not.toThrow();
		expect(() => assertModulePreloadsArePrecached(FINAL_HTML, complete.slice(0, 2))).toThrow(
			"assets/router-b2.js",
		);
	});

	test("asserts final HTML scripts are included in SW precache", () => {
		const complete = [
			entry("registerSW.js"),
			entry("assets/index-c3.js"),
			entry("assets/framework-a1.js"),
			entry("assets/router-b2.js"),
		];
		expect(() => assertAppShellJavaScriptIsPrecached(FINAL_HTML, complete)).not.toThrow();
		expect(() => assertAppShellJavaScriptIsPrecached(FINAL_HTML, complete.slice(0, 3))).toThrow(
			"assets/router-b2.js",
		);
		expect(() => assertAppShellJavaScriptIsPrecached(FINAL_HTML, complete.slice(1))).toThrow(
			"registerSW.js",
		);
	});
});
