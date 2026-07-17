import { describe, expect, test } from "bun:test";
import {
	jsonByteLength,
	makeUiRequest,
	PLUGIN_UI_MAX_VIEW_STATE_BYTES,
	PLUGIN_UI_REQUEST_MAX_BYTES,
	parsePluginDockPanelParams,
	uiBootstrapSchema,
	uiRpcEnvelopeSchema,
	validateUiEnvelope,
} from "./protocol";

describe("plugin UI protocol", () => {
	test("validates the complete bootstrap contract", () => {
		const bootstrap = {
			type: "narrafork:ui-connect" as const,
			nonce: "a".repeat(32),
			protocol: "narrafork.ui/1" as const,
			hostProtocolRange: { min: 1 as const, max: 1 as const },
			pluginId: "com.example.review",
			contributionId: "review-dashboard",
			panelInstanceId: "pui_review",
		};
		expect(uiBootstrapSchema.parse(bootstrap)).toEqual(bootstrap);
		expect(() => uiBootstrapSchema.parse({ ...bootstrap, protocol: "narrafork.ui" })).toThrow();
		expect(() =>
			uiBootstrapSchema.parse({ ...bootstrap, connectNonce: bootstrap.nonce }),
		).toThrow();
	});

	test("accepts JSON-only envelopes and rejects host objects/functions", () => {
		const request = makeUiRequest("context.get", { ok: true, nested: [1, "two"] });
		expect(uiRpcEnvelopeSchema.safeParse(request).success).toBe(true);
		expect(validateUiEnvelope(request, PLUGIN_UI_REQUEST_MAX_BYTES)).toEqual(request);
		expect(validateUiEnvelope({ ...request, params: { fn: () => "no" } })).toBeNull();
		expect(
			validateUiEnvelope({ ...request, params: { __proto__: { polluted: true } } }),
		).toBeNull();
	});

	test("rejects oversized request envelopes", () => {
		const request = makeUiRequest("storage.set", {
			value: "x".repeat(PLUGIN_UI_REQUEST_MAX_BYTES),
		});
		expect(jsonByteLength(request)).toBeGreaterThan(PLUGIN_UI_REQUEST_MAX_BYTES);
		expect(validateUiEnvelope(request, PLUGIN_UI_REQUEST_MAX_BYTES)).toBeNull();
	});

	test("validates immutable panel binding and small view state", () => {
		const valid = parsePluginDockPanelParams({
			panelType: "plugin",
			schemaVersion: 1,
			pluginId: "com.example.review",
			contributionId: "review-dashboard",
			panelInstanceId: "pui_review",
			binding: { kind: "workspace-narrator", workspaceId: "ws1", ownerNarratorId: "n1" },
			viewState: { tab: "summary" },
		});
		expect(valid?.binding).toEqual({
			kind: "workspace-narrator",
			workspaceId: "ws1",
			ownerNarratorId: "n1",
		});
		expect(parsePluginDockPanelParams({ ...valid, pluginId: "../escape" })).toBeNull();
		expect(
			parsePluginDockPanelParams({
				...valid,
				viewState: "x".repeat(PLUGIN_UI_MAX_VIEW_STATE_BYTES),
			}),
		).toBeNull();
	});
});
