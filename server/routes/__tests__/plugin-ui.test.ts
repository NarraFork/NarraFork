import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { uiBootstrapSchema } from "../../../frontend/components/plugins/protocol";
import { db } from "../../db";
import { userPluginThemes, users } from "../../db/schema";
import { integrationAuthorityService } from "../../services/integration-authority-service";
import { CapabilityBroker, capabilityBroker } from "../../services/plugin-capability-broker";
import { PluginHealthRegistry } from "../../services/plugin-health";
import { pluginInstallationAuthorityId } from "../../services/plugin-integration-authority-service";
import { PluginUiAssetService } from "../../services/plugin-ui-assets";
import { PluginUiHost } from "../../services/plugin-ui-host";
import { PluginUiSessionService } from "../../services/plugin-ui-session";
import { createPluginUiRoutes } from "../plugin-ui";

const pluginId = "com.example.ui";
const version = "1.0.0";
const hash = "b".repeat(64);
const expectedGrant = {
	capability: "ui.panel" as const,
	scope: { type: "workspace" as const, id: "workspace-1" },
	constraints: { resourceIds: ["workspace-1"], maxRatePerSecond: 25 },
	expiresAt: "2099-07-19T00:00:00.000Z",
	grantId: "grant-ui-panel",
	grantedBy: "admin-1",
};
const defaultPermissionSet = {
	revision: 7,
	grants: [
		{
			...expectedGrant,
			pluginId,
			installationId: "installation-1",
			revision: 7,
		},
	],
};

async function ensureUiIntegrationAuthority(): Promise<void> {
	const authorityId = pluginInstallationAuthorityId(pluginId, hash);
	if (await integrationAuthorityService.getSnapshot(authorityId)) return;
	await integrationAuthorityService.create({
		id: authorityId,
		kind: "plugin_installation",
		integrationId: pluginId,
		initialRevision: defaultPermissionSet.revision,
		metadataJson: { installationId: hash },
		grants: [
			{
				id: expectedGrant.grantId,
				capabilityId: "ui.panel",
				scope: expectedGrant.scope,
				constraints: expectedGrant.constraints,
				expiresAt: expectedGrant.expiresAt,
				createdBy: { type: "user", id: expectedGrant.grantedBy },
			},
		],
	});
}

async function makeRoutes(
	state: { enabled: boolean } = { enabled: true },
	uiHost?: PluginUiHost,
	options: {
		permissions?: typeof defaultPermissionSet | null;
		sessionService?: PluginUiSessionService;
		capabilityBroker?: CapabilityBroker;
	} = {},
) {
	await ensureUiIntegrationAuthority();
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
				{
					id: "quiet",
					title: "Quiet",
					entry: "ui/quiet.js",
					style: "ui/quiet.css",
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
	await writeFile(join(packagePath, "quiet.js"), "window.quietPluginReady = true;");
	await writeFile(join(packagePath, "quiet.css"), "body { color: blue; }");
	const auth: MiddlewareHandler = async (c, next) => {
		c.set("user", { sub: "user-1", role: "user", iat: 0, exp: 9_999_999_999 });
		await next();
	};
	const permissions =
		options.permissions === undefined ? defaultPermissionSet : options.permissions;
	const routes = createPluginUiRoutes({
		authMiddleware: auth,
		assetService: new PluginUiAssetService({ root }),
		sessionService: options.sessionService ?? new PluginUiSessionService(),
		capabilityBroker: options.capabilityBroker,
		pluginManager: {
			list: async () => [],
			getStatus: async () => ({
				desiredState: state.enabled ? "enabled" : "disabled",
				compatibility: "compatible",
				current: { version, hash },
			}),
			...(permissions ? { getPermissions: async () => permissions } : {}),
		},
		uiHost,
		healthRegistry: new PluginHealthRegistry(),
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
				scope: { workspaceId: "workspace-1" },
			}),
		});
		expect(create.status).toBe(200);
		const created = (await create.json()) as {
			session: { sessionId: string; connectNonce: string };
			sessionToken: string;
			assetToken: string;
			shellUrl: string;
			bootstrapUrl: string;
		};
		const binding = capabilityBroker.getBinding(pluginId, `ui:${created.session.sessionId}`);
		expect(binding?.installationGrants).toEqual([expectedGrant]);
		expect(binding?.grantRevision).toBe(defaultPermissionSet.revision);
		const bootstrapUrl = `http://localhost${created.bootstrapUrl.replace("/api/plugins", "")}`;
		const queryOnlyBootstrap = await routes.request(
			`${bootstrapUrl}?sessionToken=${encodeURIComponent(created.sessionToken)}`,
		);
		expect(queryOnlyBootstrap.status).toBe(401);
		const bootstrap = await routes.request(bootstrapUrl, {
			headers: { "X-NarraFork-Plugin-Session": created.sessionToken },
		});
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
		expect(created.shellUrl).not.toContain("sessionToken=");
		const csp = shell.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("sandbox allow-scripts");
		expect(csp).not.toContain("allow-same-origin");
		expect(csp).not.toContain("*");
		const asset = await routes.request(
			`http://localhost/ui/${pluginId}/${version}/${hash}/asset/${created.session.sessionId}/${created.assetToken}/ui/index.js`,
		);
		expect(asset.status).toBe(200);
		expect(asset.headers.get("cache-control")).toBe("private, no-store");
		expect(await asset.text()).toContain("pluginReady");
		const legacyAsset = await routes.request(
			`http://localhost/ui/${pluginId}/${version}/${hash}/asset/${created.session.sessionId}/ui/index.js?sessionToken=${encodeURIComponent(created.sessionToken)}`,
		);
		expect(legacyAsset.status).toBe(401);
		const wrongAsset = await routes.request(
			`http://localhost/ui/${pluginId}/${version}/${hash}/asset/${created.session.sessionId}/${"x".repeat(32)}/ui/index.js`,
		);
		expect(wrongAsset.status).toBe(401);
	});

	test("serves the selected view assets instead of reusing manifest.ui", async () => {
		const routes = await makeRoutes();
		const create = await routes.request("http://localhost/ui/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pluginId,
				version,
				hash,
				contributionId: "quiet",
				panelInstanceId: "panel-quiet",
				surface: "workspace",
				surfaceScope: "workspace",
				scope: { workspaceId: "workspace-1" },
			}),
		});
		expect(create.status).toBe(200);
		const created = (await create.json()) as {
			session: { sessionId: string };
			sessionToken: string;
			assetToken: string;
			shellUrl: string;
		};
		const shell = await routes.request(
			`http://localhost${created.shellUrl.replace("/api/plugins", "")}`,
		);
		expect(shell.status).toBe(200);
		const html = await shell.text();
		expect(html).toContain(`/asset/${created.session.sessionId}/${created.assetToken}/ui/quiet.js`);
		expect(html).toContain(
			`/asset/${created.session.sessionId}/${created.assetToken}/ui/quiet.css`,
		);
		expect(html).not.toContain(
			`/asset/${created.session.sessionId}/${created.assetToken}/ui/index.js`,
		);
		expect(html).not.toContain("sessionToken=");
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
				scope: { workspaceId: "workspace-1" },
			}),
		});
		const created = (await create.json()) as {
			session: { sessionId: string };
			sessionToken: string;
			assetToken: string;
			shellUrl: string;
		};
		state.enabled = false;
		const shell = await routes.request(
			`http://localhost${created.shellUrl.replace("/api/plugins", "")}`,
		);
		expect(shell.status).toBe(409);
		const asset = await routes.request(
			`http://localhost/ui/${pluginId}/${version}/${hash}/asset/${created.session.sessionId}/${created.assetToken}/ui/index.js`,
		);
		expect(asset.status).toBe(409);
	});

	test("fails closed when full permission details are unavailable", async () => {
		const routes = await makeRoutes({ enabled: true }, undefined, { permissions: null });
		const response = await routes.request("http://localhost/ui/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pluginId,
				version,
				hash,
				contributionId: "panel",
				panelInstanceId: "panel-no-permissions",
				surface: "workspace",
				surfaceScope: "workspace",
				scope: { workspaceId: "workspace-1" },
			}),
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "PLUGIN_UI_PERMISSIONS_UNAVAILABLE",
		});
	});

	test("rejects empty, expired, and scope-mismatched ui.panel grants", async () => {
		const cases = [
			{
				name: "empty",
				permissions: { ...defaultPermissionSet, grants: [] },
			},
			{
				name: "expired",
				permissions: {
					...defaultPermissionSet,
					grants: [
						{
							...defaultPermissionSet.grants[0],
							expiresAt: "2026-07-18T00:00:00.000Z",
						},
					],
				},
			},
			{
				name: "scope-mismatch",
				permissions: {
					...defaultPermissionSet,
					grants: [
						{
							...defaultPermissionSet.grants[0],
							scope: { type: "workspace" as const, id: "workspace-2" },
						},
					],
				},
			},
		];
		for (const testCase of cases) {
			const routes = await makeRoutes({ enabled: true }, undefined, {
				permissions: testCase.permissions,
			});
			const response = await routes.request("http://localhost/ui/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					pluginId,
					version,
					hash,
					contributionId: "panel",
					panelInstanceId: `panel-${testCase.name}`,
					surface: "workspace",
					surfaceScope: "workspace",
					scope: { workspaceId: "workspace-1" },
				}),
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "PLUGIN_UI_PERMISSION_DENIED" });
		}
	});

	test("requires the identifier selected by surfaceScope", async () => {
		const routes = await makeRoutes();
		for (const [surfaceScope, requiredKey] of [
			["workspace", "workspaceId"],
			["narrator", "narratorId"],
			["project", "projectId"],
		] as const) {
			const response = await routes.request("http://localhost/ui/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					pluginId,
					version,
					hash,
					contributionId: "panel",
					panelInstanceId: `panel-${surfaceScope}`,
					surface: "workspace",
					surfaceScope,
				}),
			});
			expect(response.status).toBe(400);
			expect(await response.text()).toContain(`scope.${requiredKey}`);
		}
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
				scope: { workspaceId: "workspace-1" },
			}),
		});
		const created = (await create.json()) as {
			session: { sessionId: string };
			sessionToken: string;
			assetToken: string;
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
				scope: { workspaceId: "workspace-1" },
			}),
		});
		const created = (await create.json()) as {
			session: { sessionId: string };
			sessionToken: string;
			assetToken: string;
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

	test("cascades every session removal path into the actual host and capability broker", async () => {
		let now = new Date("2026-07-20T00:00:00.000Z");
		const sessions = new PluginUiSessionService({
			now: () => now,
			ttlMs: 1000,
			setTimeout: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: () => undefined,
		});
		const broker = new CapabilityBroker();
		class TrackingHost extends PluginUiHost {
			readonly removals: Array<{ sessionId: string; reason: string }> = [];

			override revokeSession(sessionId: string, reason = "session-revoked"): number {
				this.removals.push({ sessionId, reason });
				return super.revokeSession(sessionId, reason);
			}
		}
		const host = new TrackingHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
			eventGateway: {
				subscribe: async () => ({
					subscriptionId: "unused",
					mode: "live",
					delivery: {
						maxFrameBytes: 1024,
						queueEvents: 10,
						queueBytes: 4096,
						maxRatePerSecond: 10,
					},
				}),
				unsubscribe: () => false,
				poll: () => [],
				revokeSession: () => 0,
			},
		});
		const routes = await makeRoutes({ enabled: true }, host, {
			sessionService: sessions,
			capabilityBroker: broker,
		});
		const createSession = async (panelInstanceId: string) => {
			const response = await routes.request("http://localhost/ui/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					pluginId,
					version,
					hash,
					contributionId: "panel",
					panelInstanceId,
					surface: "workspace",
					surfaceScope: "workspace",
					scope: { workspaceId: "workspace-1" },
				}),
			});
			expect(response.status).toBe(200);
			return (await response.json()) as {
				session: { sessionId: string };
				sessionToken: string;
			};
		};

		const deleted = await createSession("panel-delete");
		expect(broker.hasBinding(pluginId, `ui:${deleted.session.sessionId}`)).toBe(true);
		const deletedResponse = await routes.request(
			`http://localhost/ui/sessions/${deleted.session.sessionId}`,
			{ method: "DELETE" },
		);
		expect(deletedResponse.status).toBe(200);
		expect(await deletedResponse.json()).toEqual({ revoked: true });
		expect(broker.hasBinding(pluginId, `ui:${deleted.session.sessionId}`)).toBe(false);

		const expired = await createSession("panel-expired");
		now = new Date("2026-07-20T00:00:02.000Z");
		expect(sessions.get(expired.session.sessionId)).toBeUndefined();
		expect(broker.hasBinding(pluginId, `ui:${expired.session.sessionId}`)).toBe(false);

		const cleared = await createSession("panel-cleared");
		expect(sessions.clearForPlugin(pluginId, "plugin-disabled")).toBe(1);
		expect(broker.hasBinding(pluginId, `ui:${cleared.session.sessionId}`)).toBe(false);
		expect(host.removals).toEqual([
			{ sessionId: deleted.session.sessionId, reason: "revoked" },
			{ sessionId: expired.session.sessionId, reason: "expired" },
			{ sessionId: cleared.session.sessionId, reason: "plugin-disabled" },
		]);
		sessions.close();
	});

	test("rejects oversized JSON before route parsing", async () => {
		const routes = await makeRoutes();
		const body = JSON.stringify({ padding: "x".repeat(256 * 1024) });
		for (const headers of [
			new Headers({ "content-type": "application/json" }),
			new Headers({ "content-type": "application/json", "content-length": "1" }),
		]) {
			const response = await routes.request("http://localhost/ui/sessions", {
				method: "POST",
				headers,
				body,
			});
			expect(response.status).toBe(413);
			expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
		}
	});

	test("replaces the route removal cascade when a factory is recreated", () => {
		const sessions = new PluginUiSessionService();
		const broker = new CapabilityBroker();
		class TrackingHost extends PluginUiHost {
			removals = 0;

			override revokeSession(sessionId: string, reason = "session-revoked"): number {
				this.removals += 1;
				return super.revokeSession(sessionId, reason);
			}
		}
		const host = new TrackingHost({
			capabilityBroker: { authorize: async () => ({ allowed: true }) as never },
		});
		const options = {
			authMiddleware: (async (_c, next) => next()) as MiddlewareHandler,
			sessionService: sessions,
			capabilityBroker: broker,
			uiHost: host,
		};
		createPluginUiRoutes(options);
		createPluginUiRoutes(options);
		const created = sessions.create({
			pluginId,
			version,
			hash,
			principalId: "user-1",
			contributionId: "panel",
			panelInstanceId: "listener-test",
			surface: "workspace",
			surfaceScope: "workspace",
			scope: { workspaceId: "workspace-1" },
		});
		expect(sessions.remove(created.session.sessionId, "test-removal")).toBe(true);
		expect(host.removals).toBe(1);
		sessions.close();
	});

	test("exposes bounded health metrics for operational consumers", async () => {
		const routes = await makeRoutes();
		const response = await routes.request("http://localhost/ui/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ metrics: [] });
	});
});

describe("plugin UI theme endpoint (per-user)", () => {
	const themePluginId = "com.example.theme";
	const themeVersion = "1.0.0";
	const themeHash = "c".repeat(64);
	const themeUserId = "theme-user-1";

	interface ThemeManagerOptions {
		desiredState?: string;
		themeCss?: string;
	}

	function seedThemeUser(): void {
		// Idempotent: FK on user_plugin_themes.userId requires a real user row.
		try {
			db.insert(users)
				.values({
					id: themeUserId,
					username: themeUserId,
					passwordHash: "test-password-hash",
					role: "user",
					createdAt: new Date().toISOString(),
				})
				.run();
		} catch {
			// already seeded
		}
	}

	function clearThemeState(): void {
		db.delete(userPluginThemes).where(eq(userPluginThemes.userId, themeUserId)).run();
	}

	function makeThemeRoutes(options: ThemeManagerOptions = {}) {
		const {
			desiredState = "enabled",
			themeCss = ':root[data-plugin-theme="com.example.theme__sunset"] { --mantine-color-body: #1a1512; }\n',
		} = options;
		const auth: MiddlewareHandler = async (c, next) => {
			c.set("user", { sub: themeUserId, role: "user", iat: 0, exp: 9_999_999_999 });
			await next();
		};
		return createPluginUiRoutes({
			authMiddleware: auth,
			pluginManager: {
				list: async () => [
					{
						pluginId: themePluginId,
						desiredState,
						current: { version: themeVersion, hash: themeHash },
						contributions: [
							{
								kind: "theme",
								id: "sunset",
								title: "Sunset",
								colorScheme: "dark",
								themeCss,
							},
						],
					},
				],
				getStatus: async () => ({
					desiredState,
					compatibility: "compatible",
					current: { version: themeVersion, hash: themeHash },
				}),
			},
			healthRegistry: new PluginHealthRegistry(),
		});
	}

	test("available lists theme-only themes with per-user enabled=false initially", async () => {
		seedThemeUser();
		clearThemeState();
		const routes = makeThemeRoutes();
		const response = await routes.request("http://localhost/ui/themes/available");
		expect(response.status).toBe(200);
		const body = (await response.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(1);
		expect(body[0]).toMatchObject({
			pluginId: themePluginId,
			themeId: "sunset",
			title: "Sunset",
			colorScheme: "dark",
			enabled: false,
		});
	});

	test("themes returns nothing until the user enables one", async () => {
		seedThemeUser();
		clearThemeState();
		const routes = makeThemeRoutes();
		const before = await routes.request("http://localhost/ui/themes");
		expect(await before.json()).toEqual([]);

		const toggle = await routes.request(`http://localhost/ui/themes/${themePluginId}/sunset`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		expect(toggle.status).toBe(200);
		expect(await toggle.json()).toMatchObject({ enabled: true });

		const after = await routes.request("http://localhost/ui/themes");
		const body = (await after.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(1);
		expect(body[0]).toMatchObject({ pluginId: themePluginId, themeId: "sunset" });
		expect(String(body[0].css)).toContain("--mantine-color-body");
	});

	test("disabling a theme removes it from the user's set", async () => {
		seedThemeUser();
		clearThemeState();
		const routes = makeThemeRoutes();
		await routes.request(`http://localhost/ui/themes/${themePluginId}/sunset`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		await routes.request(`http://localhost/ui/themes/${themePluginId}/sunset`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		const after = await routes.request("http://localhost/ui/themes");
		expect(await after.json()).toEqual([]);
	});

	test("enabling a non-existent theme returns 404", async () => {
		seedThemeUser();
		clearThemeState();
		const routes = makeThemeRoutes();
		const response = await routes.request(`http://localhost/ui/themes/${themePluginId}/ghost`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		expect(response.status).toBe(404);
	});

	test("a disabled plugin exposes no available themes", async () => {
		seedThemeUser();
		clearThemeState();
		const routes = makeThemeRoutes({ desiredState: "disabled" });
		const response = await routes.request("http://localhost/ui/themes/available");
		expect(await response.json()).toEqual([]);
	});

	test("a theme with empty compiled CSS is not offered", async () => {
		seedThemeUser();
		clearThemeState();
		const routes = makeThemeRoutes({ themeCss: "" });
		const response = await routes.request("http://localhost/ui/themes/available");
		expect(await response.json()).toEqual([]);
	});
});

describe("plugin UI theme-asset endpoint", () => {
	const tPluginId = "com.example.scenic";
	const tVersion = "1.0.0";
	const tHash = "d".repeat(64);

	async function makeThemeAssetRoutes(opts: { enabled?: boolean } = {}) {
		const enabled = opts.enabled ?? true;
		const root = await mkdtemp(join(tmpdir(), "narrafork-theme-asset-"));
		const pkgDir = join(root, "packages", tPluginId, tVersion, tHash);
		await mkdir(join(pkgDir, "assets"), { recursive: true });
		const manifest = {
			schemaVersion: 1,
			pluginId: tPluginId,
			version: tVersion,
			displayName: "Scenic",
			engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
			activationEvents: [],
			contributes: {
				themes: [
					{
						id: "scenic",
						title: "Scenic",
						colorScheme: "both",
						tokens: { backgrounds: { main: { image: "assets/bg.png" } } },
					},
				],
			},
			permissions: {
				host: ["ui.theme"],
				network: { mode: "none", allow: [] },
				filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
				process: { spawn: "none" },
			},
		};
		await writeFile(join(pkgDir, "manifest.json"), JSON.stringify(manifest));
		// A 1x1 PNG (bytes are irrelevant to the route; declaredAssets + path matter).
		await writeFile(join(pkgDir, "assets", "bg.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		await writeFile(join(pkgDir, "assets", "secret.png"), Buffer.from([0x89, 0x50]));
		const auth: MiddlewareHandler = async (c, next) => {
			c.set("user", { sub: "u1", role: "user", iat: 0, exp: 9_999_999_999 });
			await next();
		};
		return createPluginUiRoutes({
			authMiddleware: auth,
			assetService: new PluginUiAssetService({ root }),
			pluginManager: {
				list: async () => [],
				getStatus: async () => ({
					desiredState: enabled ? "enabled" : "disabled",
					compatibility: "compatible",
					current: { version: tVersion, hash: tHash },
				}),
			},
			healthRegistry: new PluginHealthRegistry(),
		});
	}

	const assetUrl = (path: string) =>
		`http://localhost/ui/${tPluginId}/${tVersion}/${tHash}/theme-asset/${path}`;

	test("serves a declared theme background image without a session", async () => {
		const routes = await makeThemeAssetRoutes();
		const res = await routes.request(assetUrl("assets/bg.png"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
	});

	test("refuses an undeclared file in the same package", async () => {
		const routes = await makeThemeAssetRoutes();
		const res = await routes.request(assetUrl("assets/secret.png"));
		expect(res.status).toBe(404);
	});

	test("refuses path traversal", async () => {
		const routes = await makeThemeAssetRoutes();
		const res = await routes.request(assetUrl("../manifest.json"));
		// Either rejected as traversal or simply not a declared asset.
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test("refuses when the plugin is disabled", async () => {
		const routes = await makeThemeAssetRoutes({ enabled: false });
		const res = await routes.request(assetUrl("assets/bg.png"));
		expect(res.status).toBe(409);
	});

	test("hardens every served background against direct-navigation script execution", async () => {
		const routes = await makeThemeAssetRoutes();
		const res = await routes.request(assetUrl("assets/bg.png"));
		expect(res.status).toBe(200);
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("sandbox");
		expect(res.headers.get("content-disposition")).toBe("inline");
	});

	/**
	 * This route is unauthenticated and same-origin, so the extension of a declared
	 * background decides the response Content-Type. Serving an active type would be
	 * same-origin script delivery, reachable by any logged-in user because
	 * theme-only plugins are not admin-gated. Both the manifest schema and the
	 * route must refuse; these cases cover the route half.
	 */
	describe("refuses active content types (same-origin XSS guard)", () => {
		async function makeRoutesServingDeclared(assetPath: string, body: string) {
			const root = await mkdtemp(join(tmpdir(), "narrafork-theme-active-"));
			const pkgDir = join(root, "packages", tPluginId, tVersion, tHash);
			await mkdir(join(pkgDir, "assets"), { recursive: true });
			const manifest = {
				schemaVersion: 1,
				pluginId: tPluginId,
				version: tVersion,
				displayName: "Scenic",
				engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
				activationEvents: [],
				contributes: {
					themes: [
						{
							id: "scenic",
							title: "Scenic",
							colorScheme: "both",
							tokens: { backgrounds: { body: { image: assetPath } } },
						},
					],
				},
				permissions: {
					host: ["ui.theme"],
					network: { mode: "none", allow: [] },
					filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
					process: { spawn: "none" },
				},
			};
			await writeFile(join(pkgDir, "manifest.json"), JSON.stringify(manifest));
			await writeFile(join(pkgDir, assetPath), body);
			const auth: MiddlewareHandler = async (c, next) => {
				c.set("user", { sub: "u1", role: "user", iat: 0, exp: 9_999_999_999 });
				await next();
			};
			return createPluginUiRoutes({
				authMiddleware: auth,
				assetService: new PluginUiAssetService({ root }),
				pluginManager: {
					list: async () => [],
					getStatus: async () => ({
						desiredState: "enabled",
						compatibility: "compatible",
						current: { version: tVersion, hash: tHash },
					}),
				},
				healthRegistry: new PluginHealthRegistry(),
			});
		}

		test.each([
			["assets/xss.html", "<script>alert(document.domain)</script>"],
			["assets/steal.js", "export const x = 1;"],
			["assets/bg.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
			["assets/data.json", "{}"],
			["assets/theme.css", ":root{}"],
		])("never serves %s as an executable/active type", async (assetPath, body) => {
			const routes = await makeRoutesServingDeclared(assetPath, body);
			const res = await routes.request(assetUrl(assetPath));
			// Refused as an error, never a 200 with the attacker's bytes. In practice
			// the manifest guard rejects the package first (422); the route-level
			// content-type guard would return 404 if a manifest ever slipped through.
			expect(res.ok).toBe(false);
			expect([404, 422]).toContain(res.status);
			const type = res.headers.get("content-type") ?? "";
			expect(type).not.toContain("text/html");
			expect(type).not.toContain("javascript");
			expect(type).not.toContain("image/svg");
			expect(await res.text()).not.toContain(body);
		});

		/**
		 * Exercises the route guard on its own: a stub asset service returns an
		 * active content type as if a manifest regression had let one through, so
		 * this fails if the route ever trusts `asset.contentType` again.
		 */
		test("route guard refuses an active content type even if the manifest allowed it", async () => {
			const auth: MiddlewareHandler = async (c, next) => {
				c.set("user", { sub: "u1", role: "user", iat: 0, exp: 9_999_999_999 });
				await next();
			};
			const routes = createPluginUiRoutes({
				authMiddleware: auth,
				assetService: {
					readAsset: async () => ({
						pluginId: tPluginId,
						version: tVersion,
						hash: tHash,
						path: "assets/bg.png",
						bytes: new TextEncoder().encode("<script>alert(1)</script>"),
						contentType: "text/html; charset=utf-8",
					}),
				} as unknown as PluginUiAssetService,
				pluginManager: {
					list: async () => [],
					getStatus: async () => ({
						desiredState: "enabled",
						compatibility: "compatible",
						current: { version: tVersion, hash: tHash },
					}),
				},
				healthRegistry: new PluginHealthRegistry(),
			});
			const res = await routes.request(assetUrl("assets/bg.png"));
			expect(res.status).toBe(404);
			expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
			expect(await res.text()).not.toContain("<script>");
		});
	});
});
