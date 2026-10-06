import { describe, expect, test } from "bun:test";
import { ApiError } from "../../lib/api/client";
import type { PluginDockPanelParams, UiRpcRequest } from "./protocol";
import type { PluginUiApiRequest } from "./session-client";
import {
	createPluginUiBackendSession,
	mapHttpErrorToUiRpcError,
	PluginUiRpcError,
	requestPluginUiBackend,
	resolvePluginUiInvocationScope,
	revokePluginUiBackendSession,
} from "./session-client";
import type { PluginUiContribution } from "./types";

const params: PluginDockPanelParams = {
	panelType: "plugin",
	schemaVersion: 1,
	pluginId: "com.example.review",
	contributionId: "dashboard",
	panelInstanceId: "pui_review",
	binding: { kind: "workspace", workspaceId: "ws-1" },
};

const contribution: PluginUiContribution = {
	pluginId: params.pluginId,
	contributionId: params.contributionId,
	version: "1.0.0",
	title: "Review Dashboard",
	entryUrl: "",
	contentHash: "a".repeat(64),
	entryPath: "ui/index.js",
	stylePath: "ui/style.css",
	scope: "workspace",
	status: "available",
};

describe("Plugin UI invocation scope", () => {
	test("derives scope from the contribution and IDs from runtime-only context", () => {
		expect(
			resolvePluginUiInvocationScope(
				{ ...contribution, scope: "workspace" },
				{ surface: "workspace", workspaceId: "ws-1", narratorId: "n-1" },
			),
		).toEqual({ surfaceScope: "workspace", scope: { workspaceId: "ws-1" } });
		expect(
			resolvePluginUiInvocationScope(
				{ ...contribution, scope: "project" },
				{ surface: "focus", projectId: "project-1", narratorId: "n-1" },
			),
		).toEqual({ surfaceScope: "project", scope: { projectId: "project-1" } });
		expect(
			resolvePluginUiInvocationScope(
				{ ...contribution, scope: "narrator" },
				{ surface: "focus", narratorId: "n-1", projectId: "project-1" },
			),
		).toEqual({ surfaceScope: "narrator", scope: { narratorId: "n-1" } });
		expect(
			resolvePluginUiInvocationScope(
				{ ...contribution, scope: "global" },
				{ surface: "workspace", workspaceId: "ws-1", narratorId: "n-1" },
			),
		).toEqual({ surfaceScope: "global", scope: {} });
	});

	test("fails closed when the required live scope ID is unavailable", () => {
		expect(() =>
			resolvePluginUiInvocationScope(
				{ ...contribution, scope: "workspace" },
				{ surface: "workspace" },
			),
		).toThrow("workspace id");
		expect(() =>
			resolvePluginUiInvocationScope(
				{ ...contribution, scope: "project" },
				{ surface: "focus", narratorId: "n-1" },
			),
		).toThrow("project id");
		expect(() =>
			resolvePluginUiInvocationScope(
				{ ...contribution, scope: "narrator" },
				{ surface: "focus", projectId: "project-1" },
			),
		).toThrow("narrator id");
		expect(() =>
			resolvePluginUiInvocationScope(
				{ ...contribution, scope: undefined },
				{ surface: "settings" },
			),
		).toThrow("scope is unavailable");
	});
});

describe("Plugin UI backend session materialization", () => {
	test("creates a principal-bound session and injects session-bound asset URLs", async () => {
		const calls: Array<{ path: string; options?: RequestInit }> = [];
		const apiRequest: PluginUiApiRequest = async <T>(
			path: string,
			options: RequestInit | undefined,
		): Promise<T> => {
			calls.push({ path, options });
			return {
				session: { sessionId: "uis_test", connectNonce: "n".repeat(22) },
				sessionToken: "t".repeat(32),
				assetToken: "a".repeat(32),
			} as T;
		};
		const materialized = await createPluginUiBackendSession(
			params,
			contribution,
			{ surface: "workspace", workspaceId: "ws-1" },
			undefined,
			apiRequest,
		);
		const body = JSON.parse(String(calls[0]?.options?.body));
		expect(calls[0]?.path).toBe("/plugins/ui/sessions");
		expect(body).toEqual({
			pluginId: params.pluginId,
			version: contribution.version,
			hash: contribution.contentHash,
			contributionId: params.contributionId,
			panelInstanceId: params.panelInstanceId,
			surface: "workspace",
			surfaceScope: "workspace",
			scope: { workspaceId: "ws-1" },
		});
		expect(materialized.backendSessionId).toBe("uis_test");
		expect(materialized.nonce).toBe("n".repeat(22));
		expect(materialized.contribution.entryUrl).toBe(
			"/api/plugins/ui/com.example.review/1.0.0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/asset/uis_test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ui/index.js",
		);
		expect(materialized.contribution.styleUrl).toBe(
			"/api/plugins/ui/com.example.review/1.0.0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/asset/uis_test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ui/style.css",
		);
		expect(materialized.contribution.entryUrl).not.toContain("sessionToken=");
	});

	test("revokes the backend session during cleanup", async () => {
		let path = "";
		const apiRequest: PluginUiApiRequest = async <T>(requestPath: string): Promise<T> => {
			path = requestPath;
			return {} as T;
		};
		await revokePluginUiBackendSession("uis_test", apiRequest);
		expect(path).toBe("/plugins/ui/sessions/uis_test");
	});
});

describe("HTTP/RPC error normalization", () => {
	test("maps 401 to a retryable session-invalid error and preserves originalCode", () => {
		const mapped = mapHttpErrorToUiRpcError(new ApiError("Unauthorized", 401, {}));
		expect(mapped).toBeInstanceOf(PluginUiRpcError);
		expect(mapped.code).toBe("PLUGIN_UI_SESSION_INVALID");
		expect(mapped.retryable).toBe(true);
		expect(mapped.details).toMatchObject({ originalCode: "HTTP_401", httpStatus: 401 });
	});

	test("maps 403 to a non-retryable PERMISSION_DENIED", () => {
		const mapped = mapHttpErrorToUiRpcError(new ApiError("Forbidden", 403, {}));
		expect(mapped.code).toBe("PERMISSION_DENIED");
		expect(mapped.retryable).toBe(false);
	});

	test("maps 409 to a retryable CONFLICT", () => {
		const mapped = mapHttpErrorToUiRpcError(new ApiError("Conflict", 409, {}));
		expect(mapped.code).toBe("CONFLICT");
		expect(mapped.retryable).toBe(true);
	});

	test("keeps an extended structured business code from the body", () => {
		const mapped = mapHttpErrorToUiRpcError(
			new ApiError("quota", 413, {
				code: "STORAGE_QUOTA_EXCEEDED",
				message: "too large",
			}),
		);
		expect(mapped.code).toBe("STORAGE_QUOTA_EXCEEDED");
		expect(mapped.details).toMatchObject({ originalCode: "STORAGE_QUOTA_EXCEEDED" });
	});

	test("requestPluginUiBackend surfaces an HTTP error as a structured UiRpcError", async () => {
		const request: UiRpcRequest = {
			protocol: "narrafork.ui/1",
			kind: "request",
			id: "ui_req_1",
			method: "storage.get",
		};
		const apiRequest: PluginUiApiRequest = async () => {
			throw new ApiError("Forbidden", 403, { code: "PERMISSION_DENIED" });
		};
		const error = await requestPluginUiBackend(
			{ sessionId: "uis_1", sessionToken: "t".repeat(32), request },
			apiRequest,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PluginUiRpcError);
		expect((error as PluginUiRpcError).code).toBe("PERMISSION_DENIED");
		expect((error as PluginUiRpcError).retryable).toBe(false);
	});

	test("requestPluginUiBackend unwraps a backend RPC error body without faking success", async () => {
		const request: UiRpcRequest = {
			protocol: "narrafork.ui/1",
			kind: "request",
			id: "ui_req_2",
			method: "storage.set",
		};
		const apiRequest: PluginUiApiRequest = async <T>(): Promise<T> =>
			({
				protocol: "narrafork.ui/1",
				kind: "response",
				id: "ui_req_2",
				error: { code: "STORAGE_QUOTA_EXCEEDED", message: "quota exceeded", retryable: false },
			}) as T;
		const error = await requestPluginUiBackend(
			{ sessionId: "uis_1", sessionToken: "t".repeat(32), request },
			apiRequest,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PluginUiRpcError);
		expect((error as PluginUiRpcError).code).toBe("STORAGE_QUOTA_EXCEEDED");
		expect((error as PluginUiRpcError).retryable).toBe(false);
	});

	test("requestPluginUiBackend maps an abort to CANCELLED", async () => {
		const request: UiRpcRequest = {
			protocol: "narrafork.ui/1",
			kind: "request",
			id: "ui_req_3",
			method: "events.poll",
		};
		const apiRequest: PluginUiApiRequest = async () => {
			throw new DOMException("The operation was aborted", "AbortError");
		};
		const error = await requestPluginUiBackend(
			{ sessionId: "uis_1", sessionToken: "t".repeat(32), request },
			apiRequest,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(PluginUiRpcError);
		expect((error as PluginUiRpcError).code).toBe("CANCELLED");
	});
});
