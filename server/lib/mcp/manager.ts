import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { eventBus } from "../event-bus";
import { logger } from "../logger";
import type { McpServerConfig } from "../settings";
import { settings } from "../settings";
import { createTransport } from "./transports";

export interface McpServerStatus {
	id: string;
	name: string;
	transport: McpServerConfig["transport"];
	enabled: boolean;
	status: "connected" | "disconnected" | "connecting" | "error";
	error?: string;
	tools: Tool[];
}

interface ActiveClient {
	config: McpServerConfig;
	client: Client | null;
	transport: Transport | null;
	tools: Tool[];
	status: "connected" | "connecting" | "error";
	error?: string;
}

class McpManager {
	private clients = new Map<string, ActiveClient>();

	/** Initialize: connect all enabled servers from settings. */
	async initialize(): Promise<void> {
		const servers = settings.mcpServers ?? [];
		const enabled = servers.filter((s) => s.enabled);
		if (enabled.length === 0) return;

		logger.info(`MCP: initializing ${enabled.length} server(s)`);
		await Promise.allSettled(enabled.map((s) => this.connect(s)));
	}

	/** Connect to a single MCP server. */
	async connect(config: McpServerConfig): Promise<void> {
		// Disconnect existing connection if any
		if (this.clients.has(config.id)) {
			await this.disconnect(config.id);
		}

		const entry: ActiveClient = {
			config,
			client: null,
			transport: null,
			tools: [],
			status: "connecting",
		};
		this.clients.set(config.id, entry);

		try {
			const transport = createTransport(config);
			const client = new Client({ name: "narrafork", version: "0.1.0" }, { capabilities: {} });

			entry.client = client;
			entry.transport = transport;

			// Handle transport close
			transport.onclose = () => {
				const e = this.clients.get(config.id);
				if (e && e.status === "connected") {
					e.status = "error";
					e.error = "Transport closed unexpectedly";
					eventBus.emit({
						type: "mcp:server_disconnected",
						serverId: config.id,
						name: config.name,
						reason: "Transport closed",
					});
				}
			};

			await client.connect(transport);

			// Discover tools
			const result = await client.listTools();
			entry.tools = result.tools ?? [];
			entry.status = "connected";
			entry.error = undefined;

			logger.info(
				`MCP: connected to "${config.name}" (${config.transport}), ${entry.tools.length} tool(s)`,
			);
			eventBus.emit({
				type: "mcp:server_connected",
				serverId: config.id,
				name: config.name,
				toolCount: entry.tools.length,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			entry.status = "error";
			entry.error = msg;
			logger.error(`MCP: failed to connect to "${config.name}": ${msg}`);
			eventBus.emit({
				type: "mcp:server_error",
				serverId: config.id,
				name: config.name,
				error: msg,
			});
		}
	}

	/** Disconnect a single MCP server. */
	async disconnect(serverId: string): Promise<void> {
		const entry = this.clients.get(serverId);
		if (!entry) return;

		try {
			await entry.transport?.close?.();
		} catch {
			// ignore close errors
		}
		const name = entry.config.name;
		this.clients.delete(serverId);
		eventBus.emit({
			type: "mcp:server_disconnected",
			serverId,
			name,
		});
	}

	/** Reload: reconcile running clients with current settings. */
	async reload(): Promise<void> {
		const servers = settings.mcpServers ?? [];
		const configMap = new Map(servers.map((s) => [s.id, s]));

		// Disconnect removed or disabled servers
		for (const [id] of this.clients) {
			const cfg = configMap.get(id);
			if (!cfg || !cfg.enabled) {
				await this.disconnect(id);
			}
		}

		// Connect new or reconnect changed servers
		for (const cfg of servers) {
			if (!cfg.enabled) continue;
			const existing = this.clients.get(cfg.id);
			if (!existing || this.configChanged(existing.config, cfg)) {
				await this.connect(cfg);
			}
		}
	}

	/** Get all available MCP tools across connected servers. */
	getAvailableTools(): Array<{ serverId: string; serverName: string; tool: Tool }> {
		const result: Array<{ serverId: string; serverName: string; tool: Tool }> = [];
		for (const [, entry] of this.clients) {
			if (entry.status !== "connected") continue;
			for (const tool of entry.tools) {
				result.push({
					serverId: entry.config.id,
					serverName: entry.config.name,
					tool,
				});
			}
		}
		return result;
	}

	/** Call a tool on a specific MCP server. */
	async callTool(
		serverId: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
		const entry = this.clients.get(serverId);
		if (!entry || entry.status !== "connected" || !entry.client) {
			throw new Error(`MCP server "${serverId}" is not connected`);
		}

		const result = await entry.client.callTool({ name: toolName, arguments: args });
		return {
			content: (result.content ?? []) as Array<{ type: string; text?: string }>,
			isError: result.isError as boolean | undefined,
		};
	}

	/** Get status of all configured servers. */
	getServerStatuses(): McpServerStatus[] {
		const servers = settings.mcpServers ?? [];
		return servers.map((cfg) => {
			const entry = this.clients.get(cfg.id);
			return {
				id: cfg.id,
				name: cfg.name,
				transport: cfg.transport,
				enabled: cfg.enabled,
				status: entry?.status ?? "disconnected",
				error: entry?.error,
				tools: entry?.tools ?? [],
			};
		});
	}

	/** Test connection without persisting. Returns tool list on success. */
	async testConnection(
		config: McpServerConfig,
	): Promise<{ ok: boolean; tools?: Tool[]; error?: string }> {
		let transport: Transport | null = null;
		try {
			transport = createTransport(config);
			const client = new Client({ name: "narrafork-test", version: "0.1.0" }, { capabilities: {} });
			await client.connect(transport);
			const result = await client.listTools();
			const tools = result.tools ?? [];
			await transport.close?.();
			return { ok: true, tools };
		} catch (err) {
			try {
				await transport?.close?.();
			} catch {
				// ignore
			}
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/** Shutdown all connections. */
	async shutdown(): Promise<void> {
		const ids = [...this.clients.keys()];
		await Promise.allSettled(ids.map((id) => this.disconnect(id)));
	}

	private configChanged(a: McpServerConfig, b: McpServerConfig): boolean {
		return (
			a.transport !== b.transport ||
			a.command !== b.command ||
			a.url !== b.url ||
			a.cwd !== b.cwd ||
			JSON.stringify(a.args) !== JSON.stringify(b.args) ||
			JSON.stringify(a.env) !== JSON.stringify(b.env) ||
			JSON.stringify(a.headers) !== JSON.stringify(b.headers)
		);
	}
}

export const mcpManager = new McpManager();
