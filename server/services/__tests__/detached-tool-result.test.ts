import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { AgentEvent } from "../../lib/agent/types";
import { eventBus } from "../../lib/event-bus";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { clearStreamingSnapshot, getStreamingSnapshot, persistDetachedToolResult, processEvent } =
	await import("../narrator-event-handler");
const { narratorPersistence } = await import("../narrator-persistence");
const { markInterruptedToolCallsForMessage } = await import("../narrator-session");
type EventHandlerContext = import("../narrator-event-handler").EventHandlerContext;
type ResultEvent = Extract<AgentEvent, { type: "tool_result" }>;

const now = "2026-09-20T10:00:00.000Z";
const frames: Array<{ narratorId: string; message: Record<string, unknown> }> = [];
const toolChanges: string[] = [];
const onFrame = (event: { narratorId: string; message: { type: string } }) =>
	frames.push({ narratorId: event.narratorId, message: event.message });
const onToolChange = (event: { narratorId: string }) => toolChanges.push(event.narratorId);
eventBus.on("narrator:message_broadcast", onFrame);
eventBus.on("narrator:tool_changed", onToolChange);

async function seed(narratorId = "owner", parentNarratorId?: string) {
	await db.insert(narrators).values({
		id: narratorId,
		type: parentNarratorId ? "subagent" : "primary",
		parentNarratorId,
		title: "new turn title",
		status: "working",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narratorMessages).values({
		id: `message-${narratorId}`,
		narratorId,
		role: "assistant",
		parentToolUseId: parentNarratorId ? "parent-call" : null,
		contentJson: [{ type: "tool_use", id: "call", name: "Write", input: { file_path: "before" } }],
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${narratorId}`,
		narratorId,
		messageId: `message-${narratorId}`,
		seq: 1,
	});
	await db.insert(narratorToolCalls).values({
		id: `row-${narratorId}`,
		narratorId,
		messageId: `message-${narratorId}`,
		toolUseId: "call",
		toolName: "Write",
		inputJson: { file_path: "before" },
		status: "running",
		executionAttempt: 1,
		executionIdentityVersion: 1,
		executionStartedAt: now,
		createdAt: now,
	});
}

function result(narratorId = "owner", override: Partial<ResultEvent> = {}): ResultEvent {
	return {
		type: "tool_result",
		toolUseId: "call",
		toolName: "Write",
		toolCallBinding: { toolCallId: `row-${narratorId}`, attempt: 1 },
		input: { file_path: "before" },
		output: "actual durable result",
		isError: false,
		permissionStartedAt: Date.parse(now) - 20,
		executionStartedAt: Date.parse(now),
		completedAt: Date.parse(now) + 50,
		durationMs: 50,
		...override,
	};
}
function row(id = "row-owner") {
	return db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, id) });
}
function owner(id = "owner") {
	return db.query.narrators.findFirst({ where: eq(narrators.id, id) });
}
function context(narratorId = "owner"): EventHandlerContext {
	return {
		narratorId,
		broadcastTargetId: narratorId,
		conversationId: "new-turn",
		getPartialMessageId: () => undefined,
		setPartialMessageId: () => {
			throw new Error("late result touched new turn");
		},
		getContextUsagePct: () => undefined,
		getMeterUsage: () => undefined,
		getMeterUnit: () => undefined,
		getTokenUsage: () => undefined,
		setContextUsagePct: () => {
			throw new Error("late result touched context");
		},
		setMeterData: () => {
			throw new Error("late result touched metering");
		},
		setTokenUsage: () => {
			throw new Error("late result touched tokens");
		},
		toolCallIdsMap: new Map([["call", "new-turn-row"]]),
	};
}

beforeEach(() => {
	cleanDb(sqlite);
	frames.length = 0;
	toolChanges.length = 0;
});
afterEach(() => {
	clearStreamingSnapshot("owner");
	clearStreamingSnapshot("child");
});
afterAll(() => {
	eventBus.off("narrator:message_broadcast", onFrame);
	eventBus.off("narrator:tool_changed", onToolChange);
	mock.module("../../db", () => realDb);
	mock.restore();
	sqlite.close();
});

describe("detached tool result durable settlement", () => {
	test("retries a transient database lock without losing the original result", async () => {
		await seed();
		await markInterruptedToolCallsForMessage("owner", "message-owner");
		const original = narratorPersistence.updateToolCallResult.bind(narratorPersistence);
		const update = spyOn(narratorPersistence, "updateToolCallResult")
			.mockImplementation(original)
			.mockImplementationOnce(async () => {
				throw new Error("SQLITE_BUSY: database is locked");
			});
		try {
			await persistDetachedToolResult("owner", result());
			expect(update).toHaveBeenCalledTimes(2);
			expect(await row()).toMatchObject({ status: "success", outputJson: "actual durable result" });
			expect(frames).toHaveLength(1);
		} finally {
			update.mockRestore();
		}
	});

	test("database lock retries are bounded and do not invent a successful result", async () => {
		await seed();
		const update = spyOn(narratorPersistence, "updateToolCallResult").mockImplementation(
			async () => {
				throw new Error("SQLITE_BUSY: database is locked");
			},
		);
		try {
			await expect(persistDetachedToolResult("owner", result())).rejects.toThrow("SQLITE_BUSY");
			expect(update).toHaveBeenCalledTimes(3);
			expect((await row())?.status).toBe("running");
			expect(frames).toEqual([]);
		} finally {
			update.mockRestore();
		}
	});

	test("late success replaces interrupt cleanup with exact output, metadata, redirected input and timing", async () => {
		await seed();
		await markInterruptedToolCallsForMessage("owner", "message-owner");
		expect((await row())?.errorMessage).toBe("Narrator interrupted by user");
		const version = (await owner())?.messageVersion ?? 0;
		await persistDetachedToolResult(
			"owner",
			result("owner", {
				metadata: { applied: true },
				updatedInput: { file_path: "after" },
			}),
		);
		expect(await row()).toMatchObject({
			status: "success",
			errorMessage: null,
			outputJson: { _text: "actual durable result", _metadata: { applied: true } },
			inputJson: { file_path: "after" },
			durationMs: 50,
			permissionStartedAt: new Date(Date.parse(now) - 20).toISOString(),
			executionStartedAt: now,
			completedAt: new Date(Date.parse(now) + 50).toISOString(),
		});
		expect((await owner())?.messageVersion).toBe(version + 1);
		expect(toolChanges).toEqual(["owner"]);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ narratorId: "owner", message: { type: "message_updated" } });
		// Cleanup racing after a real completion cannot turn it back into interrupted.
		await markInterruptedToolCallsForMessage("owner", "message-owner");
		expect((await row())?.status).toBe("success");
	});

	test("late failure retains the actual error verbatim, not the interrupt placeholder", async () => {
		await seed();
		await markInterruptedToolCallsForMessage("owner", "message-owner");
		const output = "remote write failed after partial apply\nEIO: original failure details";
		await persistDetachedToolResult("owner", result("owner", { output, isError: true }));
		expect(await row()).toMatchObject({ status: "fail", outputJson: output, errorMessage: output });
		await markInterruptedToolCallsForMessage("owner", "message-owner");
		expect((await row())?.errorMessage).toBe(output);
	});

	for (const invalid of [
		{ toolCallBinding: undefined },
		{ toolCallBinding: { toolCallId: "missing", attempt: 1 } },
		{ toolCallBinding: { toolCallId: "row-owner", attempt: 2 } },
		{ toolUseId: "other-provider-id" },
	] satisfies Partial<ResultEvent>[]) {
		test(`rejects invalid receipt ${JSON.stringify(invalid)}`, async () => {
			await seed();
			await expect(persistDetachedToolResult("owner", result("owner", invalid))).rejects.toThrow();
			expect((await row())?.status).toBe("running");
			expect((await owner())?.messageVersion).toBe(0);
			expect(toolChanges).toEqual([]);
			expect(frames).toEqual([]);
		});
	}

	test("provider-id collision cannot update another narrator", async () => {
		await seed();
		await seed("other");
		await expect(persistDetachedToolResult("other", result())).rejects.toThrow();
		expect((await row())?.status).toBe("running");
		expect((await row("row-other"))?.status).toBe("running");
		expect(frames).toEqual([]);
	});

	test("stale in-place attempt rejects output and input together", async () => {
		await seed();
		await db
			.update(narratorToolCalls)
			.set({ executionAttempt: 2 })
			.where(eq(narratorToolCalls.id, "row-owner"));
		await expect(
			persistDetachedToolResult(
				"owner",
				result("owner", {
					updatedInput: { file_path: "stale redirect" },
				}),
			),
		).rejects.toThrow();
		expect(await row()).toMatchObject({
			executionAttempt: 2,
			status: "running",
			inputJson: { file_path: "before" },
			outputJson: null,
		});
	});

	test("a newer row sharing the provider id is never overwritten or projected as the old result", async () => {
		await seed();
		const old = await row();
		if (!old) throw new Error("missing fixture");
		await db.insert(narratorToolCalls).values({
			...old,
			id: "new-attempt",
			executionAttempt: 2,
			outputJson: "new output",
			status: "success",
		});
		await persistDetachedToolResult("owner", result());
		expect((await row())?.outputJson).toBe("actual durable result");
		expect(await row("new-attempt")).toMatchObject({
			executionAttempt: 2,
			outputJson: "new output",
			status: "success",
		});
		const message = frames[0]?.message.message as { toolCalls: Array<{ id: string }> };
		expect(message.toolCalls.map((call) => call.id)).toEqual(["new-attempt"]);
	});

	test("COW retires the old receipt; neither old history nor the copy is changed", async () => {
		await seed();
		await db.insert(narrators).values({ id: "fork", createdAt: now, updatedAt: now });
		await db
			.insert(narratorMessageRefs)
			.values({ id: "fork-ref", narratorId: "fork", messageId: "message-owner", seq: 1 });
		const copied = await narratorPersistence.copyOnWriteMessage("owner", "message-owner");
		expect(copied).not.toBe("message-owner");
		const copy = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.messageId, copied),
		});
		if (!copy) throw new Error("missing COW row");
		await expect(persistDetachedToolResult("owner", result())).rejects.toThrow();
		await expect(
			persistDetachedToolResult(
				"owner",
				result("owner", { toolCallBinding: { toolCallId: copy.id, attempt: 1 } }),
			),
		).rejects.toThrow();
		expect((await row())?.status).toBe("running");
		expect((await row(copy.id))?.status).toBe("running");
	});

	test("late plan-tool completion does not touch a new turn's snapshots, title, context or plan hooks", async () => {
		await seed();
		const ctx = context();
		await processEvent({ type: "stream_text", text: "new turn in progress", outputIndex: 0 }, ctx);
		await processEvent(
			{ type: "tool_use_chunk", toolUseId: "call", toolName: "Write", inputCharsTotal: 9 },
			ctx,
		);
		const snapshot = getStreamingSnapshot("owner");
		const chunks = snapshot?.toolChunks.get("call");
		const before = await owner();
		frames.length = 0;
		await persistDetachedToolResult("owner", result("owner", { toolName: "EnterPlanMode" }));
		expect(getStreamingSnapshot("owner")).toBe(snapshot);
		expect(snapshot?.toolChunks.get("call")).toBe(chunks);
		expect(chunks).toBeDefined();
		expect(snapshot?.streamingBlocks[0]).toMatchObject({
			type: "text",
			text: "new turn in progress",
		});
		expect(await owner()).toMatchObject({
			title: before?.title,
			status: before?.status,
			permissionMode: before?.permissionMode,
		});
		expect(ctx.toolCallIdsMap?.get("call")).toBe("new-turn-row");
		expect(frames.map((frame) => frame.message.type)).toEqual(["message_updated"]);
	});

	test("sanitized broken input takes precedence over permission redirects", async () => {
		await seed();
		await persistDetachedToolResult(
			"owner",
			result("owner", {
				brokenInputOverride: { content: "[invalid input omitted]" },
				updatedInput: { file_path: "redirected" },
			}),
		);
		expect((await row())?.inputJson).toEqual({ content: "[invalid input omitted]" });
	});

	test("subagent refreshes its actual parent and itself, not a parent-call id collision", async () => {
		await seed("parent");
		await seed("unrelated");
		await seed("child", "parent");
		await db
			.update(narratorToolCalls)
			.set({ toolUseId: "parent-call" })
			.where(eq(narratorToolCalls.id, "row-unrelated"));
		await persistDetachedToolResult("child", result("child"));
		expect((await owner("child"))?.messageVersion).toBe(1);
		expect((await owner("parent"))?.messageVersion).toBe(1);
		expect((await owner("unrelated"))?.messageVersion).toBe(0);
		expect(frames.map((frame) => frame.narratorId)).toEqual(["parent", "child"]);
		expect(frames[0]?.message.message).toMatchObject({ parentToolUseId: "parent-call" });
		expect(frames[1]?.message.message).toMatchObject({ parentToolUseId: null });
	});
});
