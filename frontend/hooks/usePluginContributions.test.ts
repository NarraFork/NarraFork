import { afterEach, describe, expect, test } from "bun:test";
import { pluginContributionStore } from "../components/plugins/PluginContributionStore";
import { clearPluginUiContributions } from "../components/plugins/registry";
import type { PluginUiContributionItem } from "../lib/api/plugins";
import { toPluginContributionRecords } from "./usePluginContributions";
import { pluginKeys } from "./usePlugins";

afterEach(() => {
	clearPluginUiContributions();
});

describe("toPluginContributionRecords", () => {
	test("maps backend items to host-owned records with availability", () => {
		const items: PluginUiContributionItem[] = [
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1.0.0",
				hash: "h1",
				title: "View 1",
				entryPath: "e.js",
				stylePath: "s.css",
				status: "available",
			},
			{
				pluginId: "p2",
				contributionId: "v2",
				version: "2.0.0",
				hash: "h2",
				title: "View 2",
				status: "disabled",
			},
		];
		expect(toPluginContributionRecords(items)).toEqual([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1.0.0",
				hash: "h1",
				title: "View 1",
				entryPath: "e.js",
				stylePath: "s.css",
				availability: "available",
				unavailableReason: undefined,
			},
			{
				pluginId: "p2",
				contributionId: "v2",
				version: "2.0.0",
				hash: "h2",
				title: "View 2",
				entryPath: undefined,
				stylePath: undefined,
				availability: "disabled",
				unavailableReason: "Plugin UI package is not enabled",
			},
		]);
	});
});

describe("pluginKeys.uiContributions", () => {
	test("uses the shared React Query key for contribution snapshots", () => {
		expect(pluginKeys.uiContributions).toEqual(["plugins", "ui-contributions"]);
	});
});

describe("usePluginContributions store integration contract", () => {
	test("records applied through the store become resolvable contributions", () => {
		const items: PluginUiContributionItem[] = [
			{
				pluginId: "com.example.review",
				contributionId: "dashboard",
				version: "1.0.0",
				hash: "abc",
				title: "Dashboard",
				entryPath: "ui/entry.js",
				status: "available",
			},
		];
		pluginContributionStore.applyRecords(toPluginContributionRecords(items));
		const record = pluginContributionStore.get("com.example.review", "dashboard");
		expect(record?.availability).toBe("available");
		expect(record?.entryPath).toBe("ui/entry.js");
		expect(pluginContributionStore.getSnapshot().synced).toBe(true);
	});
});
