import { describe, expect, it } from "bun:test";
import type { MiddlewareHandler } from "hono";
import {
	createPluginRoutes,
	type PluginManager,
	type ProviderCatalogRouteRefresher,
	type ProviderConfigRouteService,
} from "../../../server/routes/plugins";
import { PluginPermissionConflictError } from "../../../server/services/plugin-permission-store";
import { PluginProviderCatalogRefresher } from "../../../server/services/plugin-provider-catalog-refresh";
import { PluginProviderConfigService } from "../../../server/services/plugin-provider-config-service";

const allowAdmin: MiddlewareHandler = async (_c, next) => {
	await next();
};

const allowNamedAdmin: MiddlewareHandler = async (c, next) => {
	c.set("user", {
		sub: "admin-user-42",
		role: "admin",
		iat: 0,
		exp: Number.MAX_SAFE_INTEGER,
	});
	await next();
};

class MockPluginManager implements PluginManager {
	readonly calls: Array<{ method: string; value: unknown }> = [];
	listResult: unknown = {
		generatedAt: "2026-07-16T00:00:00.000Z",
		plugins: [
			{
				pluginId: "com.example.demo",
				status: "compatible",
				desiredState: "disabled",
				manifest: { permissions: { secret: "do-not-return" } },
				rawManifest: "do-not-return",
				rawStderr: "do-not-return",
				path: "/private/plugin/path",
				contributions: [
					{
						id: "tool",
						fullId: "com.example.demo/tool",
						kind: "tool",
						title: "Demo tool",
						hasSchema: true,
						inputSchema: { type: "object", secret: "do-not-return" },
					},
				],
			},
		],
	};
	detailResult: unknown = {
		pluginId: "com.example.demo",
		status: "compatible",
		version: "1.0.0",
		displayName: "Demo",
		manifest: { raw: true },
		path: "/private/plugin/path",
	};
	permissionError?: unknown;
	permissionsResult: unknown = {
		pluginId: "com.example.demo",
		installationId: "installation-1",
		revision: 3,
		updatedAt: "2026-07-18T00:00:00.000Z",
		grants: [
			{
				pluginId: "com.example.demo",
				installationId: "installation-1",
				grantId: "grant-1",
				capability: "query.read.projects",
				scope: { type: "global" },
				constraints: { fields: ["id"] },
				expiresAt: "2026-08-18T00:00:00.000Z",
				grantedBy: "admin-user-1",
				revision: 3,
				internalSecret: "do-not-return",
			},
		],
	};
	diagnosticsResult: unknown = {
		pluginId: "com.example.demo",
		status: "failed",
		runtimeId: "rt_1",
		generation: 2,
		stderr: `token=super-secret\n${"x".repeat(1_500)}`,
		diagnostics: [
			{
				code: "PROCESS_EXIT",
				message: "plugin failed",
				path: "/private/plugin/path",
				raw: "do-not-return",
			},
		],
	};

	list(): unknown {
		return this.listResult;
	}

	getStatus(pluginId: string): unknown {
		this.calls.push({ method: "getStatus", value: pluginId });
		return this.detailResult;
	}

	getDiagnostics(pluginId: string): unknown {
		this.calls.push({ method: "getDiagnostics", value: pluginId });
		return this.diagnosticsResult;
	}

	getPermissions(pluginId: string): unknown {
		this.calls.push({ method: "getPermissions", value: pluginId });
		return this.permissionsResult;
	}

	replacePermissions(pluginId: string, input: unknown): unknown {
		this.calls.push({ method: "replacePermissions", value: { pluginId, input } });
		if (this.permissionError) throw this.permissionError;
		return {
			status: { pluginId, desiredState: "enabled", internalSecret: "do-not-return" },
			permissions: this.permissionsResult,
		};
	}

	revokePermissions(pluginId: string, input: unknown): unknown {
		this.calls.push({ method: "revokePermissions", value: { pluginId, input } });
		return {
			status: { pluginId, desiredState: "enabled", internalSecret: "do-not-return" },
			permissions: {
				...(this.permissionsResult as Record<string, unknown>),
				grants: [],
				revision: 4,
			},
		};
	}

	async install(source: string | File | Uint8Array): Promise<unknown> {
		const value = source instanceof File ? `file:${source.name}` : source;
		this.calls.push({ method: "install", value });
		return { pluginId: "com.example.demo", status: "installed", path: value };
	}

	async enable(pluginId: string): Promise<unknown> {
		this.calls.push({ method: "enable", value: pluginId });
		return { desiredState: "enabled" };
	}

	async disable(pluginId: string): Promise<unknown> {
		this.calls.push({ method: "disable", value: pluginId });
		return { desiredState: "disabled" };
	}

	async activate(pluginId: string): Promise<unknown> {
		this.calls.push({ method: "activate", value: pluginId });
		return { runtimeState: "active" };
	}

	async uninstall(pluginId: string): Promise<unknown> {
		this.calls.push({ method: "uninstall", value: pluginId });
		return { desiredState: "uninstalling" };
	}

	async retry(pluginId: string): Promise<unknown> {
		this.calls.push({ method: "retry", value: pluginId });
		return { runtimeState: "starting" };
	}
}

function createApp(manager: PluginManager, enabled = true, adminMiddleware = allowAdmin) {
	return createPluginRoutes(manager, {
		enabled,
		adminMiddleware,
		installRoots: ["/safe/plugin-imports"],
		// Seed an admin session so tests targeting non-tier concerns (validation,
		// lifecycle delegation, path confinement) exercise the operation itself
		// rather than being blocked by the tier gate. Dedicated tier tests below
		// inject their own non-admin/admin middleware.
		authMiddleware: allowNamedAdmin,
	});
}

describe("plugin routes", () => {
	it("returns bounded list summaries without manifest, paths, schemas, or raw stderr", async () => {
		const app = createApp(new MockPluginManager());
		const response = await app.request("/");

		expect(response.status).toBe(200);
		const body = await response.json();
		const json = JSON.stringify(body);
		expect(json).toContain("com.example.demo");
		expect(json).toContain("Demo tool");
		expect(json).not.toContain("rawManifest");
		expect(json).not.toContain("manifest");
		expect(json).not.toContain("inputSchema");
		expect(json).not.toContain("/private/plugin/path");
		expect(json).not.toContain("do-not-return");
	});

	it("returns detail and 404s missing plugins with a structured error", async () => {
		const manager = new MockPluginManager();
		const app = createApp(manager);
		const detail = await app.request("/com.example.demo");
		expect(detail.status).toBe(200);
		expect(JSON.stringify(await detail.json())).not.toContain("manifest");

		manager.detailResult = null;
		const missing = await app.request("/com.example.missing");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({
			error: "Plugin not found: com.example.missing",
			code: "NOT_FOUND",
		});
	});

	it("returns redacted and bounded diagnostics without paths or raw fields", async () => {
		const app = createApp(new MockPluginManager());
		const response = await app.request("/com.example.demo/diagnostics");

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			stderrSummary: string;
			diagnostics: Array<Record<string, unknown>>;
		};
		const json = JSON.stringify(body);
		expect(body.stderrSummary.length).toBeLessThanOrEqual(1_000);
		expect(json).not.toContain("super-secret");
		expect(json).not.toContain("/private/plugin/path");
		expect(json).not.toContain("do-not-return");
		expect(body.diagnostics).toEqual([{ code: "PROCESS_EXIT", message: "plugin failed" }]);
	});

	it("exposes an admin-only bounded grant API and stamps the authenticated admin actor", async () => {
		const manager = new MockPluginManager();
		const app = createApp(manager, true, allowNamedAdmin);
		const listed = await app.request("/com.example.demo/grants");
		expect(listed.status).toBe(200);
		const listedBody = (await listed.json()) as Record<string, unknown>;
		expect(listedBody).toMatchObject({
			pluginId: "com.example.demo",
			installationId: "installation-1",
			revision: 3,
			grantCount: 1,
			hasMore: false,
		});
		expect(JSON.stringify(listedBody)).not.toContain("internalSecret");
		const grants = listedBody.grants as Array<Record<string, unknown>>;
		expect(grants[0]).not.toHaveProperty("pluginId");
		expect(grants[0]).not.toHaveProperty("installationId");

		const replaced = await app.request("/com.example.demo/grants", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				expectedRevision: 3,
				grants: [
					{
						grantId: "grant-1",
						capability: "query.read.projects",
						scope: { type: "global" },
						grantedBy: "forged-admin",
						revision: 3,
					},
				],
			}),
		});
		expect(replaced.status).toBe(200);
		const call = manager.calls.find((entry) => entry.method === "replacePermissions");
		expect(call?.value).toMatchObject({
			pluginId: "com.example.demo",
			input: {
				expectedRevision: 3,
				grantedBy: "admin-user-42",
				grants: [{ grantId: "grant-1", grantedBy: "admin-user-42", revision: 3 }],
			},
		});
		expect(JSON.stringify(await replaced.json())).not.toContain("internalSecret");

		const revoked = await app.request("/com.example.demo/grants/revoke", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: 3, grantIds: ["grant-1"] }),
		});
		expect(revoked.status).toBe(200);
		expect(manager.calls.find((entry) => entry.method === "revokePermissions")?.value).toEqual({
			pluginId: "com.example.demo",
			input: {
				expectedRevision: 3,
				grantIds: ["grant-1"],
				grantedBy: "admin-user-42",
			},
		});
	});

	it("rejects malformed grant mutations before calling the manager", async () => {
		const manager = new MockPluginManager();
		const app = createApp(manager);
		const response = await app.request("/com.example.demo/grants", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				expectedRevision: -1,
				grants: [],
				unknown: true,
			}),
		});
		expect(response.status).toBe(400);
		expect(manager.calls.some((entry) => entry.method === "replacePermissions")).toBe(false);
	});

	it("returns a structured 409 when the grant revision CAS fails", async () => {
		const manager = new MockPluginManager();
		manager.permissionError = new PluginPermissionConflictError("com.example.demo", 2, 3);
		const app = createApp(manager);
		const response = await app.request("/com.example.demo/grants", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: 2, grants: [] }),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "Plugin permission revision conflict for com.example.demo: expected 2, current 3",
			code: "PERMISSION_REVISION_CONFLICT",
		});
	});

	it("validates install input, confines paths, and returns 201", async () => {
		const manager = new MockPluginManager();
		const app = createApp(manager);
		const installed = await app.request("/install", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "demo.nfplugin" }),
		});

		expect(installed.status).toBe(201);
		expect(manager.calls.at(-1)).toEqual({
			method: "install",
			value: "/safe/plugin-imports/demo.nfplugin",
		});
		expect(JSON.stringify(await installed.json())).not.toContain("/safe/plugin-imports");

		for (const path of ["../escape.nfplugin", "/etc/passwd.nfplugin", "demo.tar.gz"]) {
			const response = await app.request("/install", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path }),
			});
			expect(response.status).toBe(400);
			expect((await response.json()) as { code: string }).toMatchObject({
				code: "VALIDATION_ERROR",
			});
		}
		expect(manager.calls.filter((call) => call.method === "install")).toHaveLength(1);
	});

	it("rejects unknown install fields and malformed JSON", async () => {
		const app = createApp(new MockPluginManager());
		const unknown = await app.request("/install", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "demo.nfplugin", url: "https://example.com/plugin.zip" }),
		});
		expect(unknown.status).toBe(400);

		const malformed = await app.request("/install", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toEqual({
			error: "Invalid JSON request body",
			code: "VALIDATION_ERROR",
		});
	});

	it("allows queries while disabled and rejects every write with PLUGINS_DISABLED", async () => {
		const manager = new MockPluginManager();
		const app = createApp(manager, false);
		expect((await app.request("/")).status).toBe(200);
		expect((await app.request("/com.example.demo")).status).toBe(200);
		expect((await app.request("/com.example.demo/diagnostics")).status).toBe(200);

		for (const path of ["enable", "disable", "activate", "uninstall", "retry"]) {
			const response = await app.request(`/com.example.demo/${path}`, { method: "POST" });
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				error: "Plugin system is disabled",
				code: "PLUGINS_DISABLED",
			});
		}
		const install = await app.request("/install", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "demo.nfplugin" }),
		});
		expect(install.status).toBe(503);
		expect(manager.calls.some((call) => call.method === "install")).toBe(false);
	});

	it("delegates lifecycle actions and validates plugin IDs", async () => {
		const manager = new MockPluginManager();
		const app = createApp(manager);
		for (const path of ["enable", "disable", "activate", "uninstall", "retry"] as const) {
			const response = await app.request(`/com.example.demo/${path}`, { method: "POST" });
			expect(response.status).toBe(200);
			const body = (await response.json()) as { pluginId: string };
			expect(body.pluginId).toBe("com.example.demo");
		}
		expect(
			manager.calls.filter(
				(call) => call.method !== "getStatus" && call.method !== "getDiagnostics",
			),
		).toEqual([
			{ method: "enable", value: "com.example.demo" },
			{ method: "disable", value: "com.example.demo" },
			{ method: "activate", value: "com.example.demo" },
			{ method: "uninstall", value: "com.example.demo" },
			{ method: "retry", value: "com.example.demo" },
		]);

		const invalid = await app.request("/Not.Valid/enable", { method: "POST" });
		expect(invalid.status).toBe(400);
		expect((await invalid.json()) as { code: string }).toMatchObject({ code: "VALIDATION_ERROR" });
	});

	it("keeps grant management behind the injected admin guard", async () => {
		const deniedAdmin: MiddlewareHandler = async (c) =>
			c.json({ error: "Admin access required", code: "FORBIDDEN" }, 403);
		const manager = new MockPluginManager();
		const app = createApp(manager, true, deniedAdmin);
		const grants = await app.request("/com.example.demo/grants");
		const replace = await app.request("/com.example.demo/grants", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: 0, grants: [] }),
		});

		expect(grants.status).toBe(403);
		expect(replace.status).toBe(403);
		expect(manager.calls).toHaveLength(0);
	});
});

/**
 * Install and lifecycle require an administrator, with no per-plugin tiering.
 *
 * The three-tier scheme this replaces (`theme-only` / `frontend` / `backend`) let any
 * logged-in user install and enable a plugin that shipped no server entry and no views. It
 * was removed because the classification was drawn in the wrong place: a "frontend" plugin
 * runs arbitrary JavaScript against the user's own session, and a plugin changed risk class
 * merely by adding a view.
 *
 * The admin gate itself is the one install-time restriction the open-capability change keeps
 * on purpose — installing a plugin puts third-party code on the server, which is a separate
 * decision from what an installed plugin is then allowed to do.
 */
describe("plugin admin gating", () => {
	// A non-admin session: authenticated user without the admin role.
	const nonAdmin: MiddlewareHandler = async (c, next) => {
		c.set("user", { sub: "user-7", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	};
	const admin: MiddlewareHandler = async (c, next) => {
		c.set("user", { sub: "admin-7", role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	};

	/** Records install calls and reports a plausible installed status. */
	class GateManager extends MockPluginManager {
		constructor(private readonly pid = "com.example.demo") {
			super();
			this.detailResult = {
				pluginId: pid,
				status: "compatible",
				manifest: {},
				contributions: [
					{ id: "sunset", fullId: `${pid}/sunset`, kind: "theme", title: "S", hasSchema: false },
				],
			};
		}
		async install(source: string | File | Uint8Array): Promise<unknown> {
			const value = source instanceof File ? `file:${source.name}` : source;
			this.calls.push({ method: "install", value });
			return { pluginId: this.pid, status: "installed", manifest: {}, contributions: [] };
		}
	}

	function gateApp(manager: PluginManager, middleware: MiddlewareHandler) {
		// The gate reads c.get("user"); the injected auth middleware seeds it.
		return createPluginRoutes(manager, {
			enabled: true,
			adminMiddleware: middleware,
			installRoots: ["/safe/plugin-imports"],
			authMiddleware: middleware,
		});
	}

	for (const path of ["enable", "disable", "activate", "uninstall", "retry"] as const) {
		it(`blocks a non-admin from ${path} with 403`, async () => {
			const manager = new GateManager();
			const app = gateApp(manager, nonAdmin);
			const res = await app.request(`/com.example.demo/${path}`, { method: "POST" });
			expect(res.status).toBe(403);
			expect((await res.json()) as { code: string }).toMatchObject({
				code: "PLUGIN_REQUIRES_ADMIN",
			});
			// A theme contribution no longer buys an exemption.
			expect(manager.calls.some((c) => c.method === path)).toBe(false);
		});
	}

	it("lets an admin run a lifecycle transition", async () => {
		const manager = new GateManager();
		const app = gateApp(manager, admin);
		const res = await app.request("/com.example.demo/enable", { method: "POST" });
		expect(res.status).toBe(200);
		expect(manager.calls.some((c) => c.method === "enable")).toBe(true);
	});

	it("refuses a non-admin install before writing anything to disk", async () => {
		const manager = new GateManager();
		const app = gateApp(manager, nonAdmin);
		const res = await app.request("/install", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "demo.nfplugin" }),
		});

		expect(res.status).toBe(403);
		expect((await res.json()) as { code: string }).toMatchObject({ code: "PLUGIN_REQUIRES_ADMIN" });
		// The decisive improvement over the tier scheme: install no longer runs speculatively
		// and then rolls back, so an unauthorized request never stages a package at all.
		expect(manager.calls.some((c) => c.method === "install")).toBe(false);
		expect(manager.calls.some((c) => c.method === "uninstall")).toBe(false);
	});

	it("lets an admin install from an import root", async () => {
		const manager = new GateManager();
		const app = gateApp(manager, admin);
		const res = await app.request("/install", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "demo.nfplugin" }),
		});
		expect(res.status).toBe(201);
		expect(manager.calls.some((c) => c.method === "install")).toBe(true);
	});

	// --- multipart upload install ---

	function uploadRequest(
		app: ReturnType<typeof gateApp>,
		filename: string,
		bytes = "PK\u0003\u0004",
	) {
		const form = new FormData();
		form.append("archive", new File([bytes], filename, { type: "application/zip" }));
		return app.request("/install", { method: "POST", body: form });
	}

	it("installs an uploaded package for an admin", async () => {
		const manager = new GateManager();
		const app = gateApp(manager, admin);
		const res = await uploadRequest(app, "duo.zip");
		expect(res.status).toBe(201);
		// The uploaded File was passed straight to the manager (byte-source install).
		expect(manager.calls.some((c) => c.method === "install" && c.value === "file:duo.zip")).toBe(
			true,
		);
		expect(manager.calls.some((c) => c.method === "uninstall")).toBe(false);
	});

	it("refuses an uploaded package from a non-admin without reading the bytes", async () => {
		const manager = new GateManager();
		const app = gateApp(manager, nonAdmin);
		const res = await uploadRequest(app, "evil.zip");
		expect(res.status).toBe(403);
		expect(manager.calls.some((c) => c.method === "install")).toBe(false);
	});

	it("rejects an uploaded file with a disallowed extension", async () => {
		const manager = new GateManager();
		const app = gateApp(manager, admin);
		const res = await uploadRequest(app, "payload.tar.gz");
		expect(res.status).toBe(400);
		expect(manager.calls.some((c) => c.method === "install")).toBe(false);
	});

	it("rejects a multipart request with no archive field", async () => {
		const manager = new GateManager();
		const app = gateApp(manager, admin);
		const form = new FormData();
		form.append("notarchive", "x");
		const res = await app.request("/install", { method: "POST", body: form });
		expect(res.status).toBe(400);
		expect(manager.calls.some((c) => c.method === "install")).toBe(false);
	});
});

describe("plugin provider config routes", () => {
	function configApp(
		service: {
			list: (pluginId: string) => unknown;
			update: (pluginId: string, instanceId: string, config: Record<string, unknown>) => unknown;
		},
		adminMiddleware = allowAdmin,
	) {
		return createPluginRoutes(new MockPluginManager(), {
			enabled: true,
			adminMiddleware,
			installRoots: ["/safe/plugin-imports"],
			authMiddleware: allowNamedAdmin,
			providerConfigService: service as never,
		});
	}

	it("returns provider config views for a plugin", async () => {
		const app = configApp({
			list: () => [
				{
					providerInstanceId: "com.example.demo/p@1.0.0:hash",
					contributionId: "p",
					config: { apiMode: "balanced" },
					secretFields: ["apiKey"],
					secretsSet: [],
				},
			],
			update: () => ({}),
		});

		const response = await app.request("/com.example.demo/providers/config");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			pluginId: string;
			providers: Array<{ contributionId: string }>;
		};
		expect(body.pluginId).toBe("com.example.demo");
		expect(body.providers[0]?.contributionId).toBe("p");
	});

	it("passes a validated body through to the config service", async () => {
		const calls: Array<{ instanceId: string; config: Record<string, unknown> }> = [];
		const app = configApp({
			list: () => [],
			update: (_pluginId, instanceId, config) => {
				calls.push({ instanceId, config });
				return { providerInstanceId: instanceId, config };
			},
		});

		const response = await app.request("/com.example.demo/providers/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				providerInstanceId: "com.example.demo/p@1.0.0:hash",
				config: { apiMode: "fast" },
			}),
		});

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.config).toEqual({ apiMode: "fast" });
	});

	it("rejects a body missing providerInstanceId", async () => {
		const app = configApp({ list: () => [], update: () => ({}) });
		const response = await app.request("/com.example.demo/providers/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ config: { apiMode: "fast" } }),
		});
		expect(response.status).toBe(400);
	});

	it("rejects unknown top-level body fields", async () => {
		const app = configApp({ list: () => [], update: () => ({}) });
		const response = await app.request("/com.example.demo/providers/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				providerInstanceId: "com.example.demo/p@1.0.0:hash",
				config: {},
				sneaky: true,
			}),
		});
		expect(response.status).toBe(400);
	});

	it("requires admin for both read and write", async () => {
		const denyAdmin: MiddlewareHandler = async (c) => c.json({ error: "forbidden" }, 403);
		const app = configApp({ list: () => [], update: () => ({}) }, denyAdmin);

		expect((await app.request("/com.example.demo/providers/config")).status).toBe(403);
		const write = await app.request("/com.example.demo/providers/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerInstanceId: "x", config: {} }),
		});
		expect(write.status).toBe(403);
	});
});

describe("plugin provider prefix route", () => {
	function prefixApp(
		updatePrefix: (pluginId: string, instanceId: string, prefix: string) => unknown,
		adminMiddleware = allowAdmin,
	) {
		return createPluginRoutes(new MockPluginManager(), {
			enabled: true,
			adminMiddleware,
			installRoots: ["/safe/plugin-imports"],
			authMiddleware: allowNamedAdmin,
			providerConfigService: {
				list: () => [],
				update: () => ({}),
				updatePrefix,
			} as never,
		});
	}

	it("forwards a valid prefix to the service", async () => {
		const calls: Array<{ instanceId: string; prefix: string }> = [];
		const app = prefixApp((_pluginId, instanceId, prefix) => {
			calls.push({ instanceId, prefix });
			return { providerInstanceId: instanceId, providerPrefix: prefix };
		});

		const response = await app.request("/com.example.demo/providers/prefix", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				providerInstanceId: "com.example.demo/p@1.0.0:hash",
				providerPrefix: "mine",
			}),
		});

		expect(response.status).toBe(200);
		expect(calls).toEqual([{ instanceId: "com.example.demo/p@1.0.0:hash", prefix: "mine" }]);
		const body = (await response.json()) as { provider: { providerPrefix: string } };
		expect(body.provider.providerPrefix).toBe("mine");
	});

	it("rejects an over-long prefix at the route boundary", async () => {
		const app = prefixApp(() => ({}));
		const response = await app.request("/com.example.demo/providers/prefix", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				providerInstanceId: "x",
				providerPrefix: "p".repeat(33),
			}),
		});
		expect(response.status).toBe(400);
	});

	it("rejects a missing prefix and unknown fields", async () => {
		const app = prefixApp(() => ({}));
		const missing = await app.request("/com.example.demo/providers/prefix", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerInstanceId: "x" }),
		});
		expect(missing.status).toBe(400);

		const extra = await app.request("/com.example.demo/providers/prefix", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerInstanceId: "x", providerPrefix: "ok", sneaky: 1 }),
		});
		expect(extra.status).toBe(400);
	});

	it("surfaces a service conflict rather than reporting success", async () => {
		const app = prefixApp(() => {
			throw new Error("Provider prefix conflicts with other-instance: taken");
		});
		const response = await app.request("/com.example.demo/providers/prefix", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerInstanceId: "x", providerPrefix: "taken" }),
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
	});

	it("requires admin", async () => {
		const denyAdmin: MiddlewareHandler = async (c) => c.json({ error: "forbidden" }, 403);
		const app = prefixApp(() => ({}), denyAdmin);
		const response = await app.request("/com.example.demo/providers/prefix", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerInstanceId: "x", providerPrefix: "ok" }),
		});
		expect(response.status).toBe(403);
	});
});

/**
 * Catalog refresh is the only way to make a plugin provider's new models visible: the host
 * pulls the catalog after activation and never again, and the plugin's own panel cannot reach
 * this endpoint (its iframe has `connect-src 'none'`).
 *
 * The ownership check carries the weight here. The refresher addresses a provider *instance*
 * globally, so without it an admin on one plugin's path could refresh — and thereby start —
 * another plugin's provider.
 */
describe("plugin provider catalog refresh route", () => {
	function catalogApp(
		options: {
			owned?: boolean;
			refresh?: (instanceId: string, opts?: { force?: boolean }) => unknown;
			adminMiddleware?: MiddlewareHandler;
		} = {},
	) {
		const calls: Array<{ instanceId: string; force?: boolean }> = [];
		const refresher = {
			refresh: (instanceId: string, opts?: { force?: boolean }) => {
				calls.push({ instanceId, ...(opts?.force ? { force: true } : {}) });
				return Promise.resolve(
					options.refresh?.(instanceId, opts) ?? { modelCount: 3, stale: false },
				);
			},
		};
		const app = createPluginRoutes(new MockPluginManager(), {
			enabled: true,
			adminMiddleware: options.adminMiddleware ?? allowAdmin,
			installRoots: ["/safe/plugin-imports"],
			authMiddleware: allowNamedAdmin,
			providerConfigService: {
				list: () =>
					options.owned === false
						? []
						: [
								{
									providerInstanceId: "com.example.demo/p@1.0.0:hash",
									contributionId: "p",
									config: {},
									secretFields: [],
									secretsSet: [],
								},
							],
				update: () => ({}),
				updatePrefix: () => ({}),
			} as never,
			providerCatalogRefresher: refresher as never,
		});
		return { app, calls };
	}

	async function refreshRequest(
		app: ReturnType<typeof createPluginRoutes>,
		providerInstanceId = "com.example.demo/p@1.0.0:hash",
	) {
		return app.request("/com.example.demo/providers/catalog/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerInstanceId }),
		});
	}

	it("forces a refresh and reports the new model count", async () => {
		const { app, calls } = catalogApp();
		const response = await refreshRequest(app);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.modelCount).toBe(3);
		// Forced on purpose: the user asked, so skipping a catalog the host still believes is
		// fresh would make the button silently do nothing.
		expect(calls).toEqual([{ instanceId: "com.example.demo/p@1.0.0:hash", force: true }]);
	});

	it("refuses a provider instance the plugin does not own", async () => {
		const { app, calls } = catalogApp({ owned: false });
		const response = await refreshRequest(app);
		expect(response.status).toBe(404);
		expect(calls).toHaveLength(0);
	});

	it("reports an upstream failure instead of claiming success", async () => {
		// The refresher returns errors rather than throwing, because a stale catalog is still
		// a usable registration. A caller must be able to tell the two apart.
		const { app } = catalogApp({
			refresh: () => ({ modelCount: 0, stale: true, error: new Error("upstream refused") }),
		});
		const response = await refreshRequest(app);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.error).toBe("upstream refused");
		expect(body.stale).toBe(true);
	});

	it("reports a skipped refresh for a provider without listModels", async () => {
		const { app } = catalogApp({
			refresh: () => ({ modelCount: 2, stale: false, skipped: true }),
		});
		const body = (await (await refreshRequest(app)).json()) as Record<string, unknown>;
		expect(body.skipped).toBe(true);
	});

	it("rejects a body with unknown fields", async () => {
		const { app } = catalogApp();
		const response = await app.request("/com.example.demo/providers/catalog/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerInstanceId: "x", force: true }),
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
	});

	it("requires admin", async () => {
		const denyAdmin: MiddlewareHandler = async (c) => c.json({ error: "forbidden" }, 403);
		const { app } = catalogApp({ adminMiddleware: denyAdmin });
		expect((await refreshRequest(app)).status).toBe(403);
	});
});

describe("plugin provider proxy route", () => {
	function proxyApp(
		updateProxy: (pluginId: string, instanceId: string, proxy: unknown) => unknown,
		adminMiddleware = allowAdmin,
	) {
		return createPluginRoutes(new MockPluginManager(), {
			enabled: true,
			adminMiddleware,
			installRoots: ["/safe/plugin-imports"],
			authMiddleware: allowNamedAdmin,
			providerConfigService: {
				list: () => [],
				update: () => ({}),
				updatePrefix: () => ({}),
				updateProxy,
			} as never,
		});
	}

	async function put(app: ReturnType<typeof createPluginRoutes>, body: unknown) {
		return app.request("/com.example.demo/providers/proxy", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("forwards a custom proxy to the service", async () => {
		const calls: unknown[] = [];
		const app = proxyApp((_pluginId, _instanceId, proxy) => {
			calls.push(proxy);
			return {};
		});
		const response = await put(app, {
			providerInstanceId: "com.example.demo/p@1.0.0:hash",
			proxy: { mode: "custom", url: "http://127.0.0.1:7890" },
		});
		expect(response.status).toBe(200);
		expect(calls).toEqual([{ mode: "custom", url: "http://127.0.0.1:7890" }]);
	});

	it("forwards null to clear the override", async () => {
		const calls: unknown[] = [];
		const app = proxyApp((_pluginId, _instanceId, proxy) => {
			calls.push(proxy);
			return {};
		});
		await put(app, { providerInstanceId: "x", proxy: null });
		expect(calls).toEqual([null]);
	});

	it("rejects an unknown proxy mode", async () => {
		const app = proxyApp(() => ({}));
		const response = await put(app, {
			providerInstanceId: "x",
			proxy: { mode: "tunnel" },
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
	});

	it("rejects unknown fields in the proxy object", async () => {
		const app = proxyApp(() => ({}));
		const response = await put(app, {
			providerInstanceId: "x",
			proxy: { mode: "custom", url: "http://p", extra: true },
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
	});

	it("echoes the stored override back so the form can show it", async () => {
		// Admin-only, and the value is what this admin just supplied; without echoing it the
		// field could not display the current setting.
		const app = proxyApp(() => ({
			providerInstanceId: "com.example.demo/p@1.0.0:hash",
			providerTypeId: "com.example.demo/p",
			pluginId: "com.example.demo",
			contributionId: "p",
			providerPrefix: "p",
			displayName: "P",
			configSchema: true,
			config: {},
			secretFields: [],
			secretsSet: [],
			proxy: { mode: "custom", url: "http://127.0.0.1:7890" },
		}));
		const response = await put(app, {
			providerInstanceId: "com.example.demo/p@1.0.0:hash",
			proxy: { mode: "custom", url: "http://127.0.0.1:7890" },
		});
		const body = (await response.json()) as { provider?: { proxy?: unknown } };
		expect(body.provider?.proxy).toEqual({ mode: "custom", url: "http://127.0.0.1:7890" });
	});

	it("omits proxy from the response when none is set", async () => {
		const app = proxyApp(() => ({
			providerInstanceId: "x",
			providerTypeId: "t",
			pluginId: "com.example.demo",
			contributionId: "p",
			providerPrefix: "p",
			displayName: "P",
			configSchema: true,
			config: {},
			secretFields: [],
			secretsSet: [],
		}));
		const body = (await (await put(app, { providerInstanceId: "x", proxy: null })).json()) as {
			provider?: Record<string, unknown>;
		};
		expect(body.provider && "proxy" in body.provider).toBe(false);
	});

	it("requires admin", async () => {
		const denyAdmin: MiddlewareHandler = async (c) => c.json({ error: "forbidden" }, 403);
		const app = proxyApp(() => ({}), denyAdmin);
		const response = await put(app, { providerInstanceId: "x", proxy: null });
		expect(response.status).toBe(403);
	});
});

describe("plugin provider config route contract", () => {
	it("keeps the route service interface satisfiable by the real service", () => {
		// The route tests inject mocks with `as never`, which would hide a drift between
		// ProviderConfigRouteService and PluginProviderConfigService. This assignment is
		// the type-level check that the real service still satisfies the route contract;
		// it fails at compile time (tsgo) if a method is renamed or its shape changes.
		const assertAssignable = (service: PluginProviderConfigService): ProviderConfigRouteService =>
			service;
		expect(typeof assertAssignable).toBe("function");
		// Method names the routes call, pinned so a rename cannot pass unnoticed.
		for (const method of ["list", "update", "updatePrefix", "updateProxy"] as const) {
			expect(typeof PluginProviderConfigService.prototype[method]).toBe("function");
		}
	});

	it("keeps the catalog refresher interface satisfiable by the real refresher", () => {
		// Same reasoning as above: the catalog route test injects a mock with `as never`, which
		// would hide a drift between the narrow route interface and the real refresher.
		const assertAssignable = (
			refresher: PluginProviderCatalogRefresher,
		): ProviderCatalogRouteRefresher => refresher;
		expect(typeof assertAssignable).toBe("function");
		expect(typeof PluginProviderCatalogRefresher.prototype.refresh).toBe("function");
	});
});
