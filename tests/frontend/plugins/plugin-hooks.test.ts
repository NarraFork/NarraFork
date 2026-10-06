import { describe, expect, test } from "bun:test";
import { invalidatePluginQueries, pluginKeys } from "../../../frontend/hooks/usePlugins";

describe("plugin query invalidation", () => {
	test("lifecycle mutations invalidate list, ui-contributions and ui-health", () => {
		const calls: unknown[][] = [];
		invalidatePluginQueries({
			invalidateQueries: ({ queryKey }) => {
				calls.push([...queryKey]);
			},
		});

		expect(calls).toEqual([["plugins"], ["plugins", "ui-contributions"], ["plugins", "ui-health"]]);
	});

	test("query keys follow the plugins resource convention", () => {
		expect(pluginKeys.all).toEqual(["plugins"]);
		expect(pluginKeys.detail("acme.hello")).toEqual(["plugins", "acme.hello"]);
		expect(pluginKeys.diagnostics("acme.hello")).toEqual(["plugins", "acme.hello", "diagnostics"]);
		expect(pluginKeys.uiContributions).toEqual(["plugins", "ui-contributions"]);
		expect(pluginKeys.uiHealth).toEqual(["plugins", "ui-health"]);
	});

	test("detail and diagnostics keys are covered by the list prefix", () => {
		// Invalidating ["plugins"] must match detail/diagnostics queries too.
		const prefix = pluginKeys.all;
		for (const key of [
			pluginKeys.detail("a"),
			pluginKeys.diagnostics("a"),
			pluginKeys.uiContributions,
			pluginKeys.uiHealth,
		]) {
			expect(key.slice(0, prefix.length)).toEqual([...prefix]);
		}
	});
});
