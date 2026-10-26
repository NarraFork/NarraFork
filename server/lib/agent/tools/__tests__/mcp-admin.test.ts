import { describe, expect, test } from "bun:test";
import type { PermissionResult, ToolContext } from "../../types";
import { createMcpAdminTool, type McpManagerLike, type SettingsLike } from "../mcp-admin";

function makeCtx(
	options: {
		userId?: string | null;
		permission?: PermissionResult;
		onPermission?: (input: Record<string, unknown>) => void;
	} = {},
): ToolContext {
	return {
		narratorId: "mcp-admin-test",
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		userId: options.userId ?? "admin-user",
		currentToolUseId: "tool-use-1",
		requestPermission: async (_toolName, input) => {
			options.onPermission?.(input);
			return options.permission ?? { behavior: "allow" };
		},
	};
}

function makeManager(): { manager: McpManagerLike; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		manager: {
			getServerStatuses: () => [
				{
					id: "s1",
					name: "demo",
					transport: "stdio",
					command: "npx",
					envKeys: ["API_KEY"],
					enabled: true,
					status: "connected",
					tools: [{ name: "tool-a", description: "does things" }],
				},
			],
			connect: async (config) => {
				calls.push(`connect:${(config as { name: string }).name}`);
			},
			disconnect: async (id) => {
				calls.push(`disconnect:${id}`);
			},
			refresh: async (id) => {
				calls.push(`refresh:${id}`);
				return { ok: true, toolCount: 1 };
			},
			refreshAll: async () => {
				calls.push("refreshAll");
				return [{ serverId: "s1", name: "demo", ok: true, toolCount: 1 }];
			},
			testConnection: async () => ({ ok: true, tools: [{ name: "test-tool" }] }),
		},
	};
}

function makeSettings(initial: unknown[] = []): SettingsLike & { saved: number } {
	const state = { saved: 0 };
	return {
		mcpServers: [...initial],
		get saved() {
			return state.saved;
		},
		save() {
			state.saved++;
		},
	};
}

describe("McpAdmin tool", () => {
	test("persists connect/disconnect mode intent and rejects contradictory add", async () => {
		const { manager } = makeManager();
		const settings = makeSettings([{ id: "s1", name: "demo", mode: "auto", enabled: true }]);
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });
		await tool.execute({ action: "connect", id: "s1" }, makeCtx());
		expect(settings.mcpServers[0]).toMatchObject({ mode: "auto", enabled: true });
		await tool.execute({ action: "disconnect", id: "s1" }, makeCtx());
		expect(settings.mcpServers[0]).toMatchObject({ mode: "disabled", enabled: false });
		await tool.execute({ action: "connect", id: "s1" }, makeCtx());
		expect(settings.mcpServers[0]).toMatchObject({ mode: "resident", enabled: true });
		expect(settings.saved).toBe(3);
		const result = await tool.execute(
			{ action: "add", name: "bad", mode: "disabled", enabled: true },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(settings.mcpServers).toHaveLength(1);
	});

	test("connect honors explicit auto/resident modes without changing disconnect semantics", async () => {
		const { manager } = makeManager();
		const settings = makeSettings([{ id: "s1", name: "demo", mode: "disabled", enabled: false }]);
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });

		for (const mode of ["auto", "resident", "auto"] as const) {
			const result = await tool.execute({ action: "connect", id: "s1", mode }, makeCtx());
			expect(result.isError).toBeFalsy();
			expect(settings.mcpServers[0]).toMatchObject({ mode, enabled: true });
		}
		await tool.execute({ action: "disconnect", id: "s1" }, makeCtx());
		expect(settings.mcpServers[0]).toMatchObject({ mode: "disabled", enabled: false });
		expect(settings.saved).toBe(4);
		await tool.execute({ action: "disconnect", id: "s1" }, makeCtx());
		expect(settings.saved).toBe(4);

		const rejected = await tool.execute(
			{ action: "connect", id: "s1", mode: "disabled" },
			makeCtx(),
		);
		expect(rejected.isError).toBe(true);
		expect(settings.saved).toBe(4);
	});

	test("lists configured servers with projected safe fields and tool names", async () => {
		const { manager } = makeManager();
		const tool = createMcpAdminTool({
			manager,
			settings: makeSettings(),
			isAdminUser: () => false,
		});

		const result = await tool.execute({ action: "list" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("demo");
		expect(result.output).toContain("tool-a");
		// env values never leak — only keys are projected
		expect(result.output).not.toContain("secret-value");
		expect(result.output).toContain("API_KEY");
	});

	test("rejects non-admin users for add", async () => {
		const { manager } = makeManager();
		const settings = makeSettings();
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => false });

		const result = await tool.execute(
			{ action: "add", name: "gh", command: "npx", transport: "stdio" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("administrators");
		expect(settings.mcpServers).toHaveLength(0);
	});

	test("does not add when the user denies permission", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings();
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });
		let permissionRequested = false;

		const result = await tool.execute(
			{ action: "add", name: "gh", command: "npx", transport: "stdio" },
			makeCtx({
				permission: { behavior: "deny", message: "No" },
				onPermission: () => {
					permissionRequested = true;
				},
			}),
		);
		expect(permissionRequested).toBe(true);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("No");
		expect(settings.mcpServers).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	test("adds a server, persists it, and connects when enabled", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings();
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });

		const result = await tool.execute(
			{
				action: "add",
				name: "gh",
				transport: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-github"],
				env: { GITHUB_TOKEN: "super-secret" },
			},
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(settings.saved).toBe(1);
		expect(settings.mcpServers).toHaveLength(1);
		const added = settings.mcpServers[0] as Record<string, unknown>;
		expect(added.name).toBe("gh");
		expect(added).toMatchObject({ mode: "auto", enabled: true });
		expect(added.env).toEqual({ GITHUB_TOKEN: "super-secret" });
		expect(calls).toEqual(["connect:gh"]);
		// output never echoes the secret
		expect(result.output).not.toContain("super-secret");
	});

	test("add keeps the loading switch separate from tool permission behavior", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings();
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });

		const result = await tool.execute(
			{ action: "add", name: "off", command: "demo", enabled: false, defaultBehavior: "deny" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(settings.mcpServers[0]).toMatchObject({
			mode: "disabled",
			enabled: false,
			defaultBehavior: "deny",
		});
		expect(calls).toEqual([]);
	});

	test("removes a server after approval", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings([{ id: "s1", name: "demo", transport: "stdio", enabled: true }]);
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });

		const result = await tool.execute({ action: "remove", id: "s1" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(settings.mcpServers).toHaveLength(0);
		expect(calls).toContain("disconnect:s1");
	});

	test("remove of an unknown server is an error", async () => {
		const { manager } = makeManager();
		const settings = makeSettings();
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });

		const result = await tool.execute({ action: "remove", id: "nope" }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not found");
	});

	test("connect and disconnect route through the manager", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings([{ id: "s1", name: "demo", transport: "stdio", enabled: true }]);
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });

		const connectResult = await tool.execute({ action: "connect", id: "s1" }, makeCtx());
		expect(connectResult.isError).toBeFalsy();
		expect(calls).toContain("connect:demo");

		const disconnectResult = await tool.execute({ action: "disconnect", id: "s1" }, makeCtx());
		expect(disconnectResult.isError).toBeFalsy();
		expect(calls).toContain("disconnect:s1");
	});

	test("test uses a consistent temporary loading config without persisting", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings();
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });
		let testedConfig: Record<string, unknown> | null = null;
		let permissionInput: Record<string, unknown> | null = null;
		manager.testConnection = async (config) => {
			testedConfig = config;
			return { ok: true, tools: [{ name: "test-tool" }] };
		};

		const result = await tool.execute(
			{
				action: "test",
				name: "probe",
				transport: "streamable-http",
				url: "https://example.com/mcp",
				enabled: false,
				defaultBehavior: "ask",
			},
			makeCtx({
				onPermission: (input) => {
					permissionInput = input;
				},
			}),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("test-tool");
		expect(testedConfig).toMatchObject({ mode: "auto", enabled: true, defaultBehavior: "ask" });
		expect(permissionInput).toMatchObject({ mode: "auto" });
		expect(permissionInput).not.toHaveProperty("enabled");
		expect(settings.mcpServers).toHaveLength(0);
		expect(settings.saved).toBe(0);
		expect(calls.some((c) => c.startsWith("connect"))).toBe(false);
	});

	test("refresh re-fetches one server's tools after approval", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings([{ id: "s1", name: "demo", transport: "stdio", enabled: true }]);
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });
		let permissionRequested = false;

		const result = await tool.execute(
			{ action: "refresh", id: "s1" },
			makeCtx({
				onPermission: () => {
					permissionRequested = true;
				},
			}),
		);
		expect(permissionRequested).toBe(true);
		expect(result.isError).toBeFalsy();
		expect(result.title).toContain("refreshed");
		expect(calls).toEqual(["refresh:s1"]);
		// Refresh must not rewrite the persisted connection intent.
		expect(settings.saved).toBe(0);
		expect(result.output).toContain('"ok": true');
	});

	test("refresh without id refreshes every enabled server", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings([{ id: "s1", name: "demo", transport: "stdio", enabled: true }]);
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });

		const result = await tool.execute({ action: "refresh" }, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["refreshAll"]);
		expect(result.output).toContain('"refreshed": 1');
	});

	test("refresh of an unknown server is an error", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings();
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });

		const result = await tool.execute({ action: "refresh", id: "nope" }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not found");
		expect(calls).toEqual([]);
	});

	test("refresh is denied for non-admin users", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings([{ id: "s1", name: "demo", transport: "stdio", enabled: true }]);
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => false });

		const result = await tool.execute({ action: "refresh", id: "s1" }, makeCtx());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("administrators");
		expect(calls).toEqual([]);
	});
});
