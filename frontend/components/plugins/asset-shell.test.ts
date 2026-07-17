import { describe, expect, test } from "bun:test";
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
		expect(shell).toContain("sandbox allow-scripts");
		expect(shell).not.toContain("allow-same-origin");
		expect(shell).toContain("connect-src 'none'");
		expect(shell).toContain("entry.js");
		expect(shell).not.toContain("narrafork_token");
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
