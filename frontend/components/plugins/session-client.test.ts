import { describe, expect, test } from "bun:test";
import type { PluginDockPanelParams } from "./protocol";
import type { PluginUiApiRequest } from "./session-client";
import { createPluginUiBackendSession, revokePluginUiBackendSession } from "./session-client";
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
	status: "available",
};

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
			} as T;
		};
		const materialized = await createPluginUiBackendSession(
			params,
			contribution,
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
		expect(materialized.contribution.entryUrl).toContain(
			"/api/plugins/ui/com.example.review/1.0.0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/asset/uis_test/ui/index.js?sessionToken=",
		);
		expect(materialized.contribution.styleUrl).toContain(
			"/asset/uis_test/ui/style.css?sessionToken=",
		);
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
