import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
	CallToolResultSchema,
	ListToolsResultSchema,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type McpLoadingMode, resolveMcpLoadingMode } from "@shared/mcp-loading-mode";
import { eventBus } from "../event-bus";
import { logger } from "../logger";
import type { McpServerConfig } from "../settings";
import { settings } from "../settings";
import { createTransport } from "./transports";

/** Timeout for a connection or one discovery page, not the entire directory (ms). */
const CONNECT_TIMEOUT_MS = 30_000;

/** Delay before attempting auto-reconnect after unexpected disconnect (ms). */
const RECONNECT_DELAY_MS = 5_000;

/** Maximum number of consecutive reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Safe MCP server configuration projection for API responses.
 *
 * The actual env/header values remain in settings and the active client config,
 * but API callers only need to know which keys are configured. Command, args,
 * cwd, and URL remain available because administrators use them to edit an
 * existing server; management routes are administrator-only.
 */
export interface McpServerConfigProjection {
	id: string;
	name: string;
	transport: McpServerConfig["transport"];
	command?: string;
	args?: string[];
	cwd?: string;
	url?: string;
	envKeys: string[];
	headerKeys: string[];
	mode: McpLoadingMode;
	enabled: boolean;
	defaultBehavior?: "readOnly" | "readWrite" | "ask" | "deny";
	toolPermissions?: Array<{ toolName: string; behavior: string; enabled?: boolean }>;
}

export interface McpServerStatus extends McpServerConfigProjection {
	status: "connected" | "disconnected" | "connecting" | "error";
	error?: string;
	tools: Tool[];
}

/** Outcome of re-fetching one server's tool list. */
export interface McpRefreshResult {
	ok: boolean;
	toolCount: number;
	error?: string;
}

/** Project a persisted MCP config without exposing secret values. */
export function projectMcpServerConfig(config: McpServerConfig): McpServerConfigProjection {
	return {
		id: config.id,
		name: config.name,
		transport: config.transport,
		...(config.command !== undefined && { command: config.command }),
		...(config.args !== undefined && { args: [...config.args] }),
		...(config.cwd !== undefined && { cwd: config.cwd }),
		...(config.url !== undefined && { url: config.url }),
		envKeys: Object.keys(config.env ?? {}).sort(),
		headerKeys: Object.keys(config.headers ?? {}).sort(),
		mode: resolveMcpLoadingMode(config),
		enabled: resolveMcpLoadingMode(config) !== "disabled",
		...(config.defaultBehavior !== undefined && { defaultBehavior: config.defaultBehavior }),
		...(config.toolPermissions !== undefined && { toolPermissions: config.toolPermissions }),
	};
}

export interface McpDirectoryEntry {
	serverId: string;
	serverName: string;
	tool: Tool;
}

interface ToolCandidate {
	entry: ActiveClient;
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
	/** Shared until publication finishes, so preparation also belongs to the flight. */
	discovery?: Promise<ToolCandidate>;
	candidate?: ToolCandidate;
	notification?: Promise<void>;
	refreshAgain?: boolean;
}

class McpManager {
	private clients = new Map<string, ActiveClient>();
	private _shuttingDown = false;
	private pending = new Map<ActiveClient, ToolCandidate>();
	private publication: Promise<void> | null = null;
	private revision = 0;

	/** Preparation must not mutate the registry. A false commit requests fresh preparation. */
	prepareTools: ((tools: readonly McpDirectoryEntry[]) => Promise<() => boolean>) | null = null;

	private isCurrent(entry: ActiveClient): boolean {
		return this.clients.get(entry.config.id) === entry && this.isCurrentConfig(entry.config);
	}

	private releaseCandidate(candidate: ToolCandidate): void {
		if (candidate.entry.candidate === candidate) {
			candidate.entry.candidate = undefined;
			candidate.entry.discovery = undefined;
		}
	}

	/** Only this short coordinator can publish. Network discovery never waits inside it. */
	private publish(candidates: ToolCandidate[] = []): Promise<void> {
		if (
			candidates.length &&
			candidates.every((candidate) => candidate.entry.tools === candidate.tools)
		)
			return this.publication ?? Promise.resolve();
		for (const candidate of candidates) {
			if (
				candidate.entry.tools === candidate.tools ||
				this.pending.get(candidate.entry) === candidate
			)
				continue;
			this.pending.set(candidate.entry, candidate);
			this.revision++;
		}
		if (this.publication) return this.publication;
		this.publication = Promise.resolve().then(async () => {
			try {
				for (;;) {
					for (const [entry, candidate] of this.pending) {
						if (!this.isCurrent(entry) || entry.status === "error") {
							this.pending.delete(entry);
							this.releaseCandidate(candidate);
						}
					}
					const revision = this.revision;
					// Permission/loading-only edits also invalidate preparation, without reconnecting.
					const configSnapshot = JSON.stringify(settings.mcpServers);
					const directory: McpDirectoryEntry[] = [];
					for (const entry of this.clients.values()) {
						if (!this.isCurrent(entry) || entry.status === "error") continue;
						const candidate = this.pending.get(entry);
						if (!candidate && entry.status !== "connected") continue;
						for (const tool of candidate?.tools ?? entry.tools) {
							directory.push({ serverId: entry.config.id, serverName: entry.config.name, tool });
						}
					}
					const commit = await this.prepareTools?.(directory);
					if (revision !== this.revision || configSnapshot !== JSON.stringify(settings.mcpServers))
						continue;
					if (commit && !commit()) continue;
					// No await or callbacks between registry commit and all execution metadata updates.
					const connected: ActiveClient[] = [];
					for (const [entry, candidate] of this.pending) {
						const connecting = entry.status === "connecting";
						entry.tools = candidate.tools;
						entry.status = "connected";
						entry.error = undefined;
						entry.reconnectAttempts = 0;
						this.releaseCandidate(candidate);
						if (connecting) connected.push(entry);
					}
					this.pending.clear();
					for (const entry of connected) {
						if (this.isCurrent(entry) && entry.status === "connected")
							eventBus.emit({
								type: "mcp:server_connected",
								serverId: entry.config.id,
								name: entry.config.name,
								toolCount: entry.tools.length,
							});
					}
					// Synchronous event listeners can disconnect/replace a lifecycle or change settings.
					if (revision !== this.revision || configSnapshot !== JSON.stringify(settings.mcpServers))
						continue;
					return;
				}
			} catch (error) {
				for (const entry of this.pending.keys()) {
					if (this.isCurrent(entry) && entry.status === "connecting")
						this.connectionFailed(entry, error);
				}
				throw error;
			} finally {
				for (const candidate of this.pending.values()) this.releaseCandidate(candidate);
				this.pending.clear();
				this.publication = null;
			}
		});
		return this.publication;
	}

	private async closeEntry(entry: ActiveClient): Promise<void> {
		if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
		entry.reconnectTimer = undefined;
		try {
			await entry.transport?.close?.();
		} catch {
			/* ignore close errors */
		}
	}

	private notify(entry: ActiveClient): Promise<void> {
		entry.refreshAgain = true;
		if (entry.notification) return entry.notification;
		entry.notification = Promise.resolve().then(async () => {
			try {
				if (!this.isCurrent(entry)) return;
				// A notification during an existing discovery needs one fresh pass after it.
				if (entry.discovery) await this.refresh(entry.config.id);
				do {
					entry.refreshAgain = false;
					if (!this.isCurrent(entry)) return;
					const result = await this.refresh(entry.config.id);
					if (!result.ok)
						logger.warn(`MCP: failed to refresh tools for "${entry.config.name}": ${result.error}`);
				} while (entry.refreshAgain);
			} finally {
				entry.notification = undefined;
			}
		});
		return entry.notification;
	}

	/** Initialize: connect all enabled servers from settings. */
	async initialize(): Promise<void> {
		this._shuttingDown = false;
		const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
		const enabled = servers.filter((s) => resolveMcpLoadingMode(s) !== "disabled");
		const discovered = await Promise.allSettled(enabled.map((s) => this.startConnection(s)));
		await this.publish(
			discovered.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : [])),
		);
	}

	/** Connect and publish before returning; bulk callers use the private network stage. */
	async connect(config: McpServerConfig): Promise<void> {
		const candidate = await this.startConnection(config);
		await this.publish(candidate ? [candidate] : []);
	}

	private startConnection(config: McpServerConfig): Promise<ToolCandidate | null> {
		config = structuredClone(config);
		if (!this.isCurrentConfig(config)) return Promise.resolve(null);
		const previous = this.clients.get(config.id);
		if (previous?.status === "connecting" && this.isCurrent(previous) && previous.discovery)
			return previous.discovery.catch(() => null);
		const entry: ActiveClient = {
			config,
			client: null,
			transport: null,
			tools: [],
			status: "connecting",
			reconnectAttempts: previous?.reconnectAttempts ?? 0,
		};
		// Install the sole lifecycle record before the first await, including transport close.
		this.clients.set(config.id, entry);
		this.revision++;
		entry.discovery = Promise.resolve().then(async () => {
			try {
				if (previous) await this.closeEntry(previous);
				if (!this.isCurrent(entry)) throw new Error("MCP connection superseded");
				const transport = createTransport(config);
				const client = new Client({ name: "narrafork", version: "0.1.0" }, { capabilities: {} });
				entry.client = client;
				entry.transport = transport;
				// Use the Client hook: the SDK owns and replaces transport.onclose on connect.
				client.onclose = () => {
					if (!this.isCurrent(entry) || entry.status === "error") return;
					this.connectionFailed(entry, new Error("Transport closed unexpectedly"));
					eventBus.emit({
						type: "mcp:server_disconnected",
						serverId: config.id,
						name: config.name,
						reason: "Transport closed",
					});
					void this.publish().catch((error) =>
						logger.warn(`MCP: disconnect publication failed: ${error}`),
					);
				};
				await withTimeout(
					client.connect(transport),
					CONNECT_TIMEOUT_MS,
					`MCP connect to "${config.name}"`,
				);
				if (!this.isCurrent(entry) || entry.status === "error")
					throw new Error("MCP connection superseded");
				client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.notify(entry));
				const tools = await listAllTools(client);
				if (!this.isCurrent(entry) || this.clients.get(config.id)?.status === "error")
					throw new Error("MCP connection superseded");
				const candidate = { entry, tools };
				entry.candidate = candidate;
				return candidate;
			} catch (error) {
				entry.discovery = undefined;
				entry.status = "error";
				this.revision++;
				await this.closeEntry(entry);
				if (this.isCurrent(entry)) this.connectionFailed(entry, error);
				throw error;
			}
		});
		// connect historically reports network failures through status rather than rejection.
		return entry.discovery.catch(() => null);
	}

	private connectionFailed(entry: ActiveClient, error: unknown): void {
		entry.status = "error";
		entry.error = error instanceof Error ? error.message : String(error);
		this.revision++;
		eventBus.emit({
			type: "mcp:server_error",
			serverId: entry.config.id,
			name: entry.config.name,
			error: entry.error,
		});
		this.scheduleReconnect(entry.config.id);
	}

	/** Disconnect a single MCP server. */
	async disconnect(serverId: string): Promise<void> {
		const entry = this.clients.get(serverId);
		this.clients.delete(serverId);
		this.revision++;
		await Promise.all([entry ? this.closeEntry(entry) : Promise.resolve(), this.publish()]);
		if (entry)
			eventBus.emit({ type: "mcp:server_disconnected", serverId, name: entry.config.name });
	}

	/**
	 * Re-fetch a server's tool list without a config change.
	 *
	 * Prefers a lightweight `tools/list` on the live connection — the case where an
	 * upstream (e.g. JetBrains MCP) toggles APIs but never sends `tools/list_changed`.
	 * Reconnects a missing client or an expired HTTP session. Other discovery errors
	 * keep the previous complete directory. Does not change persisted intent: a disabled server is
	 * reported as an error rather than silently brought up.
	 */
	async refresh(serverId: string): Promise<McpRefreshResult> {
		try {
			const candidate = await this.discover(serverId);
			await this.publish([candidate]);
			return this.refreshResult(candidate);
		} catch (error) {
			return this.refreshError(serverId, error);
		}
	}

	private async discover(serverId: string): Promise<ToolCandidate> {
		const config = (Array.isArray(settings.mcpServers) ? settings.mcpServers : []).find(
			(s) => s.id === serverId,
		);
		if (!config) throw new Error(`MCP server "${serverId}" is not configured`);
		if (resolveMcpLoadingMode(config) === "disabled")
			throw new Error(`MCP server "${config.name}" is disabled`);
		const entry = this.clients.get(serverId);
		if (entry && !this.isCurrent(entry)) throw new Error("MCP server changed during refresh");
		if (entry?.discovery) return entry.discovery;
		if (!entry || entry.status !== "connected" || !entry.client) {
			const candidate = await this.startConnection(config);
			if (!candidate)
				throw new Error(this.clients.get(serverId)?.error ?? "MCP connection cancelled");
			return candidate;
		}
		const client = entry.client;
		entry.discovery = Promise.resolve().then(async () => {
			try {
				const tools = await listAllTools(client);
				if (!this.isCurrent(entry) || entry.status !== "connected")
					throw new Error("MCP server changed or was disconnected during refresh");
				const candidate = { entry, tools };
				entry.candidate = candidate;
				return candidate;
			} catch (error) {
				entry.discovery = undefined;
				if (this.isCurrent(entry) && error instanceof StreamableHTTPError && error.code === 404) {
					const candidate = await this.startConnection(config);
					if (candidate) return candidate;
				}
				throw error;
			}
		});
		return entry.discovery;
	}

	private refreshResult(candidate: ToolCandidate): McpRefreshResult {
		if (!this.isCurrent(candidate.entry) || candidate.entry.status !== "connected")
			return {
				ok: false,
				toolCount: 0,
				error: "MCP server changed or was disconnected during refresh",
			};
		return { ok: true, toolCount: candidate.entry.tools.length };
	}

	private refreshError(serverId: string, error: unknown): McpRefreshResult {
		return {
			ok: false,
			toolCount: this.clients.get(serverId)?.tools.length ?? 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	/** Refresh the tool list of every enabled configured server. */
	async refreshAll(): Promise<Array<{ serverId: string; name: string } & McpRefreshResult>> {
		const servers = (Array.isArray(settings.mcpServers) ? settings.mcpServers : []).filter(
			(s) => resolveMcpLoadingMode(s) !== "disabled",
		);
		const settled = await Promise.allSettled(servers.map((s) => this.discover(s.id)));
		let publicationError: unknown;
		try {
			await this.publish(settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
		} catch (error) {
			publicationError = error;
		}
		return settled.map((result, idx) => ({
			serverId: servers[idx].id,
			name: servers[idx].name,
			...(result.status === "rejected"
				? this.refreshError(servers[idx].id, result.reason)
				: publicationError
					? this.refreshError(servers[idx].id, publicationError)
					: this.refreshResult(result.value)),
		}));
	}

	/** Reload: reconcile running clients with current settings. */
	async reload(): Promise<void> {
		const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
		const configMap = new Map(servers.map((s) => [s.id, s]));

		const closing: Promise<void>[] = [];
		for (const [id, entry] of this.clients) {
			const cfg = configMap.get(id);
			if (!cfg || resolveMcpLoadingMode(cfg) === "disabled") {
				this.clients.delete(id);
				this.revision++;
				closing.push(this.closeEntry(entry));
			}
		}
		const connecting = servers.filter((cfg) => {
			const existing = this.clients.get(cfg.id);
			return (
				resolveMcpLoadingMode(cfg) !== "disabled" &&
				(!existing || this.configChanged(existing.config, cfg))
			);
		});
		const discovered = await Promise.allSettled(connecting.map((cfg) => this.startConnection(cfg)));
		await Promise.all(closing);
		// Always publish, including permission-only changes and an empty directory after removal.
		await this.publish(
			discovered.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : [])),
		);
	}

	/** Get all available MCP tools across connected servers. */
	isServerConnected(serverId: string): boolean {
		const entry = this.clients.get(serverId);
		return entry?.status === "connected";
	}

	getAvailableTools(): McpDirectoryEntry[] {
		const result: McpDirectoryEntry[] = [];
		for (const [, entry] of this.clients) {
			if (entry.status !== "connected" || !this.isCurrentConfig(entry.config)) continue;
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
		signal?.throwIfAborted();
		const entry = this.clients.get(serverId);
		if (!entry || entry.status !== "connected" || !this.isCurrent(entry) || !entry.client) {
			throw new Error(`MCP server "${serverId}" is not connected`);
		}
		const tool = entry.tools.find((candidate) => candidate.name === toolName);
		if (!tool) throw new Error(`MCP tool "${toolName}" is not in the published directory`);
		// Read execution metadata from the same complete directory that declares the tools,
		// including tools on earlier pages and the old directory after a failed refresh.
		if (tool.execution?.taskSupport === "required") {
			throw new Error(
				`MCP tool "${toolName}" requires task-based execution, which is not supported`,
			);
		}
		// NarraFork consumes the content envelope, not structured fields as typed business data.
		// Validate that envelope without the SDK's outputSchema precompilation/validation cache.
		const result = await entry.client.request(
			{ method: "tools/call", params: { name: toolName, arguments: args } },
			CallToolResultSchema,
			signal ? { signal } : undefined,
		);
		return {
			content:
				result.content.length || result.structuredContent === undefined
					? result.content
					: [
							{
								type: "text",
								text: "The MCP server returned structured content only (currently not displayed). The tool call has completed.",
							},
						],
			isError: result.isError,
		};
	}

	/** Get status of all configured servers. */
	getServerStatuses(): McpServerStatus[] {
		const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
		return servers.map((cfg) => {
			const entry = this.clients.get(cfg.id);
			return {
				...projectMcpServerConfig(cfg),
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
			const tools = await listAllTools(client);
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
		if (!entry || entry.status !== "error" || entry.reconnectTimer || !this.isCurrent(entry))
			return;
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
			if (this._shuttingDown || !this.isCurrent(entry)) return;
			entry.reconnectAttempts++;
			logger.info(
				`MCP: reconnecting to "${entry.config.name}" (attempt ${entry.reconnectAttempts})`,
			);
			try {
				await this.connect(entry.config);
			} catch (err) {
				logger.error(`MCP: reconnect failed for "${entry.config.name}": ${err}`);
			}
		}, delay);
	}

	private isCurrentConfig(config: McpServerConfig): boolean {
		const current = (Array.isArray(settings.mcpServers) ? settings.mcpServers : []).find(
			(s) => s.id === config.id,
		);
		return (
			!!current &&
			resolveMcpLoadingMode(current) !== "disabled" &&
			resolveMcpLoadingMode(config) !== "disabled" &&
			!this.configChanged(current, config)
		);
	}

	private configChanged(a: McpServerConfig, b: McpServerConfig): boolean {
		return (
			a.name !== b.name ||
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

/** Bound each SDK request, not the total directory: a healthy next page may continue. */
async function listAllTools(client: Client): Promise<Tool[]> {
	const tools: Tool[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	do {
		// Keep protocol validation, but do not compile unused outputSchema contracts or
		// mutate the SDK's page-local metadata cache. entry.tools owns the complete directory.
		const page = await client.request(
			{ method: "tools/list", params: cursor === undefined ? undefined : { cursor } },
			ListToolsResultSchema,
			{ timeout: CONNECT_TIMEOUT_MS },
		);
		for (const tool of page.tools ?? []) tools.push(tool);
		cursor = page.nextCursor;
		if (cursor !== undefined) {
			if (cursors.has(cursor)) throw new Error("MCP tools/list returned a repeated cursor");
			cursors.add(cursor);
		}
	} while (cursor !== undefined);
	return tools;
}

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
