import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";
import { errorResult, isAdminUser, requestWritePermission } from "./admin-common";

/**
 * McpAdmin — optional, admin-only agent tool for managing external MCP servers.
 *
 * Mirrors the REST API in server/routes/mcp.ts: servers are persisted in
 * settings.mcpServers and activated through mcpManager. Adding a server can
 * spawn an arbitrary local process (stdio) or reach an arbitrary network URL,
 * so every mutating action requires admin identity + user approval.
 */

const mcpTransportSchema = z.enum(["stdio", "streamable-http", "sse"]);
const mcpBehaviorSchema = z.enum(["readOnly", "readWrite", "ask", "deny"]);

const actionSchema = z.enum(["list", "add", "remove", "connect", "disconnect", "refresh", "test"]);

const serverFieldsSchema = {
	name: z.string().min(1).max(200).optional().describe("Display name for the server (add)"),
	transport: mcpTransportSchema
		.optional()
		.describe("Transport type (add/test): stdio, streamable-http, or sse"),
	command: z.string().max(500).optional().describe("stdio: executable command to spawn"),
	args: z.array(z.string().max(500)).max(50).optional().describe("stdio: command arguments"),
	cwd: z.string().max(500).optional().describe("stdio: working directory"),
	url: z.string().url().max(2000).optional().describe("http/sse: server URL"),
	env: z
		.record(z.string().min(1).max(200), z.string().max(2000))
		.optional()
		.describe("Environment variables (secret values; never echoed back)"),
	headers: z
		.record(z.string().min(1).max(200), z.string().max(2000))
		.optional()
		.describe("HTTP headers (secret values; never echoed back)"),
	enabled: z.boolean().optional().describe("Whether the server is enabled (default true)"),
	defaultBehavior: mcpBehaviorSchema
		.optional()
		.describe("Default permission behavior for tools from this server"),
};

export interface McpAdminToolDeps {
	/** Test seam: mcp manager-like object. Defaults to lazy import of the real manager. */
	manager?: McpManagerLike;
	/** Test seam: settings accessor. Defaults to the real settings singleton. */
	settings?: SettingsLike;
	/** Test seam: admin check. Defaults to DB role check. */
	isAdminUser?: (userId: string | null | undefined) => Promise<boolean> | boolean;
}

export interface McpManagerLike {
	getServerStatuses(): Array<Record<string, unknown>>;
	connect(config: Record<string, unknown>): Promise<void>;
	disconnect(serverId: string): Promise<void>;
	/** Re-fetch one server's tool list. */
	refresh(serverId: string): Promise<{ ok: boolean; toolCount: number; error?: string }>;
	/** Re-fetch tool lists of every enabled server. */
	refreshAll(): Promise<
		Array<{ serverId: string; name?: string; ok: boolean; toolCount: number; error?: string }>
	>;
	testConnection(
		config: Record<string, unknown>,
	): Promise<{ ok: boolean; tools?: unknown[]; error?: string }>;
}

export interface SettingsLike {
	mcpServers: unknown[];
	save(): void;
}

export function createMcpAdminTool(deps: McpAdminToolDeps = {}): ToolDefinition {
	return {
		name: "McpAdmin",
		description:
			"Manage external MCP servers (admin only, mutating actions require approval). action=list shows configured servers and connection status; action=add registers a new server (stdio command or streamable-http/sse URL) and connects it; action=remove deletes a server; action=connect/disconnect toggles the runtime connection; action=refresh re-fetches the tool list from a connected server (or all enabled servers when id is omitted) so tool changes that did not emit tools/list_changed become visible; action=test validates connectivity without persisting. Secret env/header values are never echoed back.",
		parameters: z.object({
			action: actionSchema.describe("The MCP server management action to perform."),
			id: z
				.string()
				.min(1)
				.max(100)
				.optional()
				.describe(
					"Server id (remove/connect/disconnect/refresh/test). Omit id with action=refresh to refresh every enabled server.",
				),
			...serverFieldsSchema,
		}),
		async execute(args, ctx): Promise<ToolResult> {
			const input = args as Record<string, unknown>;
			const action = input.action as string;
			const isAdmin = deps.isAdminUser ?? isAdminUser;
			const manager = deps.manager ?? (await loadManager());
			const settingsRef = deps.settings ?? (await loadSettingsRef());
			try {
				if (action === "list") {
					const statuses = await manager.getServerStatuses();
					const sanitized = statuses.map((s) => {
						const tools = Array.isArray(s.tools) ? (s.tools as unknown[]) : [];
						return {
							id: s.id,
							name: s.name,
							transport: s.transport,
							command: s.command,
							args: s.args,
							cwd: s.cwd,
							url: s.url,
							envKeys: s.envKeys,
							headerKeys: s.headerKeys,
							enabled: s.enabled,
							defaultBehavior: s.defaultBehavior,
							status: s.status,
							error: s.error,
							toolCount: tools.length,
							tools: tools.slice(0, 200).map((t) => ({
								name: (t as Record<string, unknown>).name,
								description:
									typeof (t as Record<string, unknown>).description === "string"
										? ((t as Record<string, unknown>).description as string).slice(0, 300)
										: undefined,
							})),
						};
					});
					return {
						output:
							sanitized.length === 0
								? "No MCP servers configured."
								: JSON.stringify(sanitized, null, 2),
						title: "MCP servers",
						metadata: { tool: "McpAdmin", action, count: sanitized.length },
					};
				}

				if (!(await isAdmin(ctx.userId))) {
					return errorResult("McpAdmin is restricted to administrators.", "McpAdmin denied");
				}

				if (action === "add" || action === "test") {
					if (action === "add" && !input.name) {
						return errorResult("Error: 'name' is required for add.");
					}
					const denied = await requestWritePermission(ctx, "McpAdmin", {
						action,
						...(input.name !== undefined && { name: input.name }),
						...(input.transport !== undefined && { transport: input.transport }),
						...(input.command !== undefined && { command: input.command }),
						...(input.url !== undefined && { url: input.url }),
						...(input.enabled !== undefined && { enabled: input.enabled }),
						warning:
							action === "add"
								? "This will register a new MCP server. stdio servers spawn a local process with the given command; HTTP servers connect to the given URL. MCP tools become available to narrators according to their permission configuration."
								: "This will test-connect to an MCP server configuration without persisting it.",
					});
					if (denied) return errorResult(denied, "McpAdmin denied");

					const { generateShortId } = await import("../../id");
					const config = {
						id: action === "add" ? generateShortId() : `test-${input.id ?? "manual"}`,
						name: (input.name as string) ?? "Untitled",
						transport: (input.transport as McpTransport) ?? "stdio",
						...(input.command !== undefined && { command: input.command as string }),
						...(input.args !== undefined && { args: input.args as string[] }),
						...(input.cwd !== undefined && { cwd: input.cwd as string }),
						...(input.url !== undefined && { url: input.url as string }),
						...(input.env !== undefined && { env: input.env as Record<string, string> }),
						...(input.headers !== undefined && {
							headers: input.headers as Record<string, string>,
						}),
						enabled: action === "test" ? true : ((input.enabled as boolean | undefined) ?? true),
						...(input.defaultBehavior !== undefined && {
							defaultBehavior: input.defaultBehavior as McpBehavior,
						}),
					};

					if (action === "test") {
						const result = await manager.testConnection(config);
						const tools = Array.isArray(result.tools) ? (result.tools as unknown[]) : [];
						return {
							output: JSON.stringify(
								{
									ok: result.ok,
									error: result.error,
									toolCount: tools.length,
									tools: tools.slice(0, 200).map((t) => ({
										name: (t as Record<string, unknown>).name,
										description:
											typeof (t as Record<string, unknown>).description === "string"
												? ((t as Record<string, unknown>).description as string).slice(0, 300)
												: undefined,
									})),
								},
								null,
								2,
							),
							title: result.ok ? "MCP connection OK" : "MCP connection failed",
							metadata: { tool: "McpAdmin", action, ok: result.ok },
						};
					}

					const servers = (
						Array.isArray(settingsRef.mcpServers) ? [...settingsRef.mcpServers] : []
					) as Record<string, unknown>[];
					servers.push(config);
					settingsRef.mcpServers = servers;
					settingsRef.save();
					if (config.enabled) {
						await manager.connect(config);
						await syncTools();
					}
					return {
						output: JSON.stringify(project(config), null, 2),
						title: "MCP server added",
						metadata: { tool: "McpAdmin", action, serverId: config.id },
					};
				}

				if (action === "refresh") {
					// Same approval model as connect/disconnect: refresh can reconnect a
					// dead server (spawning stdio processes) and replaces the tool surface
					// exposed to narrators.
					const id = input.id as string | undefined;
					const servers = (
						Array.isArray(settingsRef.mcpServers) ? settingsRef.mcpServers : []
					) as Record<string, unknown>[];
					if (id) {
						const idx = servers.findIndex((s) => s.id === id);
						if (idx === -1) return errorResult(`MCP server not found: ${id}`);
						const denied = await requestWritePermission(ctx, "McpAdmin", {
							action,
							id,
							name: servers[idx].name,
							warning:
								"This will re-fetch the tool list from the MCP server (reconnecting if needed) and update tools available to narrators.",
						});
						if (denied) return errorResult(denied, "McpAdmin denied");

						const result = await manager.refresh(id);
						await syncTools();
						const status = manager.getServerStatuses().find((s) => s.id === id);
						return {
							output: JSON.stringify(
								{
									ok: result.ok,
									serverId: id,
									toolCount: result.toolCount,
									error: result.error,
									status: status ?? { id, status: "unknown" },
								},
								null,
								2,
							),
							title: result.ok ? "MCP tools refreshed" : "MCP refresh failed",
							metadata: { tool: "McpAdmin", action, serverId: id, ok: result.ok },
						};
					}

					const denied = await requestWritePermission(ctx, "McpAdmin", {
						action,
						warning:
							"This will re-fetch tool lists from every enabled MCP server (reconnecting where needed) and update tools available to narrators.",
					});
					if (denied) return errorResult(denied, "McpAdmin denied");

					const results = await manager.refreshAll();
					await syncTools();
					const failed = results.filter((r) => !r.ok);
					return {
						output: JSON.stringify(
							{
								ok: failed.length === 0,
								refreshed: results.length - failed.length,
								failed: failed.length,
								results,
							},
							null,
							2,
						),
						title:
							failed.length === 0 ? "MCP tools refreshed" : "MCP refresh completed with errors",
						metadata: {
							tool: "McpAdmin",
							action,
							ok: failed.length === 0,
							refreshed: results.length - failed.length,
						},
					};
				}

				if (action === "remove" || action === "connect" || action === "disconnect") {
					const id = input.id as string | undefined;
					if (!id) return errorResult("Error: 'id' is required for this action.");
					const servers = (
						Array.isArray(settingsRef.mcpServers) ? settingsRef.mcpServers : []
					) as Record<string, unknown>[];
					const idx = servers.findIndex((s) => s.id === id);
					if (idx === -1) return errorResult(`MCP server not found: ${id}`);

					const denied = await requestWritePermission(ctx, "McpAdmin", {
						action,
						id,
						name: servers[idx].name,
						warning:
							action === "remove"
								? "This will permanently remove the MCP server configuration and disconnect it."
								: action === "connect"
									? "This will connect to the MCP server and make its tools available."
									: "This will disconnect the MCP server and remove its tools from narrators.",
					});
					if (denied) return errorResult(denied, "McpAdmin denied");

					if (action === "remove") {
						await manager.disconnect(id);
						servers.splice(idx, 1);
						settingsRef.mcpServers = servers;
						settingsRef.save();
						await syncTools();
						return {
							output: `Removed MCP server ${id}.`,
							title: "MCP server removed",
							metadata: { tool: "McpAdmin", action, serverId: id },
						};
					}
					if (action === "connect") {
						await manager.connect(servers[idx]);
						await syncTools();
						return {
							output: `Connected MCP server ${id}.`,
							title: "MCP server connected",
							metadata: { tool: "McpAdmin", action, serverId: id },
						};
					}
					await manager.disconnect(id);
					await syncTools();
					return {
						output: `Disconnected MCP server ${id}.`,
						title: "MCP server disconnected",
						metadata: { tool: "McpAdmin", action, serverId: id },
					};
				}

				return errorResult(`Unknown McpAdmin action: ${action}`);
			} catch (error) {
				return errorResult(
					`McpAdmin failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	};
}

type McpTransport = "stdio" | "streamable-http" | "sse";
type McpBehavior = "readOnly" | "readWrite" | "ask" | "deny";

/** Project a config without echoing secret env/header values. */
function project(config: Record<string, unknown>): Record<string, unknown> {
	return {
		id: config.id,
		name: config.name,
		transport: config.transport,
		...(config.command !== undefined && { command: config.command }),
		...(config.args !== undefined && { args: config.args }),
		...(config.cwd !== undefined && { cwd: config.cwd }),
		...(config.url !== undefined && { url: config.url }),
		envKeys: config.env && typeof config.env === "object" ? Object.keys(config.env).sort() : [],
		headerKeys:
			config.headers && typeof config.headers === "object"
				? Object.keys(config.headers).sort()
				: [],
		enabled: config.enabled,
		...(config.defaultBehavior !== undefined && { defaultBehavior: config.defaultBehavior }),
	};
}

async function loadManager(): Promise<McpManagerLike> {
	const mod = await import("../../mcp/manager");
	return mod.mcpManager as unknown as McpManagerLike;
}

async function loadSettingsRef(): Promise<SettingsLike> {
	const mod = await import("../../settings");
	return {
		get mcpServers() {
			return Array.isArray(mod.settings.mcpServers) ? mod.settings.mcpServers : [];
		},
		set mcpServers(servers: unknown[]) {
			mod.settings.mcpServers = servers as NonNullable<typeof mod.settings.mcpServers>;
		},
		save() {
			mod.saveSettings(mod.settings);
		},
	};
}

async function syncTools(): Promise<void> {
	const mod = await import("../../mcp/tool-bridge");
	mod.syncMcpTools();
}

export const mcpAdminTool: ToolDefinition = createMcpAdminTool();
