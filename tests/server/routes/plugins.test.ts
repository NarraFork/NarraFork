import { describe, expect, it } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createPluginRoutes, type PluginManager } from "../../../server/routes/plugins";

const allowAdmin: MiddlewareHandler = async (_c, next) => {
	await next();
};

class MockPluginManager implements PluginManager {
	readonly calls: Array<{ method: string; value: string }> = [];
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

		expect(response.status).toBe(403);
		expect(manager.calls).toHaveLength(0);
	});
});
