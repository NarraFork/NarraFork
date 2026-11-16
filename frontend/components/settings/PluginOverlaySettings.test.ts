import { describe, expect, test } from "bun:test";
import type { PluginContributionRecord } from "../plugins/types";
import { listOverlayPlugins } from "./PluginOverlaySettings";

function record(overrides: Partial<PluginContributionRecord>): PluginContributionRecord {
	return {
		pluginId: "com.example.pet",
		contributionId: "pet",
		version: "1.0.0",
		hash: "a".repeat(64),
		title: "Pet",
		scope: "global",
		surfaces: ["overlay"],
		availability: "available",
		...overrides,
	};
}

describe("listOverlayPlugins", () => {
	test("groups overlay views per plugin, because visibility is chosen per plugin", () => {
		const plugins = listOverlayPlugins({
			a: record({ contributionId: "cat", title: "Cat", pluginName: "Pets" }),
			b: record({ contributionId: "dog", title: "Dog", pluginName: "Pets" }),
			c: record({ pluginId: "com.example.clock", title: "Clock" }),
		});
		expect(plugins).toEqual([
			{ pluginId: "com.example.clock", label: "com.example.clock", titles: ["Clock"] },
			{ pluginId: "com.example.pet", label: "Pets", titles: ["Cat", "Dog"] },
		]);
	});

	test("lists only overlays the host would actually mount", () => {
		expect(
			listOverlayPlugins({
				dock: record({ surfaces: ["workspace"] }),
				scoped: record({ scope: "workspace" }),
				disabled: record({ availability: "disabled" }),
			}),
		).toEqual([]);
	});
});
