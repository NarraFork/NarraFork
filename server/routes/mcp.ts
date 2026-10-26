import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	applyMcpLoadingPatch,
	hasMcpLoadingConflict,
	normalizeMcpLoadingConfig,
	resolveMcpLoadingMode,
} from "@shared/mcp-loading-mode";
import { Hono } from "hono";
import { z } from "zod";
import { generateShortId } from "../lib/id";
import { mcpManager, projectMcpServerConfig } from "../lib/mcp/manager";
import { syncMcpTools } from "../lib/mcp/tool-bridge";
import { type McpServerConfig, saveSettings, settings } from "../lib/settings";
import { requireAdmin } from "../middleware/auth";
import { narratorContext } from "../services/narrator-context";
import { countNarratorMessageRefs } from "../services/narrator-message-count";
import { narratorService } from "../services/narrator-service";

function createMcpServer(userId?: string | null): McpServer {
	const server = new McpServer({
		name: "narrafork",
		version: "0.1.0",
	});

	server.tool(
		"narrafork_get_context_summary",
		"Get an AI-generated context summary of a narrator's recent conversation",
		{ narratorId: z.string().describe("Narrator ID to get context from") },
		async ({ narratorId }) => {
			try {
				const narrator = await narratorService.getById(narratorId);
				const summary = await narratorContext.generateContextSummary(narratorId, "en", { userId });
				const messageCount = await countNarratorMessageRefs(narratorId);

				return {
					content: [
						{
							type: "text",
							text: `Narrator: ${narrator.type} (${narrator.model})\nStatus: ${narrator.status}\nMessages: ${messageCount}\n\nContext summary:\n${summary}`,
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
					],
					isError: true,
				};
			}
		},
	);

	return server;
}

// === Hono route handler ===

export const mcpRoutes = new Hono();

mcpRoutes.post("/", async (c) => {
	const server = createMcpServer(c.get("user")?.sub);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	});

	await server.connect(transport);

	return transport.handleRequest(c.req.raw);
});

// === External MCP server management ===

const mcpBehaviorSchema = z
	.enum(["allow", "readOnly", "readWrite", "ask", "deny"])
	.transform((behavior) => (behavior === "allow" ? "readWrite" : behavior));
const mcpSecretMapSchema = z.record(z.string().min(1).max(200), z.string().max(2000));
const mcpSecretMapPatchSchema = z.object({
	set: mcpSecretMapSchema.optional(),
	delete: z.array(z.string().min(1).max(200)).max(200).optional(),
});
const mcpToolPermissionInputSchema = z.object({
	toolName: z.string().min(1).max(200),
	behavior: mcpBehaviorSchema,
	enabled: z.boolean().optional(),
});
const mcpToolPermissionPatchSchema = z.object({
	toolName: z.string().min(1).max(200),
	// null clears the per-tool override; undefined leaves the existing behavior unchanged.
	behavior: mcpBehaviorSchema.nullable().optional(),
	enabled: z.boolean().optional(),
});

const mcpServerCreateSchema = z.object({
	name: z.string().min(1).max(200).optional().default("Untitled"),
	transport: z.enum(["stdio", "streamable-http", "sse"]).optional().default("stdio"),
	command: z.string().max(500).optional(),
	args: z.array(z.string().max(500)).max(50).optional(),
	cwd: z.string().max(500).optional(),
	env: mcpSecretMapSchema.optional(),
	url: z.string().url().max(2000).optional(),
	headers: mcpSecretMapSchema.optional(),
	mode: z.enum(["disabled", "auto", "resident"]).optional(),
	enabled: z.boolean().optional(),
	defaultBehavior: mcpBehaviorSchema.optional(),
	toolPermissions: z.array(mcpToolPermissionInputSchema).optional(),
});

const mcpServerPatchSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	transport: z.enum(["stdio", "streamable-http", "sse"]).optional(),
	command: z.string().max(500).optional(),
	args: z.array(z.string().max(500)).max(50).optional(),
	cwd: z.string().max(500).optional(),
	env: mcpSecretMapSchema.optional(),
	envPatch: mcpSecretMapPatchSchema.optional(),
	url: z.string().url().max(2000).optional(),
	headers: mcpSecretMapSchema.optional(),
	headerPatch: mcpSecretMapPatchSchema.optional(),
	mode: z.enum(["disabled", "auto", "resident"]).optional(),
	enabled: z.boolean().optional(),
	// null explicitly clears the server-level override; undefined leaves it unchanged.
	defaultBehavior: mcpBehaviorSchema.nullable().optional(),
	toolPermissions: z.array(mcpToolPermissionInputSchema).optional(),
	toolPermissionPatch: mcpToolPermissionPatchSchema.optional(),
});

function applyMcpSecretMapPatch(
	current: Record<string, string> | undefined,
	patch: z.infer<typeof mcpSecretMapPatchSchema>,
): Record<string, string> | undefined {
	const next = { ...(current ?? {}) };
	for (const key of patch.delete ?? []) delete next[key];
	Object.assign(next, patch.set ?? {});
	return Object.keys(next).length > 0 ? next : undefined;
}

function applyMcpServerPatch(
	server: McpServerConfig,
	patch: z.infer<typeof mcpServerPatchSchema>,
): McpServerConfig {
	const { defaultBehavior, toolPermissionPatch, envPatch, headerPatch, ...rest } = patch;
	const updated: McpServerConfig = { ...server, ...rest, ...applyMcpLoadingPatch(server, patch) };
	if (envPatch) {
		const env = applyMcpSecretMapPatch(updated.env, envPatch);
		if (env) updated.env = env;
		else delete updated.env;
	}
	if (headerPatch) {
		const headers = applyMcpSecretMapPatch(updated.headers, headerPatch);
		if (headers) updated.headers = headers;
		else delete updated.headers;
	}
	if ("defaultBehavior" in patch) {
		if (defaultBehavior == null) {
			delete updated.defaultBehavior;
		} else {
			updated.defaultBehavior = defaultBehavior;
		}
	}
	if (toolPermissionPatch) {
		const existing = [...(updated.toolPermissions ?? [])];
		const idx = existing.findIndex((tp) => tp.toolName === toolPermissionPatch.toolName);
		if (toolPermissionPatch.behavior === null) {
			if (idx >= 0) existing.splice(idx, 1);
		} else if (toolPermissionPatch.behavior === undefined) {
			if (idx >= 0 && toolPermissionPatch.enabled !== undefined) {
				existing[idx] = { ...existing[idx], enabled: toolPermissionPatch.enabled };
			}
		} else {
			const nextRule = {
				...(idx >= 0 ? existing[idx] : {}),
				toolName: toolPermissionPatch.toolName,
				behavior: toolPermissionPatch.behavior,
				...(toolPermissionPatch.enabled !== undefined && { enabled: toolPermissionPatch.enabled }),
			};
			if (idx >= 0) {
				existing[idx] = nextRule;
			} else {
				existing.push(nextRule);
			}
		}
		if (existing.length > 0) {
			updated.toolPermissions = existing;
		} else {
			delete updated.toolPermissions;
		}
	}
	return updated;
}

/** List all configured MCP servers with runtime status. */
mcpRoutes.get("/servers", requireAdmin, (c) => {
	return c.json({ servers: mcpManager.getServerStatuses() });
});

/** Add a new MCP server. */
mcpRoutes.post("/servers", requireAdmin, async (c) => {
	const body = await c.req.json();
	const parsed = mcpServerCreateSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.message }, 400);
	}
	if (hasMcpLoadingConflict(parsed.data))
		return c.json({ error: "MCP mode conflicts with enabled" }, 400);
	const config: McpServerConfig = normalizeMcpLoadingConfig({
		id: generateShortId(),
		...parsed.data,
	});

	const servers = [...(Array.isArray(settings.mcpServers) ? settings.mcpServers : []), config];
	settings.mcpServers = servers;
	saveSettings(settings);

	if (config.enabled) {
		await mcpManager.connect(config);
		syncMcpTools();
	}

	return c.json(projectMcpServerConfig(config), 201);
});

/** Update an existing MCP server. */
mcpRoutes.patch("/servers/:id", requireAdmin, async (c) => {
	const { id } = c.req.param();
	const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const idx = servers.findIndex((s) => s.id === id);
	if (idx === -1) return c.json({ error: "Not found" }, 404);

	const body = await c.req.json();
	const parsed = mcpServerPatchSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.message }, 400);
	}
	if (hasMcpLoadingConflict(parsed.data))
		return c.json({ error: "MCP mode conflicts with enabled" }, 400);
	const updated = applyMcpServerPatch(servers[idx], parsed.data);
	servers[idx] = updated;
	settings.mcpServers = servers;
	saveSettings(settings);

	await mcpManager.reload();
	syncMcpTools();

	return c.json(projectMcpServerConfig(updated));
});

/** Delete an MCP server. */
mcpRoutes.delete("/servers/:id", requireAdmin, async (c) => {
	const { id } = c.req.param();
	const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const idx = servers.findIndex((s) => s.id === id);
	if (idx === -1) return c.json({ error: "Not found" }, 404);

	await mcpManager.disconnect(id);
	servers.splice(idx, 1);
	settings.mcpServers = servers;
	saveSettings(settings);
	syncMcpTools();

	return c.json({ ok: true });
});

/**
 * Manually connect a server, persisting the intent.
 *
 * Connect and disconnect are the same switch as the `enabled` toggle in the edit
 * dialog: there is exactly one persisted connection intent. Without persisting
 * here, a manual disconnect would be undone by the next startup (`initialize()`
 * reconnects everything still marked `enabled`) or even by the next unrelated
 * `PATCH` (which calls `reload()`).
 *
 * Settings are written before touching the runtime so that a crash between the
 * two steps leaves the intent recorded rather than silently reverted.
 */
mcpRoutes.post("/servers/:id/connect", requireAdmin, async (c) => {
	const { id } = c.req.param();
	const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const config = servers.find((s) => s.id === id);
	if (!config) return c.json({ error: "Not found" }, 404);

	Object.assign(config, applyMcpLoadingPatch(config, { enabled: true }));
	settings.mcpServers = servers;
	saveSettings(settings);

	// A failed connection is deliberately NOT rolled back to enabled=false: the
	// user asked for this server to be up, and the failure is already reported
	// through status/error. Reverting would silently discard that request and
	// stop future startups from retrying.
	await mcpManager.connect(config);
	syncMcpTools();

	const statuses = mcpManager.getServerStatuses();
	const status = statuses.find((s) => s.id === id);
	return c.json(status ?? { id, status: "error" });
});

/** Manually disconnect a server, persisting the intent (see connect above). */
mcpRoutes.post("/servers/:id/disconnect", requireAdmin, async (c) => {
	const { id } = c.req.param();
	const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const config = servers.find((s) => s.id === id);
	// Accepting an unknown id would let the caller believe they turned something
	// off, which now also means "wrote a config change" — worth failing loudly.
	if (!config) return c.json({ error: "Not found" }, 404);

	if (resolveMcpLoadingMode(config) !== "disabled" || config.enabled !== false) {
		Object.assign(config, applyMcpLoadingPatch(config, { mode: "disabled" }));
		settings.mcpServers = servers;
		saveSettings(settings);
	}

	await mcpManager.disconnect(id);
	syncMcpTools();

	const statuses = mcpManager.getServerStatuses();
	const status = statuses.find((s) => s.id === id);
	return c.json(status ?? { id, status: "disconnected", enabled: false });
});

/**
 * Re-fetch a server's tool list without toggling the connection intent.
 *
 * Distinct from disconnect+connect: a live connection only re-runs `tools/list`,
 * which is what an upstream that toggles APIs without `tools/list_changed`
 * (e.g. JetBrains MCP) needs. A dead connection falls back to reconnect.
 */
mcpRoutes.post("/servers/:id/refresh", requireAdmin, async (c) => {
	const { id } = c.req.param();
	const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const config = servers.find((s) => s.id === id);
	if (!config) return c.json({ error: "Not found" }, 404);

	const result = await mcpManager.refresh(id);
	syncMcpTools();

	const status = mcpManager.getServerStatuses().find((s) => s.id === id);
	if (!result.ok) {
		return c.json(
			{
				error: result.error ?? "Failed to refresh MCP tools",
				ok: false,
				toolCount: result.toolCount,
				status: status ?? { id, status: "error", error: result.error },
			},
			502,
		);
	}
	return c.json({
		ok: true,
		toolCount: result.toolCount,
		status: status ?? { id, status: "connected", tools: [] },
	});
});

/** Re-fetch tool lists of every enabled MCP server. */
mcpRoutes.post("/servers/refresh", requireAdmin, async (c) => {
	const results = await mcpManager.refreshAll();
	syncMcpTools();
	const failed = results.filter((r) => !r.ok);
	return c.json({
		ok: failed.length === 0,
		refreshed: results.length - failed.length,
		failed: failed.length,
		results,
	});
});

/** Test an existing server with secret values inherited from persisted settings. */
mcpRoutes.post("/servers/:id/test", requireAdmin, async (c) => {
	const { id } = c.req.param();
	const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const existing = servers.find((s) => s.id === id);
	if (!existing) return c.json({ error: "Not found" }, 404);

	const body = await c.req.json();
	const parsed = mcpServerPatchSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.message }, 400);
	}
	if (hasMcpLoadingConflict(parsed.data)) {
		return c.json({ error: "MCP mode conflicts with enabled" }, 400);
	}

	const config: McpServerConfig = {
		...applyMcpServerPatch(existing, parsed.data),
		id: `test-${id}`,
		mode: "auto",
		enabled: true,
	};
	return c.json(await mcpManager.testConnection(config));
});

/** Test connection without persisting. */
mcpRoutes.post("/servers/test", requireAdmin, async (c) => {
	const body = await c.req.json();
	const parsed = mcpServerCreateSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.message }, 400);
	}
	if (hasMcpLoadingConflict(parsed.data)) {
		return c.json({ error: "MCP mode conflicts with enabled" }, 400);
	}
	const config: McpServerConfig = {
		id: "test",
		...parsed.data,
		mode: "auto",
		enabled: true,
	};

	const result = await mcpManager.testConnection(config);
	return c.json(result);
});

/** Import MCP servers from JSON (Claude Desktop / Cursor / VS Code format). */
mcpRoutes.post("/servers/import", requireAdmin, async (c) => {
	const body = await c.req.json();
	const json = body.json;
	if (!json || typeof json !== "object") {
		return c.json({ error: "Invalid JSON" }, 400);
	}

	// Normalize: accept { mcpServers: { ... } } or { servers: { ... } } or bare { name: { ... } }
	// Also accept single server config object (JetBrains format): { type: "sse", url: "..." }
	// biome-ignore lint/suspicious/noExplicitAny: flexible import format
	let serverMap: Record<string, any> = {};
	if (json.mcpServers && typeof json.mcpServers === "object") {
		serverMap = json.mcpServers;
	} else if (json.servers && typeof json.servers === "object" && !Array.isArray(json.servers)) {
		serverMap = json.servers;
	} else {
		// Check if this is a single server config (has url/command or type field)
		const isSingleServer =
			typeof json.url === "string" ||
			typeof json.command === "string" ||
			(typeof json.type === "string" && ["stdio", "sse", "streamable-http"].includes(json.type));
		if (isSingleServer) {
			// Wrap as a named server map; derive name from url host or command
			let autoName = "imported-server";
			if (typeof json.url === "string") {
				try {
					const u = new URL(json.url);
					autoName = u.hostname === "localhost" ? `localhost-${u.port}` : u.hostname;
				} catch {}
			} else if (typeof json.command === "string") {
				autoName = json.command.split("/").pop() ?? "imported-server";
			}
			serverMap = { [autoName]: json };
		} else {
			// Try treating the whole object as a server map (each key = server name)
			const keys = Object.keys(json);
			const looksLikeServerMap = keys.length > 0 && keys.every((k) => typeof json[k] === "object");
			if (looksLikeServerMap) {
				serverMap = json;
			} else {
				return c.json({ error: "Unrecognized format" }, 400);
			}
		}
	}

	const existing = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const existingNames = new Set(existing.map((s) => s.name.toLowerCase()));
	const added: McpServerConfig[] = [];
	let skipped = 0;

	for (const [name, cfg] of Object.entries(serverMap)) {
		if (!cfg || typeof cfg !== "object") continue;

		// Skip duplicates by name
		if (existingNames.has(name.toLowerCase())) {
			skipped++;
			continue;
		}

		// Detect transport type — support both "transport" and "type" fields
		const rawTransport = cfg.transport ?? cfg.type;
		let transport: McpServerConfig["transport"] = "stdio";
		if (rawTransport === "sse") {
			transport = "sse";
		} else if (rawTransport === "streamable-http") {
			transport = "streamable-http";
		} else if (cfg.url && !cfg.command) {
			transport = "streamable-http";
		}

		// Filter out null/undefined header values (e.g. JetBrains format)
		let headers: Record<string, string> | undefined;
		if (cfg.headers && typeof cfg.headers === "object") {
			const filtered: [string, string][] = Object.entries(cfg.headers).filter(
				(entry): entry is [string, string] => entry[1] != null && typeof entry[1] === "string",
			);
			headers = filtered.length > 0 ? Object.fromEntries(filtered) : undefined;
		}

		const loading = z
			.object({
				mode: z.enum(["disabled", "auto", "resident"]).optional(),
				enabled: z.boolean().optional(),
			})
			.safeParse({ mode: cfg.mode, enabled: cfg.disabled === true ? false : cfg.enabled });
		if (!loading.success || hasMcpLoadingConflict(loading.data)) {
			return c.json({ error: `Invalid MCP loading policy for ${name}` }, 400);
		}
		const config: McpServerConfig = {
			id: generateShortId(),
			name,
			transport,
			...normalizeMcpLoadingConfig(loading.data),
			command: cfg.command,
			args: Array.isArray(cfg.args) ? cfg.args : undefined,
			cwd: cfg.cwd,
			env: cfg.env && typeof cfg.env === "object" ? cfg.env : undefined,
			url: cfg.url,
			headers,
		};

		added.push(config);
		existingNames.add(name.toLowerCase());
	}

	if (added.length > 0) {
		settings.mcpServers = [...existing, ...added];
		saveSettings(settings);

		// Connect enabled servers
		for (const cfg of added) {
			if (cfg.enabled) {
				await mcpManager.connect(cfg);
			}
		}
		syncMcpTools();
	}

	return c.json({ added: added.length, skipped });
});

/** List all MCP tools (from connected external servers). */
mcpRoutes.get("/tools", (c) => {
	const externalTools = mcpManager.getAvailableTools().map(({ serverId, serverName, tool }) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		serverName,
		serverId,
		source: "external" as const,
	}));

	return c.json({ tools: externalTools });
});
