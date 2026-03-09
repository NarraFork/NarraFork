import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { generateShortId } from "../lib/id";
import { mcpManager } from "../lib/mcp/manager";
import { syncMcpTools } from "../lib/mcp/tool-bridge";
import { type McpServerConfig, saveSettings, settings } from "../lib/settings";
import { chapterFork } from "../services/chapter-fork";
import { chapterMerge } from "../services/chapter-merge";
import { chapterService } from "../services/chapter-service";
import { narratorContext } from "../services/narrator-context";
import { narratorService } from "../services/narrator-service";

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
		"Fork an existing chapter into a new branch",
		{
			chapterId: z.string().describe("Source chapter ID to fork from"),
			title: z.string().describe("Title for the new chapter"),
			inheritMode: z
				.enum(["full", "compressed", "fresh"])
				.optional()
				.describe("Narrator context inheritance mode"),
		},
		async ({ chapterId, title, inheritMode }) => {
			try {
				const chapter = await chapterFork.fork(chapterId, { title, inheritMode });
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
									messageCount: n.messageCount,
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

				return {
					content: [
						{
							type: "text",
							text: `Narrator: ${narrator.type} (${narrator.model})\nStatus: ${narrator.status}\nMessages: ${narrator.messageCount}\n\nContext summary:\n${summary}`,
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

const mcpServerInputSchema = z.object({
	name: z.string().min(1).max(200).optional().default("Untitled"),
	transport: z.enum(["stdio", "streamable-http", "sse"]).optional().default("stdio"),
	command: z.string().max(500).optional(),
	args: z.array(z.string().max(500)).max(50).optional(),
	cwd: z.string().max(500).optional(),
	env: z.record(z.string().max(200), z.string().max(2000)).optional(),
	url: z.string().url().max(2000).optional(),
	headers: z.record(z.string().max(200), z.string().max(2000)).optional(),
	enabled: z.boolean().optional().default(true),
});

/** List all configured MCP servers with runtime status. */
mcpRoutes.get("/servers", (c) => {
	return c.json({ servers: mcpManager.getServerStatuses() });
});

/** Add a new MCP server. */
mcpRoutes.post("/servers", async (c) => {
	const body = await c.req.json();
	const parsed = mcpServerInputSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.message }, 400);
	}
	const config: McpServerConfig = {
		id: generateShortId(),
		...parsed.data,
	};

	const servers = [...(settings.mcpServers ?? []), config];
	settings.mcpServers = servers;
	saveSettings(settings);

	if (config.enabled) {
		await mcpManager.connect(config);
		syncMcpTools();
	}

	return c.json(config, 201);
});

/** Update an existing MCP server. */
mcpRoutes.patch("/servers/:id", async (c) => {
	const { id } = c.req.param();
	const servers = settings.mcpServers ?? [];
	const idx = servers.findIndex((s) => s.id === id);
	if (idx === -1) return c.json({ error: "Not found" }, 404);

	const body = await c.req.json();
	const parsed = mcpServerInputSchema.partial().safeParse(body);
	if (!parsed.success) {
		return c.json({ error: parsed.error.message }, 400);
	}
	const updated = { ...servers[idx], ...parsed.data, id }; // prevent id override
	servers[idx] = updated;
	settings.mcpServers = servers;
	saveSettings(settings);

	await mcpManager.reload();
	syncMcpTools();

	return c.json(updated);
});

/** Delete an MCP server. */
mcpRoutes.delete("/servers/:id", async (c) => {
	const { id } = c.req.param();
	const servers = settings.mcpServers ?? [];
	const idx = servers.findIndex((s) => s.id === id);
	if (idx === -1) return c.json({ error: "Not found" }, 404);

	await mcpManager.disconnect(id);
	servers.splice(idx, 1);
	settings.mcpServers = servers;
	saveSettings(settings);
	syncMcpTools();

	return c.json({ ok: true });
});

/** Manually connect a server. */
mcpRoutes.post("/servers/:id/connect", async (c) => {
	const { id } = c.req.param();
	const servers = settings.mcpServers ?? [];
	const config = servers.find((s) => s.id === id);
	if (!config) return c.json({ error: "Not found" }, 404);

	await mcpManager.connect(config);
	syncMcpTools();

	const statuses = mcpManager.getServerStatuses();
	const status = statuses.find((s) => s.id === id);
	return c.json(status ?? { id, status: "error" });
});

/** Manually disconnect a server. */
mcpRoutes.post("/servers/:id/disconnect", async (c) => {
	const { id } = c.req.param();
	await mcpManager.disconnect(id);
	syncMcpTools();
	return c.json({ ok: true });
});

/** Test connection without persisting. */
mcpRoutes.post("/servers/test", async (c) => {
	const body = await c.req.json();
	const parsed = mcpServerInputSchema.safeParse(body);
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
mcpRoutes.post("/servers/import", async (c) => {
	const body = await c.req.json();
	const json = body.json;
	if (!json || typeof json !== "object") {
		return c.json({ error: "Invalid JSON" }, 400);
	}

	// Normalize: accept { mcpServers: { ... } } or { servers: { ... } } or bare { name: { ... } }
	// biome-ignore lint/suspicious/noExplicitAny: flexible import format
	let serverMap: Record<string, any> = {};
	if (json.mcpServers && typeof json.mcpServers === "object") {
		serverMap = json.mcpServers;
	} else if (json.servers && typeof json.servers === "object" && !Array.isArray(json.servers)) {
		serverMap = json.servers;
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

	const existing = settings.mcpServers ?? [];
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

		// Detect transport type
		let transport: McpServerConfig["transport"] = "stdio";
		if (cfg.url && !cfg.command) {
			transport = cfg.transport === "sse" ? "sse" : "streamable-http";
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
			headers: cfg.headers && typeof cfg.headers === "object" ? cfg.headers : undefined,
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
