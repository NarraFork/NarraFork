import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Unit tests for McpManager.refresh — the manual tool-list re-fetch that covers
 * upstreams which change their tools without emitting tools/list_changed
 * (e.g. JetBrains MCP toggling APIs at runtime).
 */

type FakeTool = { name: string; description?: string };

const state = {
	beforeListTools: null as null | (() => Promise<void>),
	listToolsCalls: 0,
	listToolsResult: { tools: [{ name: "tool-a" }] as FakeTool[] },
	/** Fail the next N listTools calls, then succeed. */
	listToolsFailuresRemaining: 0,
	listToolsErrorMessage: "stale connection",
	connectCalls: 0,
};

class FakeClient {
	async connect(_transport: unknown): Promise<void> {
		state.connectCalls++;
	}
	setNotificationHandler(): void {}
	async listTools(): Promise<{ tools: FakeTool[] }> {
		state.listToolsCalls++;
		await state.beforeListTools?.();
		if (state.listToolsFailuresRemaining > 0) {
			state.listToolsFailuresRemaining--;
			throw new Error(state.listToolsErrorMessage);
		}
		return { tools: state.listToolsResult.tools };
	}
	async callTool(): Promise<{ content: [] }> {
		return { content: [] };
	}
}

const settingsState: {
	mcpServers: Array<{
		id: string;
		name: string;
		transport: "stdio";
		command: string;
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

	it("falls back to reconnect when listTools fails on the live connection", async () => {
		await mcpManager.connect(serverConfig);
		const connectCallsAfterConnect = state.connectCalls;
		const listCallsAfterConnect = state.listToolsCalls;

		// Only the in-place re-list fails; the reconnected client's discovery succeeds.
		state.listToolsFailuresRemaining = 1;
		const result = await mcpManager.refresh("srv1");
		expect(result.ok).toBe(true);
		expect(result.toolCount).toBe(1);
		// One failed re-list + one successful list inside the reconnect.
		expect(state.listToolsCalls).toBe(listCallsAfterConnect + 2);
		expect(state.connectCalls).toBe(connectCallsAfterConnect + 1);
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
