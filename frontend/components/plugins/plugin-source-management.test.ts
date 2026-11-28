import { expect, test } from "bun:test";
import type { PluginSource, PluginUpdateJob } from "@shared/plugin-source";
import {
	pluginCanUninstall,
	pluginIsCatalogOnly,
	pluginSourceHomepage,
	pluginUpdateDownloadPercent,
	pluginUpdateJobActive,
} from "./plugin-source-management";

const sources: PluginSource[] = [
	{ type: "github", owner: "owner", repo: "repo", assetName: "plugin.nfplugin" },
	{
		type: "website",
		updateApi: "https://updates.example/latest",
		downloadOrigins: [],
		allowInsecureHttp: false,
	},
	{ type: "local", builtinId: "io.narrafork.provider-quota" },
];
test("every source has plain text without an explicit homepage; no repository/feed/publisher fallback", () => {
	for (const source of sources) {
		expect(pluginSourceHomepage(source)).toBeNull();
		expect(pluginSourceHomepage({ ...source, homepage: "https://custom.example/plugin" })).toBe(
			"https://custom.example/plugin",
		);
	}
	expect(pluginSourceHomepage(undefined)).toBeNull();
});
test("unsafe and credential-bearing homepage schemes never become external links", () => {
	const source = sources[0];
	if (!source) throw new Error("source fixture missing");
	for (const homepage of [
		"javascript:alert(1)",
		"data:text/html,evil",
		"file:///private",
		"//example.com/plugin",
		"https://user:password@example.com",
		"https://example.com\\evil",
		"https://example.com\n/evil",
	]) {
		expect(pluginSourceHomepage({ ...source, homepage })).toBeNull();
	}
});
test("explicit package capabilities win over presentation tags and preserve legacy builtin behavior", () => {
	expect(
		pluginCanUninstall({
			pluginId: "io.archive",
			builtin: true,
			canUninstall: true,
			packageKind: "installed",
			origin: "builtin",
		}),
	).toBe(true);
	expect(
		pluginIsCatalogOnly({
			pluginId: "io.archive",
			builtin: true,
			canUninstall: true,
			packageKind: "installed",
		}),
	).toBe(false);
	expect(pluginCanUninstall({ pluginId: "io.directory", packageKind: "builtin-directory" })).toBe(
		false,
	);
	expect(
		pluginCanUninstall({ pluginId: "io.archive", builtin: true, packageKind: "installed" }),
	).toBe(true);
	expect(pluginCanUninstall({ pluginId: "io.directory", builtin: true })).toBe(false);
	expect(pluginCanUninstall({ pluginId: "io.legacy" })).toBe(true);
});
test("job activity and download percentages remain honest for unknown byte counts", () => {
	const job: PluginUpdateJob = {
		id: "j",
		pluginId: "io.example",
		kind: "update",
		status: "running",
		phase: "downloading",
		cancellable: true,
		downloadedBytes: 0,
		totalBytes: null,
		error: null,
		createdAt: "2026-11-01T00:00:00Z",
		updatedAt: "2026-11-01T00:00:00Z",
	};
	expect(pluginUpdateJobActive(job)).toBe(true);
	expect(pluginUpdateDownloadPercent(job)).toBeNull();
	expect(pluginUpdateDownloadPercent({ ...job, downloadedBytes: 25, totalBytes: 100 })).toBe(25);
	expect(pluginUpdateJobActive({ ...job, status: "failed" })).toBe(false);
	expect(pluginUpdateJobActive({ ...job, status: "cancelled" })).toBe(false);
});
