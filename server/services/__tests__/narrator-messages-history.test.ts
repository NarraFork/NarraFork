import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narratorSidecars,
	narratorToolCalls,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { narratorService } = await import("../narrator-service");
const { narratorMessageQueries } = await import("../narrator-messages");

const now = "2026-07-17T10:00:00.000Z";

async function seedNarrator(id = "n1") {
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run(id, now, now);
}

async function seedMessage(params: {
	id: string;
	narratorId: string;
	seq: number;
	role: "user" | "assistant" | "system";
	contentText?: string;
	contentJson?: unknown;
	isCompact?: boolean;
	parentToolUseId?: string;
}) {
	await db.insert(narratorMessages).values({
		id: params.id,
		narratorId: params.narratorId,
		role: params.role,
		contentJson: params.contentJson ?? [{ type: "text", text: params.contentText ?? "" }],
		contentText: params.contentText ?? null,
		parentToolUseId: params.parentToolUseId,
		provider: "provider-that-must-not-be-loaded",
		model: "model-that-must-not-be-loaded",
		tokensIn: 123,
		commandText: "/internal-command",
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${params.id}`,
		narratorId: params.narratorId,
		messageId: params.id,
		seq: params.seq,
		isCompact: params.isCompact ? 1 : 0,
	});
}

beforeEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("narrator model history projection", () => {
	test("loads post-compact history with narrow fields and legacy sidecar fallback", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-before",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "old",
		});
		await seedMessage({
			id: "m-compact",
			narratorId: "n1",
			seq: 2,
			role: "system",
			contentText: "[Compact] summary",
			contentJson: [{ type: "compact", status: "compacted", summary: "old" }],
			isCompact: true,
		});
		await seedMessage({
			id: "m-after",
			narratorId: "n1",
			seq: 3,
			role: "assistant",
			contentText: "new",
			contentJson: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } }],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-1",
			narratorId: "n1",
			messageId: "m-after",
			toolUseId: "tu-1",
			toolName: "Bash",
			inputJson: { command: "pwd" },
			outputJson: { stdout: "/workspace" },
			status: "success",
			createdAt: now,
		});
		await db.insert(narratorSidecars).values({
			id: "sc-legacy",
			narratorId: "n1",
			messageId: null,
			toolUseId: "tu-1",
			target: "tool_result",
			source: "legacy-provider",
			content: JSON.stringify({ stdout: "/workspace" }),
			createdAt: now,
		});

		const messages = await narratorService.getModelHistorySinceLastCompact("n1");

		expect(messages.map((message) => message.id)).toEqual(["m-after"]);
		expect(messages[0]).toMatchObject({
			id: "m-after",
			narratorId: "n1",
			role: "assistant",
			contentText: "new",
		});
		expect(messages[0]).not.toHaveProperty("provider");
		expect(messages[0]).not.toHaveProperty("model");
		expect(messages[0]).not.toHaveProperty("tokensIn");
		expect(messages[0]).not.toHaveProperty("commandText");
		expect(messages[0].toolCalls).toEqual([
			expect.objectContaining({
				toolUseId: "tu-1",
				toolName: "Bash",
				inputJson: { command: "pwd" },
				outputJson: { stdout: "/workspace" },
				status: "success",
			}),
		]);
		expect(messages[0].sideCars).toEqual([
			expect.objectContaining({
				id: "sc-legacy",
				messageId: null,
				toolUseId: "tu-1",
				target: "tool_result",
			}),
		]);
	});

	test("excludes metadata-only empty reasoning without hiding trailing tool results", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-tool",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentJson: [
				{
					type: "reasoning",
					text: "",
					providerMetadata: {
						anthropic: { blockIndex: 0, signature: "tool-signature" },
						signatureSource: "kimi-2",
					},
				},
				{ type: "tool_use", id: "tu-continue", name: "Read", input: { file_path: "a.ts" } },
			],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-continue",
			narratorId: "n1",
			messageId: "m-tool",
			toolUseId: "tu-continue",
			toolName: "Read",
			inputJson: { file_path: "a.ts" },
			outputJson: { content: "file contents" },
			status: "success",
			createdAt: now,
		});
		await seedMessage({
			id: "m-empty-reasoning",
			narratorId: "n1",
			seq: 2,
			role: "assistant",
			contentJson: [
				{
					type: "reasoning",
					text: "",
					providerMetadata: {
						anthropic: { blockIndex: 0, signature: "metadata-only-signature" },
						signatureSource: "kimi-2",
					},
				},
			],
		});

		const messages = await narratorService.getModelHistorySinceLastCompact("n1");

		expect(messages.map((message) => message.id)).toEqual(["m-tool"]);
		expect(messages[0].toolCalls).toEqual([
			expect.objectContaining({
				toolUseId: "tu-continue",
				toolName: "Read",
				status: "success",
				outputJson: { content: "file contents" },
			}),
		]);
	});

	test("preserves non-empty reasoning and empty reasoning attached to tools", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-visible-reasoning",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentJson: [{ type: "reasoning", text: "visible thought" }],
		});
		await seedMessage({
			id: "m-reasoning-tool",
			narratorId: "n1",
			seq: 2,
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "" },
				{ type: "tool_use", id: "tu-preserved", name: "Read", input: {} },
			],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-preserved",
			narratorId: "n1",
			messageId: "m-reasoning-tool",
			toolUseId: "tu-preserved",
			toolName: "Read",
			inputJson: {},
			outputJson: {},
			status: "success",
			createdAt: now,
		});

		const messages = await narratorService.getModelHistorySinceLastCompact("n1");

		expect(messages.map((message) => message.id)).toEqual([
			"m-visible-reasoning",
			"m-reasoning-tool",
		]);
	});

	test("builds a bounded ContextAsk snapshot from the latest post-compact history", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-before",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "old context",
		});
		await seedMessage({
			id: "m-compact",
			narratorId: "n1",
			seq: 2,
			role: "system",
			contentText: "[Compact] summary",
			contentJson: [{ type: "compact", status: "compacted", summary: "old" }],
			isCompact: true,
		});
		await seedMessage({
			id: "m-after",
			narratorId: "n1",
			seq: 3,
			role: "assistant",
			contentText: "first recent message",
		});
		await seedMessage({
			id: "m-long",
			narratorId: "n1",
			seq: 4,
			role: "assistant",
			contentText: `latest ${"x".repeat(7_000)}`,
		});
		await seedMessage({
			id: "m-lifecycle",
			narratorId: "n1",
			seq: 5,
			role: "system",
			contentText: "inactive compact marker",
			contentJson: [{ type: "compact", status: "error", summary: "ignored" }],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-long",
			narratorId: "n1",
			messageId: "m-long",
			toolUseId: "tu-long",
			toolName: "Bash",
			inputJson: { command: "x".repeat(2_000) },
			outputJson: { stdout: "y".repeat(4_000) },
			status: "success",
			createdAt: now,
		});

		const full = await narratorService.getContextAskHistorySnapshot("n1", 2);
		expect(full.messages.map((message) => message.id)).toEqual(["m-after", "m-long"]);
		expect(full.hasMore).toBe(false);
		expect(full.messages[1].contentText?.length).toBe(6_000);
		expect(full.messages[1].contentTruncated).toBe(true);
		expect(full.messages[1].toolCalls).toEqual([
			expect.objectContaining({
				toolUseId: "tu-long",
				inputTruncated: true,
				outputTruncated: true,
			}),
		]);
		expect(full.messages[1].toolCalls[0].inputText?.length).toBeLessThanOrEqual(1_200);
		expect(full.messages[1].toolCalls[0].outputText?.length).toBeLessThanOrEqual(2_400);
		expect(full.sourceTruncated).toBe(true);

		const latestOnly = await narratorService.getContextAskHistorySnapshot("n1", 1);
		expect(latestOnly.messages.map((message) => message.id)).toEqual(["m-long"]);
		expect(latestOnly.hasMore).toBe(true);
	});

	test("projects pending permissions without loading unrelated tool-call metadata", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-pending",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentText: "tool",
		});
		await db.insert(narratorToolCalls).values([
			{
				id: "tc-visible",
				narratorId: "n1",
				messageId: "m-pending",
				toolUseId: "tu-visible",
				toolName: "Bash",
				inputJson: { command: "pwd" },
				status: "pending",
				permissionDecisionReason: "needs approval",
				permissionSuggestions: [{ type: "permission", status: "awaiting_user" }],
				executionDeviceId: "local",
				executionCwd: "/workspace",
				resolvedFilePath: "/workspace/file.txt",
				deviceSelectionSource: "local_default",
				provider: "provider-that-must-not-be-loaded",
				model: "model-that-must-not-be-loaded",
				createdAt: now,
			},
			{
				id: "tc-hidden",
				narratorId: "n1",
				messageId: "m-pending",
				toolUseId: "tu-hidden",
				toolName: "Edit",
				inputJson: { path: "/workspace/file.txt" },
				status: "pending",
				permissionSuggestions: [{ type: "danger_reflection", status: "running" }],
				createdAt: now,
			},
		]);

		const permissions = await narratorService.getPendingPermissions("n1");

		expect(permissions).toEqual([
			{
				id: "tc-visible",
				toolName: "Bash",
				toolUseId: "tu-visible",
				inputJson: { command: "pwd" },
				decisionReason: "needs approval",
				suggestions: [{ type: "permission", status: "awaiting_user" }],
				executionDeviceId: "local",
				executionCwd: "/workspace",
				resolvedFilePath: "/workspace/file.txt",
				deviceSelectionSource: "local_default",
				parentToolUseId: null,
				subagentNarratorId: null,
				ownerNarratorId: "n1",
			},
		]);
	});

	test("returns pending permissions for directly visible subagents with routing ownership", async () => {
		await seedNarrator("n1");
		sqlite
			.prepare(
				"INSERT INTO narrators (id, type, variant, parent_narrator_id, created_at, updated_at) VALUES (?, 'subagent', 'subagent:general', ?, ?, ?)",
			)
			.run("sub1", "n1", now, now);
		await seedMessage({
			id: "m-spawn",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu-spawn", name: "Agent", input: {} }],
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-spawn",
			narratorId: "n1",
			messageId: "m-spawn",
			toolUseId: "tu-spawn",
			toolName: "Agent",
			status: "running",
			createdAt: now,
		});
		await seedMessage({
			id: "m-sub-pending",
			narratorId: "sub1",
			seq: 1,
			role: "assistant",
			parentToolUseId: "tu-spawn",
		});
		await db.insert(narratorToolCalls).values({
			id: "tc-sub-pending",
			narratorId: "sub1",
			messageId: "m-sub-pending",
			toolUseId: "tu-sub-pending",
			toolName: "Write",
			inputJson: { file_path: "secret.ts", content: "permission detail remains complete" },
			status: "pending",
			createdAt: now,
		});

		const permissions = await narratorService.getPendingPermissions("n1");
		expect(permissions).toEqual([
			expect.objectContaining({
				id: "tc-sub-pending",
				parentToolUseId: "tu-spawn",
				subagentNarratorId: "sub1",
				ownerNarratorId: "sub1",
				inputJson: {
					file_path: "secret.ts",
					content: "permission detail remains complete",
				},
			}),
		]);
	});
});

describe("pretext exact document transport", () => {
	test("pages the complete ordered top-level history without layout estimates", async () => {
		await seedNarrator();
		for (let seq = 1; seq <= 5; seq++) {
			await seedMessage({
				id: `m-${seq}`,
				narratorId: "n1",
				seq,
				role: seq % 2 === 0 ? "assistant" : "user",
				contentText: `message ${seq}`,
			});
		}

		const first = await narratorService.getPretextDocumentPage("n1", { limit: 2 });
		expect(first.messages.map((message) => [message.id, message.seq])).toEqual([
			["m-1", 1],
			["m-2", 2],
		]);
		expect(first).toMatchObject({ minSeq: 1, maxSeq: 2, hasNext: true, messageVersion: 0 });
		expect(first).not.toHaveProperty("heightHint");
		expect(first).not.toHaveProperty("bands");

		const second = await narratorService.getPretextDocumentPage("n1", {
			afterSeq: first.maxSeq ?? undefined,
			limit: 2,
			messageVersion: first.messageVersion,
		});
		expect(second.messages.map((message) => [message.id, message.seq])).toEqual([
			["m-3", 3],
			["m-4", 4],
		]);
		expect(second).toMatchObject({ minSeq: 3, maxSeq: 4, hasNext: true, messageVersion: 0 });

		const last = await narratorService.getPretextDocumentPage("n1", {
			afterSeq: second.maxSeq ?? undefined,
			limit: 2,
			messageVersion: first.messageVersion,
		});
		expect(last.messages.map((message) => [message.id, message.seq])).toEqual([["m-5", 5]]);
		expect(last).toMatchObject({ minSeq: 5, maxSeq: 5, hasNext: false, messageVersion: 0 });
	});

	test("rejects a continuation page pinned to a stale document revision", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-1",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "message 1",
		});

		await expect(
			narratorService.getPretextDocumentPage("n1", { limit: 1, messageVersion: 9 }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "PRETEXT_DOCUMENT_CHANGED",
		});
	});

	test("rejects a page if the document revision changes while it is being built", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-1",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "message 1",
		});
		const original = narratorMessageQueries.getMessageVersion;
		let calls = 0;
		narratorMessageQueries.getMessageVersion = async () => (calls++ === 0 ? 10 : 11);
		try {
			await expect(
				narratorMessageQueries.getPretextDocumentPage("n1", { limit: 1 }),
			).rejects.toMatchObject({
				statusCode: 409,
				code: "PRETEXT_DOCUMENT_CHANGED",
			});
		} finally {
			narratorMessageQueries.getMessageVersion = original;
		}
	});
});

describe("latest assistant text across compact boundary", () => {
	test("recovers the last assistant text even when a compact marker is at the tail", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-user",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "do the work",
		});
		await seedMessage({
			id: "m-answer",
			narratorId: "n1",
			seq: 2,
			role: "assistant",
			contentText: "here is the real conclusion",
		});
		// A compact that completed right before the subagent stopped: its marker is
		// the highest-seq ref and is flagged isCompact=1, so getModelHistorySinceLastCompact
		// would return an empty set.
		await seedMessage({
			id: "m-compact",
			narratorId: "n1",
			seq: 3,
			role: "system",
			contentText: "[Compact] summary",
			contentJson: [{ type: "compact", status: "compacted", summary: "compacted summary" }],
			isCompact: true,
		});

		// Sanity: the compact-bounded query is empty in this window.
		expect(await narratorService.getModelHistorySinceLastCompact("n1")).toEqual([]);

		const latest = await narratorService.getLatestAssistantTextAndId("n1");
		expect(latest).toEqual({ id: "m-answer", text: "here is the real conclusion" });
	});

	test("skips tool-only assistant messages and returns the most recent with text", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-text",
			narratorId: "n1",
			seq: 1,
			role: "assistant",
			contentText: "earlier text answer",
		});
		await seedMessage({
			id: "m-toolonly",
			narratorId: "n1",
			seq: 2,
			role: "assistant",
			contentText: "tool call",
			contentJson: [{ type: "tool_use", id: "tu-x", name: "Bash", input: { command: "ls" } }],
		});

		const latest = await narratorService.getLatestAssistantTextAndId("n1");
		expect(latest).toEqual({ id: "m-text", text: "earlier text answer" });
	});

	test("returns null when there is no assistant text at all", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-user",
			narratorId: "n1",
			seq: 1,
			role: "user",
			contentText: "only a question",
		});

		expect(await narratorService.getLatestAssistantTextAndId("n1")).toBeNull();
	});

	test("getLatestSuccessfulCompactSummary returns the newest compacted summary only", async () => {
		await seedNarrator();
		await seedMessage({
			id: "m-old-compact",
			narratorId: "n1",
			seq: 1,
			role: "system",
			contentText: "[Compact] old",
			contentJson: [{ type: "compact", status: "compacted", summary: "old summary" }],
			isCompact: true,
		});
		await seedMessage({
			id: "m-new-compact",
			narratorId: "n1",
			seq: 2,
			role: "system",
			contentText: "[Compact] new",
			contentJson: [{ type: "compact", status: "compacted", summary: "newest summary" }],
			isCompact: true,
		});
		// A failed compact marker is not flagged isCompact=1 and must be ignored.
		await seedMessage({
			id: "m-failed-compact",
			narratorId: "n1",
			seq: 3,
			role: "system",
			contentText: "[Compact Failed]",
			contentJson: [{ type: "compact", status: "error", summary: "ignored" }],
		});

		const summary = await narratorService.getLatestSuccessfulCompactSummary("n1");
		expect(summary).toEqual({ id: "m-new-compact", summary: "newest summary" });
	});
});
