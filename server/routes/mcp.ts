import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { chapterFork } from "../services/chapter-fork";
import { chapterMerge } from "../services/chapter-merge";
import { chapterService } from "../services/chapter-service";
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
									type: ch.type,
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
			type: z.enum(["meanwhile", "whatif"]).optional().describe("Chapter type"),
			inheritMode: z
				.enum(["full", "compressed", "fresh"])
				.optional()
				.describe("Narrator context inheritance mode"),
		},
		async ({ chapterId, title, type, inheritMode }) => {
			try {
				const chapter = await chapterFork.fork(chapterId, { title, type, inheritMode });
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
		"narrafork_create_whatif",
		"Quick-create a WhatIf exploration branch from a chapter",
		{
			chapterId: z.string().describe("Source chapter ID"),
			title: z.string().describe("Title for the WhatIf branch"),
		},
		async ({ chapterId, title }) => {
			try {
				const chapter = await chapterFork.fork(chapterId, { title, type: "whatif" });
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
		"Get a context summary of a narrator's recent conversation",
		{ narratorId: z.string().describe("Narrator ID to get context from") },
		async ({ narratorId }) => {
			try {
				const narrator = await narratorService.getById(narratorId);
				const messages = await narratorService.getMessages(narratorId, 20);
				const summary = messages
					.filter((m) => m.role === "assistant" && m.contentText)
					.map((m) => m.contentText)
					.join("\n---\n")
					.slice(0, 5000);

				return {
					content: [
						{
							type: "text",
							text: `Narrator: ${narrator.type} (${narrator.model})\nStatus: ${narrator.status}\nMessages: ${narrator.messageCount}\n\nRecent context:\n${summary}`,
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
