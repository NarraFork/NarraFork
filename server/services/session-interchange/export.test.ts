/**
 * Session export against a real isolated DB (temp NARRAFORK_HOME via the test preload).
 *
 * The fixture is built through the importer, so these tests double as a
 * NarraFork-side round trip: interchange → DB rows → interchange → CLI files →
 * parsed back by the same readers the importer uses.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { parseClaudeCodeSession } from "@shared/session-interchange/claude-code/parse";
import { parseCodexSession } from "@shared/session-interchange/codex/parse";
import type { InterchangeSession } from "@shared/session-interchange/model";
import { clearedToolOutput, historyClearedText } from "@shared/storage-retention";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narratorMessages, narratorToolCalls, users } from "../../db/schema";
import { settings } from "../../lib/settings";
// Loaded before the modules under test: the narrator service graph has an import
// cycle that only resolves when narrator-service is the first of them evaluated,
// which is also the order the running server loads them in.
import { narratorService } from "../narrator-service";
import { exportNarratorSession, narratorToInterchange } from "./export";
import { importInterchangeSession } from "./import";

const TAG = Date.now();
const USER = `export-user-${TAG}`;
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

beforeAll(async () => {
	await db.insert(users).values({
		id: USER,
		username: USER,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
});

function fixture(tag: string): InterchangeSession {
	const bash = `bash-${tag}`;
	const agent = `agent-${tag}`;
	return {
		source: "claude-code",
		externalId: `ext-${tag}`,
		title: "Export fixture",
		cwd: "/work/project",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:01:00.000Z",
		messages: [
			{
				role: "user",
				timestamp: "2026-01-01T00:00:00.000Z",
				blocks: [
					{ type: "text", text: "list files" },
					{ type: "image", mediaType: "image/png", data: PNG },
				],
			},
			{
				role: "assistant",
				timestamp: "2026-01-01T00:00:01.000Z",
				model: "claude-x",
				blocks: [
					{ type: "reasoning", text: "unsigned thought" },
					{ type: "text", text: "running ls" },
					{ type: "tool_use", id: bash, name: "Bash", input: { command: "ls" } },
					{
						type: "tool_use",
						id: agent,
						name: "Agent",
						input: { prompt: "explore", subagent_type: "explore" },
						subagentRef: "sub-1",
					},
				],
			},
			{
				role: "tool_result",
				timestamp: "2026-01-01T00:00:02.000Z",
				toolUseId: bash,
				output: "a.txt\nb.txt",
				isError: false,
			},
			{
				role: "tool_result",
				timestamp: "2026-01-01T00:00:03.000Z",
				toolUseId: agent,
				output: "found two files",
				isError: false,
			},
			{
				role: "assistant",
				timestamp: "2026-01-01T00:00:04.000Z",
				blocks: [{ type: "text", text: "two files" }],
			},
		],
		subagents: [
			{
				ref: "sub-1",
				parentToolUseId: agent,
				subagentType: "explore",
				messages: [
					{
						role: "user",
						timestamp: "2026-01-01T00:00:02.100Z",
						blocks: [{ type: "text", text: "explore" }],
					},
					{
						role: "assistant",
						timestamp: "2026-01-01T00:00:02.200Z",
						blocks: [{ type: "text", text: "found two files" }],
					},
				],
			},
		],
		warnings: [],
	};
}

async function importFixture(tag: string) {
	return importInterchangeSession(fixture(tag), {
		ownerUserId: USER,
		source: { format: "claude-code" },
	});
}

async function importRetentionFixture(tag: string) {
	const base = fixture(tag);
	const oldTools = ["Write", "Edit", "StructSed", "GenUI"];
	return importInterchangeSession(
		{
			...base,
			subagents: [],
			messages: [
				{
					role: "assistant",
					timestamp: "2026-01-01T00:00:01.000Z",
					blocks: [
						{ type: "text", text: "old assistant prose" },
						...oldTools.map((name) => ({
							type: "tool_use" as const,
							id: `${name}-${tag}`,
							name,
							input: {},
						})),
					],
				},
				...oldTools.map((name) => ({
					role: "tool_result" as const,
					timestamp: "2026-01-01T00:00:02.000Z",
					toolUseId: `${name}-${tag}`,
					output: "old-ledger-output-secret",
					isError: false,
				})),
				{
					role: "assistant",
					timestamp: "2026-01-01T00:00:03.000Z",
					blocks: [
						{ type: "text", text: "recent assistant prose" },
						{
							type: "tool_use",
							id: `live-${tag}`,
							name: "Bash",
							input: { command: "recent command" },
						},
					],
				},
				{
					role: "tool_result",
					timestamp: "2026-01-01T00:00:04.000Z",
					toolUseId: `live-${tag}`,
					output: "recent output",
					isError: false,
				},
			],
		},
		{ ownerUserId: USER, source: { format: "claude-code" } },
	);
}

function lines(content: string): string[] {
	return content.split("\n").filter(Boolean);
}

describe("narratorToInterchange", () => {
	test("reads back the transcript, results, image bytes and subagent", async () => {
		const tag = `read-${TAG}`;
		const imported = await importFixture(tag);
		const session = await narratorToInterchange(imported.narratorId);

		expect(session.source).toBe("narrafork");
		expect(session.cwd).toBe("/work/project");
		expect(session.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool_result",
			"tool_result",
			"assistant",
		]);
		const user = session.messages[0];
		expect(user?.role === "user" && user.blocks.map((b) => b.type)).toEqual(["text", "image"]);
		const image = user?.role === "user" ? user.blocks[1] : undefined;
		expect(image?.type === "image" && image.data.length > 0).toBe(true);

		const assistant = session.messages[1];
		const agentBlock =
			assistant?.role === "assistant"
				? assistant.blocks.find((b) => b.type === "tool_use" && b.name === "Agent")
				: undefined;
		const subagentId = imported.subagentIds[0];
		expect(agentBlock?.type === "tool_use" && agentBlock.subagentRef).toBe(subagentId);

		expect(session.subagents).toHaveLength(1);
		expect(session.subagents[0]).toMatchObject({
			ref: subagentId,
			// Import rewrote the id; the subagent must hang off the same call the transcript shows.
			parentToolUseId: agentBlock?.type === "tool_use" ? agentBlock.id : "missing",
			subagentType: "explore",
		});
		expect(session.subagents[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	test("an unfinished call is left out instead of exported unpaired", async () => {
		const tag = `open-${TAG}`;
		const base = fixture(tag);
		const imported = await importInterchangeSession(
			{
				...base,
				subagents: [],
				messages: [
					base.messages[0],
					{
						role: "assistant",
						timestamp: "2026-01-01T00:00:01.000Z",
						blocks: [
							{ type: "text", text: "starting" },
							{ type: "tool_use", id: `open-call-${tag}`, name: "Bash", input: { command: "x" } },
						],
					},
				] as InterchangeSession["messages"],
			},
			{ ownerUserId: USER, source: { format: "claude-code" } },
		);
		// The importer records a missing result as a failed call; mark it running to
		// model a call that was still in flight when the export was taken.
		await db
			.update(narratorToolCalls)
			.set({ status: "running" })
			.where(eq(narratorToolCalls.narratorId, imported.narratorId));

		const session = await narratorToInterchange(imported.narratorId);
		const assistant = session.messages.find((m) => m.role === "assistant");
		expect(assistant?.role === "assistant" && assistant.blocks.map((b) => b.type)).toEqual([
			"text",
		]);
		expect(session.messages.some((m) => m.role === "tool_result")).toBe(false);
	});

	test("a narrator with no conversation is rejected", async () => {
		const narrator = await narratorService.create({ title: "empty", ownerUserId: USER });
		await expect(narratorToInterchange(narrator.id)).rejects.toThrow(/no conversation/);
	});
});

describe("exportNarratorSession", () => {
	test("cleared tool pairs export as text without their retained replay input", async () => {
		const imported = await importRetentionFixture(`cleared-${TAG}`);
		const tools = await db
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.narratorId, imported.narratorId));
		for (const tool of tools) {
			if (tool.toolName === "Bash") continue;
			await db
				.update(narratorToolCalls)
				.set({
					inputJson: {
						file_path: "/private/retained-session-secret",
						content: "retained-session-secret",
					},
					outputJson: clearedToolOutput("2026-07-17T12:00:00.000Z"),
				})
				.where(eq(narratorToolCalls.id, tool.id));
		}
		// Legacy calls may exist only in the ledger, without a content tool_use block.
		const [oldMessage] = await db
			.select({ id: narratorMessages.id, contentJson: narratorMessages.contentJson })
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, imported.narratorId))
			.orderBy(narratorMessages.createdAt)
			.limit(1);
		expect(oldMessage).toBeDefined();
		await db
			.update(narratorMessages)
			.set({
				contentJson: (oldMessage?.contentJson as Array<{ name?: string }>).filter(
					(block) => block.name !== "GenUI",
				),
			})
			.where(eq(narratorMessages.id, oldMessage?.id ?? ""));
		const session = await narratorToInterchange(imported.narratorId);
		const calls = session.messages.flatMap((message) =>
			message.role === "assistant"
				? message.blocks.filter((block) => block.type === "tool_use")
				: [],
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.type === "tool_use" && calls[0].name).toBe("Bash");
		expect(session.messages.filter((message) => message.role === "tool_result")).toHaveLength(1);
		for (const format of ["claude-code", "codex"] as const) {
			const result = await exportNarratorSession(imported.narratorId, { format });
			const content = result.files.map((file) => file.content).join("\n");
			expect(content).not.toContain("retained-session-secret");
			expect(content).not.toContain("old-ledger-output-secret");
			for (const name of ["Write", "Edit", "StructSed", "GenUI"]) {
				expect(content).toContain(`[Tool details cleared: ${name}]`);
			}
			const parsed =
				format === "claude-code"
					? parseClaudeCodeSession({ main: lines(result.files[0]?.content ?? "") })
					: parseCodexSession({ main: lines(result.files[0]?.content ?? "") });
			expect(parsed.messages.filter((message) => message.role === "tool_result")).toHaveLength(1);
			expect(JSON.stringify(parsed)).toContain("recent command");
			expect(JSON.stringify(parsed)).toContain("recent output");
		}
		expect(
			JSON.stringify(
				await db
					.select({ input: narratorToolCalls.inputJson })
					.from(narratorToolCalls)
					.where(eq(narratorToolCalls.narratorId, imported.narratorId)),
			),
		).toContain("retained-session-secret");
	});

	test.each([
		"cleared",
		"suppressed",
	] as const)("%s message bodies never replay their old tool ledger", async (kind) => {
		const imported = await importRetentionFixture(`${kind}-body-${TAG}`);
		const [oldMessage] = await db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, imported.narratorId))
			.orderBy(narratorMessages.createdAt)
			.limit(1);
		const text = kind === "cleared" ? "[History cleared]" : "new human edit";
		const contentJson =
			kind === "cleared"
				? [historyClearedText("2026-07-17T12:00:00.000Z")]
				: [{ type: "text", text, historyToolsSuppressed: true }];
		await db
			.update(narratorMessages)
			.set({ contentJson, contentText: text })
			.where(eq(narratorMessages.id, oldMessage?.id ?? ""));
		for (const format of ["claude-code", "codex"] as const) {
			const result = await exportNarratorSession(imported.narratorId, { format });
			const content = result.files.map((file) => file.content).join("\n");
			expect(content).toContain(text);
			expect(content).not.toContain("old-ledger-output-secret");
			expect(content).not.toContain("old assistant prose");
			expect(content).toContain("recent assistant prose");
			expect(content).toContain("recent command");
			expect(content).toContain("recent output");
			const parsed =
				format === "claude-code"
					? parseClaudeCodeSession({ main: lines(result.files[0]?.content ?? "") })
					: parseCodexSession({ main: lines(result.files[0]?.content ?? "") });
			expect(parsed.messages.filter((message) => message.role === "tool_result")).toHaveLength(1);
		}
	});

	test("Claude Code: files parse back with the same conversation and sidechain", async () => {
		const imported = await importFixture(`cc-${TAG}`);
		const result = await exportNarratorSession(imported.narratorId, { format: "claude-code" });

		expect(result.cwd).toBe("/work/project");
		expect(result.resumeCommand).toBe(`cd /work/project && claude --resume ${result.sessionId}`);
		const [main, ...rest] = result.files;
		expect(main?.relativePath).toEqual(["projects", "-work-project", `${result.sessionId}.jsonl`]);
		const sidechain = rest.find((f) => f.relativePath.at(-1)?.endsWith(".jsonl"));
		const meta = rest.find((f) => f.relativePath.at(-1)?.endsWith(".meta.json"));
		expect(sidechain?.relativePath.slice(0, 4)).toEqual([
			"projects",
			"-work-project",
			result.sessionId,
			"subagents",
		]);
		expect(JSON.parse(meta?.content ?? "{}")).toMatchObject({ agentType: "explore" });

		// Unsigned reasoning is never written as thinking.
		expect(result.warnings.some((w) => w.kind === "dropped_reasoning")).toBe(true);

		const parsed = parseClaudeCodeSession({
			main: lines(main?.content ?? ""),
			subagents: [{ lines: lines(sidechain?.content ?? "") }],
		});
		expect(parsed.externalId).toBe(result.sessionId);
		expect(parsed.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool_result",
			"tool_result",
			"assistant",
		]);
		expect(parsed.subagents).toHaveLength(1);
		expect(parsed.subagents[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	test("Codex: rollouts parse back, child linked through spawn_agent, index row appended", async () => {
		const imported = await importFixture(`codex-${TAG}`);
		const result = await exportNarratorSession(imported.narratorId, {
			format: "codex",
			codexModelProvider: "my-provider",
		});

		const rollouts = result.files.filter((f) => f.relativePath[0] === "sessions");
		expect(rollouts).toHaveLength(2);
		for (const file of rollouts) {
			expect(file.mode).toBe("create");
			const name = file.relativePath.at(-1) ?? "";
			expect(name).toMatch(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl$/);
			const first = JSON.parse(lines(file.content)[0] ?? "{}");
			expect(first.type).toBe("session_meta");
			// The id inside must match the file name, or `codex resume <id>` misses it.
			expect(name).toContain(first.payload.id);
			expect(first.payload.model_provider).toBe("my-provider");
		}
		const index = result.files.find((f) => f.relativePath.join("/") === "session_index.jsonl");
		expect(index?.mode).toBe("append");
		expect(JSON.parse(index?.content ?? "{}")).toMatchObject({ id: result.sessionId });

		const main = rollouts.find((f) => f.relativePath.at(-1)?.includes(result.sessionId));
		const child = rollouts.find((f) => f !== main);
		const parsed = parseCodexSession({
			main: lines(main?.content ?? ""),
			children: [{ lines: lines(child?.content ?? "") }],
		});
		expect(parsed.externalId).toBe(result.sessionId);
		const roles = parsed.messages.map((m) => m.role);
		expect(roles.filter((r) => r === "user")).toHaveLength(1);
		expect(roles.filter((r) => r === "tool_result")).toHaveLength(2);
		expect(parsed.subagents).toHaveLength(1);
		expect(result.resumeCommand).toBe(`cd /work/project && codex resume ${result.sessionId}`);
	});

	test("an explicit cwd overrides the narrator's and is quoted in the command", async () => {
		const imported = await importFixture(`cwd-${TAG}`);
		const result = await exportNarratorSession(imported.narratorId, {
			format: "claude-code",
			cwd: "/home/me/my project",
		});
		expect(result.files[0]?.relativePath[1]).toBe("-home-me-my-project");
		expect(result.resumeCommand).toStartWith("cd '/home/me/my project' && claude --resume ");
	});

	test("only signatures from an official-API provider (or read from Claude Code) are replayed", async () => {
		settings.anthropicProviders = [
			{
				id: "offic001",
				name: "Official",
				prefix: "official",
				apiKey: "k",
				baseUrl: "https://api.anthropic.com/v1",
				defaultModel: "claude-x",
				officialApi: true,
			},
		];
		const imported = await importFixture(`sig-${TAG}`);
		const [assistant] = await db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, imported.narratorId))
			.orderBy(narratorMessages.createdAt)
			.limit(1)
			.offset(1);
		await db
			.update(narratorMessages)
			.set({
				contentJson: [
					{
						type: "reasoning",
						text: "from official",
						providerMetadata: {
							anthropic: { signature: "SIG-OFFICIAL" },
							signatureSource: "official",
						},
					},
					{
						type: "reasoning",
						text: "from a gateway channel",
						providerMetadata: {
							anthropic: { signature: "SIG-NUG" },
							signatureSource: "nug:antigravity",
						},
					},
					{
						type: "reasoning",
						text: "legacy, no source",
						providerMetadata: { anthropic: { signature: "SIG-LEGACY" } },
					},
					{ type: "text", text: "answer" },
				],
			})
			.where(eq(narratorMessages.id, assistant?.id ?? ""));

		const result = await exportNarratorSession(imported.narratorId, { format: "claude-code" });
		const transcript = result.files[0]?.content ?? "";
		expect(transcript).toContain("SIG-OFFICIAL");
		expect(transcript).not.toContain("SIG-NUG");
		expect(transcript).not.toContain("SIG-LEGACY");
	});

	test("a Claude Code signature survives import → export back to Claude Code", async () => {
		const tag = `ccsig-${TAG}`;
		const base = fixture(tag);
		const imported = await importInterchangeSession(
			{
				...base,
				subagents: [],
				messages: [
					base.messages[0],
					{
						role: "assistant",
						timestamp: "2026-01-01T00:00:01.000Z",
						blocks: [
							{
								type: "reasoning",
								text: "cc thought",
								signature: { provider: "anthropic", value: "SIG-CC", officialAnthropic: true },
							},
							{ type: "text", text: "ok" },
						],
					},
				] as InterchangeSession["messages"],
			},
			{ ownerUserId: USER, source: { format: "claude-code" } },
		);
		const result = await exportNarratorSession(imported.narratorId, { format: "claude-code" });
		expect(result.files[0]?.content).toContain("SIG-CC");
	});
});
