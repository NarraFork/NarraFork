import { describe, expect, test } from "bun:test";
import type { PluginUiPanelDelegate } from "./host-local-router";
import { routePluginUiHostLocalRequest } from "./host-local-router";
import type { JsonValue, PluginDockPanelParams, UiRpcRequest } from "./protocol";
import { PluginUiHostError } from "./runtime";
import type { PluginUiContext, PluginUiRequestContext } from "./types";

const params: PluginDockPanelParams = {
	panelType: "plugin",
	schemaVersion: 1,
	pluginId: "com.example.review",
	contributionId: "dashboard",
	panelInstanceId: "pui_review",
	binding: { kind: "global" },
};

const context: PluginUiContext = {
	contextVersion: 1,
	host: { appVersion: "0.0.0-test", locale: "en", colorScheme: "dark", platform: "linux" },
	plugin: {
		id: params.pluginId,
		version: "1.0.0",
		contributionId: params.contributionId,
		panelInstanceId: params.panelInstanceId,
	},
	surface: { kind: "settings", active: true, visible: true },
	route: { routeId: "plugin-ui" },
};

function makeRequest(method: string, requestParams?: JsonValue): PluginUiRequestContext {
	const request: UiRpcRequest = {
		protocol: "narrafork.ui/1",
		kind: "request",
		id: `req_${method}`,
		method,
		...(requestParams === undefined ? {} : { params: requestParams }),
	};
	return { params, request, signal: new AbortController().signal };
}

async function route(
	method: string,
	options: Parameters<typeof routePluginUiHostLocalRequest>[1],
	requestParams?: JsonValue,
): Promise<JsonValue | null> {
	const result = routePluginUiHostLocalRequest(makeRequest(method, requestParams), options);
	return result instanceof Promise ? result : result;
}

async function expectError(
	method: string,
	options: Parameters<typeof routePluginUiHostLocalRequest>[1],
	requestParams?: JsonValue,
): Promise<PluginUiHostError> {
	try {
		await route(method, options, requestParams);
	} catch (error) {
		expect(error).toBeInstanceOf(PluginUiHostError);
		return error as PluginUiHostError;
	}
	throw new Error(`Expected ${method} to throw`);
}

describe("routePluginUiHostLocalRequest", () => {
	test("returns null for backend methods so callers forward them", async () => {
		expect(await route("storage.get", {})).toBeNull();
		expect(await route("queries.execute", {})).toBeNull();
		expect(await route("events.poll", {})).toBeNull();
	});

	test("context.get is served host-locally from the handshake data source", async () => {
		const result = await route("context.get", { getContext: () => context });
		expect(result).toEqual(context as unknown as JsonValue);
	});

	test("context.get without a resolver reports CONTEXT_UNAVAILABLE, never a hardcoded stub", async () => {
		const error = await expectError("context.get", {});
		expect(error.code).toBe("CONTEXT_UNAVAILABLE");
	});

	test("context.subscribe is explicitly NOT_SUPPORTED (non-retryable)", async () => {
		const error = await expectError("context.subscribe", { getContext: () => context });
		expect(error.code).toBe("NOT_SUPPORTED");
		expect(error.retryable).toBe(false);
	});

	test("panel.getState returns the delegate-backed panel state", async () => {
		const delegate: PluginUiPanelDelegate = {
			getTitle: () => "Review Dashboard",
			isActive: () => true,
		};
		const result = await route("panel.getState", {
			getPanelDelegate: (id) => (id === params.panelInstanceId ? delegate : undefined),
		});
		expect(result).toEqual({
			panelInstanceId: params.panelInstanceId,
			pluginId: params.pluginId,
			contributionId: params.contributionId,
			binding: { kind: "global" },
			title: "Review Dashboard",
			active: true,
			viewState: null,
			viewStateVersion: null,
		});
	});

	test("panel.setTitle updates the Dockview chrome without any backend call", async () => {
		let title = "";
		const result = await route(
			"panel.setTitle",
			{ getPanelDelegate: () => ({ setTitle: (value) => (title = value) }) },
			{ title: "New Title" },
		);
		expect(result).toEqual({ ok: true });
		expect(title).toBe("New Title");
	});

	test("panel.setTitle rejects empty and overlong titles", async () => {
		const delegate: PluginUiPanelDelegate = { setTitle: () => {} };
		const options = { getPanelDelegate: () => delegate };
		expect((await expectError("panel.setTitle", options, { title: "" })).code).toBe(
			"INVALID_PARAMS",
		);
		expect((await expectError("panel.setTitle", options, { title: "x".repeat(201) })).code).toBe(
			"INVALID_PARAMS",
		);
	});

	test("panel.updateParams only forwards the bounded viewState fields", async () => {
		let patch: Record<string, JsonValue> | undefined;
		const result = await route(
			"panel.updateParams",
			{ getPanelDelegate: () => ({ updateParams: (value) => (patch = value) }) },
			{ viewState: { cursor: 3 }, viewStateVersion: 2, evil: "dropped" },
		);
		expect(result).toEqual({ ok: true });
		expect(patch).toEqual({
			...params,
			viewState: { cursor: 3 },
			viewStateVersion: 2,
		});
		expect(patch).not.toHaveProperty("evil");
	});

	test("panel.focus / panel.close go through the delegate", async () => {
		let focused = 0;
		let closed = 0;
		const options = {
			getPanelDelegate: (): PluginUiPanelDelegate => ({
				focus: () => {
					focused += 1;
				},
				close: () => {
					closed += 1;
				},
			}),
		};
		expect(await route("panel.focus", options)).toEqual({ ok: true });
		expect(await route("panel.close", options)).toEqual({ ok: true });
		expect(focused).toBe(1);
		expect(closed).toBe(1);
	});

	test("panel.open requires the openPanel bridge and validates identity", async () => {
		expect((await expectError("panel.open", {}, { pluginId: "p", contributionId: "v" })).code).toBe(
			"NOT_SUPPORTED",
		);
		const opened: unknown[] = [];
		const result = await route(
			"panel.open",
			{ openPanel: (request) => opened.push(request) },
			{ pluginId: "p2", contributionId: "v2", title: "Other" },
		);
		expect(result).toEqual({ accepted: true });
		expect(opened).toEqual([{ pluginId: "p2", contributionId: "v2", title: "Other" }]);
		expect(
			(await expectError("panel.open", { openPanel: () => {} }, { pluginId: "p2" })).code,
		).toBe("INVALID_PARAMS");
	});

	test("notifications.show forwards to the host notification surface", async () => {
		const shown: unknown[] = [];
		const result = await route(
			"notifications.show",
			{ showNotification: (input) => shown.push(input) },
			{ title: "Hi", message: "hello" },
		);
		expect(result).toEqual({ ok: true });
		expect(shown).toEqual([{ title: "Hi", message: "hello" }]);
		expect((await expectError("notifications.show", {}, { message: "x" })).code).toBe(
			"NOT_SUPPORTED",
		);
		expect((await expectError("notifications.show", { showNotification: () => {} }, {})).code).toBe(
			"INVALID_PARAMS",
		);
	});

	test("ui.openExternal is NOT_SUPPORTED without a policy gate and http(s)-only", async () => {
		expect((await expectError("ui.openExternal", {}, { url: "https://example.com" })).code).toBe(
			"NOT_SUPPORTED",
		);
		const opened: string[] = [];
		expect(
			(
				await expectError(
					"ui.openExternal",
					{ openExternal: (url) => opened.push(url) },
					{ url: "file:///etc/passwd" },
				)
			).code,
		).toBe("INVALID_PARAMS");
		expect(
			await route(
				"ui.openExternal",
				{ openExternal: (url) => opened.push(url) },
				{ url: "https://example.com/docs" },
			),
		).toEqual({ ok: true });
		expect(opened).toEqual(["https://example.com/docs"]);
	});

	test("panel.setHeight resizes through the delegate, clamped to host bounds", async () => {
		// Without a setHeight delegate (Dockview panels) the method is NOT_SUPPORTED, which is
		// the plugin's signal to stop reporting.
		expect((await expectError("panel.setHeight", {}, { height: 400 })).code).toBe("NOT_SUPPORTED");
		const heights: number[] = [];
		const options = {
			getPanelDelegate: (): PluginUiPanelDelegate => ({
				setHeight: (height) => heights.push(height),
			}),
		};
		expect(await route("panel.setHeight", options, { height: 640 })).toEqual({
			ok: true,
			height: 640,
		});
		// Untrusted input is clamped and rounded host-side.
		expect(await route("panel.setHeight", options, { height: 12 })).toEqual({
			ok: true,
			height: 120,
		});
		expect(await route("panel.setHeight", options, { height: 99_999 })).toEqual({
			ok: true,
			height: 5000,
		});
		expect(await route("panel.setHeight", options, { height: 640.6 })).toEqual({
			ok: true,
			height: 641,
		});
		expect(heights).toEqual([640, 120, 5000, 641]);
	});

	test("panel.setHeight validates its params before touching the delegate", async () => {
		const options = {
			getPanelDelegate: (): PluginUiPanelDelegate => ({ setHeight: () => {} }),
		};
		expect((await expectError("panel.setHeight", options)).code).toBe("INVALID_PARAMS");
		expect((await expectError("panel.setHeight", options, {})).code).toBe("INVALID_PARAMS");
		expect((await expectError("panel.setHeight", options, { height: "640" })).code).toBe(
			"INVALID_PARAMS",
		);
		expect((await expectError("panel.setHeight", options, { height: Number.NaN })).code).toBe(
			"INVALID_PARAMS",
		);
	});

	test("panel.setBadge / panel.setDirty report explicit NOT_SUPPORTED", async () => {
		expect((await expectError("panel.setBadge", {}, { text: "1" })).code).toBe("NOT_SUPPORTED");
		expect((await expectError("panel.setDirty", {}, { dirty: true })).code).toBe("NOT_SUPPORTED");
	});

	test("provider.modelsChanged calls the host invalidation with the session's plugin id", async () => {
		expect((await expectError("provider.modelsChanged", {})).code).toBe("NOT_SUPPORTED");
		const invalidated: string[] = [];
		const result = await route("provider.modelsChanged", {
			modelsChanged: (pluginId) => {
				invalidated.push(pluginId);
			},
		});
		expect(result).toEqual({ ok: true });
		expect(invalidated).toEqual([params.pluginId]);
	});

	test("models.test forwards model and prompt, scoped by the session's plugin id", async () => {
		expect((await expectError("models.test", {}, { model: "p:m" })).code).toBe("NOT_SUPPORTED");
		const calls: Array<{ pluginId: string; model: string; prompt?: string }> = [];
		const options = {
			testModel: (pluginId: string, model: string, prompt?: string) => {
				calls.push({ pluginId, model, ...(prompt === undefined ? {} : { prompt }) });
				return Promise.resolve({ ok: true, text: "hi", diagnosticId: null });
			},
		};
		expect(await route("models.test", options, { model: "cline:x-ai/grok-4.5" })).toEqual({
			ok: true,
			text: "hi",
			diagnosticId: null,
		});
		expect(await route("models.test", options, { model: "cline:m", prompt: "ping" })).toEqual({
			ok: true,
			text: "hi",
			diagnosticId: null,
		});
		expect(calls).toEqual([
			{ pluginId: params.pluginId, model: "cline:x-ai/grok-4.5" },
			{ pluginId: params.pluginId, model: "cline:m", prompt: "ping" },
		]);
	});

	test("models.test validates its params before touching the host implementation", async () => {
		const options = { testModel: () => Promise.resolve({ ok: true }) };
		expect((await expectError("models.test", options)).code).toBe("INVALID_PARAMS");
		expect((await expectError("models.test", options, {})).code).toBe("INVALID_PARAMS");
		expect((await expectError("models.test", options, { model: "" })).code).toBe("INVALID_PARAMS");
		expect((await expectError("models.test", options, { model: "x".repeat(301) })).code).toBe(
			"INVALID_PARAMS",
		);
		expect(
			(await expectError("models.test", options, { model: "p:m", prompt: "x".repeat(4001) })).code,
		).toBe("INVALID_PARAMS");
	});
});
