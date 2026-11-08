import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eventBus } from "../../../server/lib/event-bus";

/**
 * Unit tests for McpManager.refresh — the manual tool-list re-fetch that covers
 * upstreams which change their tools without emitting tools/list_changed
 * (e.g. JetBrains MCP toggling APIs at runtime).
 */

type FakeTool = { name: string; description?: string };
type FakePage = { tools: FakeTool[]; nextCursor?: string };

const state = {
	beforeListTools: null as null | (() => Promise<void>),
	beforeClose: null as null | (() => Promise<void>),
	clients: [] as FakeClient[],
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
	onclose: (() => void) | undefined;
	async connect(_transport: unknown): Promise<void> {
		state.clients.push(this);
		state.connectCalls++;
	}
	setNotificationHandler(_schema: unknown, handler: () => Promise<void>): void {
		state.onToolsChanged = handler;
	}
	async request(request: { method: string; params?: { cursor?: string } }): Promise<FakePage> {
		if (request.method !== "tools/list") throw new Error(`Unexpected request: ${request.method}`);
		state.listToolsCalls++;
		state.cursors.push(request.params?.cursor);
		await state.beforeListTools?.();
		if (state.listToolsFailuresRemaining > 0) {
			state.listToolsFailuresRemaining--;
			throw new Error(state.listToolsErrorMessage);
		}
		const page = state.pages?.get(request.params?.cursor) ?? state.listToolsResult;
		if (page instanceof Error) throw page;
		return page;
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
		defaultBehavior?: "ask" | "deny";
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
		close: async () => {
			await state.beforeClose?.();
		},
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
	state.beforeClose = null;
	state.clients = [];
	state.pages = null;
	state.cursors = [];
	state.onToolsChanged = null;
	state.listToolsCalls = 0;
	state.listToolsResult = { tools: [{ name: "tool-a" }] };
	state.listToolsFailuresRemaining = 0;
	state.listToolsErrorMessage = "stale connection";
	state.connectCalls = 0;
	settingsState.mcpServers = [{ ...serverConfig }];
	mcpManager.prepareTools = null;
});

afterEach(async () => {
	await mcpManager.shutdown();
});

afterAll(() => {
	mock.module("../../../server/lib/settings", () => actualSettingsModule);
	mock.module("../../../server/lib/mcp/transports", () => actualTransportsModule);
	mock.restore();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("McpManager.refresh", () => {
	it("publishes all execution metadata before synchronous connected observers run", async () => {
		settingsState.mcpServers.push({ ...serverConfig, id: "srv2", name: "other" });
		const observed: string[][] = [];
		const listener = () => {
			observed.push(mcpManager.getAvailableTools().map((t) => t.serverId));
		};
		eventBus.on("mcp:server_connected", listener);
		try {
			await mcpManager.initialize();
			expect(observed).toEqual([
				["srv1", "srv2"],
				["srv1", "srv2"],
			]);
		} finally {
			eventBus.off("mcp:server_connected", listener);
		}
	});

	it("does not drop a disconnect reentered from a synchronous connected observer", async () => {
		settingsState.mcpServers.push({ ...serverConfig, id: "srv2", name: "other" });
		const committed: string[][] = [];
		mcpManager.prepareTools = async (tools) => () => {
			committed.push(tools.map((t) => t.serverId));
			return true;
		};
		let disconnecting: Promise<void> | undefined;
		const listener = () => {
			disconnecting ??= mcpManager.disconnect("srv2");
		};
		eventBus.on("mcp:server_connected", listener);
		try {
			await mcpManager.initialize();
			await disconnecting;
			expect(committed).toEqual([["srv1", "srv2"], ["srv1"]]);
			expect(mcpManager.getAvailableTools().map((t) => t.serverId)).toEqual(["srv1"]);
		} finally {
			eventBus.off("mcp:server_connected", listener);
			mcpManager.prepareTools = null;
		}
	});

	it("installs the replacement lifecycle before awaiting the old transport close", async () => {
		await mcpManager.connect(serverConfig);
		const gate = deferred();
		const ready = deferred();
		state.beforeClose = async () => {
			ready.resolve();
			await gate.promise;
		};
		const replacing = mcpManager.connect(serverConfig);
		expect(mcpManager.getServerStatuses()[0].status).toBe("connecting");
		await ready.promise;
		const disconnecting = mcpManager.disconnect("srv1");
		gate.resolve();
		await Promise.all([replacing, disconnecting]);
		expect(state.connectCalls).toBe(1);
		expect(mcpManager.isServerConnected("srv1")).toBe(false);
	});

	it("invalidates a pending publication immediately when the SDK client closes", async () => {
		await mcpManager.connect(serverConfig);
		const gate = deferred();
		const ready = deferred();
		let preparations = 0;
		const committed: string[][] = [];
		mcpManager.prepareTools = async (tools) => {
			if (++preparations === 1) {
				ready.resolve();
				await gate.promise;
			}
			return () => {
				committed.push(tools.map((t) => t.tool.name));
				return true;
			};
		};
		state.listToolsResult = { tools: [{ name: "stale" }] };
		const work = mcpManager.refresh("srv1");
		await ready.promise;
		state.clients[0].onclose?.();
		expect(mcpManager.isServerConnected("srv1")).toBe(false);
		await expect(mcpManager.callTool("srv1", "tool-a", {})).rejects.toThrow("not connected");
		gate.resolve();
		expect((await work).ok).toBe(false);
		expect(committed).toEqual([[]]);
		mcpManager.prepareTools = null;
	});

	it("permission-only reload reprepares but does not reconnect or repeat discovery", async () => {
		await mcpManager.connect(serverConfig);
		const gate = deferred();
		const ready = deferred();
		let preparations = 0;
		const committed: Array<string | undefined> = [];
		mcpManager.prepareTools = async () => {
			const permission = settingsState.mcpServers[0].defaultBehavior;
			if (++preparations === 1) {
				ready.resolve();
				await gate.promise;
			}
			return () => {
				committed.push(permission);
				return true;
			};
		};
		const refreshing = mcpManager.refresh("srv1");
		await ready.promise;
		settingsState.mcpServers[0].defaultBehavior = "deny";
		const reloading = mcpManager.reload();
		await new Promise((resolve) => setImmediate(resolve));
		gate.resolve();
		await Promise.all([refreshing, reloading]);
		expect(committed).toEqual(["deny"]);
		expect(preparations).toBe(2);
		expect(state.connectCalls).toBe(1);
		expect(state.listToolsCalls).toBe(2);
		mcpManager.prepareTools = null;
	});

	it("retains reconnect backoff and stops after three failed retries", async () => {
		const scheduled: Array<{ delay: number; run: () => Promise<void> }> = [];
		const realSetTimeout = globalThis.setTimeout;
		const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: () => Promise<void>,
			delay: number,
		) => {
			if ([5000, 10000, 15000].includes(delay)) {
				const timer = realSetTimeout(() => {}, 60000);
				scheduled.push({
					delay,
					run: async () => {
						clearTimeout(timer);
						await fn();
					},
				});
				return timer;
			}
			return realSetTimeout(fn, delay);
		}) as typeof setTimeout);
		try {
			state.listToolsFailuresRemaining = 4;
			await mcpManager.initialize();
			for (let i = 0; i < 3; i++) {
				expect(scheduled[i]?.delay).toBe((i + 1) * 5000);
				await scheduled[i].run();
			}
			expect(scheduled).toHaveLength(3);
			expect(state.connectCalls).toBe(4);
			expect(mcpManager.getServerStatuses()[0].status).toBe("error");
		} finally {
			timerSpy.mockRestore();
		}
	});

	it("shares concurrent manual discovery and publication, including async preparation", async () => {
		await mcpManager.connect(serverConfig);
		const gate = deferred();
		const ready = deferred();
		let preparations = 0;
		let commits = 0;
		mcpManager.prepareTools = async () => {
			preparations++;
			ready.resolve();
			await gate.promise;
			return () => {
				commits++;
				return true;
			};
		};
		state.listToolsResult = { tools: [{ name: "new" }] };
		const first = mcpManager.refresh("srv1");
		await ready.promise;
		const second = mcpManager.refresh("srv1");
		expect(mcpManager.getAvailableTools().map((t) => t.tool.name)).toEqual(["tool-a"]);
		gate.resolve();
		expect((await Promise.all([first, second])).every((r) => r.ok)).toBe(true);
		expect(state.listToolsCalls).toBe(2);
		expect(preparations).toBe(1);
		expect(commits).toBe(1);
		expect(mcpManager.getAvailableTools().map((t) => t.tool.name)).toEqual(["new"]);
	});

	it("preserves old metadata when preparation fails and permits another refresh", async () => {
		await mcpManager.connect(serverConfig);
		state.listToolsResult = { tools: [{ name: "new" }] };
		mcpManager.prepareTools = async () => {
			throw new Error("prepare failed");
		};
		expect(await mcpManager.refresh("srv1")).toEqual({
			ok: false,
			toolCount: 1,
			error: "prepare failed",
		});
		expect(mcpManager.getAvailableTools().map((t) => t.tool.name)).toEqual(["tool-a"]);
		mcpManager.prepareTools = null;
		expect((await mcpManager.refresh("srv1")).ok).toBe(true);
	});

	it("initializes and refreshes multiple servers with one preparation and commit each", async () => {
		settingsState.mcpServers.push({ ...serverConfig, id: "srv2", name: "other" });
		let preparations = 0;
		let commits = 0;
		mcpManager.prepareTools = async (tools) => {
			preparations++;
			expect(tools.map((t) => t.serverId)).toEqual(["srv1", "srv2"]);
			return () => {
				commits++;
				return true;
			};
		};
		await mcpManager.initialize();
		expect(preparations).toBe(1);
		expect(commits).toBe(1);
		expect((await mcpManager.refreshAll()).every((r) => r.ok)).toBe(true);
		expect(preparations).toBe(2);
		expect(commits).toBe(2);
		mcpManager.prepareTools = null;
	});

	it("coalesces notification bursts and retains notifications during the follow-up", async () => {
		await mcpManager.connect(serverConfig);
		const first = deferred();
		const firstReady = deferred();
		const second = deferred();
		const secondReady = deferred();
		let passes = 0;
		state.beforeListTools = async () => {
			passes++;
			if (passes === 1) {
				firstReady.resolve();
				await first.promise;
			}
			if (passes === 2) {
				secondReady.resolve();
				await second.promise;
			}
		};
		const work = state.onToolsChanged?.();
		await firstReady.promise;
		const burst = Array.from({ length: 20 }, () => state.onToolsChanged?.());
		first.resolve();
		await secondReady.promise;
		const late = state.onToolsChanged?.();
		second.resolve();
		await Promise.all([work, late, ...burst]);
		expect(passes).toBe(3);
	});

	it("a notification during a manual discovery forces exactly one follow-up", async () => {
		await mcpManager.connect(serverConfig);
		const gate = deferred();
		const ready = deferred();
		state.beforeListTools = async () => {
			ready.resolve();
			await gate.promise;
		};
		const refresh = mcpManager.refresh("srv1");
		await ready.promise;
		const notifications = Array.from({ length: 10 }, () => state.onToolsChanged?.());
		gate.resolve();
		await Promise.all([refresh, ...notifications]);
		expect(state.listToolsCalls).toBe(3);
	});

	it("merges another server's candidate arriving during preparation without losing either", async () => {
		const other = { ...serverConfig, id: "srv2", name: "other" };
		settingsState.mcpServers.push(other);
		await mcpManager.initialize();
		const gate = deferred();
		const ready = deferred();
		const discovered = deferred();
		const committed: string[][] = [];
		let preparations = 0;
		mcpManager.prepareTools = async (tools) => {
			if (++preparations === 1) {
				ready.resolve();
				await gate.promise;
			}
			return () => {
				committed.push(tools.map((t) => `${t.serverId}:${t.tool.name}`));
				return true;
			};
		};
		state.listToolsResult = { tools: [{ name: "first" }] };
		const first = mcpManager.refresh("srv1");
		await ready.promise;
		state.listToolsResult = { tools: [{ name: "second" }] };
		state.beforeListTools = async () => {
			discovered.resolve();
		};
		const second = mcpManager.refresh("srv2");
		await discovered.promise;
		// Let discovery hand its candidate to the publication coordinator.
		await new Promise((resolve) => setImmediate(resolve));
		gate.resolve();
		await Promise.all([first, second]);
		expect(committed).toEqual([["srv1:first", "srv2:second"]]);
		expect(preparations).toBe(2);
		mcpManager.prepareTools = null;
	});

	for (const change of ["disconnect", "disable", "delete", "rename"] as const) {
		it(`rejects stale preparation after ${change} and never commits its old candidate`, async () => {
			await mcpManager.connect(serverConfig);
			const gate = deferred();
			const ready = deferred();
			let preparations = 0;
			const committed: string[][] = [];
			mcpManager.prepareTools = async (tools) => {
				if (++preparations === 1) {
					ready.resolve();
					await gate.promise;
				}
				return () => {
					committed.push(tools.map((t) => `${t.serverName}:${t.tool.name}`));
					return true;
				};
			};
			state.listToolsResult = { tools: [{ name: "stale" }] };
			const work = mcpManager.refresh("srv1");
			await ready.promise;
			if (change === "disable") settingsState.mcpServers[0].enabled = false;
			if (change === "delete") settingsState.mcpServers = [];
			if (change === "rename") settingsState.mcpServers[0].name = "renamed";
			const updating =
				change === "disconnect" ? mcpManager.disconnect("srv1") : mcpManager.reload();
			expect(mcpManager.isServerConnected("srv1")).toBe(false);
			if (change === "rename") await new Promise((resolve) => setImmediate(resolve));
			gate.resolve();
			expect((await work).ok).toBe(false);
			await updating;
			expect(committed.flat()).not.toContain("jetbrains:stale");
			if (change === "rename") expect(committed.at(-1)).toEqual(["renamed:stale"]);
			else expect(committed.at(-1)).toEqual([]);
			mcpManager.prepareTools = null;
		});
	}

	it("reprepares on registry conflict without repeating discovery", async () => {
		await mcpManager.connect(serverConfig);
		let attempts = 0;
		mcpManager.prepareTools = async () => {
			const attempt = ++attempts;
			return () => attempt > 1;
		};
		expect((await mcpManager.refresh("srv1")).ok).toBe(true);
		expect(attempts).toBe(2);
		expect(state.listToolsCalls).toBe(2);
		mcpManager.prepareTools = null;
	});

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
		mcpManager.prepareTools = async () => () => {
			toolsChanged++;
			return true;
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
		mcpManager.prepareTools = async () => () => {
			updates++;
			return true;
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
