import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { createPluginAssetShell, createPluginNonce, isAllowedPluginAssetUrl } from "./asset-shell";

describe("host-controlled plugin asset shell", () => {
	test("uses an opaque-origin-safe sandbox and restrictive CSP", () => {
		const nonce = createPluginNonce();
		const shell = createPluginAssetShell({
			nonce,
			pluginId: "com.example.review",
			contributionId: "dashboard",
			panelInstanceId: "pui_review",
			entryUrl: "/api/plugin-assets/com.example.review/1/hash/entry.js",
			styleUrl: "/api/plugin-assets/com.example.review/1/hash/style.css",
		});
		expect(shell).not.toContain("allow-same-origin");
		expect(shell).toContain("connect-src 'none'");
		expect(shell).toContain("entry.js");
		expect(shell).not.toContain("narrafork_token");
	});

	/**
	 * The sandbox is the IFRAME ATTRIBUTE's job, not the shell's.
	 *
	 * A `sandbox` directive in a `<meta>` CSP is ignored by the browser (it is header-only),
	 * so asserting the shell contains one tested a string that enforced nothing — and would
	 * have kept passing if the real attribute were ever dropped. Pinned here as a source
	 * check on the component that actually renders the frame.
	 */
	test("the sandbox is declared on the iframe, and the shell does not restate it", () => {
		const shell = createPluginAssetShell({
			nonce: createPluginNonce(),
			pluginId: "com.example.review",
			contributionId: "dashboard",
			panelInstanceId: "pui_review",
			entryUrl: "/api/plugin-assets/com.example.review/1/hash/entry.js",
		});
		expect(shell).not.toContain("sandbox");

		const dockPanel = readFileSync(
			new URL("./PluginDockPanel.tsx", import.meta.url).pathname,
			"utf8",
		);
		expect(dockPanel).toContain('sandbox="allow-scripts"');
		expect(dockPanel).not.toContain("allow-same-origin");
	});

	test("removes the host-owned loading splash after the plugin entry loads", () => {
		const shell = createPluginAssetShell({
			nonce: createPluginNonce(),
			pluginId: "com.example.review",
			contributionId: "dashboard",
			panelInstanceId: "pui_review",
			entryUrl: "/api/plugin-assets/com.example.review/1/hash/entry.js",
		});
		expect(shell).toContain(
			'script.onload = () => document.getElementById("plugin-shell-splash")?.remove()',
		);
	});

	test("transparent shells omit the splash without relaxing the asset policy", () => {
		const options = {
			nonce: createPluginNonce(),
			pluginId: "com.example.review",
			contributionId: "dashboard",
			panelInstanceId: "pui_review",
			entryUrl: "/api/plugin-assets/com.example.review/1/hash/entry.js",
		};
		const { document: dock } = parseHTML(createPluginAssetShell(options));
		const { document: overlay } = parseHTML(
			createPluginAssetShell({ ...options, transparent: true }),
		);
		expect(dock.getElementById("plugin-shell-splash")).not.toBeNull();
		expect(overlay.getElementById("plugin-shell-splash")).toBeNull();
		expect(overlay.head.querySelector("style")?.textContent).toContain(
			"html,body{background:transparent!important;}",
		);
		expect(overlay.head.querySelector("style")?.textContent).toContain(
			":root{color-scheme:light dark!important;}",
		);
		expect(dock.head.querySelector("style")?.textContent).not.toContain("background:transparent");
		expect(
			overlay.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
		).toBe(
			dock.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
		);
	});

	test("fails closed when the entry URL is empty", () => {
		expect(isAllowedPluginAssetUrl("")).toBe(false);
		expect(() =>
			createPluginAssetShell({
				nonce: createPluginNonce(),
				pluginId: "com.example.review",
				contributionId: "dashboard",
				panelInstanceId: "pui_review",
				entryUrl: "",
			}),
		).toThrow();
	});

	test("rejects remote and non-HTTP asset URLs", () => {
		expect(isAllowedPluginAssetUrl("https://example.com/plugin.js")).toBe(false);
		expect(isAllowedPluginAssetUrl("data:text/javascript,alert(1)")).toBe(false);
		expect(isAllowedPluginAssetUrl("javascript:alert(1)")).toBe(false);
		expect(() =>
			createPluginAssetShell({
				nonce: createPluginNonce(),
				pluginId: "com.example.review",
				contributionId: "dashboard",
				panelInstanceId: "pui_review",
				entryUrl: "https://example.com/plugin.js",
			}),
		).toThrow();
	});
});
