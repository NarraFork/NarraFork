import { describe, expect, test } from "bun:test";
import type {
	PluginCatalogPlugin,
	PluginCatalogSnapshot,
	PluginContributionSummary,
	PluginPackageStatus,
	PluginPackageSummary,
} from "@server/services/plugin-catalog";
import {
	ActivationIndex,
	type PluginContributionKind,
	PluginContributionRegistry,
} from "@server/services/plugin-contribution-registry";

const DEFAULT_HASH = "a".repeat(64);

function contribution(
	pluginId: string,
	id: string,
	kind: PluginContributionKind,
	overrides: Partial<PluginContributionSummary> = {},
): PluginContributionSummary {
	return {
		pluginId,
		version: "1.0.0",
		hash: DEFAULT_HASH,
		id,
		fullId: `${pluginId}/${id}`,
		kind,
		hasSchema: false,
		...overrides,
	};
}

function packageSummary(options: {
	pluginId: string;
	contributions?: PluginContributionSummary[];
	activationEvents?: unknown[];
	status?: PluginPackageStatus;
	hash?: string;
	version?: string;
	diagnostics?: PluginPackageSummary["diagnostics"];
}): PluginPackageSummary {
	const version = options.version ?? "1.0.0";
	const hash = options.hash ?? DEFAULT_HASH;
	return {
		pluginId: options.pluginId,
		version,
		hash,
		path: `/plugins/${options.pluginId}/${version}/${hash}`,
		status: options.status ?? "compatible",
		isCurrent: true,
		manifest: {
			schemaVersion: 1,
			pluginId: options.pluginId,
			version,
			displayName: options.pluginId,
			engine: {
				runtime: "bun",
				hostApi: ">=1.0 <2",
				rpc: "narrafork.rpc/1",
				runner: "local-process",
			},
			activationEvents: (options.activationEvents ?? []) as string[],
		},
		contributions: options.contributions ?? [],
		diagnostics: options.diagnostics ?? [],
	};
}

function pluginFromPackage(packageItem: PluginPackageSummary): PluginCatalogPlugin {
	return {
		pluginId: packageItem.pluginId,
		status: packageItem.status,
		current: { version: packageItem.version, hash: packageItem.hash },
		packages: [packageItem],
		contributions: packageItem.contributions,
		diagnostics: packageItem.diagnostics,
	};
}

function snapshot(...packages: PluginPackageSummary[]): PluginCatalogSnapshot {
	return {
		generatedAt: "2026-07-16T00:00:00.000Z",
		plugins: packages.map(pluginFromPackage),
		packages,
		diagnostics: [],
	};
}

describe("PluginContributionRegistry", () => {
	test("refreshes host-owned static entries by contribution kind", () => {
		const pluginId = "com.example.registry";
		const firstPackage = packageSummary({
			pluginId,
			contributions: [
				contribution(pluginId, "z-tool", "tool", { title: "Tool" }),
				contribution(pluginId, "provider", "provider", { title: "Provider" }),
				contribution(pluginId, "command", "command", { title: "Command" }),
				contribution(pluginId, "event", "event", {
					topic: "narrafork.chapter.lifecycle",
				}),
				contribution(pluginId, "view", "view", { title: "View" }),
			],
		});
		const registry = new PluginContributionRegistry(snapshot(firstPackage));

		expect(registry.list().map((entry) => entry.fullId)).toEqual([
			`${pluginId}/command`,
			`${pluginId}/event`,
			`${pluginId}/provider`,
			`${pluginId}/view`,
			`${pluginId}/z-tool`,
		]);
		expect(registry.listByKind("tool").map((entry) => entry.contributionId)).toEqual(["z-tool"]);
		expect(registry.get(`${pluginId}/provider`)).toMatchObject({
			pluginId,
			version: "1.0.0",
			hash: DEFAULT_HASH,
			contributionId: "provider",
			kind: "provider",
			status: "available",
			unavailableReason: undefined,
		});
		expect(registry.get(`${pluginId}/provider`)?.descriptor.title).toBe("Provider");

		const replacementHash = "b".repeat(64);
		const replacement = packageSummary({
			pluginId,
			hash: replacementHash,
			version: "1.1.0",
			contributions: [
				contribution(pluginId, "new-command", "command", {
					version: "1.1.0",
					hash: replacementHash,
					fullId: `${pluginId}/new-command`,
				}),
			],
		});
		registry.refresh(snapshot(replacement));

		expect(registry.get(`${pluginId}/provider`)).toBeUndefined();
		expect(registry.list().map((entry) => entry.fullId)).toEqual([`${pluginId}/new-command`]);
	});

	test("rejects duplicate fullId entries and records a conflict diagnostic", () => {
		const pluginId = "com.example.conflict";
		const duplicatePackage = packageSummary({
			pluginId,
			contributions: [
				contribution(pluginId, "shared", "tool"),
				contribution(pluginId, "shared", "command"),
			],
		});
		const registry = new PluginContributionRegistry(snapshot(duplicatePackage));

		expect(registry.list()).toHaveLength(1);
		expect(
			registry.diagnostics.some(
				(item) =>
					item.code === "CONTRIBUTION_FULL_ID_CONFLICT" && item.fullId === `${pluginId}/shared`,
			),
		).toBe(true);
	});

	test("keeps known entries unavailable when a package becomes corrupt and rejects incompatible activation", () => {
		const corruptPluginId = "com.example.corrupt-registry";
		const compatible = packageSummary({
			pluginId: corruptPluginId,
			contributions: [contribution(corruptPluginId, "tool", "tool")],
		});
		const registry = new PluginContributionRegistry(snapshot(compatible));
		const corrupt = packageSummary({
			pluginId: corruptPluginId,
			status: "corrupt",
			contributions: [],
			diagnostics: [{ code: "MANIFEST_INVALID", message: "manifest is damaged" }],
		});
		registry.refresh(snapshot(corrupt));

		expect(registry.get(`${corruptPluginId}/tool`)).toMatchObject({
			status: "unavailable",
			unavailableReason: "manifest is damaged",
		});

		const incompatiblePluginId = "com.example.incompatible-registry";
		const incompatible = packageSummary({
			pluginId: incompatiblePluginId,
			status: "incompatible",
			contributions: [contribution(incompatiblePluginId, "command", "command")],
			activationEvents: ["onCommand:command"],
			diagnostics: [{ code: "INCOMPATIBLE_RPC", message: "unsupported RPC" }],
		});
		registry.refresh(snapshot(incompatible));
		expect(registry.get(`${incompatiblePluginId}/command`)).toMatchObject({
			status: "unavailable",
			unavailableReason: "unsupported RPC",
		});
		expect(new ActivationIndex(snapshot(incompatible)).listTargets()).toEqual([]);
	});

	test("marks contributions unavailable and removes a plugin without affecting others", () => {
		const firstId = "com.example.first-registry";
		const secondId = "com.example.second-registry";
		const registry = new PluginContributionRegistry(
			snapshot(
				packageSummary({
					pluginId: firstId,
					contributions: [
						contribution(firstId, "one", "tool"),
						contribution(firstId, "two", "command"),
					],
				}),
				packageSummary({
					pluginId: secondId,
					contributions: [contribution(secondId, "three", "view")],
				}),
			),
		);

		expect(registry.markUnavailable(`${firstId}/one`, "runtime crashed")).toBe(true);
		expect(registry.get(`${firstId}/one`)).toMatchObject({
			status: "unavailable",
			unavailableReason: "runtime crashed",
		});
		expect(registry.get(`${firstId}/two`)?.status).toBe("available");
		expect(registry.removePlugin(firstId)).toBe(2);
		expect(registry.list().map((entry) => entry.pluginId)).toEqual([secondId]);
	});
});

describe("ActivationIndex", () => {
	test("maps supported activation families to stable plugin and contribution targets", () => {
		const pluginId = "com.example.activation";
		const current = packageSummary({
			pluginId,
			contributions: [
				contribution(pluginId, "provider", "provider"),
				contribution(pluginId, "tool", "tool"),
				contribution(pluginId, "command", "command"),
				contribution(pluginId, "view", "view"),
				contribution(pluginId, "event", "event", {
					topic: "narrafork.chapter.lifecycle",
				}),
			],
			activationEvents: [
				"onView:view",
				"onStartup",
				"onTool:tool",
				"onProvider:com.example.activation/provider",
				"onEvent:narrafork.chapter.lifecycle",
				"onSchedule:nightly",
				"onCommand:command",
			],
		});
		const index = new ActivationIndex(snapshot(current));

		expect(index.get("onStartup")).toMatchObject([
			{ pluginId, kind: "onStartup", contributionId: undefined },
		]);
		expect(index.get("onProvider:provider")).toMatchObject([
			{ pluginId, fullId: `${pluginId}/provider`, contributionKind: "provider" },
		]);
		expect(index.get(`onTool:${pluginId}/tool`)).toMatchObject([
			{ pluginId, contributionId: "tool", contributionKind: "tool" },
		]);
		expect(index.get("onCommand:command")[0]?.fullId).toBe(`${pluginId}/command`);
		expect(index.get("onView:view")[0]?.fullId).toBe(`${pluginId}/view`);
		expect(index.get("onEvent:narrafork.chapter.lifecycle")[0]?.fullId).toBe(`${pluginId}/event`);
		expect(index.get("onSchedule:nightly")).toMatchObject([
			{
				pluginId,
				fullId: `${pluginId}/nightly`,
				contributionKind: "schedule",
			},
		]);
		expect(index.listTargets().map((target) => target.kind)).toEqual([
			"onStartup",
			"onCommand",
			"onEvent",
			"onSchedule",
			"onProvider",
			"onTool",
			"onView",
		]);
	});

	test("diagnoses malicious and unknown events without discarding valid mappings", () => {
		const pluginId = "com.example.hostile-activation";
		const hostilePackage = packageSummary({
			pluginId,
			contributions: [
				contribution(pluginId, "safe", "command"),
				contribution(pluginId, "event", "event", { topic: "internal.secret.changed" }),
			],
			activationEvents: [
				"onCommand:safe",
				"onCommand:other.plugin/steal",
				"onTool:../../escape",
				"onStartup:unexpected",
				"onEvent:internal.secret.changed",
				"onSchedule:../escape",
				"onUnknown:anything",
				{ malicious: true },
			],
		});
		const index = new ActivationIndex(snapshot(hostilePackage));

		expect(index.get("onCommand:safe")).toMatchObject([
			{ pluginId, contributionId: "safe", contributionKind: "command" },
		]);
		expect(index.listTargets()).toHaveLength(1);
		expect(new Set(index.diagnostics.map((item) => item.code))).toEqual(
			new Set([
				"ACTIVATION_EVENT_INVALID",
				"ACTIVATION_EVENT_TOPIC_UNKNOWN",
				"ACTIVATION_EVENT_UNKNOWN",
				"ACTIVATION_REFERENCE_INVALID",
				"ACTIVATION_SCHEDULE_ID_INVALID",
			]),
		);
	});
});
