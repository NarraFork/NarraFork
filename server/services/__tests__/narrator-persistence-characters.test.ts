import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ContextCharStats } from "@shared/context-composition";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	hasPendingContextCharacterRefresh,
	measureSerializedCharacters,
	queueContextCharacterRefresh,
} from "../../lib/context-characters";

const { db, sqlite } = getTestDb();
// Schema changes intentionally precede generated migrations in this worktree.
for (const [table, column, definition] of [
	["narrator_messages", "context_chars_json", "text"],
	["narrator_tool_calls", "input_chars", "integer NOT NULL DEFAULT 0"],
	["narrator_tool_calls", "output_chars", "integer NOT NULL DEFAULT 0"],
	["narrators", "context_summary_chars", "integer NOT NULL DEFAULT 0"],
	["narrators", "context_system_chars", "integer NOT NULL DEFAULT 0"],
	["narrators", "context_tools_chars", "integer NOT NULL DEFAULT 0"],
	["narrators", "context_char_revision", "integer NOT NULL DEFAULT 0"],
	["narrators", "context_char_cache_json", "text"],
	["narrators", "context_usage_snapshot_json", "text"],
]) {
	const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	if (!columns.some(({ name }) => name === column))
		sqlite.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const refreshes: string[] = [];
const messageRefreshes: Array<{ narratorId: string; messageId?: string }> = [];
const { createContextCharacterService } = await import("../narrator-context-composition");
let integrationService: ReturnType<typeof createContextCharacterService> | undefined;
mock.module("../narrator-context-composition", () => ({
	storeNarratorContextUsage: async () => {},
	freezeNarratorContextComposition: async () => null,
	invalidateContextCharacterCache: async (id: string, messageId?: string) => {
		refreshes.push(id);
		messageRefreshes.push({ narratorId: id, messageId });
		await integrationService?.invalidate(id, messageId);
	},
	invalidateContextCharacterBatch: async (
		id: string,
		messageIds?: readonly string[],
		options?: { full?: boolean },
	) => {
		refreshes.push(id);
		for (const messageId of messageIds ?? [undefined])
			messageRefreshes.push({ narratorId: id, messageId });
		await integrationService?.invalidateBatch(id, messageIds, options);
	},
	invalidateContextCharacterOverflow: async () => integrationService?.invalidateOverflow(),
}));
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const NOW = "2026-10-04T10:00:00.000Z";

function seedNarrator(id = "n1") {
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run(id, NOW, NOW);
}
function charsOf(id: string): ContextCharStats | null {
	const row = sqlite
		.prepare("SELECT context_chars_json AS chars FROM narrator_messages WHERE id = ?")
		.get(id) as { chars: string | null };
	return row.chars ? JSON.parse(row.chars) : null;
}
function toolOf(id: string) {
	return sqlite
		.prepare(
			"SELECT input_chars AS input, output_chars AS output, output_json AS body FROM narrator_tool_calls WHERE id = ?",
		)
		.get(id) as { input: number; output: number; body: string | null };
}
async function flushRefreshes() {
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

beforeEach(async () => {
	await flushRefreshes();
	await integrationService?.dispose();
	integrationService = undefined;
	cleanDb(sqlite);
	refreshes.length = 0;
	messageRefreshes.length = 0;
	seedNarrator();
});
afterAll(async () => {
	await flushRefreshes();
	await integrationService?.dispose();
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("character statistics at actual persistence boundaries", () => {
	test("new messages store their counts and coalesce successful refresh notifications", async () => {
		const user = await narratorPersistence.persistUserMessage("n1", "中😀", [
			{ type: "text", text: "中😀" },
			{ type: "file_reference", snapshotText: "snapshot" },
			{ type: "image", source: { type: "base64", data: "x".repeat(10000) } },
		]);
		const system = await narratorPersistence.persistSystemMessage("n1", "fallback", [
			{ type: "system_injection", source: "test", modelText: "native" },
		]);
		expect(charsOf(user.id)).toEqual({
			segments: [
				{ category: "user", chars: 3 },
				{ category: "attachment", chars: 8 },
			],
		});
		expect(charsOf(system.id)).toEqual({ segments: [{ category: "system", chars: 6 }] });
		await flushRefreshes();
		expect(messageRefreshes).toEqual([
			{ narratorId: "n1", messageId: user.id },
			{ narratorId: "n1", messageId: system.id },
		]);
	});

	test("stream replacements count current revision, not historical checkpoints or tool duplicates", async () => {
		const partial = await narratorPersistence.createPartialAssistantMessage("n1", {
			uuid: "partial",
			session_id: "s",
		});
		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "text",
			id: "t",
			text: "hello",
			revision: 1,
		});
		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "text",
			id: "t",
			text: "hello world",
			revision: 2,
		});
		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "text",
			id: "t",
			text: "stale",
			revision: 1,
		});
		const input = { command: "pwd" };
		const toolId = await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "tool_use",
			id: "u1",
			name: "Bash",
			input,
		});
		expect(toolId).toBeDefined();
		if (!toolId) throw new Error("Tool row missing");
		expect(charsOf(partial.id)).toEqual({
			segments: [
				{ category: "assistant", chars: 11 },
				{ category: "toolCall", chars: 0, toolUseId: "u1" },
			],
		});
		expect(toolOf(toolId).input).toBe(measureSerializedCharacters(input));
		await narratorPersistence.updateToolCallResult(
			"u1",
			{ output: "output", status: "success" },
			partial.id,
			toolId,
		);
		expect(toolOf(toolId).output).toBe(measureSerializedCharacters("output"));
		await narratorPersistence.overwriteToolCallInput("u1", { command: "ls" }, toolId);
		expect(toolOf(toolId).input).toBe(measureSerializedCharacters({ command: "ls" }));
		expect(charsOf(partial.id)).toEqual({
			segments: [
				{ category: "assistant", chars: 11 },
				{ category: "toolCall", chars: 0, toolUseId: "u1" },
			],
		});
	});

	test("shared tool updates and streaming edits notify with their actual message identity", async () => {
		seedNarrator("n2");
		const msg = await narratorPersistence.persistAssistantMessage("n1", {
			uuid: "shared-tool",
			session_id: "s",
			message: {
				content: [{ type: "tool_use", id: "shared-u", name: "Bash", input: { command: "pwd" } }],
			},
		});
		const tool = sqlite
			.prepare("SELECT id FROM narrator_tool_calls WHERE message_id = ?")
			.get(msg.id) as { id: string };
		sqlite
			.prepare(
				"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('r-shared','n2',?,0)",
			)
			.run(msg.id);
		await flushRefreshes();
		messageRefreshes.length = 0;
		await narratorPersistence.overwriteToolCallInput("shared-u", { command: "ls" }, tool.id);
		await flushRefreshes();
		expect(messageRefreshes).toEqual([{ narratorId: "n1", messageId: msg.id }]);
		messageRefreshes.length = 0;
		await narratorPersistence.updateToolCallResult(
			"shared-u",
			{ output: "one", status: "success" },
			msg.id,
			tool.id,
		);
		await flushRefreshes();
		expect(messageRefreshes).toEqual([{ narratorId: "n1", messageId: msg.id }]);
		messageRefreshes.length = 0;
		sqlite.prepare("UPDATE narrator_tool_calls SET status='running' WHERE id=?").run(tool.id);
		await narratorPersistence.updateToolCallResultIfActive(
			"shared-u",
			{ output: "two", status: "success" },
			msg.id,
			tool.id,
		);
		await flushRefreshes();
		expect(messageRefreshes).toEqual([{ narratorId: "n1", messageId: msg.id }]);
		messageRefreshes.length = 0;
		await narratorPersistence.appendBlockToMessage(msg.id, "n1", { type: "text", text: "new" });
		await flushRefreshes();
		expect(messageRefreshes).toEqual([{ narratorId: "n1", messageId: msg.id }]);
	});

	test("CAS output failure cannot alter stored counts or notify", async () => {
		const assistant = await narratorPersistence.persistAssistantMessage("n1", {
			uuid: "a",
			session_id: "s",
			message: {
				content: [{ type: "tool_use", id: "u2", name: "Bash", input: { command: "pwd" } }],
			},
		});
		const tool = sqlite
			.prepare("SELECT id FROM narrator_tool_calls WHERE message_id = ?")
			.get(assistant.id) as { id: string };
		await flushRefreshes();
		refreshes.length = 0;
		await expect(
			narratorPersistence.updateToolCallResult(
				"u2",
				{
					output: "bad",
					status: "success",
					expectedBinding: { toolCallId: tool.id, narratorId: "n1", attempt: 9 },
				},
				assistant.id,
				tool.id,
			),
		).rejects.toThrow();
		expect(toolOf(tool.id).output).toBe(0);
		await flushRefreshes();
		expect(refreshes).toEqual([]);
		await narratorPersistence.updateToolCallResultIfActive(
			"u2",
			{ output: "done", status: "success" },
			assistant.id,
			tool.id,
		);
		expect(toolOf(tool.id).output).toBe(measureSerializedCharacters("done"));
		expect(
			await narratorPersistence.updateToolCallResultIfActive(
				"u2",
				{ output: "late", status: "fail" },
				assistant.id,
				tool.id,
			),
		).toBe(false);
		expect(toolOf(tool.id).output).toBe(measureSerializedCharacters("done"));
	});

	test("global Plan summary counts once, then clear resets it", async () => {
		const plan = await narratorPersistence.persistPlanMessage("n1", "plan 中😀");
		expect(charsOf(plan.id)).toEqual({ segments: [] });
		const count = () =>
			(
				sqlite
					.prepare("SELECT context_summary_chars AS chars FROM narrators WHERE id = 'n1'")
					.get() as { chars: number }
			).chars;
		expect(count()).toBe("plan 中😀".length);
		sqlite.run("UPDATE narrators SET context_usage_snapshot_json = '{}' WHERE id = 'n1'");
		await narratorPersistence.clearContext("n1");
		expect(count()).toBe(0);
		expect(
			(
				sqlite
					.prepare("SELECT context_usage_snapshot_json AS snapshot FROM narrators WHERE id = 'n1'")
					.get() as { snapshot: string | null }
			).snapshot,
		).toBeNull();
	});

	test("clear before a message discards calibration from the previous input", async () => {
		const msg = await narratorPersistence.persistUserMessage("n1", "keep this");
		sqlite.run("UPDATE narrators SET context_usage_snapshot_json = '{}' WHERE id = 'n1'");
		await narratorPersistence.clearContextBefore("n1", msg.id);
		expect(
			(
				sqlite
					.prepare("SELECT context_usage_snapshot_json AS snapshot FROM narrators WHERE id = 'n1'")
					.get() as { snapshot: string | null }
			).snapshot,
		).toBeNull();
	});

	test("model changes discard the previous request calibration", async () => {
		sqlite.run("UPDATE narrators SET context_usage_snapshot_json = '{}' WHERE id = 'n1'");
		await narratorPersistence.updateModel("n1", "other-model");
		expect(
			(
				sqlite
					.prepare("SELECT context_usage_snapshot_json AS snapshot FROM narrators WHERE id = 'n1'")
					.get() as { snapshot: string | null }
			).snapshot,
		).toBeNull();
	});

	test("COW inheritance preserves legacy null, semantic edit only measures its new private version", async () => {
		seedNarrator("n2");
		const msg = await narratorPersistence.persistUserMessage("n1", "old");
		sqlite
			.prepare("UPDATE narrator_messages SET context_chars_json = NULL WHERE id = ?")
			.run(msg.id);
		sqlite
			.prepare(
				"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('r2','n2',?,0)",
			)
			.run(msg.id);
		const copied = await narratorPersistence.copyOnWriteMessage("n2", msg.id);
		expect(copied).not.toBe(msg.id);
		expect(charsOf(copied)).toBeNull();
		expect(charsOf(msg.id)).toBeNull();
		await narratorPersistence.copyOnWriteMessage("n2", copied, {
			contentJson: [{ type: "text", text: "new content" }],
			contentText: "new content",
		});
		expect(charsOf(copied)).toEqual({ segments: [{ category: "user", chars: 11 }] });
		expect(charsOf(msg.id)).toBeNull();
	});

	test("compact lifecycle CAS counts successful summaries, failed and stale attempts do not", async () => {
		const marker = await narratorPersistence.persistCompactingMessage("n1");
		expect(charsOf(marker.id)).toEqual({ segments: [] });
		await narratorPersistence.finalizeCompactingMessage(marker.id, "n1", "ignored", undefined, {
			status: "failed",
			error: "failed",
		});
		const count = () =>
			(
				sqlite
					.prepare("SELECT context_summary_chars AS chars FROM narrators WHERE id = 'n1'")
					.get() as { chars: number }
			).chars;
		expect(count()).toBe(0);
		const retry = await narratorPersistence.prepareFailedCompactRetry("n1", marker.id);
		await narratorPersistence.finalizeCompactingMessage(retry.id, "n1", "summary😀");
		expect(count()).toBe("summary😀".length);
		expect(charsOf(retry.id)).toEqual({ segments: [] });
		await flushRefreshes();
		refreshes.length = 0;
		expect(
			await narratorPersistence.finalizeCompactingMessage(retry.id, "n1", "stale summary"),
		).toBeNull();
		await flushRefreshes();
		expect(count()).toBe("summary😀".length);
		expect(refreshes).toEqual([]);
	});

	test("segment summary replacements only count the currently persisted new body", async () => {
		const user = await narratorPersistence.persistUserMessage("n1", "original message");
		const marker = await narratorPersistence.persistSegmentCompactMarker("n1", [user.id]);
		expect(charsOf(marker.message.id)).toEqual({ segments: [] });
		await narratorPersistence.finalizeSegmentCompact(marker.message.id, "n1", "short");
		expect(charsOf(marker.message.id)).toEqual({ segments: [{ category: "summary", chars: 5 }] });
		await narratorPersistence.updateSegmentCompactSummary("n1", marker.message.id, "replacement");
		expect(charsOf(marker.message.id)).toEqual({ segments: [{ category: "summary", chars: 11 }] });
		expect(charsOf(user.id)).toEqual({ segments: [{ category: "user", chars: 16 }] });
	});

	test("COW tool clones inherit existing counters, including legacy zero", async () => {
		seedNarrator("n2");
		const msg = await narratorPersistence.persistAssistantMessage("n1", {
			uuid: "copy-tool",
			session_id: "s",
			message: {
				content: [{ type: "tool_use", id: "u-copy", name: "Bash", input: { command: "pwd" } }],
			},
		});
		const tool = sqlite
			.prepare("SELECT id FROM narrator_tool_calls WHERE message_id = ?")
			.get(msg.id) as { id: string };
		await narratorPersistence.updateToolCallResult(
			"u-copy",
			{ output: "result", status: "success" },
			msg.id,
			tool.id,
		);
		sqlite.prepare("UPDATE narrator_tool_calls SET input_chars=0 WHERE id=?").run(tool.id);
		sqlite
			.prepare(
				"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('r-tool','n2',?,0)",
			)
			.run(msg.id);
		const copied = await narratorPersistence.copyOnWriteMessage("n2", msg.id);
		const clone = sqlite
			.prepare("SELECT id FROM narrator_tool_calls WHERE message_id = ?")
			.get(copied) as { id: string };
		expect(toolOf(clone.id)).toEqual(toolOf(tool.id));
		expect(toolOf(clone.id).input).toBe(0);
	});

	test("metadata/translated reasoning and display messages do not backfill historical statistics", async () => {
		const msg = await narratorPersistence.persistAssistantMessage("n1", {
			uuid: "reason",
			session_id: "s",
			message: { content: [{ type: "reasoning", text: "old" }] },
		});
		sqlite
			.prepare("UPDATE narrator_messages SET context_chars_json = NULL WHERE id = ?")
			.run(msg.id);
		await narratorPersistence.patchReasoningTranslation(msg.id, 0, "translation");
		expect(charsOf(msg.id)).toBeNull();
		const display = await narratorPersistence.persistDisplayMessage("n1", "UI only");
		expect(charsOf(display.id)).toEqual({ segments: [] });
		await flushRefreshes();
		refreshes.length = 0;
		await narratorPersistence.updateMessageCost(msg.id, 1);
		await flushRefreshes();
		expect(charsOf(msg.id)).toBeNull();
		expect(refreshes).toEqual([]);
	});
});

test("actual new-session persistence and queued invalidation prepare full request classification before output", async () => {
	integrationService = createContextCharacterService(sqlite);
	sqlite.run("UPDATE narrators SET context_system_chars=10,context_tools_chars=20 WHERE id='n1'");
	await narratorPersistence.persistUserMessage("n1", "question");
	const assistant = await narratorPersistence.createPartialAssistantMessage("n1", {
		uuid: "real-input",
		session_id: "session",
	});
	await narratorPersistence.appendBlockToMessage(assistant.id, "n1", {
		type: "text",
		id: "answer",
		text: "answer",
		revision: 1,
	});
	const input = { command: "pwd" };
	const toolId = await narratorPersistence.appendBlockToMessage(assistant.id, "n1", {
		type: "tool_use",
		id: "real-call",
		name: "Bash",
		input,
	});
	if (!toolId) throw new Error("real tool persistence missing");
	await narratorPersistence.updateToolCallResult(
		"real-call",
		{ output: "result", status: "success" },
		assistant.id,
		toolId,
	);
	await narratorPersistence.persistUserMessage("n1", "next");
	// No ready()/settled()/refresh sleep between the last actual write and request preparation.
	const counts = { totalChars: 10000, systemChars: 10, toolsChars: 20 };
	const pin = await integrationService.freezeForRequest("n1", counts, "real-request", NOW);
	expect(pin).not.toBeNull();
	const composition = await integrationService.get("n1");
	const category = (name: string) =>
		composition.totals.find((entry) => entry.category === name)?.chars;
	expect(category("user")).toBe("question".length + "next".length);
	expect(category("assistant")).toBe("answer".length);
	expect(category("toolCall")).toBe(measureSerializedCharacters(input));
	expect(category("toolResult")).toBe(measureSerializedCharacters("result"));
	expect(composition.pending).toBe(false);
	const output = await narratorPersistence.createPartialAssistantMessage("n1", {
		uuid: "after-input",
		session_id: "session",
	});
	await narratorPersistence.appendBlockToMessage(output.id, "n1", {
		type: "text",
		id: "after",
		text: "later output",
		revision: 1,
	});
	const secondPin = await integrationService.freezeForRequest(
		"n1",
		counts,
		"next-real-request",
		NOW,
	);
	expect(secondPin?.totals.find((entry) => entry.category === "assistant")?.chars).toBe(
		"answer".length + "later output".length,
	);
	// A subsequent tool result is counted at its latest value, not its previous execution output.
	await narratorPersistence.updateToolCallResult(
		"real-call",
		{ output: "updated result", status: "success" },
		assistant.id,
		toolId,
	);
	const thirdPin = await integrationService.freezeForRequest(
		"n1",
		counts,
		"tool-result-request",
		NOW,
	);
	expect(thirdPin?.totals.find((entry) => entry.category === "toolResult")?.chars).toBe(
		measureSerializedCharacters("updated result"),
	);
	await flushRefreshes();
	await integrationService.settled();
	expect((await integrationService.get("n1")).generation).toBe(thirdPin?.generation ?? null);
});

test("an unrelated narrator's queued write cannot force a fresh request to fixed-only classification", async () => {
	integrationService = createContextCharacterService(sqlite);
	await narratorPersistence.persistUserMessage("n1", "own question");
	const counts = { totalChars: 10000, systemChars: 10, toolsChars: 20 };
	await integrationService.freezeForRequest("n1", counts, "own-first", NOW);
	await integrationService.settled();
	seedNarrator("other");
	await narratorPersistence.persistUserMessage("other", "unrelated write");
	expect(hasPendingContextCharacterRefresh()).toBe(true);
	expect(hasPendingContextCharacterRefresh("n1")).toBe(false);
	const pin = await integrationService.freezeForRequest("n1", counts, "own-next", NOW);
	expect(pin?.totals.find((entry) => entry.category === "user")?.chars).toBe("own question".length);
	expect(pin?.totalChars).toBe(30 + "own question".length);
	await flushRefreshes();
	await integrationService.settled();
});

test("fork waits for owner-only shared-message notifications and rejects a later shared write", async () => {
	integrationService = createContextCharacterService(sqlite);
	const assistant = await narratorPersistence.createPartialAssistantMessage("n1", {
		uuid: "shared-boundary",
		session_id: "session",
	});
	await narratorPersistence.appendBlockToMessage(assistant.id, "n1", {
		type: "text",
		id: "shared-text",
		text: "shared",
		revision: 1,
	});
	const toolId = await narratorPersistence.appendBlockToMessage(assistant.id, "n1", {
		type: "tool_use",
		id: "shared-boundary-call",
		name: "Bash",
		input: { command: "pwd" },
	});
	if (!toolId) throw new Error("shared tool persistence missing");
	await narratorPersistence.updateToolCallResult(
		"shared-boundary-call",
		{ output: "before", status: "success" },
		assistant.id,
		toolId,
	);
	seedNarrator("fork");
	sqlite.run(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq,is_compact,segment_compact_id) SELECT 'fork-'||id,'fork',message_id,seq,is_compact,segment_compact_id FROM narrator_message_refs WHERE narrator_id='n1'",
	);
	const counts = { totalChars: 10000, systemChars: 10, toolsChars: 20 };
	await integrationService.freezeForRequest("fork", counts, "fork-first", NOW);
	await integrationService.settled();
	await narratorPersistence.updateToolCallResult(
		"shared-boundary-call",
		{ output: "owner updated result", status: "success" },
		assistant.id,
		toolId,
	);
	expect(hasPendingContextCharacterRefresh("n1")).toBe(true);
	expect(hasPendingContextCharacterRefresh("fork")).toBe(false);
	const pin = await integrationService.freezeForRequest("fork", counts, "fork-current", NOW);
	expect(pin?.totals.find((entry) => entry.category === "toolResult")?.chars).toBe(
		measureSerializedCharacters("owner updated result"),
	);
	await integrationService.settled();
	await narratorPersistence.updateToolCallResult(
		"shared-boundary-call",
		{ output: "input boundary", status: "success" },
		assistant.id,
		toolId,
	);
	const preparing = integrationService.freezeForRequest("fork", counts, "fork-late-write", NOW);
	await narratorPersistence.updateToolCallResult(
		"shared-boundary-call",
		{ output: "later shared output", status: "success" },
		assistant.id,
		toolId,
	);
	expect(await preparing).toBeNull();
	expect((await integrationService.get("fork")).usage?.composition).toBeNull();
	await flushRefreshes();
	await integrationService.settled();
});

test("duplicate unrelated write notifications cannot overflow a request's distinct-message guard", async () => {
	integrationService = createContextCharacterService(sqlite);
	await narratorPersistence.persistUserMessage("n1", "guarded input");
	seedNarrator("duplicate-owner");
	const other = await narratorPersistence.persistUserMessage("duplicate-owner", "unrelated");
	const counts = { totalChars: 10000, systemChars: 10, toolsChars: 20 };
	const preparing = integrationService.freezeForRequest(
		"n1",
		counts,
		"duplicate-guard-request",
		NOW,
	);
	for (let i = 0; i < 300; i++) queueContextCharacterRefresh("duplicate-owner", other.id);
	const pin = await preparing;
	expect(pin?.totals.find((entry) => entry.category === "user")?.chars).toBe(
		"guarded input".length,
	);
	expect(pin?.totalChars).toBe(30 + "guarded input".length);
	await flushRefreshes();
	await integrationService.settled();
});
