import { describe, expect, it } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createPluginRoutes, type PluginManager } from "../../../server/routes/plugins";
import { PluginPermissionConflictError } from "../../../server/services/plugin-permission-store";

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

	async install(source: string): Promise<unknown> {
		this.calls.push({ method: "install", value: source });
		return { pluginId: "com.example.demo", status: "installed", path: source };
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

	it("requires the injected admin guard for mutations", async () => {
		const deniedAdmin: MiddlewareHandler = async (c) =>
			c.json({ error: "Admin access required", code: "FORBIDDEN" }, 403);
		const manager = new MockPluginManager();
		const app = createApp(manager, true, deniedAdmin);
		const response = await app.request("/install", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "demo.nfplugin" }),
		});
		const grants = await app.request("/com.example.demo/grants");
		const replace = await app.request("/com.example.demo/grants", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: 0, grants: [] }),
		});

		expect(response.status).toBe(403);
		expect(grants.status).toBe(403);
		expect(replace.status).toBe(403);
		expect(manager.calls).toHaveLength(0);
	});
});
