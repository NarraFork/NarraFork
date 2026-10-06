import { describe, expect, test } from "bun:test";
import {
	isKnownPluginUiMethod,
	isPluginUiBackendMethod,
	isPluginUiHostLocalMethod,
	jsonByteLength,
	makeUiRequest,
	PLUGIN_UI_BACKEND_METHODS,
	PLUGIN_UI_HOST_LOCAL_METHODS,
	PLUGIN_UI_MAX_VIEW_STATE_BYTES,
	PLUGIN_UI_REQUEST_MAX_BYTES,
	parsePluginDockPanelParams,
	uiBootstrapSchema,
	uiRpcEnvelopeSchema,
	uiRpcErrorSchema,
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

describe("plugin UI method inventory", () => {
	test("classifies host-local and backend methods without overlap", () => {
		const hostLocal = new Set<string>(PLUGIN_UI_HOST_LOCAL_METHODS);
		const backend = new Set<string>(PLUGIN_UI_BACKEND_METHODS);
		for (const method of hostLocal) {
			expect(backend.has(method)).toBe(false);
			expect(isPluginUiHostLocalMethod(method)).toBe(true);
			expect(isPluginUiBackendMethod(method)).toBe(false);
		}
		for (const method of backend) {
			expect(hostLocal.has(method)).toBe(false);
			expect(isPluginUiBackendMethod(method)).toBe(true);
			expect(isPluginUiHostLocalMethod(method)).toBe(false);
		}
	});

	test("exposes events.poll as a backend method", () => {
		expect(isPluginUiBackendMethod("events.poll")).toBe(true);
		expect(isKnownPluginUiMethod("events.poll")).toBe(true);
	});

	test("keeps context.get host-local so handshake and RPC share one source", () => {
		expect(isPluginUiHostLocalMethod("context.get")).toBe(true);
		expect(isPluginUiBackendMethod("context.get")).toBe(false);
	});

	test("flags unknown methods as not part of the protocol surface", () => {
		expect(isKnownPluginUiMethod("snapshot_live")).toBe(false);
		expect(isKnownPluginUiMethod("backend.call")).toBe(false);
		expect(isKnownPluginUiMethod("totally.unknown")).toBe(false);
	});

	test("accepts bounded open error identifiers, including business codes", () => {
		for (const code of ["NOT_SUPPORTED", "STORAGE_QUOTA_EXCEEDED", "plugin.storage-conflict:v2"]) {
			const parsed = uiRpcErrorSchema.safeParse({
				code,
				message: "method has no host implementation",
				retryable: false,
			});
			expect(parsed.success).toBe(true);
		}
		expect(
			uiRpcErrorSchema.safeParse({ code: "bad code", message: "invalid identifier" }).success,
		).toBe(false);
		expect(
			uiRpcErrorSchema.safeParse({ code: `E${"X".repeat(128)}`, message: "too long" }).success,
		).toBe(false);
	});
});
