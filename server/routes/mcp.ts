import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { FORK_WORKTREE_SOURCES } from "@shared/chapter-fork";
import { Hono } from "hono";
import { z } from "zod";
import { gitAvailable, recheckGit } from "../lib/git-status";
import { generateShortId } from "../lib/id";
import { mcpManager, projectMcpServerConfig } from "../lib/mcp/manager";
import { syncMcpTools } from "../lib/mcp/tool-bridge";
import { type McpServerConfig, saveSettings, settings } from "../lib/settings";
import { requireAdmin } from "../middleware/auth";
import { chapterFork } from "../services/chapter-fork";
import { chapterMerge } from "../services/chapter-merge";
import { chapterService } from "../services/chapter-service";
import { narratorContext } from "../services/narrator-context";
import {
	countNarratorMessageRefs,
	countNarratorMessageRefsBatch,
} from "../services/narrator-message-count";
import { narratorService } from "../services/narrator-service";

function assertGitAvailableForMcp(): void {
	if (gitAvailable || recheckGit()) return;
	throw new Error(
		"GIT_NOT_INSTALLED: Git is not installed. Please install git and retry this Git-dependent action.",
	);
}

function createMcpServer(): McpServer {
	const server = new McpServer({
		name: "narrafork",
		version: "0.1.0",
	});

	server.tool(
		"narrafork_list_chapters",
		"List chapters in a project",
		{ projectId: z.string().describe("Project ID") },
		async ({ projectId }) => {
			try {
				const chapters = await chapterService.listByProject(projectId);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								chapters.map((ch) => ({
									id: ch.id,
									title: ch.title,
									status: ch.status,
									branch: ch.branch,
								})),
								null,
								2,
							),
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

	server.tool(
		"narrafork_fork_chapter",
		"Fork a chapter, independently choosing conversation inheritance and filesystem source",
		{
			chapterId: z.string().describe("Source chapter ID to fork from"),
			title: z.string().describe("Title for the new chapter"),
			inheritMode: z
				.enum(["full", "compressed", "fresh"])
				.optional()
				.describe("Conversation inheritance only; does not choose which files are forked"),
			worktreeSource: z
				.enum(FORK_WORKTREE_SOURCES)
				.optional()
				.describe(
					'Filesystem source: "workspace" includes current uncommitted files; "commit" uses committed history only. Legacy omission remains supported.',
				),
			commitSha: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional commit in the parent branch history. Maps to startCommitSha and requires worktreeSource="commit".',
				),
		},
		async ({ chapterId, title, inheritMode, worktreeSource, commitSha }) => {
			try {
				assertGitAvailableForMcp();
				const chapter = await chapterFork.fork(chapterId, {
					title,
					inheritMode,
					worktreeSource,
					startCommitSha: commitSha,
				});
				return {
					content: [{ type: "text", text: JSON.stringify(chapter, null, 2) }],
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

	server.tool(
		"narrafork_merge_chapter",
		"Merge a chapter into a target chapter",
		{
			chapterId: z.string().describe("Source chapter ID to merge"),
			targetChapterId: z.string().describe("Target chapter ID to merge into"),
			strategy: z.enum(["merge", "squash", "cherry-pick"]).optional().describe("Merge strategy"),
		},
		async ({ chapterId, targetChapterId, strategy }) => {
			try {
				assertGitAvailableForMcp();
				const result = await chapterMerge.merge(chapterId, { targetChapterId, strategy });
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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

	server.tool(
		"narrafork_check_conflicts",
		"Check for merge conflicts between two chapters",
		{
			chapterId: z.string().describe("Source chapter ID"),
			targetChapterId: z.string().describe("Target chapter ID"),
		},
		async ({ chapterId, targetChapterId }) => {
			try {
				assertGitAvailableForMcp();
				const result = await chapterMerge.checkConflicts(chapterId, targetChapterId);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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

	server.tool(
		"narrafork_abandon_chapter",
		"Abandon a chapter (mark as abandoned and clean up)",
		{ chapterId: z.string().describe("Chapter ID to abandon") },
		async ({ chapterId }) => {
			try {
				await chapterService.update(chapterId, { status: "abandoned" });
				return {
					content: [{ type: "text", text: `Chapter ${chapterId} abandoned` }],
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

	server.tool(
		"narrafork_list_narrators",
		"List narrators for a chapter",
		{ chapterId: z.string().describe("Chapter ID") },
		async ({ chapterId }) => {
			try {
				const list = await narratorService.listByChapter(chapterId);
				// The stored column is an insert-only upper bound; count for real so an
				// agent reading this tool's output is not told a stale number.
				const messageCounts = await countNarratorMessageRefsBatch(list.map((n) => n.id));
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								list.map((n) => ({
									id: n.id,
									type: n.type,
									status: n.status,
									model: n.model,
									messageCount: messageCounts.get(n.id) ?? 0,
								})),
								null,
								2,
							),
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

	server.tool(
		"narrafork_get_context_summary",
		"Get an AI-generated context summary of a narrator's recent conversation",
		{ narratorId: z.string().describe("Narrator ID to get context from") },
		async ({ narratorId }) => {
			try {
				const narrator = await narratorService.getById(narratorId);
				const summary = await narratorContext.generateContextSummary(narratorId);
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
	const server = createMcpServer();
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
	enabled: z.boolean().optional().default(true),
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
	const updated: McpServerConfig = { ...server, ...rest };
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
	const config: McpServerConfig = {
		id: generateShortId(),
		...parsed.data,
	};

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

	if (!config.enabled) {
		config.enabled = true;
		settings.mcpServers = servers;
		saveSettings(settings);
	}

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

	if (config.enabled) {
		config.enabled = false;
		settings.mcpServers = servers;
		saveSettings(settings);
	}

	await mcpManager.disconnect(id);
	syncMcpTools();

	const statuses = mcpManager.getServerStatuses();
	const status = statuses.find((s) => s.id === id);
	return c.json(status ?? { id, status: "disconnected", enabled: false });
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

	const config: McpServerConfig = {
		...applyMcpServerPatch(existing, parsed.data),
		id: `test-${id}`,
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
	const config: McpServerConfig = {
		id: "test",
		...parsed.data,
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

		const config: McpServerConfig = {
			id: generateShortId(),
			name,
			transport,
			enabled: cfg.disabled !== true && cfg.enabled !== false,
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
