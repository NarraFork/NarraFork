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
		expect(added.env).toEqual({ GITHUB_TOKEN: "super-secret" });
		expect(calls).toEqual(["connect:gh"]);
		// output never echoes the secret
		expect(result.output).not.toContain("super-secret");
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

	test("test action runs testConnection without persisting", async () => {
		const { manager, calls } = makeManager();
		const settings = makeSettings();
		const tool = createMcpAdminTool({ manager, settings, isAdminUser: () => true });

		const result = await tool.execute(
			{
				action: "test",
				name: "probe",
				transport: "streamable-http",
				url: "https://example.com/mcp",
			},
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("test-tool");
		expect(settings.mcpServers).toHaveLength(0);
		expect(settings.saved).toBe(0);
		expect(calls.some((c) => c.startsWith("connect"))).toBe(false);
	});
});
