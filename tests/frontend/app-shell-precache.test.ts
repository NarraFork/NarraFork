import { describe, expect, test } from "bun:test";
import {
	assertAppShellJavaScriptIsPrecached,
	assertModulePreloadsArePrecached,
	extractAppShellUrls,
	filterAppShellManifest,
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
	test("extracts final module scripts and modulepreload URLs", () => {
		expect(extractAppShellUrls(FINAL_HTML)).toEqual({
			scripts: ["registerSW.js", "assets/index-c3.js"],
			moduleScripts: ["assets/index-c3.js"],
			modulePreloads: ["assets/framework-a1.js", "assets/router-b2.js"],
		});
	});

	test("keeps shell JS and existing CSS/font/icon rules without lazy route chunks", () => {
		const manifest = [
			entry("index.html"),
			entry("registerSW.js"),
			entry("assets/index-c3.js"),
			entry("assets/framework-a1.js"),
			entry("assets/router-b2.js"),
			entry("assets/route-narrator-lazy.js"),
			entry("assets/index.css"),
			entry("assets/app.woff2"),
			entry("favicon.svg"),
		];

		expect(filterAppShellManifest(manifest, FINAL_HTML).map(({ url }) => url)).toEqual([
			"index.html",
			"registerSW.js",
			"assets/index-c3.js",
			"assets/framework-a1.js",
			"assets/router-b2.js",
			"assets/index.css",
			"assets/app.woff2",
			"favicon.svg",
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
