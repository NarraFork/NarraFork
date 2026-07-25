import { describe, expect, test } from "bun:test";
import { isThemeOnlyPlugin, pluginTier } from "@server/lib/plugins/manifest";

/** Minimal manifest-shaped fixtures for the pure tier classifier. */
function fixture(overrides: { server?: unknown; views?: unknown[] }): {
	server?: unknown;
	contributes: { views: unknown[] };
} {
	return {
		...(overrides.server !== undefined ? { server: overrides.server } : {}),
		contributes: { views: overrides.views ?? [] },
	};
}

describe("pluginTier", () => {
	test("classifies a manifest with a server as backend", () => {
		expect(pluginTier(fixture({ server: { entry: "server/index.js" } }))).toBe("backend");
	});

	test("backend takes precedence even when views are also present", () => {
		expect(
			pluginTier(fixture({ server: { entry: "server/index.js" }, views: [{ id: "v" }] })),
		).toBe("backend");
	});

	test("classifies a serverless manifest with views as frontend", () => {
		expect(pluginTier(fixture({ views: [{ id: "panel" }] }))).toBe("frontend");
	});

	test("classifies a serverless, viewless manifest as theme-only", () => {
		expect(pluginTier(fixture({}))).toBe("theme-only");
	});

	test("isThemeOnlyPlugin is true only for the theme-only tier", () => {
		expect(isThemeOnlyPlugin(fixture({}))).toBe(true);
		expect(isThemeOnlyPlugin(fixture({ views: [{ id: "v" }] }))).toBe(false);
		expect(isThemeOnlyPlugin(fixture({ server: {} }))).toBe(false);
	});
});
