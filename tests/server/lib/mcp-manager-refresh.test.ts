import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Unit tests for McpManager.refresh — the manual tool-list re-fetch that covers
 * upstreams which change their tools without emitting tools/list_changed
 * (e.g. JetBrains MCP toggling APIs at runtime).
 */

type FakeTool = { name: string; description?: string };
type FakePage = { tools: FakeTool[]; nextCursor?: string };

const state = {
	beforeListTools: null as null | (() => Promise<void>),
	listToolsCalls: 0,
	listToolsResult: { tools: [{ name: "tool-a" }] } as FakePage,
	pages: null as Map<string | undefined, FakePage | Error> | null,
	cursors: [] as (string | undefined)[],
	onToolsChanged: null as (() => Promise<void>) | null,
	/** Fail the next N listTools calls, then succeed. */
	listToolsFailuresRemaining: 0,
	listToolsErrorMessage: "stale connection",
	connectCalls: 0,
};

class FakeClient {
	async connect(_transport: unknown): Promise<void> {
		state.connectCalls++;
	}
	setNotificationHandler(_schema: unknown, handler: () => Promise<void>): void {
		state.onToolsChanged = handler;
	}
	async listTools(params?: { cursor?: string }): Promise<FakePage> {
		state.listToolsCalls++;
		state.cursors.push(params?.cursor);
		await state.beforeListTools?.();
		if (state.listToolsFailuresRemaining > 0) {
			state.listToolsFailuresRemaining--;
			throw new Error(state.listToolsErrorMessage);
		}
		const page = state.pages?.get(params?.cursor) ?? state.listToolsResult;
		if (page instanceof Error) throw page;
		return page;
	}
	async callTool(): Promise<{ content: [] }> {
		return { content: [] };
	}
}

const settingsState: {
	mcpServers: Array<{
		id: string;
		name: string;
		transport: "stdio" | "streamable-http";
		command: string;
		url?: string;
		mode?: "disabled" | "auto" | "resident";
		enabled: boolean;
	}>;
} = {
	mcpServers: [],
};

const actualSettingsModule = { ...(await import("../../../server/lib/settings")) };
const actualTransportsModule = { ...(await import("../../../server/lib/mcp/transports")) };

mock.module("../../../server/lib/settings", () => ({
	...actualSettingsModule,
	settings: settingsState,
	loadSettings: () => ({ ...actualSettingsModule.getDefaults(), mcpServers: [] }),
	saveSettings: () => {},
}));
mock.module("../../../server/lib/mcp/transports", () => ({
	...actualTransportsModule,
	createTransport: () => ({
		onclose: null as (() => void) | null,
		close: async () => {},
	}),
}));
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: FakeClient,
}));

const { mcpManager } = await import("../../../server/lib/mcp/manager");

const serverConfig = {
	id: "srv1",
	name: "jetbrains",
	transport: "stdio" as const,
	command: "jb-mcp",
	enabled: true,
};

beforeEach(() => {
	state.beforeListTools = null;
	state.pages = null;
	state.cursors = [];
	state.onToolsChanged = null;
	state.listToolsCalls = 0;
	state.listToolsResult = { tools: [{ name: "tool-a" }] };
	state.listToolsFailuresRemaining = 0;
	state.listToolsErrorMessage = "stale connection";
	state.connectCalls = 0;
	settingsState.mcpServers = [{ ...serverConfig }];
	mcpManager.onToolsChanged = null;
});

afterEach(async () => {
	await mcpManager.shutdown();
});

afterAll(() => {
	mock.module("../../../server/lib/settings", () => actualSettingsModule);
	mock.module("../../../server/lib/mcp/transports", () => actualTransportsModule);
	mock.restore();
});

describe("McpManager.refresh", () => {
	it("initializes auto/resident and skips disabled even with stale legacy flags", async () => {
		settingsState.mcpServers = [
			{ ...serverConfig, id: "auto", mode: "auto", enabled: false },
			{ ...serverConfig, id: "resident", mode: "resident", enabled: false },
			{ ...serverConfig, id: "disabled", mode: "disabled", enabled: true },
		];
		await mcpManager.initialize();
		expect(state.connectCalls).toBe(2);
		expect(
			mcpManager
				.getServerStatuses()
				.filter((s) => s.status === "connected")
				.map((s) => s.id),
		).toEqual(["auto", "resident"]);
		settingsState.mcpServers[0].mode = "disabled";
		await mcpManager.reload();
		expect(mcpManager.getServerStatuses().find((s) => s.id === "auto")?.status).toBe(
			"disconnected",
		);
	});

	it("re-lists tools on a live connection without reconnecting", async () => {
		await mcpManager.connect(serverConfig);
		const connectCallsAfterConnect = state.connectCalls;
		const listCallsAfterConnect = state.listToolsCalls;

		// Upstream swaps the tool set without emitting tools/list_changed.
		state.listToolsResult = { tools: [{ name: "tool-b" }, { name: "tool-c" }] };
		let toolsChanged = 0;
		mcpManager.onToolsChanged = () => {
			toolsChanged++;
		};

		const result = await mcpManager.refresh("srv1");
		expect(result.ok).toBe(true);
		expect(result.toolCount).toBe(2);
		// The lightweight path must not tear down and rebuild the transport.
		expect(state.connectCalls).toBe(connectCallsAfterConnect);
		expect(state.listToolsCalls).toBe(listCallsAfterConnect + 1);
		expect(toolsChanged).toBe(1);

		const status = mcpManager.getServerStatuses().find((s) => s.id === "srv1");
		expect(status?.tools.map((t) => t.name)).toEqual(["tool-b", "tool-c"]);
	});

	it("retains the previous directory and connection when a refresh fails", async () => {
		await mcpManager.connect(serverConfig);
		const connectCallsAfterConnect = state.connectCalls;
		state.pages = new Map<string | undefined, FakePage | Error>([
			[undefined, { tools: [{ name: "partial" }], nextCursor: "second" }],
			["second", new Error("page unavailable")],
		]);
		const result = await mcpManager.refresh("srv1");
		expect(result).toEqual({ ok: false, toolCount: 1, error: "page unavailable" });
		expect(state.connectCalls).toBe(connectCallsAfterConnect);
		expect(mcpManager.getServerStatuses()[0]?.tools.map((tool) => tool.name)).toEqual(["tool-a"]);
	});

	it("reconnects an expired HTTP session instead of repeatedly refreshing the dead session", async () => {
		const config = {
			...serverConfig,
			transport: "streamable-http" as const,
			url: "https://mcp.invalid",
		};
		settingsState.mcpServers = [config];
		await mcpManager.connect(config);
		let expired = true;
		state.beforeListTools = async () => {
			if (expired) {
				expired = false;
				throw new StreamableHTTPError(404, "session expired");
			}
		};
		state.listToolsResult = { tools: [{ name: "after-restart" }] };
		expect(await mcpManager.refresh("srv1")).toEqual({ ok: true, toolCount: 1 });
		expect(state.connectCalls).toBe(2);
		expect(mcpManager.getAvailableTools().map((tool) => tool.tool.name)).toEqual(["after-restart"]);
	});

	it("follows three discovery pages on connect and notification refresh", async () => {
		state.pages = new Map<string | undefined, FakePage | Error>([
			[undefined, { tools: [{ name: "first" }], nextCursor: "second" }],
			["second", { tools: [{ name: "second" }], nextCursor: "third" }],
			["third", { tools: [{ name: "third" }] }],
		]);
		await mcpManager.connect(serverConfig);
		expect(state.cursors).toEqual([undefined, "second", "third"]);
		expect(mcpManager.getServerStatuses()[0]?.tools.map((tool) => tool.name)).toEqual([
			"first",
			"second",
			"third",
		]);
		let updates = 0;
		mcpManager.onToolsChanged = () => {
			updates++;
		};
		state.pages.set("third", { tools: [{ name: "replacement" }] });
		await state.onToolsChanged?.();
		expect(updates).toBe(1);
		expect(mcpManager.getServerStatuses()[0]?.tools.map((tool) => tool.name)).toEqual([
			"first",
			"second",
			"replacement",
		]);
	});

	it("a repeated cursor fails only that refresh and preserves its last complete directory", async () => {
		await mcpManager.connect(serverConfig);
		state.pages = new Map<string | undefined, FakePage | Error>([
			[undefined, { tools: [{ name: "partial" }], nextCursor: "repeat" }],
			["repeat", { tools: [], nextCursor: "repeat" }],
		]);
		const result = await mcpManager.refresh("srv1");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("repeated cursor");
		expect(mcpManager.getServerStatuses()[0]?.tools.map((tool) => tool.name)).toEqual(["tool-a"]);
		expect(state.connectCalls).toBe(1);
		state.pages = new Map<string | undefined, FakePage | Error>([
			[undefined, { tools: [], nextCursor: "second" }],
			["second", { tools: [], nextCursor: "third" }],
			["third", { tools: [{ name: "recovered" }] }],
		]);
		expect(await mcpManager.refresh("srv1")).toEqual({ ok: true, toolCount: 1 });
		expect(mcpManager.getServerStatuses()[0]?.tools.map((tool) => tool.name)).toEqual([
			"recovered",
		]);
	});

	it("reconnects a missing live client when the server is enabled", async () => {
		// No connect() first: refresh should discover the config and connect.
		const result = await mcpManager.refresh("srv1");
		expect(result.ok).toBe(true);
		expect(result.toolCount).toBe(1);
		expect(state.connectCalls).toBe(1);
	});

	it("refuses to refresh a disabled server without connecting", async () => {
		settingsState.mcpServers[0].enabled = false;
		const result = await mcpManager.refresh("srv1");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("disabled");
		expect(state.connectCalls).toBe(0);
	});

	for (const change of ["disable", "delete", "replace", "disconnect"] as const) {
		it(`does not revive a server ${change}d while refresh listTools is awaiting`, async () => {
			await mcpManager.connect(serverConfig);
			const connections = state.connectCalls;
			let release!: () => void;
			let started!: () => void;
			const ready = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			state.beforeListTools = async () => {
				started();
				await gate;
			};
			state.listToolsFailuresRemaining = 1;
			const refreshing = mcpManager.refresh("srv1");
			await ready;
			if (change === "disable") settingsState.mcpServers[0].enabled = false;
			if (change === "delete") settingsState.mcpServers = [];
			if (change === "replace")
				settingsState.mcpServers = [{ ...serverConfig, command: "replacement" }];
			await mcpManager.disconnect("srv1");
			release();
			const result = await refreshing;
			expect(result.ok).toBe(false);
			expect(state.connectCalls).toBe(connections);
			expect(mcpManager.getAvailableTools()).toEqual([]);
		});
	}

	it("does not publish a successful list after a concurrent disable", async () => {
		await mcpManager.connect(serverConfig);
		state.beforeListTools = async () => {
			settingsState.mcpServers[0].enabled = false;
			await mcpManager.disconnect("srv1");
		};
		expect((await mcpManager.refresh("srv1")).ok).toBe(false);
		expect(mcpManager.getAvailableTools()).toEqual([]);
		expect(state.connectCalls).toBe(1);
	});

	it("connect refuses disabled configs even when called directly", async () => {
		settingsState.mcpServers[0].enabled = false;
		await mcpManager.connect(settingsState.mcpServers[0]);
		expect(state.connectCalls).toBe(0);
	});

	it("reports an unknown server id", async () => {
		const result = await mcpManager.refresh("missing");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not configured");
	});

	it("refreshAll covers every enabled server and skips disabled ones", async () => {
		settingsState.mcpServers = [
			{ ...serverConfig },
			{ ...serverConfig, id: "srv2", name: "other" },
			{ ...serverConfig, id: "off", name: "off", enabled: false },
		];
		await mcpManager.connect(serverConfig);
		await mcpManager.connect({ ...serverConfig, id: "srv2", name: "other" });

		const results = await mcpManager.refreshAll();
		expect(results.map((r) => r.serverId).sort()).toEqual(["srv1", "srv2"]);
		expect(results.every((r) => r.ok)).toBe(true);
	});
});
