import { describe, expect, test } from "bun:test";
import type { PluginUiContributionItem } from "../../lib/api/plugins";
import {
	fromPluginUiContributionItem,
	PluginContributionStore,
	parsePluginContributionItems,
	pluginContributionKey,
	toPluginUiContribution,
} from "./PluginContributionStore";
import type { PluginContributionRecord } from "./types";

function makeRecord(overrides: Partial<PluginContributionRecord> = {}): PluginContributionRecord {
	return {
		pluginId: "com.example.review",
		contributionId: "dashboard",
		version: "1.0.0",
		hash: "abc123",
		title: "Review Dashboard",
		entryPath: "ui/entry.js",
		stylePath: "ui/style.css",
		availability: "available",
		...overrides,
	};
}

describe("PluginContributionStore", () => {
	test("applies a bounded backend snapshot and resolves records", () => {
		const store = new PluginContributionStore();
		const payload = [
			{
				pluginId: "com.example.review",
				contributionId: "dashboard",
				version: "1.0.0",
				hash: "abc123",
				title: "Review Dashboard",
				entryPath: "ui/entry.js",
				stylePath: "ui/style.css",
				status: "available",
			},
		];
		const count = store.applySnapshot(payload);
		expect(count).toBe(1);
		expect(store.get("com.example.review", "dashboard")).toEqual(makeRecord());
		expect(store.getSnapshot().synced).toBe(true);
		expect(store.getSnapshot().status).toBe("ready");
	});

	test("skips malformed items and keeps the snapshot bounded", () => {
		const store = new PluginContributionStore();
		const payload = [
			null,
			"not-an-object",
			{ pluginId: "missing-fields" },
			{
				pluginId: "com.example.review",
				contributionId: "dashboard",
				version: "1.0.0",
				hash: "abc123",
				title: "Review Dashboard",
				status: "available",
			},
		];
		expect(store.applySnapshot(payload)).toBe(1);
		expect(store.list()).toHaveLength(1);
	});

	test("tracks all supported availability states", () => {
		const store = new PluginContributionStore();
		const payload = [
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1",
				hash: "h1",
				title: "V1",
				status: "available",
			},
			{
				pluginId: "p2",
				contributionId: "v2",
				version: "1",
				hash: "h2",
				title: "V2",
				status: "disabled",
			},
			{
				pluginId: "p3",
				contributionId: "v3",
				version: "1",
				hash: "h3",
				title: "V3",
				status: "denied",
			},
			{
				pluginId: "p4",
				contributionId: "v4",
				version: "1",
				hash: "h4",
				title: "V4",
				status: "incompatible",
			},
		];
		store.applySnapshot(payload);
		expect(store.get("p1", "v1")?.availability).toBe("available");
		expect(store.get("p2", "v2")?.availability).toBe("disabled");
		expect(store.get("p3", "v3")?.availability).toBe("denied");
		expect(store.get("p4", "v4")?.availability).toBe("incompatible");
	});

	test("distinguishes missing contributions from other statuses", () => {
		const store = new PluginContributionStore();
		store.applySnapshot([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1",
				hash: "h1",
				title: "V1",
				status: "available",
			},
		]);
		expect(store.has("p1", "v1")).toBe(true);
		expect(store.has("p1", "unknown")).toBe(false);
		expect(store.get("p1", "unknown")).toBeUndefined();
	});

	test("invalidation marks the snapshot stale without clearing records", () => {
		const store = new PluginContributionStore();
		store.applySnapshot([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1",
				hash: "h1",
				title: "V1",
				status: "available",
			},
		]);
		store.invalidate();
		expect(store.getSnapshot().synced).toBe(false);
		expect(store.getSnapshot().status).toBe("idle");
		expect(store.get("p1", "v1")).toBeDefined();
	});

	test("failed sync keeps previous contributions and records the error", () => {
		const store = new PluginContributionStore();
		store.applySnapshot([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1",
				hash: "h1",
				title: "V1",
				status: "available",
			},
		]);
		store.failSync(new Error("network down"));
		expect(store.get("p1", "v1")).toBeDefined();
		expect(store.getSnapshot().status).toBe("error");
		expect(store.getSnapshot().error).toBe("network down");
	});

	test("notifies subscribers when the snapshot changes", () => {
		const store = new PluginContributionStore();
		let calls = 0;
		const unsubscribe = store.subscribe(() => {
			calls += 1;
		});
		store.beginSync();
		store.applySnapshot([]);
		store.invalidate();
		unsubscribe();
		store.applySnapshot([]);
		expect(calls).toBe(3);
	});

	test("clear resets the snapshot and bumps revision", () => {
		const store = new PluginContributionStore();
		store.applySnapshot([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1",
				hash: "h1",
				title: "V1",
				status: "available",
			},
		]);
		const before = store.getSnapshot().revision;
		store.clear();
		expect(store.getSnapshot().revision).toBe(before + 1);
		expect(store.getSnapshot().synced).toBe(false);
		expect(store.list()).toHaveLength(0);
	});
});

describe("parsePluginContributionItems", () => {
	test("accepts extra fields and preserves optional identity fields", () => {
		const records = parsePluginContributionItems([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "2.0.0",
				hash: "hash2",
				title: "View",
				pluginName: "Example Plugin",
				entryPath: "dist/view.js",
				stylePath: "dist/view.css",
				entryUrl: "https://assets.example/view.js",
				styleUrl: "https://assets.example/view.css",
				status: "available",
				unavailableReason: "should be ignored",
				extra: "kept-out",
			},
		]);
		expect(records).toHaveLength(1);
		expect(records[0]).toEqual({
			pluginId: "p1",
			contributionId: "v1",
			version: "2.0.0",
			hash: "hash2",
			title: "View",
			pluginName: "Example Plugin",
			entryPath: "dist/view.js",
			stylePath: "dist/view.css",
			entryUrl: "https://assets.example/view.js",
			styleUrl: "https://assets.example/view.css",
			availability: "available",
			unavailableReason: undefined,
		});
	});

	test("accepts legacy entry/style aliases from older backends", () => {
		const records = parsePluginContributionItems([
			{
				pluginId: "p1",
				contributionId: "legacy-view",
				version: "1.0.0",
				hash: "legacy-hash",
				title: "Legacy view",
				entry: "legacy/view.js",
				style: "legacy/view.css",
				status: "available",
			},
		]);
		expect(records[0]).toMatchObject({
			entryPath: "legacy/view.js",
			stylePath: "legacy/view.css",
		});
	});

	test("maps unknown status values to disabled", () => {
		const records = parsePluginContributionItems([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1",
				hash: "h1",
				title: "V1",
				status: "pending",
			},
		]);
		expect(records[0]?.availability).toBe("disabled");
	});
});

describe("PluginContributionStore adapters", () => {
	test("pluginContributionKey composes the registry key", () => {
		expect(pluginContributionKey("a", "b")).toBe("a:b");
	});

	test("toPluginUiContribution maps store records to the runtime shape", () => {
		const record = makeRecord({
			pluginName: "Example Plugin",
			entryUrl: "https://assets.example/entry.js",
			styleUrl: "https://assets.example/style.css",
			availability: "denied",
			unavailableReason: "grant revoked",
		});
		expect(toPluginUiContribution(record)).toEqual({
			pluginId: "com.example.review",
			contributionId: "dashboard",
			version: "1.0.0",
			title: "Review Dashboard",
			pluginName: "Example Plugin",
			contentHash: "abc123",
			packageHash: "abc123",
			entryPath: "ui/entry.js",
			stylePath: "ui/style.css",
			entryUrl: "https://assets.example/entry.js",
			styleUrl: "https://assets.example/style.css",
			status: "denied",
			unavailableReason: "grant revoked",
		});
	});

	test("fromPluginUiContributionItem maps backend API items", () => {
		const item: PluginUiContributionItem = {
			pluginId: "p1",
			contributionId: "v1",
			version: "1.2.3",
			hash: "h",
			title: "View",
			entryPath: "e.js",
			stylePath: "s.css",
			status: "available",
		};
		expect(fromPluginUiContributionItem(item)).toEqual({
			pluginId: "p1",
			contributionId: "v1",
			version: "1.2.3",
			hash: "h",
			title: "View",
			entryPath: "e.js",
			stylePath: "s.css",
			availability: "available",
			unavailableReason: undefined,
		});
	});
});
