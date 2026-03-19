import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { eventBus } from "../event-bus";
import { logger } from "../logger";
import type { McpServerConfig } from "../settings";
import { settings } from "../settings";
import { createTransport } from "./transports";

/** Timeout for initial MCP server connection + tool discovery (ms). */
const CONNECT_TIMEOUT_MS = 30_000;

/** Delay before attempting auto-reconnect after unexpected disconnect (ms). */
const RECONNECT_DELAY_MS = 5_000;

/** Maximum number of consecutive reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

export interface McpServerStatus {
	id: string;
	name: string;
	transport: McpServerConfig["transport"];
	command?: string;
	args?: string[];
	cwd?: string;
	url?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
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
	/** Number of consecutive reconnect attempts since last successful connection. */
	reconnectAttempts: number;
	/** Timer for pending reconnect. Cleared on manual disconnect. */
	reconnectTimer?: ReturnType<typeof setTimeout>;
}

class McpManager {
	private clients = new Map<string, ActiveClient>();
	private _shuttingDown = false;

	/** External callback invoked whenever the set of available tools changes.
	 *  Set by the startup code to trigger syncMcpTools(). */
	onToolsChanged: (() => void) | null = null;

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
		// Preserve reconnect attempt count across reconnections so the
		// MAX_RECONNECT_ATTEMPTS limit is actually enforced.
		const prevAttempts = this.clients.get(config.id)?.reconnectAttempts ?? 0;

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
			reconnectAttempts: prevAttempts,
		};
		this.clients.set(config.id, entry);

		try {
			const transport = createTransport(config);
			const client = new Client({ name: "narrafork", version: "0.1.0" }, { capabilities: {} });

			entry.client = client;
			entry.transport = transport;

			// Handle transport close — auto-reconnect if not shutting down
			transport.onclose = () => {
				const e = this.clients.get(config.id);
				if (!e || e.status !== "connected") return;
				e.status = "error";
				e.error = "Transport closed unexpectedly";
				eventBus.emit({
					type: "mcp:server_disconnected",
					serverId: config.id,
					name: config.name,
					reason: "Transport closed",
				});
				this.onToolsChanged?.();
				this.scheduleReconnect(config.id);
			};

			// Connect with timeout
			await withTimeout(
				client.connect(transport),
				CONNECT_TIMEOUT_MS,
				`MCP connect to "${config.name}"`,
			);

			// Listen for tools/list_changed notifications — re-fetch tools when server updates them
			client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
				try {
					const refreshed = await client.listTools();
					entry.tools = refreshed.tools ?? [];
					logger.info(`MCP: "${config.name}" tools updated, now ${entry.tools.length} tool(s)`);
					this.onToolsChanged?.();
				} catch (err) {
					logger.warn(`MCP: failed to refresh tools for "${config.name}": ${err}`);
				}
			});

			// Discover tools
			const result = await withTimeout(
				client.listTools(),
				CONNECT_TIMEOUT_MS,
				`MCP listTools for "${config.name}"`,
			);
			entry.tools = result.tools ?? [];
			entry.status = "connected";
			entry.error = undefined;
			entry.reconnectAttempts = 0;

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
			this.scheduleReconnect(config.id);
		}
	}

	/** Disconnect a single MCP server. */
	async disconnect(serverId: string): Promise<void> {
		const entry = this.clients.get(serverId);
		if (!entry) return;

		// Clear any pending reconnect
		if (entry.reconnectTimer) {
			clearTimeout(entry.reconnectTimer);
			entry.reconnectTimer = undefined;
		}

		// Remove from map BEFORE closing transport so the onclose callback
		// (which fires during transport.close()) won't schedule a reconnect.
		const name = entry.config.name;
		this.clients.delete(serverId);

		try {
			await entry.transport?.close?.();
		} catch {
			// ignore close errors
		}
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
		signal?: AbortSignal,
	): Promise<{
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
			resource?: unknown;
		}>;
		isError?: boolean;
	}> {
		const entry = this.clients.get(serverId);
		if (!entry || entry.status !== "connected" || !entry.client) {
			throw new Error(`MCP server "${serverId}" is not connected`);
		}

		const result = await entry.client.callTool(
			{ name: toolName, arguments: args },
			undefined,
			signal ? { signal } : undefined,
		);
		return {
			content: (result.content ?? []) as Array<{
				type: string;
				text?: string;
				data?: string;
				mimeType?: string;
				resource?: unknown;
			}>,
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
				command: cfg.command,
				args: cfg.args,
				cwd: cfg.cwd,
				url: cfg.url,
				env: cfg.env,
				headers: cfg.headers,
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
		this._shuttingDown = true;
		const ids = [...this.clients.keys()];
		await Promise.allSettled(ids.map((id) => this.disconnect(id)));
	}

	/** Schedule an auto-reconnect attempt for a server. */
	private scheduleReconnect(serverId: string): void {
		if (this._shuttingDown) return;
		const entry = this.clients.get(serverId);
		if (!entry) return;
		if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			logger.warn(
				`MCP: "${entry.config.name}" exceeded max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}), giving up`,
			);
			return;
		}
		const delay = RECONNECT_DELAY_MS * (entry.reconnectAttempts + 1);
		logger.info(
			`MCP: scheduling reconnect for "${entry.config.name}" in ${delay}ms (attempt ${entry.reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`,
		);
		entry.reconnectTimer = setTimeout(async () => {
			entry.reconnectTimer = undefined;
			if (this._shuttingDown) return;
			entry.reconnectAttempts++;
			logger.info(
				`MCP: reconnecting to "${entry.config.name}" (attempt ${entry.reconnectAttempts})`,
			);
			try {
				await this.connect(entry.config);
				this.onToolsChanged?.();
			} catch (err) {
				logger.error(`MCP: reconnect failed for "${entry.config.name}": ${err}`);
			}
		}, delay);
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

/** Race a promise against a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}
