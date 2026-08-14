import { describe, expect, it } from "bun:test";
import { parseManifest } from "@server/lib/plugins/manifest";
import { createPluginUiRoutes } from "@server/routes/plugin-ui";
import type { MiddlewareHandler } from "hono";

/**
 * `POST /plugins/ui/sessions` is the gate that decides whether a view may run on a
 * given surface. The manifest declares which surfaces a view supports, but the manifest
 * is the plugin's own claim — this route is where the host enforces it.
 *
 * The invariant worth pinning for the new `provider-settings` surface is isolation in
 * both directions: a provider-settings view must not open a session on the plugin detail
 * page (`settings`), and a settings view must not open one in the provider config area.
 * Without that, the surface distinction would be decorative and either surface could
 * host any view.
 */

const pluginId = "com.example.provider-surface";
const version = "1.0.0";
const hash = "a".repeat(64);
const installationId = "installation-provider-surface";

const allowAuth: MiddlewareHandler = async (c, next) => {
	c.set("user", { sub: "user-1", role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
	await next();
};

function manifestWith(views: Array<Record<string, unknown>>) {
	return parseManifest({
		schemaVersion: 1,
		pluginId,
		version,
		displayName: "Provider surface fixture",
		engine: {
			runtime: "bun",
			hostApi: ">=1.0 <2",
			rpc: "narrafork.rpc/1",
			runner: "local-process",
		},
		server: {
			entry: "server/index.js",
			transport: "stdio",
			protocol: "narrafork.rpc/1",
			args: [],
			workingDirectory: "package",
		},
		ui: { entry: "ui/index.js" },
		activationEvents: ["onStartup"],
		contributes: {
			providers: [{ id: "demo", title: "Demo", providerPrefix: "demo" }],
			views,
			tools: [],
			commands: [],
			events: [],
		},
		permissions: {
			host: ["ui.panel", "provider.register"],
			network: { mode: "none", allow: [] },
			filesystem: { package: "readOnly", pluginData: "readWrite", workspace: "none" },
			process: { spawn: "none" },
		},
		secrets: [],
		dependencies: { plugins: {}, runtime: {} },
	});
}

function routes(views: Array<Record<string, unknown>>) {
	const manifest = manifestWith(views);
	return createPluginUiRoutes({
		authMiddleware: allowAuth,
		pluginManager: {
			getStatus: async () => ({
				desiredState: "enabled",
				compatibility: "compatible",
				current: { version, hash },
			}),
			getPermissions: async () => ({
				installationId,
				revision: 1,
				grants: [
					{
						pluginId,
						// The capability binding is keyed by the authority installation id, not the
						// package hash, so this must match what `getPermissions` reports or the grant
						// does not apply to the session being opened.
						installationId,
						grantId: "g1",
						capability: "ui.panel",
						scope: { type: "global" },
						grantedBy: "admin",
						revision: 1,
					},
				],
			}),
		} as never,
		assetService: {
			inspectPackage: async () => ({
				pluginId,
				version,
				hash,
				packagePath: `/virtual/${pluginId}`,
				manifest,
			}),
		} as never,
	});
}

const providerSettingsView = {
	id: "provider-ui",
	title: "Provider settings",
	entry: "ui/provider.js",
	surfaces: ["provider-settings"],
	scope: "global",
	instance: "singleton",
	providerId: "demo",
};

const settingsView = {
	id: "detail-ui",
	title: "Detail settings",
	entry: "ui/detail.js",
	surfaces: ["settings"],
	scope: "global",
	instance: "singleton",
};

async function openSession(
	views: Array<Record<string, unknown>>,
	input: { contributionId: string; surface: string },
) {
	return routes(views).request("/ui/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			pluginId,
			version,
			hash,
			contributionId: input.contributionId,
			panelInstanceId: `panel-${input.surface}`,
			surface: input.surface,
			surfaceScope: "global",
			scope: {},
		}),
	});
}

/**
 * Read the structured error code, or `null` for a success.
 *
 * The surface check (`assertUiContribution`) runs before the capability grant check, so
 * the code distinguishes the two: `PLUGIN_UI_SCOPE_DENIED` means the surface was
 * rejected, anything else means the surface was accepted and a later stage stopped the
 * request. Opening a session for real additionally needs a kernel integration authority
 * registered in the database, which is out of scope here — these tests assert the
 * surface gate, not the full session handshake.
 */
async function errorCodeOf(response: Response): Promise<string | null> {
	if (response.status === 200) return null;
	const body = (await response.json()) as { code?: unknown };
	return typeof body.code === "string" ? body.code : "UNKNOWN";
}

describe("provider-settings surface isolation", () => {
	it("lets a provider-settings view past the surface gate", async () => {
		const response = await openSession([providerSettingsView], {
			contributionId: "provider-ui",
			surface: "provider-settings",
		});
		// Not SCOPE_DENIED: the view declared this surface, so the gate must let it through.
		expect(await errorCodeOf(response)).not.toBe("PLUGIN_UI_SCOPE_DENIED");
	});

	it("refuses a provider-settings view on the plugin detail settings surface", async () => {
		const response = await openSession([providerSettingsView], {
			contributionId: "provider-ui",
			surface: "settings",
		});
		expect(response.status).toBe(403);
		expect(await errorCodeOf(response)).toBe("PLUGIN_UI_SCOPE_DENIED");
	});

	it("refuses a settings view in the provider config area", async () => {
		const response = await openSession([settingsView], {
			contributionId: "detail-ui",
			surface: "provider-settings",
		});
		expect(response.status).toBe(403);
		// Without this the surface distinction would be decorative: any view could be
		// mounted anywhere and the manifest declaration would carry no weight.
		expect(await errorCodeOf(response)).toBe("PLUGIN_UI_SCOPE_DENIED");
	});

	it("lets a view declaring both surfaces past the gate on either one", async () => {
		const dual = { ...providerSettingsView, surfaces: ["provider-settings", "settings"] };
		for (const surface of ["provider-settings", "settings"]) {
			const response = await openSession([dual], { contributionId: "provider-ui", surface });
			expect(await errorCodeOf(response)).not.toBe("PLUGIN_UI_SCOPE_DENIED");
		}
	});

	it("rejects an unknown surface at the request boundary", async () => {
		const response = await openSession([providerSettingsView], {
			contributionId: "provider-ui",
			surface: "provider-config",
		});
		expect(response.status).toBe(400);
	});
});
