import { afterEach, describe, expect, test } from "bun:test";
import {
	buildPluginDockPanelOpenRequest,
	buildPluginDockPanelParams,
	nextPluginPanelInstanceId,
	type PluginContributionPick,
} from "./PluginContributionPicker";
import { pluginContributionStore } from "./PluginContributionStore";
import { parsePluginDockPanelParams } from "./protocol";
import { clearPluginUiContributions } from "./registry";

afterEach(() => {
	clearPluginUiContributions();
});

describe("buildPluginDockPanelParams", () => {
	test("produces schema-valid params for the Dockview plugin component", () => {
		const params = buildPluginDockPanelParams({
			pluginId: "com.example.review",
			contributionId: "dashboard",
			panelInstanceId: "pui_test_1",
			binding: { kind: "focus-current-narrator" },
			fallback: {
				title: "Review",
				pluginVersion: "1.0.0",
				packageHash: "a".repeat(64),
			},
		});
		const parsed = parsePluginDockPanelParams(params);
		expect(parsed).not.toBeNull();
		expect(parsed?.panelType).toBe("plugin");
		expect(parsed?.pluginId).toBe("com.example.review");
		expect(parsed?.binding).toEqual({ kind: "focus-current-narrator" });
		expect(parsed?.fallback?.packageHash).toBe("a".repeat(64));
	});

	test("defaults to a settings host-surface binding", () => {
		const params = buildPluginDockPanelParams({
			pluginId: "p",
			contributionId: "v",
			panelInstanceId: "pui_x",
		});
		expect(parsePluginDockPanelParams(params)?.binding).toEqual({
			kind: "host-surface",
			surface: "settings",
		});
	});
});

describe("buildPluginDockPanelOpenRequest", () => {
	test("uses the live host surface independently of contribution scope", () => {
		const request = buildPluginDockPanelOpenRequest({
			pick: {
				pluginId: "com.example.review",
				contributionId: "dashboard",
				title: "Review",
				version: "1.0.0",
				hash: "a".repeat(64),
				scope: "global",
			},
			hostContext: { surface: "focus", narratorId: "narrator-1" },
			panels: [
				{ id: "chat-1", params: { panelType: "chat" } },
				{ id: "tool-1", group: "group-1", params: { panelType: "terminal" } },
			],
		});
		expect(request.component).toBe("plugin");
		expect(request.title).toBe("Review");
		expect(request.params.binding).toEqual({
			kind: "focus-current-narrator",
			narratorId: "narrator-1",
		});
		expect(request.params.fallback?.packageHash).toBe("a".repeat(64));
		expect(request.position).toEqual({ referenceGroup: "group-1" });
		expect(parsePluginDockPanelParams(request.params)?.contributionId).toBe("dashboard");
	});

	test("keeps workspace surface binding for a narrator-scope view", () => {
		const request = buildPluginDockPanelOpenRequest({
			pick: {
				pluginId: "p",
				contributionId: "v",
				title: "View",
				version: "1.0.0",
				hash: "a".repeat(64),
				scope: "narrator",
			},
			hostContext: {
				surface: "workspace",
				workspaceId: "workspace-1",
				narratorId: "narrator-1",
			},
			panels: [{ id: "chat-1", params: { panelType: "chat" } }],
		});
		expect(request.params.binding).toEqual({
			kind: "workspace-narrator",
			workspaceId: "workspace-1",
			ownerNarratorId: "narrator-1",
		});
		expect(request.position).toEqual({ referencePanel: "chat-1", direction: "right" });
	});
});

describe("nextPluginPanelInstanceId", () => {
	test("generates unique, schema-valid ids from arbitrary plugin identities", () => {
		const a = nextPluginPanelInstanceId("com.example.review", "dash board");
		const b = nextPluginPanelInstanceId("com.example.review", "dash board");
		expect(a).not.toBe(b);
		expect(a.startsWith("pui_com.example.review_dash_board_")).toBe(true);
		// Must survive the strict id regex used by the panel params schema.
		expect(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(a)).toBe(true);
	});
});

describe("picker → panel discovery contract", () => {
	test("only available contributions are pickable; unavailable ones surface with status", () => {
		pluginContributionStore.applySnapshot([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1.0.0",
				hash: "a".repeat(64),
				scope: "global",
				title: "Available View",
				status: "available",
			},
			{
				pluginId: "p2",
				contributionId: "v2",
				version: "1.0.0",
				hash: "b".repeat(64),
				scope: "global",
				title: "Disabled View",
				status: "disabled",
			},
		]);
		const records = pluginContributionStore.list();
		const pickable: PluginContributionPick[] = records.flatMap((record) => {
			if (record.availability !== "available" || !record.hash) return [];
			return [
				{
					pluginId: record.pluginId,
					contributionId: record.contributionId,
					title: record.title,
					version: record.version ?? "",
					hash: record.hash,
					scope: record.scope,
				},
			];
		});
		expect(pickable).toEqual([
			{
				pluginId: "p1",
				contributionId: "v1",
				title: "Available View",
				version: "1.0.0",
				hash: "a".repeat(64),
				scope: "global",
			},
		]);
	});
});
