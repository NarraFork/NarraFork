import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	applyMcpLoadingPatch,
	hasMcpLoadingConflict,
	normalizeMcpLoadingConfig,
	resolveMcpLoadingMode,
} from "@shared/mcp-loading-mode";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { generateShortId } from "../lib/id";
import { mcpManager, projectMcpServerConfig } from "../lib/mcp/manager";
import {
	cancelMcpOAuth,
	deleteMcpOAuth,
	finishMcpOAuth,
	MCP_OAUTH_CALLBACK_PATH,
	setMcpOAuthClientSecret,
	signOutMcpOAuth,
	startMcpOAuth,
} from "../lib/mcp/oauth";
import { resolvePublicOrigin } from "../lib/public-origin";
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

const mcpOAuthConfigSchema = z.object({
	clientId: z.string().min(1).max(500).optional(),
	scope: z.string().min(1).max(1000).optional(),
});
// Stored in the encrypted MCP OAuth file, never in settings.json. null clears it.
const mcpOAuthClientSecretSchema = z.string().max(4000).nullable().optional();

const mcpServerCreateSchema = z.object({
	name: z.string().min(1).max(200).optional().default("Untitled"),
	transport: z.enum(["stdio", "streamable-http", "sse"]).optional().default("stdio"),
	command: z.string().max(500).optional(),
	args: z.array(z.string().max(500)).max(50).optional(),
	cwd: z.string().max(500).optional(),
	env: mcpSecretMapSchema.optional(),
	url: z.string().url().max(2000).optional(),
	headers: mcpSecretMapSchema.optional(),
	oauth: mcpOAuthConfigSchema.optional(),
	oauthClientSecret: mcpOAuthClientSecretSchema,
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
	// null removes the OAuth client settings; undefined leaves them unchanged.
	oauth: mcpOAuthConfigSchema.nullable().optional(),
	oauthClientSecret: mcpOAuthClientSecretSchema,
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
	const {
		defaultBehavior,
		toolPermissionPatch,
		envPatch,
		headerPatch,
		oauth,
		oauthClientSecret: _secret,
		...rest
	} = patch;
	const updated: McpServerConfig = { ...server, ...rest, ...applyMcpLoadingPatch(server, patch) };
	if (oauth === null) delete updated.oauth;
	else if (oauth) updated.oauth = oauth;
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
	const { oauthClientSecret, ...fields } = parsed.data;
	const config: McpServerConfig = normalizeMcpLoadingConfig({
		id: generateShortId(),
		...fields,
	});

	const servers = [...(Array.isArray(settings.mcpServers) ? settings.mcpServers : []), config];
	settings.mcpServers = servers;
	saveSettings(settings);
	setMcpOAuthClientSecret(config.id, oauthClientSecret);

	if (config.enabled) {
		await mcpManager.connect(config);
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
	setMcpOAuthClientSecret(id, parsed.data.oauthClientSecret);

	await mcpManager.reload();

	return c.json(projectMcpServerConfig(updated));
});

/** Delete an MCP server. */
mcpRoutes.delete("/servers/:id", requireAdmin, async (c) => {
	const { id } = c.req.param();
	const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const idx = servers.findIndex((s) => s.id === id);
	if (idx === -1) return c.json({ error: "Not found" }, 404);

	servers.splice(idx, 1);
	settings.mcpServers = servers;
	saveSettings(settings);
	await mcpManager.disconnect(id);
	deleteMcpOAuth(id);

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
	// Reuse the saved server's OAuth tokens; a test never starts an authorization.
	return c.json(await mcpManager.testConnection(config, id));
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
	const { oauthClientSecret: _secret, ...fields } = parsed.data;
	const config: McpServerConfig = {
		id: "test",
		...fields,
		mode: "auto",
		enabled: true,
	};

	const result = await mcpManager.testConnection(config);
	return c.json(result);
});

function findMcpServer(id: string): McpServerConfig | undefined {
	return (Array.isArray(settings.mcpServers) ? settings.mcpServers : []).find((s) => s.id === id);
}

/** The callback must reach this server at the origin the admin's browser used. */
function mcpOAuthRedirectUrl(c: Context): string {
	const origin = c.req.header("Origin");
	if (origin) {
		try {
			const url = new URL(origin);
			if (url.protocol === "http:" || url.protocol === "https:")
				return `${url.origin}${MCP_OAUTH_CALLBACK_PATH}`;
		} catch {
			// fall through to the resolved public origin
		}
	}
	return `${resolvePublicOrigin(c).origin}${MCP_OAUTH_CALLBACK_PATH}`;
}

/**
 * The callback URL the browser asked for, which carries the proxy prefix NarraFork is mounted
 * under; accepted only on the same origin and ending in the callback path.
 */
export function requestedMcpOAuthRedirectUrl(c: Context, requested: unknown): string {
	const fallback = mcpOAuthRedirectUrl(c);
	if (typeof requested !== "string") return fallback;
	try {
		const url = new URL(requested);
		if (url.origin !== new URL(fallback).origin) return fallback;
		if (!url.pathname.endsWith(MCP_OAUTH_CALLBACK_PATH) || url.search || url.hash) return fallback;
		return url.href;
	} catch {
		return fallback;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Start OAuth authorization for a remote server. Returns the authorization URL the
 * admin opens, or `authorized: true` when stored credentials were enough.
 */
mcpRoutes.post("/servers/:id/oauth/start", requireAdmin, async (c) => {
	const config = findMcpServer(c.req.param("id") ?? "");
	if (!config) return c.json({ error: "Not found" }, 404);
	try {
		const body = (await c.req.json().catch(() => ({}))) as { redirectUrl?: unknown } | null;
		const redirectUrl = requestedMcpOAuthRedirectUrl(c, body?.redirectUrl);
		const result = await startMcpOAuth(config, redirectUrl);
		if ("authorized" in result && config.enabled) await mcpManager.connect(config);
		return c.json(result);
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 400);
	}
});

/** Forget a server's OAuth tokens and registration (the client secret is kept). */
mcpRoutes.delete("/servers/:id/oauth", requireAdmin, async (c) => {
	const config = findMcpServer(c.req.param("id") ?? "");
	if (!config) return c.json({ error: "Not found" }, 404);
	signOutMcpOAuth(config.id);
	if (config.enabled) await mcpManager.connect(config);
	return c.json({ ok: true });
});

const callbackQuerySchema = z.object({
	state: z.string().min(1).max(200),
	code: z.string().min(1).max(4000).optional(),
	error: z.string().max(200).optional(),
	error_description: z.string().max(1000).optional(),
});

function escapeHtml(text: string): string {
	return text.replace(
		/[&<>"']/g,
		(ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
	);
}

function callbackPage(c: Context, ok: boolean, message: string) {
	const title = ok ? "MCP authorization complete" : "MCP authorization failed";
	const body = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;padding:2rem"><h1>${title}</h1><p>${escapeHtml(message)}</p><p><a href="../../../routines">Back to NarraFork</a></p>${ok ? '<script>setTimeout(()=>{window.close();location.replace("../../../routines")},1500)</script>' : ""}</body></html>`;
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	return c.html(body, ok ? 200 : 400);
}

/**
 * Public OAuth redirect target, mounted before the session gate: the authorization
 * server redirects the browser here without NarraFork credentials. Only a `state`
 * minted by an admin's start request, unexpired and unused, is accepted.
 */
export const mcpOAuthCallbackRoutes = new Hono();

mcpOAuthCallbackRoutes.get("/callback", async (c) => {
	const parsed = callbackQuerySchema.safeParse(c.req.query());
	if (!parsed.success) return callbackPage(c, false, "Invalid authorization callback.");
	const { state, code, error, error_description } = parsed.data;
	if (error || !code) {
		cancelMcpOAuth(state);
		return callbackPage(c, false, error_description ?? error ?? "No authorization code.");
	}
	try {
		const config = await finishMcpOAuth(state, code, findMcpServer);
		if (config.enabled) await mcpManager.connect(config);
		return callbackPage(c, true, `"${config.name}" is authorized. You can close this window.`);
	} catch (err) {
		return callbackPage(c, false, errorMessage(err));
	}
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
