import { afterEach, describe, expect, test } from "bun:test";
import { pluginContributionStore, toPluginUiContribution } from "./PluginContributionStore";
import type { PluginDockPanelParams } from "./protocol";
import { clearPluginUiContributions, resolvePluginUiContribution } from "./registry";
import type { PluginUiStatus } from "./types";

afterEach(() => {
	clearPluginUiContributions();
});

const params: PluginDockPanelParams = {
	panelType: "plugin",
	schemaVersion: 1,
	pluginId: "com.example.review",
	contributionId: "dashboard",
	panelInstanceId: "pui_review_1",
	binding: { kind: "global" },
	fallback: { title: "Review Dashboard", pluginName: "Review Plugin" },
};

/**
 * Mirror of the PluginDockPanel render-state decision tree. The component
 * itself is a thin Dockview adapter; this matrix is the contract the F2
 * placeholders must honor:
 *
 * | runtime | synced | record      | rendered state      |
 * |---------|--------|-------------|---------------------|
 * | absent  | any    | any         | runtimeUnavailable  |
 * | present | false  | absent      | loading             |
 * | present | true   | absent      | missing             |
 * | present | true   | available   | session lifecycle   |
 * | present | true   | disabled    | disabled            |
 * | present | true   | denied      | denied              |
 * | present | true   | incompatible| incompatible        |
 */
type PanelRenderState =
	| "runtimeUnavailable"
	| "loading"
	| "missing"
	| "session"
	| "disabled"
	| "denied"
	| "incompatible";

function decidePanelState(options: {
	hasRuntime: boolean;
	params: PluginDockPanelParams | null;
}): PanelRenderState {
	if (!options.params) return "runtimeUnavailable";
	if (!options.hasRuntime) return "runtimeUnavailable";
	const contribution = resolvePluginUiContribution(options.params);
	const synced = pluginContributionStore.getSnapshot().synced;
	if (!contribution) return synced ? "missing" : "loading";
	const status: PluginUiStatus | undefined = contribution.status ?? "available";
	if (status === "available") return "session";
	if (status === "disabled") return "disabled";
	if (status === "denied") return "denied";
	if (status === "incompatible") return "incompatible";
	return "missing";
}

function seedRecord(status: string): void {
	pluginContributionStore.applySnapshot([
		{
			pluginId: params.pluginId,
			contributionId: params.contributionId,
			version: "1.0.0",
			hash: "h1",
			title: "Review Dashboard",
			status,
		},
	]);
}

describe("PluginDockPanel render-state contract", () => {
	test("absent runtime is the ONLY runtimeUnavailable state", () => {
		expect(decidePanelState({ hasRuntime: false, params })).toBe("runtimeUnavailable");
	});

	test("unsynced registry renders loading, never missing", () => {
		expect(pluginContributionStore.getSnapshot().synced).toBe(false);
		expect(decidePanelState({ hasRuntime: true, params })).toBe("loading");
	});

	test("synced registry without a record renders missing (uninstalled), not runtimeUnavailable", () => {
		pluginContributionStore.applySnapshot([]);
		expect(decidePanelState({ hasRuntime: true, params })).toBe("missing");
	});

	test("available record renders the session lifecycle", () => {
		seedRecord("available");
		expect(decidePanelState({ hasRuntime: true, params })).toBe("session");
	});

	test("disabled / denied / incompatible map to their own placeholders", () => {
		seedRecord("disabled");
		expect(decidePanelState({ hasRuntime: true, params })).toBe("disabled");
		seedRecord("denied");
		expect(decidePanelState({ hasRuntime: true, params })).toBe("denied");
		seedRecord("incompatible");
		expect(decidePanelState({ hasRuntime: true, params })).toBe("incompatible");
	});

	test("a contribution removed by a resync transitions available → missing", () => {
		seedRecord("available");
		expect(decidePanelState({ hasRuntime: true, params })).toBe("session");
		pluginContributionStore.applySnapshot([]);
		expect(decidePanelState({ hasRuntime: true, params })).toBe("missing");
	});

	test("hash change keeps availability but changes session identity", () => {
		seedRecord("available");
		const beforeRecord = pluginContributionStore.get(params.pluginId, params.contributionId);
		expect(beforeRecord).toBeDefined();
		const before = toPluginUiContribution(beforeRecord as NonNullable<typeof beforeRecord>);
		pluginContributionStore.applySnapshot([
			{
				pluginId: params.pluginId,
				contributionId: params.contributionId,
				version: "1.0.1",
				hash: "h2",
				title: "Review Dashboard",
				status: "available",
			},
		]);
		const afterRecord = pluginContributionStore.get(params.pluginId, params.contributionId);
		expect(afterRecord).toBeDefined();
		const after = toPluginUiContribution(afterRecord as NonNullable<typeof afterRecord>);
		expect(after.status).toBe("available");
		expect(after.packageHash).not.toBe(before.packageHash);
		expect(after.version).not.toBe(before.version);
	});
});
