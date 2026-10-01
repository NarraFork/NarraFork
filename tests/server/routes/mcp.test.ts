import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ToolContext } from "../../../server/lib/agent/types";
import { AppError } from "../../../server/lib/errors";
import type { McpServerConfig } from "../../../server/lib/settings";

const actualSettingsModule = { ...(await import("../../../server/lib/settings")) };
const actualManagerModule = { ...(await import("../../../server/lib/mcp/manager")) };
const actualToolBridgeModule = { ...(await import("../../../server/lib/mcp/tool-bridge")) };

const settingsState: { mcpServers: McpServerConfig[] } = { mcpServers: [] };
const connectedServerIds = new Set<string>();
let lastTestConfig: McpServerConfig | null = null;
let saveSettingsCalls = 0;
let refreshCalls: string[] = [];
let refreshAllCalls = 0;
/** When set, refresh(id) fails with this message. */
let refreshFailWith: string | null = null;

/**
 * The set `mcpManager.initialize()` would connect on the next startup. Mirrors
 * the manager's own filter, so asserting against it checks the behavior the
 * disconnect fix is about, not merely the value of a field.
 */
function autoConnectOnStartup(): string[] {
	return settingsState.mcpServers.filter((s) => s.enabled).map((s) => s.id);
}

const mcpManagerMock = {
	getServerStatuses: () =>
		settingsState.mcpServers.map((config) => ({
			...actualManagerModule.projectMcpServerConfig(config),
			status: connectedServerIds.has(config.id)
				? ("connected" as const)
				: ("disconnected" as const),
			error: undefined,
			tools: connectedServerIds.has(config.id) ? [{ name: "demo" }] : [],
		})),
	connect: async (config: McpServerConfig) => {
		connectedServerIds.add(config.id);
	},
	disconnect: async (serverId: string) => {
		connectedServerIds.delete(serverId);
	},
	refresh: async (serverId: string) => {
		refreshCalls.push(serverId);
		if (refreshFailWith) {
			return { ok: false, toolCount: 0, error: refreshFailWith };
		}
		if (!connectedServerIds.has(serverId)) {
			return { ok: false, toolCount: 0, error: "not connected" };
		}
		return { ok: true, toolCount: 1 };
	},
	refreshAll: async () => {
		refreshAllCalls++;
		return settingsState.mcpServers
			.filter((s) => s.enabled)
			.map((s) => ({
				serverId: s.id,
				name: s.name,
				ok: connectedServerIds.has(s.id) && !refreshFailWith,
				toolCount: connectedServerIds.has(s.id) ? 1 : 0,
				...(connectedServerIds.has(s.id) && !refreshFailWith
					? {}
					: { error: refreshFailWith ?? "not connected" }),
			}));
	},
	reload: async () => {},
	testConnection: async (config: McpServerConfig) => {
		lastTestConfig = structuredClone(config);
		return { ok: true, tools: [{ name: "demo" }] };
	},
};

mock.module("../../../server/lib/settings", () => ({
	...actualSettingsModule,
	settings: settingsState,
	loadSettings: () => ({
		...actualSettingsModule.getDefaults(),
		mcpServers: structuredClone(settingsState.mcpServers),
	}),
	saveSettings: (value: { mcpServers?: McpServerConfig[] }) => {
		actualSettingsModule.normalizeMcpServerIds({
			...actualSettingsModule.getDefaults(),
			mcpServers: value.mcpServers,
		});
		settingsState.mcpServers = value.mcpServers ?? [];
		saveSettingsCalls++;
	},
}));
mock.module("../../../server/lib/mcp/manager", () => ({
	...actualManagerModule,
	mcpManager: mcpManagerMock,
}));
mock.module("../../../server/lib/mcp/tool-bridge", () => ({
	...actualToolBridgeModule,
	syncMcpTools: () => {},
}));

const { mcpRoutes } = await import("../../../server/routes/mcp");

let role: "admin" | "user" = "user";
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "mcp-test-user", role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
	await next();
});
app.onError((error, c) => {
	if (error instanceof AppError) {
		return c.json(
			{ error: error.message, code: error.code },
			error.statusCode as ContentfulStatusCode,
		);
	}
	return c.json({ error: String(error) }, 500);
});
app.route("/", mcpRoutes);

const existingServer: McpServerConfig = {
	id: "existing",
	name: "Existing server",
	transport: "stdio",
	command: "node",
	args: ["server.js"],
	cwd: "/srv/mcp",
	env: { MCP_TOKEN: "env-secret" },
	headers: { Authorization: "Bearer header-secret" },
	enabled: false,
};

async function request(path: string, init?: RequestInit): Promise<Response> {
	return app.request(path, init);
}

async function jsonRequest(path: string, method: string, body: unknown): Promise<Response> {
	return app.request(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	role = "user";
	connectedServerIds.clear();
	lastTestConfig = null;
	saveSettingsCalls = 0;
	refreshCalls = [];
	refreshAllCalls = 0;
	refreshFailWith = null;
	settingsState.mcpServers = [structuredClone(existingServer)];
});

afterAll(() => {
	mock.module("../../../server/lib/settings", () => actualSettingsModule);
	mock.module("../../../server/lib/mcp/manager", () => actualManagerModule);
	mock.module("../../../server/lib/mcp/tool-bridge", () => actualToolBridgeModule);
	mock.restore();
});

describe("agent-created MCP servers remain manageable through the UI API", () => {
	const ctx = {
		narratorId: "mcp-route-test",
		cwd: process.cwd(),
		signal: new AbortController().signal,
		locale: "en",
		userId: "mcp-test-user",
		requestPermission: async () => ({ behavior: "allow" as const }),
	} as ToolContext;

	it("assigns IDs to raw NarraForkAdmin configurations so list, edit and delete work", async () => {
		role = "admin";
		const { narraforkAdminTool } = await import("../../../server/lib/agent/tools/narrafork-admin");
		const result = await narraforkAdminTool.execute(
			{
				action: "update_settings",
				value: {
					mcpServers: [
						{
							name: "intellij-index",
							transport: "sse",
							url: "http://localhost:1234/sse",
							enabled: false,
						},
						{ id: 42, name: "numeric-id", transport: "stdio", enabled: false },
					],
				},
			},
			ctx,
		);
		expect(result.isError).toBeFalsy();
		const listed = await (await request("/servers")).json();
		expect(listed.servers).toHaveLength(2);
		for (const server of listed.servers) {
			expect(typeof server.id).toBe("string");
			expect(server.id.length).toBeGreaterThan(0);
			expect((await jsonRequest(`/servers/${server.id}`, "PATCH", { name: "edited" })).status).toBe(
				200,
			);
			expect((await request(`/servers/${server.id}`, { method: "DELETE" })).status).toBe(200);
		}
		expect(settingsState.mcpServers).toEqual([]);
	});

	it("writes McpAdmin additions through the real settings adapter before UI deletion", async () => {
		role = "admin";
		const { createMcpAdminTool } = await import("../../../server/lib/agent/tools/mcp-admin");
		const tool = createMcpAdminTool({ isAdminUser: () => true });
		const result = await tool.execute(
			{ action: "add", name: "agent-server", command: "demo", enabled: false },
			ctx,
		);
		expect(result.isError).toBeFalsy();
		const added = JSON.parse(result.output);
		expect(settingsState.mcpServers.map((server) => server.id)).toContain(added.id);
		expect(saveSettingsCalls).toBe(1);
		expect((await request(`/servers/${added.id}`, { method: "DELETE" })).status).toBe(200);
		expect(settingsState.mcpServers.map((server) => server.id)).toEqual(["existing"]);
	});
});

describe("MCP external server management authorization", () => {
	it("rejects ordinary users on every external server management route", async () => {
		const requests: Array<[string, Promise<Response>]> = [
			["list", request("/servers")],
			["create", jsonRequest("/servers", "POST", { name: "new", enabled: false })],
			["patch", jsonRequest("/servers/existing", "PATCH", { name: "updated" })],
			["delete", request("/servers/existing", { method: "DELETE" })],
			["connect", request("/servers/existing/connect", { method: "POST" })],
			["disconnect", request("/servers/existing/disconnect", { method: "POST" })],
			["refresh", request("/servers/existing/refresh", { method: "POST" })],
			["refresh all", request("/servers/refresh", { method: "POST" })],
			["test existing", jsonRequest("/servers/existing/test", "POST", { name: "test" })],
			["test", jsonRequest("/servers/test", "POST", { name: "test", enabled: false })],
			["import", jsonRequest("/servers/import", "POST", { json: { mcpServers: {} } })],
		];

		for (const [name, request] of requests) {
			const response = await request;
			expect(response.status, name).toBe(403);
		}
		expect(settingsState.mcpServers).toHaveLength(1);
	});

	it("allows administrators and projects server responses without env/header values", async () => {
		role = "admin";

		const listResponse = await app.request("/servers");
		expect(listResponse.status).toBe(200);
		const listed = (await listResponse.json()).servers[0];
		expect(listed).toMatchObject({
			id: "existing",
			command: "node",
			cwd: "/srv/mcp",
			envKeys: ["MCP_TOKEN"],
			headerKeys: ["Authorization"],
		});
		expect(listed).not.toHaveProperty("env");
		expect(listed).not.toHaveProperty("headers");
		expect(JSON.stringify(listed)).not.toContain("env-secret");
		expect(JSON.stringify(listed)).not.toContain("header-secret");

		const createdResponse = await jsonRequest("/servers", "POST", {
			name: "Created server",
			transport: "stdio",
			command: "bun",
			cwd: "/tmp/mcp",
			env: { CREATED_TOKEN: "created-secret" },
			headers: { "X-MCP-Key": "created-header-secret" },
			enabled: false,
		});
		expect(createdResponse.status).toBe(201);
		const created = await createdResponse.json();
		expect(created).toMatchObject({
			name: "Created server",
			command: "bun",
			cwd: "/tmp/mcp",
			envKeys: ["CREATED_TOKEN"],
			headerKeys: ["X-MCP-Key"],
		});
		expect(created).not.toHaveProperty("env");
		expect(created).not.toHaveProperty("headers");
		expect(JSON.stringify(created)).not.toContain("created-secret");
		expect(JSON.stringify(created)).not.toContain("created-header-secret");
	});

	it("allows administrators to update, connect, disconnect, test, import, and delete", async () => {
		role = "admin";

		const renameResponse = await jsonRequest("/servers/existing", "PATCH", {
			name: "Renamed server",
		});
		expect(renameResponse.status).toBe(200);
		expect(settingsState.mcpServers[0].env).toEqual({ MCP_TOKEN: "env-secret" });
		expect(settingsState.mcpServers[0].headers).toEqual({
			Authorization: "Bearer header-secret",
		});

		const patchResponse = await jsonRequest("/servers/existing", "PATCH", {
			name: "Updated server",
			envPatch: {
				set: { PATCHED_TOKEN: "patched-secret" },
				delete: ["MCP_TOKEN"],
			},
			headerPatch: {
				set: { "X-Patched": "patched-header-secret" },
				delete: ["Authorization"],
			},
		});
		expect(patchResponse.status).toBe(200);
		const patched = await patchResponse.json();
		expect(patched).toMatchObject({
			name: "Updated server",
			envKeys: ["PATCHED_TOKEN"],
			headerKeys: ["X-Patched"],
		});
		expect(patched).not.toHaveProperty("env");
		expect(patched).not.toHaveProperty("headers");
		expect(settingsState.mcpServers[0].env).toEqual({ PATCHED_TOKEN: "patched-secret" });
		expect(settingsState.mcpServers[0].headers).toEqual({ "X-Patched": "patched-header-secret" });

		const existingTestResponse = await jsonRequest("/servers/existing/test", "POST", {
			name: "Test existing server",
		});
		expect(existingTestResponse.status).toBe(200);
		expect(await existingTestResponse.json()).toEqual({ ok: true, tools: [{ name: "demo" }] });
		expect(lastTestConfig?.env).toEqual({ PATCHED_TOKEN: "patched-secret" });
		expect(lastTestConfig?.headers).toEqual({ "X-Patched": "patched-header-secret" });

		const connectResponse = await app.request("/servers/existing/connect", { method: "POST" });
		expect(connectResponse.status).toBe(200);
		const connected = await connectResponse.json();
		expect(connected.status).toBe("connected");
		expect(connected).not.toHaveProperty("env");
		expect(connected).not.toHaveProperty("headers");

		expect((await app.request("/servers/existing/disconnect", { method: "POST" })).status).toBe(
			200,
		);

		const testResponse = await jsonRequest("/servers/test", "POST", {
			name: "Test server",
			command: "bun",
			env: { TEST_TOKEN: "test-secret" },
			enabled: false,
		});
		expect(testResponse.status).toBe(200);
		expect(await testResponse.json()).toEqual({ ok: true, tools: [{ name: "demo" }] });

		const importResponse = await jsonRequest("/servers/import", "POST", {
			json: {
				mcpServers: {
					Imported: {
						command: "bun",
						env: { IMPORT_TOKEN: "import-secret" },
						headers: { "X-Import": "import-header-secret" },
					},
				},
			},
		});
		expect(importResponse.status).toBe(200);
		expect(await importResponse.json()).toEqual({ added: 1, skipped: 0 });

		expect((await app.request("/servers/existing", { method: "DELETE" })).status).toBe(200);
		expect(settingsState.mcpServers.some((server) => server.id === "existing")).toBe(false);
	});
});

describe("MCP manual connect/disconnect persists the connection intent", () => {
	beforeEach(() => {
		role = "admin";
	});

	it("persists a manual disconnect so the next startup does not reconnect", async () => {
		settingsState.mcpServers[0].enabled = true;
		connectedServerIds.add("existing");
		saveSettingsCalls = 0;

		const response = await app.request("/servers/existing/disconnect", { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: "existing", enabled: false });

		expect(settingsState.mcpServers[0].enabled).toBe(false);
		expect(saveSettingsCalls).toBeGreaterThan(0);
		// The actual regression: a manually disconnected server used to come back
		// because initialize() reconnects everything still marked enabled.
		expect(autoConnectOnStartup()).not.toContain("existing");
		expect(connectedServerIds.has("existing")).toBe(false);
	});

	it("persists a manual connect so the next startup reconnects", async () => {
		expect(settingsState.mcpServers[0].enabled).toBe(false);
		saveSettingsCalls = 0;

		const response = await app.request("/servers/existing/connect", { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: "existing", status: "connected" });

		expect(settingsState.mcpServers[0].enabled).toBe(true);
		expect(saveSettingsCalls).toBeGreaterThan(0);
		expect(autoConnectOnStartup()).toContain("existing");
	});

	it("does not rewrite settings when the intent already matches", async () => {
		settingsState.mcpServers[0].enabled = false;
		saveSettingsCalls = 0;

		expect((await app.request("/servers/existing/disconnect", { method: "POST" })).status).toBe(
			200,
		);
		expect(saveSettingsCalls).toBe(0);
		expect(settingsState.mcpServers[0].enabled).toBe(false);
	});

	it("rejects an unknown server id on disconnect without touching settings", async () => {
		const before = structuredClone(settingsState.mcpServers);
		saveSettingsCalls = 0;

		const response = await app.request("/servers/missing/disconnect", { method: "POST" });
		expect(response.status).toBe(404);
		expect(saveSettingsCalls).toBe(0);
		expect(settingsState.mcpServers).toEqual(before);
	});
});

describe("MCP tool-list refresh", () => {
	beforeEach(() => {
		role = "admin";
	});

	it("refreshes a single server and returns the updated status without toggling enabled", async () => {
		settingsState.mcpServers[0].enabled = true;
		connectedServerIds.add("existing");
		saveSettingsCalls = 0;

		const response = await app.request("/servers/existing/refresh", { method: "POST" });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.toolCount).toBe(1);
		expect(body.status).toMatchObject({ id: "existing", status: "connected" });
		expect(refreshCalls).toEqual(["existing"]);
		// Refresh is not a connection-intent change: it must not rewrite settings.
		expect(saveSettingsCalls).toBe(0);
		expect(settingsState.mcpServers[0].enabled).toBe(true);
	});

	it("reports refresh failure with an error payload", async () => {
		settingsState.mcpServers[0].enabled = true;
		connectedServerIds.add("existing");
		refreshFailWith = "upstream tools/list failed";

		const response = await app.request("/servers/existing/refresh", { method: "POST" });
		expect(response.status).toBe(502);
		const body = await response.json();
		expect(body.ok).toBe(false);
		expect(body.error).toContain("upstream tools/list failed");
		expect(refreshCalls).toEqual(["existing"]);
	});

	it("returns 404 for an unknown server id", async () => {
		const response = await app.request("/servers/missing/refresh", { method: "POST" });
		expect(response.status).toBe(404);
		expect(refreshCalls).toEqual([]);
	});

	it("refreshes all enabled servers", async () => {
		settingsState.mcpServers[0].enabled = true;
		connectedServerIds.add("existing");
		settingsState.mcpServers.push({
			id: "second",
			name: "Second",
			transport: "stdio",
			command: "node",
			enabled: true,
		});
		connectedServerIds.add("second");
		// Disabled servers are skipped by refreshAll.
		settingsState.mcpServers.push({
			id: "off",
			name: "Off",
			transport: "stdio",
			command: "node",
			enabled: false,
		});

		const response = await app.request("/servers/refresh", { method: "POST" });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.refreshed).toBe(2);
		expect(body.failed).toBe(0);
		expect(refreshAllCalls).toBe(1);
		expect(body.results.map((r: { serverId: string }) => r.serverId).sort()).toEqual([
			"existing",
			"second",
		]);
	});
});
