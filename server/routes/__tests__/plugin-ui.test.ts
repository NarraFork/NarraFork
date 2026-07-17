import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { uiBootstrapSchema } from "../../../frontend/components/plugins/protocol";
import { PluginUiAssetService } from "../../services/plugin-ui-assets";
import { PluginUiHost } from "../../services/plugin-ui-host";
import { PluginUiSessionService } from "../../services/plugin-ui-session";
import { createPluginUiRoutes } from "../plugin-ui";

const pluginId = "com.example.ui";
const version = "1.0.0";
const hash = "b".repeat(64);

async function makeRoutes(state: { enabled: boolean } = { enabled: true }, uiHost?: PluginUiHost) {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-ui-route-"));
	const packagePath = join(root, "packages", pluginId, version, hash, "ui");
	await mkdir(packagePath, { recursive: true });
	const manifest = {
		schemaVersion: 1,
		pluginId,
		version,
		displayName: "UI",
		engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
		ui: { entry: "ui/index.js" },
		activationEvents: ["onView:panel"],
		contributes: {
			views: [
				{
					id: "panel",
					title: "Panel",
					entry: "ui/index.js",
					surfaces: ["workspace"],
					scope: "workspace",
					instance: "multiple",
				},
			],
		},
		permissions: {
			host: ["ui.panel"],
			network: { mode: "none", allow: [] },
			filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
			process: { spawn: "none" },
		},
	};
	await writeFile(
		join(root, "packages", pluginId, version, hash, "manifest.json"),
		JSON.stringify(manifest),
	);
	await writeFile(join(packagePath, "index.js"), "window.pluginReady = true;");
	const auth: MiddlewareHandler = async (c, next) => {
		c.set("user", { sub: "user-1", role: "user", iat: 0, exp: 9_999_999_999 });
		await next();
	};
	const routes = createPluginUiRoutes({
		authMiddleware: auth,
		assetService: new PluginUiAssetService({ root }),
		sessionService: new PluginUiSessionService(),
		pluginManager: {
			list: async () => [],
			getStatus: async () => ({
				desiredState: state.enabled ? "enabled" : "disabled",
				compatibility: "compatible",
				current: { version, hash },
			}),
		},
		uiHost,
	});
	return routes;
}

describe("plugin UI routes", () => {
	test("creates a bound session, returns bootstrap metadata, and serves immutable shell assets", async () => {
		const routes = await makeRoutes();
		const create = await routes.request("http://localhost/ui/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pluginId,
				version,
				hash,
				contributionId: "panel",
				panelInstanceId: "panel-1",
				surface: "workspace",
				surfaceScope: "workspace",
			}),
		});
		expect(create.status).toBe(200);
		const created = (await create.json()) as {
			session: { sessionId: string; connectNonce: string };
			sessionToken: string;
			shellUrl: string;
			bootstrapUrl: string;
		};
		const bootstrap = await routes.request(
			`http://localhost${created.bootstrapUrl.replace("/api/plugins", "")}?sessionToken=${encodeURIComponent(created.sessionToken)}`,
		);
		expect(bootstrap.status).toBe(200);
		const bootstrapBody = (await bootstrap.json()) as Record<string, unknown>;
		expect(bootstrapBody).toEqual({
			type: "narrafork:ui-connect",
			nonce: created.session.connectNonce,
			protocol: "narrafork.ui/1",
			hostProtocolRange: { min: 1, max: 1 },
			pluginId,
			contributionId: "panel",
			panelInstanceId: "panel-1",
		});
		expect(uiBootstrapSchema.parse(bootstrapBody as unknown)).toEqual(
			bootstrapBody as unknown as ReturnType<typeof uiBootstrapSchema.parse>,
		);
		const shell = await routes.request(
			`http://localhost${created.shellUrl.replace("/api/plugins", "")}`,
		);
		expect(shell.status).toBe(200);
		const csp = shell.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("sandbox allow-scripts");
		expect(csp).not.toContain("allow-same-origin");
		expect(csp).not.toContain("*");
		const asset = await routes.request(
			`http://localhost/ui/${pluginId}/${version}/${hash}/asset/${created.session.sessionId}/ui/index.js?sessionToken=${encodeURIComponent(created.sessionToken)}`,
		);
		expect(asset.status).toBe(200);
		expect(asset.headers.get("cache-control")).toContain("immutable");
		expect(await asset.text()).toContain("pluginReady");
	});

	test("rejects existing shell and asset capabilities after the plugin is disabled", async () => {
		const state = { enabled: true };
		const routes = await makeRoutes(state);
		const create = await routes.request("http://localhost/ui/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pluginId,
				version,
				hash,
				contributionId: "panel",
				panelInstanceId: "panel-disabled",
				surface: "workspace",
				surfaceScope: "workspace",
			}),
		});
		const created = (await create.json()) as {
			session: { sessionId: string };
			sessionToken: string;
			shellUrl: string;
		};
		state.enabled = false;
		const shell = await routes.request(
			`http://localhost${created.shellUrl.replace("/api/plugins", "")}`,
		);
		expect(shell.status).toBe(409);
		const asset = await routes.request(
			`http://localhost/ui/${pluginId}/${version}/${hash}/asset/${created.session.sessionId}/ui/index.js?sessionToken=${encodeURIComponent(created.sessionToken)}`,
		);
		expect(asset.status).toBe(409);
	});

	test("dispatches a principal-bound host request through the backend session", async () => {
		const host = new PluginUiHost({
			capabilityBroker: {
				authorize: async () => ({ allowed: true }) as never,
			},
		});
		const routes = await makeRoutes({ enabled: true }, host);
		const create = await routes.request("http://localhost/ui/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pluginId,
				version,
				hash,
				contributionId: "panel",
				panelInstanceId: "panel-host",
				surface: "workspace",
				surfaceScope: "workspace",
			}),
		});
		const created = (await create.json()) as {
			session: { sessionId: string };
			sessionToken: string;
		};
		const response = await routes.request(
			`http://localhost/ui/sessions/${created.session.sessionId}/request`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-NarraFork-Plugin-Session": created.sessionToken,
				},
				body: JSON.stringify({
					protocol: "narrafork.ui/1",
					kind: "request",
					id: "request-1",
					method: "context.get",
				}),
			},
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { id: string; result: { plugin: { id: string } } };
		expect(body.id).toBe("request-1");
		expect(body.result.plugin.id).toBe(pluginId);
	});

	test("rejects host requests after the plugin is disabled", async () => {
		const state = { enabled: true };
		const routes = await makeRoutes(
			state,
			new PluginUiHost({
				capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			}),
		);
		const create = await routes.request("http://localhost/ui/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pluginId,
				version,
				hash,
				contributionId: "panel",
				panelInstanceId: "panel-host-disabled",
				surface: "workspace",
				surfaceScope: "workspace",
			}),
		});
		const created = (await create.json()) as {
			session: { sessionId: string };
			sessionToken: string;
		};
		state.enabled = false;
		const response = await routes.request(
			`http://localhost/ui/sessions/${created.session.sessionId}/request`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-NarraFork-Plugin-Session": created.sessionToken,
				},
				body: JSON.stringify({
					protocol: "narrafork.ui/1",
					kind: "request",
					id: "request-disabled",
					method: "context.get",
				}),
			},
		);
		expect(response.status).toBe(409);
	});

	test("exposes bounded health metrics for operational consumers", async () => {
		const routes = await makeRoutes();
		const response = await routes.request("http://localhost/ui/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ metrics: [] });
	});
});
