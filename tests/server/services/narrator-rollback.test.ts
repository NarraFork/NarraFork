import { afterEach, describe, expect, it } from "bun:test";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
} from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

interface Block {
	type: string;
	text?: string;
	id?: string;
	name?: string;
}

const { db, sqlite } = getTestDb();

afterEach(() => cleanDb(sqlite));

const now = new Date().toISOString();

// === Seed helpers ===

function seedProject() {
	db.insert(projects)
		.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: now, updatedAt: now })
		.run();
	db.insert(chapters)
		.values({
			id: "ch1",
			projectId: "p1",
			title: "Chapter 1",
			branch: "chapter/ch1-abc",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function seedNarrator(
	id = "n1",
	chapterId: string | null = "ch1",
	apiConversationId?: string | null,
) {
	db.insert(narrators)
		.values({
			id,
			chapterId,
			apiConversationId,
			type: "primary",
			inheritMode: "fresh",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function seedMessage(
	id: string,
	narratorId: string,
	role: "user" | "assistant" | "system" = "user",
	text = "Hello",
	blocks?: unknown[],
) {
	const contentBlocks = blocks ?? [{ type: "text", text }];
	db.insert(narratorMessages)
		.values({
			id,
			narratorId,
			role,
			contentJson: contentBlocks,
			contentText: text,
			createdAt: now,
		})
		.run();
}

function seedRef(narratorId: string, messageId: string, seq: number) {
	db.insert(narratorMessageRefs)
		.values({
			id: `ref-${narratorId}-${messageId}`,
			narratorId,
			messageId,
			seq,
			isCompact: 0,
		})
		.run();
}

function seedToolCall(
	id: string,
	narratorId: string,
	messageId: string,
	toolUseId: string,
	toolName: string,
	inputJson: unknown,
	status: "success" | "fail" = "success",
) {
	db.insert(narratorToolCalls)
		.values({
			id,
			narratorId,
			messageId,
			toolUseId,
			toolName,
			inputJson,
			status,
			createdAt: now,
		})
		.run();
}

/**
 * Simulate the core logic of narratorService.deleteMessagesAfter.
 * Removes refs with seq > target's seq, then deletes orphan messages.
 */
async function simulateDeleteMessagesAfter(
	narratorId: string,
	messageId: string,
	opts?: { preserveConversationId?: boolean },
) {
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
	});
	if (!targetRef) throw new Error(`Ref not found: ${narratorId}/${messageId}`);

	const refsToRemove = db
		.select({ id: narratorMessageRefs.id, messageId: narratorMessageRefs.messageId })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				gt(narratorMessageRefs.seq, targetRef.seq),
			),
		)
		.all();

	if (refsToRemove.length === 0) return { deletedMessageIds: [] as string[] };

	db.update(narrators)
		.set({
			...(opts?.preserveConversationId ? {} : { apiConversationId: null }),
			pruneBoundaryMessageId: null,
			prunedPercent: null,
		})
		.where(eq(narrators.id, narratorId))
		.run();

	const refIds = refsToRemove.map((r) => r.id);
	const messageIds = [...new Set(refsToRemove.map((r) => r.messageId))];

	db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.id, refIds)).run();

	// Delete orphan messages (not referenced by any narrator)
	for (const mid of messageIds) {
		const otherRef = await db.query.narratorMessageRefs.findFirst({
			where: eq(narratorMessageRefs.messageId, mid),
		});
		if (!otherRef) {
			db.delete(narratorMessages).where(eq(narratorMessages.id, mid)).run();
		}
	}

	return { deletedMessageIds: messageIds };
}

/**
 * Simulate the core logic of rollbackToBlock from narrator-session.ts.
 * Step 1: delete all messages after the target message.
 * Step 2: truncate blocks after blockIndex in the target message.
 */
async function simulateRollbackToBlock(narratorId: string, messageId: string, blockIndex: number) {
	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
	});
	if (!targetMsg) throw new Error(`Message not found: ${messageId}`);

	const blocks = Array.isArray(targetMsg.contentJson) ? (targetMsg.contentJson as unknown[]) : [];

	if (blockIndex < 0 || blockIndex >= blocks.length) {
		throw new Error(`Block index ${blockIndex} out of range (0..${blocks.length - 1})`);
	}

	// Step 1: delete subsequent messages while preserving the API cache key.
	const { deletedMessageIds } = await simulateDeleteMessagesAfter(narratorId, messageId, {
		preserveConversationId: true,
	});

	// Step 2: truncate blocks after blockIndex
	if (blockIndex < blocks.length - 1) {
		const truncated = blocks.slice(0, blockIndex + 1);
		const contentText = truncated
			// biome-ignore lint/suspicious/noExplicitAny: test helper
			.filter((b: any) => b.type === "text")
			// biome-ignore lint/suspicious/noExplicitAny: test helper
			.map((b: any) => b.text ?? "")
			.join("\n");
		db.update(narratorMessages)
			.set({
				contentJson: truncated,
				contentText: contentText || null,
			})
			.where(eq(narratorMessages.id, messageId))
			.run();
	}

	return { deletedMessageIds, truncatedBlocks: blocks.length - blockIndex - 1 };
}

/**
 * Simulate the rollback-preview route's query logic.
 * Returns affected file paths, deleted block/message counts.
 */
async function simulateRollbackPreview(narratorId: string, messageId: string, blockIndex: number) {
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
		columns: { seq: true },
	});
	if (!targetRef) throw new Error(`Ref not found: ${narratorId}/${messageId}`);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
		columns: { contentJson: true },
	});
	if (!targetMsg) throw new Error(`Message not found: ${messageId}`);

	const blocks = Array.isArray(targetMsg.contentJson)
		? (targetMsg.contentJson as { type: string; id?: string }[])
		: [];
	if (blockIndex < 0 || blockIndex >= blocks.length) {
		throw new Error(`Block index ${blockIndex} out of range (0..${blocks.length - 1})`);
	}

	// Collect tool_use IDs from blocks after blockIndex
	const truncatedToolUseIds: string[] = [];
	for (let i = blockIndex + 1; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.type === "tool_use" && b.id) {
			truncatedToolUseIds.push(b.id);
		}
	}

	const deletedBlockCount = blocks.length - blockIndex - 1;

	// Find tool calls from subsequent messages
	const subsequentToolCalls = db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "success"),
				gt(narratorMessageRefs.seq, targetRef.seq),
			),
		)
		.all();

	// Count subsequent messages
	const subsequentMsgCount = db
		.select({ cnt: sql<number>`count(*)` })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				gt(narratorMessageRefs.seq, targetRef.seq),
			),
		)
		.all();
	const deletedMessageCount = subsequentMsgCount[0]?.cnt ?? 0;

	// Find tool calls from truncated blocks
	const truncatedToolCalls =
		truncatedToolUseIds.length > 0
			? await db.query.narratorToolCalls.findMany({
					where: and(
						eq(narratorToolCalls.narratorId, narratorId),
						eq(narratorToolCalls.status, "success"),
						inArray(narratorToolCalls.toolUseId, truncatedToolUseIds),
					),
					columns: { toolUseId: true, toolName: true, inputJson: true },
				})
			: [];

	const allToolCalls = [...truncatedToolCalls, ...subsequentToolCalls];

	// Extract affected file paths
	const files = new Set<string>();
	for (const tc of allToolCalls) {
		if (tc.toolName !== "Write" && tc.toolName !== "Edit") continue;
		const input = tc.inputJson as Record<string, unknown> | null;
		if (!input?.file_path) continue;
		files.add(input.file_path as string);
	}

	return {
		affectedFilePaths: [...files],
		toolCallCount: allToolCalls.length,
		deletedBlockCount,
		deletedMessageCount,
	};
}

// === rollbackToBlock tests ===

describe("rollbackToBlock", () => {
	it("preserves apiConversationId so rollback keeps the provider cache key", async () => {
		seedProject();
		seedNarrator("n1", "ch1", "cache-conv-1");
		seedMessage("m0", "n1", "assistant", "first", [
			{ type: "text", text: "first" },
			{ type: "text", text: "discard" },
		]);
		seedMessage("m1", "n1", "user", "after");
		seedRef("n1", "m0", 0);
		seedRef("n1", "m1", 1);

		await simulateRollbackToBlock("n1", "m0", 0);

		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, "n1"),
		});
		expect(narrator?.apiConversationId).toBe("cache-conv-1");
	});

	it("deletes subsequent messages and preserves the target", async () => {
		seedProject();
		seedNarrator();
		seedMessage("m0", "n1", "user", "first");
		seedMessage("m1", "n1", "assistant", "second");
		seedMessage("m2", "n1", "user", "third");
		seedRef("n1", "m0", 0);
		seedRef("n1", "m1", 1);
		seedRef("n1", "m2", 2);

		const result = await simulateRollbackToBlock("n1", "m0", 0);

		expect(result.deletedMessageIds).toHaveLength(2);
		expect(result.truncatedBlocks).toBe(0);

		const refs = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.narratorId, "n1"),
		});
		expect(refs).toHaveLength(1);
		expect(refs[0].messageId).toBe("m0");

		const m0 = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m0"),
		});
		expect(m0?.contentText).toBe("first");

		const m1 = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m1"),
		});
		expect(m1).toBeUndefined();
	});

	it("truncates blocks after blockIndex in the target message", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "Hello" },
			{ type: "tool_use", id: "tu1", name: "Read", input: { path: "/a" } },
			{ type: "tool_result", tool_use_id: "tu1", content: "ok" },
			{ type: "text", text: "Done" },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);

		const result = await simulateRollbackToBlock("n1", "m0", 1);
		expect(result.truncatedBlocks).toBe(2);

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m0"),
		});
		const parsed = msg?.contentJson as Block[];
		expect(parsed).toHaveLength(2);
		expect(parsed[0].type).toBe("text");
		expect(parsed[1].type).toBe("tool_use");
	});

	it("rollback to first block removes all subsequent blocks", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "I will help" },
			{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/a.ts" } },
			{ type: "tool_result", tool_use_id: "tu1", content: "written" },
			{ type: "text", text: "All done" },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);

		const result = await simulateRollbackToBlock("n1", "m0", 0);
		expect(result.truncatedBlocks).toBe(3);

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m0"),
		});
		const parsed = msg?.contentJson as Block[];
		expect(parsed).toHaveLength(1);
		expect(parsed[0].text).toBe("I will help");
	});

	it("rollback to last block only deletes subsequent messages, not blocks", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "Hello" },
			{ type: "tool_use", id: "tu1", name: "Read", input: {} },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);
		seedMessage("m1", "n1", "user", "follow up");
		seedRef("n1", "m1", 1);

		const result = await simulateRollbackToBlock("n1", "m0", 1);

		expect(result.deletedMessageIds).toHaveLength(1);
		expect(result.truncatedBlocks).toBe(0);

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m0"),
		});
		const parsed = msg?.contentJson as Block[];
		expect(parsed).toHaveLength(2);
	});

	it("throws on out-of-range blockIndex", async () => {
		seedProject();
		seedNarrator();
		seedMessage("m0", "n1", "assistant", "only one");
		seedRef("n1", "m0", 0);

		await expect(simulateRollbackToBlock("n1", "m0", 1)).rejects.toThrow("out of range");
		await expect(simulateRollbackToBlock("n1", "m0", -1)).rejects.toThrow("out of range");
	});

	it("throws on nonexistent message", async () => {
		seedProject();
		seedNarrator();

		await expect(simulateRollbackToBlock("n1", "nonexistent", 0)).rejects.toThrow("not found");
	});

	it("preserves messages before the target", async () => {
		seedProject();
		seedNarrator();

		seedMessage("m0", "n1", "user", "first");
		seedMessage("m1", "n1", "assistant", "second");
		seedMessage("m2", "n1", "user", "third");
		seedMessage("m3", "n1", "assistant", "fourth");
		seedRef("n1", "m0", 0);
		seedRef("n1", "m1", 1);
		seedRef("n1", "m2", 2);
		seedRef("n1", "m3", 3);

		await simulateRollbackToBlock("n1", "m1", 0);

		const refs = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.narratorId, "n1"),
			orderBy: (r, { asc }) => [asc(r.seq)],
		});
		expect(refs).toHaveLength(2);
		expect(refs[0].messageId).toBe("m0");
		expect(refs[1].messageId).toBe("m1");

		const m0 = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m0"),
		});
		const m1 = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m1"),
		});
		expect(m0?.contentText).toBe("first");
		expect(m1?.contentText).toBe("second");
	});

	it("shared messages are not deleted when still referenced by another narrator", async () => {
		seedProject();
		seedNarrator("n1");
		seedNarrator("n2");

		seedMessage("m-shared", "n1", "user", "shared");
		seedRef("n1", "m-shared", 0);
		seedRef("n2", "m-shared", 0);

		seedMessage("m-after", "n1", "assistant", "n1 only");
		seedRef("n1", "m-after", 1);

		await simulateRollbackToBlock("n1", "m-shared", 0);

		const sharedMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m-shared"),
		});
		expect(sharedMsg).toBeDefined();

		const sharedRefs = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.messageId, "m-shared"),
		});
		expect(sharedRefs).toHaveLength(2);

		const n1Refs = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.narratorId, "n1"),
		});
		expect(n1Refs).toHaveLength(1);
		expect(n1Refs[0].messageId).toBe("m-shared");

		const afterMsg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m-after"),
		});
		expect(afterMsg).toBeUndefined();
	});

	it("rollback with no subsequent messages only truncates blocks", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "start" },
			{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/x.ts" } },
			{ type: "text", text: "end" },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);

		const result = await simulateRollbackToBlock("n1", "m0", 0);

		expect(result.deletedMessageIds).toHaveLength(0);
		expect(result.truncatedBlocks).toBe(2);

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m0"),
		});
		const parsed = msg?.contentJson as Block[];
		expect(parsed).toHaveLength(1);
		expect(parsed[0].text).toBe("start");
	});
});

// === rollback-preview tests ===

describe("rollback-preview", () => {
	it("returns correct counts for blocks and subsequent messages", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "Hello" },
			{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/a.ts" } },
			{ type: "text", text: "Done" },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);
		seedToolCall("tc1", "n1", "m0", "tu1", "Write", { file_path: "/a.ts" });

		seedMessage("m1", "n1", "user", "next");
		seedRef("n1", "m1", 1);

		const preview = await simulateRollbackPreview("n1", "m0", 0);

		expect(preview.deletedBlockCount).toBe(2);
		expect(preview.deletedMessageCount).toBe(1);
		expect(preview.affectedFilePaths).toContain("/a.ts");
		expect(preview.toolCallCount).toBe(1);
	});

	it("returns empty affected files when no Write/Edit tool calls", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "Hello" },
			{ type: "tool_use", id: "tu1", name: "Read", input: { path: "/a.ts" } },
			{ type: "text", text: "Done" },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);
		seedToolCall("tc1", "n1", "m0", "tu1", "Read", { path: "/a.ts" });

		const preview = await simulateRollbackPreview("n1", "m0", 0);

		expect(preview.affectedFilePaths).toHaveLength(0);
		expect(preview.toolCallCount).toBe(1); // Read tool call is counted but not file-affecting
		expect(preview.deletedBlockCount).toBe(2);
	});

	it("includes tool calls from both truncated blocks and subsequent messages", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "start" },
			{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/a.ts" } },
			{ type: "tool_use", id: "tu2", name: "Edit", input: { file_path: "/b.ts" } },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);
		seedToolCall("tc1", "n1", "m0", "tu1", "Write", { file_path: "/a.ts" });
		seedToolCall("tc2", "n1", "m0", "tu2", "Edit", { file_path: "/b.ts" });

		const blocks2 = [{ type: "tool_use", id: "tu3", name: "Write", input: { file_path: "/c.ts" } }];
		seedMessage("m1", "n1", "assistant", "", blocks2);
		seedRef("n1", "m1", 1);
		seedToolCall("tc3", "n1", "m1", "tu3", "Write", { file_path: "/c.ts" });

		const preview = await simulateRollbackPreview("n1", "m0", 0);

		expect(preview.deletedBlockCount).toBe(2);
		expect(preview.deletedMessageCount).toBe(1);
		expect(preview.toolCallCount).toBe(3); // tu1 + tu2 (truncated) + tu3 (subsequent)
		expect(preview.affectedFilePaths).toContain("/a.ts");
		expect(preview.affectedFilePaths).toContain("/b.ts");
		expect(preview.affectedFilePaths).toContain("/c.ts");
	});

	it("ignores failed tool calls", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "start" },
			{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/a.ts" } },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);
		seedToolCall("tc1", "n1", "m0", "tu1", "Write", { file_path: "/a.ts" }, "fail");

		const preview = await simulateRollbackPreview("n1", "m0", 0);

		expect(preview.affectedFilePaths).toHaveLength(0);
		expect(preview.toolCallCount).toBe(0);
	});

	it("returns zero counts when rolling back to last block with no subsequent messages", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "Hello" },
			{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/a.ts" } },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);
		seedToolCall("tc1", "n1", "m0", "tu1", "Write", { file_path: "/a.ts" });

		const preview = await simulateRollbackPreview("n1", "m0", 1);

		expect(preview.deletedBlockCount).toBe(0);
		expect(preview.deletedMessageCount).toBe(0);
		expect(preview.affectedFilePaths).toHaveLength(0);
		expect(preview.toolCallCount).toBe(0);
	});

	it("deduplicates affected file paths", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "start" },
			{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/a.ts" } },
			{ type: "tool_use", id: "tu2", name: "Edit", input: { file_path: "/a.ts" } },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);
		seedToolCall("tc1", "n1", "m0", "tu1", "Write", { file_path: "/a.ts" });
		seedToolCall("tc2", "n1", "m0", "tu2", "Edit", { file_path: "/a.ts" });

		const preview = await simulateRollbackPreview("n1", "m0", 0);

		expect(preview.affectedFilePaths).toHaveLength(1);
		expect(preview.affectedFilePaths[0]).toBe("/a.ts");
		expect(preview.toolCallCount).toBe(2);
	});

	it("throws on nonexistent narrator/message ref", async () => {
		seedProject();
		seedNarrator();

		await expect(simulateRollbackPreview("n1", "nonexistent", 0)).rejects.toThrow("Ref not found");
	});

	it("throws on out-of-range blockIndex", async () => {
		seedProject();
		seedNarrator();
		seedMessage("m0", "n1", "assistant", "only one");
		seedRef("n1", "m0", 0);

		await expect(simulateRollbackPreview("n1", "m0", 1)).rejects.toThrow("out of range");
	});
});

// === Preview + Rollback consistency ===

describe("preview and rollback consistency", () => {
	it("preview counts match actual rollback results", async () => {
		seedProject();
		seedNarrator();

		const blocks = [
			{ type: "text", text: "start" },
			{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/a.ts" } },
			{ type: "tool_use", id: "tu2", name: "Edit", input: { file_path: "/b.ts" } },
		];
		seedMessage("m0", "n1", "assistant", "", blocks);
		seedRef("n1", "m0", 0);
		seedToolCall("tc1", "n1", "m0", "tu1", "Write", { file_path: "/a.ts" });
		seedToolCall("tc2", "n1", "m0", "tu2", "Edit", { file_path: "/b.ts" });

		seedMessage("m1", "n1", "user", "next");
		seedRef("n1", "m1", 1);
		seedMessage("m2", "n1", "assistant", "reply");
		seedRef("n1", "m2", 2);

		const preview = await simulateRollbackPreview("n1", "m0", 0);
		expect(preview.deletedBlockCount).toBe(2);
		expect(preview.deletedMessageCount).toBe(2);

		const result = await simulateRollbackToBlock("n1", "m0", 0);
		expect(result.truncatedBlocks).toBe(preview.deletedBlockCount);
		expect(result.deletedMessageIds.length).toBe(preview.deletedMessageCount);
	});
});
