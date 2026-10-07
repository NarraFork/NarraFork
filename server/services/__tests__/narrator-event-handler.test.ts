import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ContextUsageSnapshot } from "@shared/context-usage";
import { createStreamingEditOrigin } from "@shared/streaming-edit-origin";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import {
	apiRequests,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { TokenUsageSnapshot } from "../narrator-event-handler";

// Functional in-memory test db (not empty stubs): Bun's mock.module is global
// and leaks across files, so `{}` stubs would break `db.*` in later real-db suites.
// Do NOT import the real `../../db` first: that opens the runtime database and runs
// drizzle migrations (journal may reference SQL files that are gitignored / absent).
const { db, sqlite } = getTestDb();
const dbStub = {
	db,
	sqlite,
	activeDatabaseBackend: "sqlite" as const,
	startupShutdownState: { canSkipVerification: true },
	markDatabaseCleanShutdown: () => true,
	releaseDatabaseInstanceLockOnly: () => {},
};
// Mock BEFORE any module that transitively imports the runtime DB
// (narrator-ws → services → @server/db opens sqlite and runs drizzle migrations).
mock.module("../../db", () => dbStub);
mock.module("@server/db", () => dbStub);
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };

const broadcastMessages: unknown[] = [];
const broadcastTargets: string[] = [];
mock.module("../../websocket/narrator-ws", () => ({
	broadcastToNarrator: (_narratorId: string, message: unknown) => {
		broadcastTargets.push(_narratorId);
		broadcastMessages.push(message);
	},
	getNarratorConnections: () => [],
}));

const {
	clearStreamingSnapshot,
	CriticalEventPersistenceError,
	getStreamingSnapshot,
	isSameReasoningBlock,
	processEvent,
} = await import("../narrator-event-handler");

type EventHandlerContext = import("../narrator-event-handler").EventHandlerContext;

const PARENT_NARRATOR_ID = "parent-narrator";
const SUBAGENT_NARRATOR_ID = "subagent-narrator";
const PARENT_TOOL_USE_ID = "parent-tool-use";

describe("Write complete input source routing", () => {
	test("child source and descriptor go only to self; parent remains a bounded summary", async () => {
		const ctx = makeSubagentContext();
		await processEvent(
			{
				type: "tool_use_chunk",
				toolUseId: "write-private",
				toolName: "Write",
				inputCharsTotal: 20,
				streamingField: {
					name: "content",
					delta: "private\r\n\ud800",
					startsField: true,
					offset: 0,
				},
			},
			ctx,
		);
		const messages = broadcastMessages as Array<Record<string, unknown>>;
		const parent = messages[broadcastTargets.indexOf(PARENT_NARRATOR_ID)];
		const self = messages[broadcastTargets.indexOf(SUBAGENT_NARRATOR_ID)];
		expect(parent).not.toHaveProperty("inputDocument");
		expect(parent).not.toHaveProperty("streamingField");
		expect(self.inputDocument).toBeDefined();
		const descriptor =
			getStreamingSnapshot(SUBAGENT_NARRATOR_ID)?.toolChunks.get("write-private")?.inputDocument;
		expect(descriptor?.ref.length).toBe(10);
		expect(descriptor?.ref.source?.narratorId).toBe(SUBAGENT_NARRATOR_ID);
		expect(
			JSON.stringify(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("write-private")),
		).not.toContain("private\\r");
		const { toolInputStreamSource } = await import("../tool-input-stream-source");
		if (!descriptor) throw new Error("missing descriptor");
		expect(
			(await toolInputStreamSource.getTextDocumentRange(SUBAGENT_NARRATOR_ID, descriptor.ref.id))
				.text,
		).toBe("private\r\n\ud800");
		await expect(
			toolInputStreamSource.getTextDocumentRange(PARENT_NARRATOR_ID, descriptor.ref.id),
		).rejects.toMatchObject({ statusCode: 404 });
	});

	test("field closure before persistence stays readable without putting complete content in started/snapshot", async () => {
		const ctx = makeMainContext();
		await processEvent(
			{
				type: "tool_use_chunk",
				toolUseId: "write-seal",
				toolName: "Write",
				inputCharsTotal: 7,
				streamingField: { name: "content", delta: "before", offset: 0, startsField: true },
			},
			ctx,
		);
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "write-seal",
				toolName: "Write",
				input: { file_path: "file.txt", content: "beforeafter" },
			},
			ctx,
		);
		const started = (broadcastMessages as Array<Record<string, unknown>>).find(
			(message) => message.type === "tool_started",
		);
		expect(started?.input).toEqual({ file_path: "file.txt" });
		const descriptor =
			getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("write-seal")?.inputDocument;
		expect(descriptor?.ref.complete).toBe(true);
		expect(
			JSON.stringify(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("write-seal")),
		).not.toContain("beforeafter");
		const { toolInputStreamSource } = await import("../tool-input-stream-source");
		if (!descriptor) throw new Error("missing descriptor");
		expect(
			(await toolInputStreamSource.getTextDocumentRange(PARENT_NARRATOR_ID, descriptor.ref.id))
				.text,
		).toBe("beforeafter");
	});

	test("startsField restart explicitly switches epoch instead of appending into an old decoded field", async () => {
		const ctx = makeMainContext();
		const chunk = {
			type: "tool_use_chunk" as const,
			toolUseId: "restarted-field",
			toolName: "Write",
			inputCharsTotal: 5,
			streamingField: { name: "content", delta: "first", offset: 0, startsField: true },
		};
		await processEvent(chunk, ctx);
		const first = getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get(chunk.toolUseId)
			?.inputDocument?.ref;
		await processEvent(
			{ ...chunk, streamingField: { ...chunk.streamingField, delta: "replacement" } },
			ctx,
		);
		const next = getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get(chunk.toolUseId)
			?.inputDocument?.ref;
		expect(next?.epoch).not.toBe(first?.epoch);
		const { toolInputStreamSource } = await import("../tool-input-stream-source");
		if (!next) throw new Error("missing descriptor");
		expect(
			(await toolInputStreamSource.getTextDocumentRange(PARENT_NARRATOR_ID, next.id)).text,
		).toBe("replacement");
	});

	test("discarded provider id retry changes source identity and retires the abandoned source", async () => {
		const ctx = makeMainContext();
		const chunk = {
			type: "tool_use_chunk" as const,
			toolUseId: "same-provider-id",
			toolName: "Write",
			inputCharsTotal: 5,
			streamingField: { name: "content", delta: "first", offset: 0, startsField: true },
		};
		await processEvent(chunk, ctx);
		const first = getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get(chunk.toolUseId)
			?.inputDocument?.ref;
		await processEvent({ type: "tool_use_discarded", toolUseIds: [chunk.toolUseId] }, ctx);
		await processEvent(
			{ ...chunk, streamingField: { ...chunk.streamingField, delta: "retry" } },
			ctx,
		);
		const next = getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get(chunk.toolUseId)
			?.inputDocument?.ref;
		expect(first?.id).not.toBe(next?.id);
		const { toolInputStreamSource } = await import("../tool-input-stream-source");
		if (!first) throw new Error("missing descriptor");
		await expect(
			toolInputStreamSource.getTextDocumentRange(PARENT_NARRATOR_ID, first.id),
		).rejects.toMatchObject({ statusCode: 404 });
	});
});

describe("request attribution", () => {
	test("persists the actual request identity on the first content checkpoint", async () => {
		const id = "request-checkpoint-identity";
		const createdAt = new Date().toISOString();
		await db
			.insert(narrators)
			.values({ id, type: "primary", inheritMode: "fresh", createdAt, updatedAt: createdAt });
		let partialId: string | undefined;
		const ctx: EventHandlerContext = {
			...makeMainContext(),
			narratorId: id,
			broadcastTargetId: id,
			model: "__default__",
			provider: "configured-provider",
			getPartialMessageId: () => partialId,
			setPartialMessageId: (value) => {
				partialId = value;
			},
		};
		try {
			await processEvent(
				{
					type: "api_request_start",
					requestId: "checkpoint-request",
					model: "gpt-resolved",
					provider: "openai",
				},
				ctx,
			);
			expect(ctx).toMatchObject({ model: "gpt-resolved", provider: "openai" });
			await processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id: "reason-checkpoint", text: "Actual reasoning" },
				},
				ctx,
			);
			expect(partialId).toBeDefined();
			const persisted = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, partialId as string),
			});
			expect(persisted).toMatchObject({ model: "gpt-resolved", provider: "openai" });
			expect(persisted?.contentJson).toMatchObject([
				{ type: "reasoning", text: "Actual reasoning" },
			]);
		} finally {
			clearStreamingSnapshot(id);
			await cleanupFileContextNarrator(id);
		}
	});
	test("publishes actual request identity to live clients and author reconnect snapshots", async () => {
		for (const child of [false, true]) {
			const ctx = child ? makeSubagentContext() : makeMainContext();
			ctx.model = "configured-default";
			ctx.provider = "configured-provider";
			await processEvent(
				{
					type: "api_request_start",
					requestId: `identity-${child}`,
					model: child ? "gpt-child" : "gpt-actual",
					provider: "actual-provider",
				},
				ctx,
			);
			expect(getStreamingSnapshot(ctx.narratorId)).toMatchObject({
				model: child ? "gpt-child" : "gpt-actual",
				provider: "actual-provider",
			});
			const identities = (broadcastMessages as Array<Record<string, unknown>>).filter(
				(message) => message.type === "streaming_identity",
			);
			expect(identities.at(-1)).toMatchObject({
				model: child ? "gpt-child" : "gpt-actual",
				provider: "actual-provider",
			});
			if (child) {
				expect(identities.at(-2)).toMatchObject({ parentToolUseId: PARENT_TOOL_USE_ID });
				expect(identities.at(-1)).not.toHaveProperty("parentToolUseId");
				expect(broadcastTargets.at(-1)).toBe(SUBAGENT_NARRATOR_ID);
				expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.model).toBe("gpt-actual");
			}
		}
	});
	test("subagent request keeps its event owner rather than the later pass owner", async () => {
		const ctx = makeSubagentContext();
		ctx.userId = "later-user";
		await processEvent(
			{
				type: "api_request_start",
				requestId: "request-alice",
				provider: "test",
				model: "test",
				userId: "alice",
			},
			ctx,
		);
		ctx.userId = "bob";
		expect(ctx.apiRequestsMap?.get("request-alice")?.userId).toBe("alice");
		await processEvent(
			{
				type: "api_request_start",
				requestId: "request-unknown",
				provider: "test",
				model: "test",
			},
			ctx,
		);
		expect(ctx.apiRequestsMap?.get("request-unknown")?.userId).toBeNull();
	});
});

function makeSubagentContext(): EventHandlerContext {
	return {
		narratorId: SUBAGENT_NARRATOR_ID,
		broadcastTargetId: PARENT_NARRATOR_ID,
		conversationId: "subagent-conversation",
		parentToolUseId: PARENT_TOOL_USE_ID,
		getContextUsagePct: () => undefined,
		getMeterUsage: () => undefined,
		getMeterUnit: () => undefined,
		getPartialMessageId: () => undefined,
		getTokenUsage: () => undefined,
		setPartialMessageId: () => {},
		setContextUsagePct: () => {},
		setMeterData: () => {},
		setTokenUsage: () => {},
		toolCallIdsMap: new Map(),
	};
}

function makeMainContext(sseEmitter?: EventEmitter): EventHandlerContext {
	return {
		...makeSubagentContext(),
		narratorId: PARENT_NARRATOR_ID,
		broadcastTargetId: PARENT_NARRATOR_ID,
		conversationId: "main-conversation",
		parentToolUseId: undefined,
		sseEmitter,
	};
}

afterEach(() => {
	clearStreamingSnapshot(PARENT_NARRATOR_ID);
	clearStreamingSnapshot(SUBAGENT_NARRATOR_ID);
	broadcastMessages.length = 0;
	broadcastTargets.length = 0;
});

afterAll(() => {
	// Leave the in-memory stub in place. Bun's mock.module is process-global and
	// mock.restore() does not undo module mocks; re-pointing at a lazily imported
	// real `../../db` would open the runtime database mid-suite.
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

async function cleanupFileContextNarrator(id: string) {
	// These tests use the functional in-memory DB, whose historical FK edges
	// intentionally mirror migrations beyond the minimal narrator fixture.
	sqlite.run("PRAGMA foreign_keys = OFF");
	try {
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
		await db.delete(narrators).where(eq(narrators.id, id));
	} finally {
		sqlite.run("PRAGMA foreign_keys = ON");
	}
}

describe("request occupancy is independent from billing and historical usage", () => {
	test("real usage explicitly clears sticky estimate state in memory, WS and SSE", async () => {
		let usage: TokenUsageSnapshot = { promptTokens: 42, inputTokens: 42, isEstimated: true };
		const sse = new EventEmitter();
		const sseEvents: Array<{ data: Record<string, unknown> }> = [];
		sse.on("event", (event) => sseEvents.push(event));
		const ctx = {
			...makeMainContext(sse),
			getTokenUsage: () => usage,
			setTokenUsage: (next: TokenUsageSnapshot | undefined) => {
				usage = next ?? {};
			},
		};
		await processEvent(
			{
				type: "context_usage",
				source: "upstream",
				percentage: 92.6,
				promptTokens: 926000,
				contextWindow: 1_000_000,
				isEstimated: true,
			},
			ctx,
		);
		expect(usage.promptTokens).toBe(42);
		await processEvent(
			{
				type: "context_usage",
				source: "usage",
				percentage: 51.08,
				promptTokens: 510800,
				inputTokens: 510800,
				contextWindow: 1_000_000,
				isEstimated: false,
			},
			ctx,
		);
		expect(usage).toMatchObject({ promptTokens: 510800, inputTokens: 510800, isEstimated: false });
		expect((broadcastMessages.at(-1) as { isEstimated?: boolean }).isEstimated).toBe(false);
		expect(sseEvents.at(-1)?.data.isEstimated).toBe(false);
	});
	test("request end stores one snapshot in narrator, API row and assistant turn metadata", async () => {
		const id = "occupancy-history-narrator";
		const now = "2026-10-05T00:00:00Z";
		await db.insert(narrators).values({ id, createdAt: now, updatedAt: now });
		let usage: TokenUsageSnapshot | undefined;
		let pct: number | undefined;
		const ctx: EventHandlerContext = {
			...makeMainContext(),
			narratorId: id,
			broadcastTargetId: id,
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			getTokenUsage: () => usage,
			setTokenUsage: (next) => {
				usage = next;
			},
			getContextUsagePct: () => pct,
			setContextUsagePct: (next) => {
				pct = next;
			},
		};
		const snapshot: ContextUsageSnapshot = {
			requestId: "logical-occupancy-history",
			startedAt: now,
			source: "upstream",
			percentage: 92.6,
			contextWindow: 1_000_000,
			occupiedTokens: 926000,
			inputCharacters: { totalChars: 1_000_000, systemChars: 0, toolsChars: 0 },
			composition: null,
		};
		try {
			await processEvent(
				{
					type: "api_request_start",
					requestId: snapshot.requestId,
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
				},
				ctx,
			);
			await processEvent(
				{
					type: "context_usage",
					source: "upstream",
					percentage: 92.6,
					promptTokens: 926000,
					contextWindow: 1_000_000,
					isEstimated: true,
					snapshot,
				},
				ctx,
			);
			await processEvent(
				{
					type: "api_request_end",
					requestId: snapshot.requestId,
					contextPercent: 92.6,
					contextSnapshot: snapshot,
					usage: { promptTokens: 510800, inputTokens: 510800, completionTokens: 12 },
				},
				ctx,
			);
			expect(usage).toMatchObject({
				promptTokens: 510800,
				inputTokens: 510800,
				isEstimated: false,
				contextSnapshot: snapshot,
			});
			expect(
				db
					.select({ snapshot: narrators.contextUsageSnapshotJson })
					.from(narrators)
					.where(eq(narrators.id, id))
					.get()?.snapshot,
			).toEqual(snapshot);
			const request = db.select().from(apiRequests).where(eq(apiRequests.narratorId, id)).get();
			expect(request?.inputTokens).toBe(510800);
			expect(request?.contextUsageSnapshotJson).toEqual(snapshot);
			expect(broadcastMessages.at(-1)).toMatchObject({
				type: "context_usage",
				promptTokens: 926000,
				snapshot,
			});
			await processEvent({ type: "assistant_message", text: "answer", toolUses: [] }, ctx);
			const message = db
				.select({ usage: narratorMessages.turnUsageJson })
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, id))
				.get();
			expect(message?.usage).toMatchObject({
				input_tokens: 510800,
				prompt_tokens: 510800,
				context_snapshot: snapshot,
			});
		} finally {
			await db.delete(apiRequests).where(eq(apiRequests.narratorId, id));
			await cleanupFileContextNarrator(id);
		}
	});
});

describe("streaming snapshot author isolation", () => {
	for (const event of [
		{ type: "stream_reset" as const },
		{ type: "error" as const, message: "Aborted" },
		{ type: "attempt_discarded" as const, requestId: "discard-child" },
		{ type: "assistant_message" as const, text: "child finished", toolUses: [] },
	]) {
		test(`child ${event.type} preserves the parent's text/reasoning prefix and sibling tools`, async () => {
			const child = makeSubagentContext();
			const parent = {
				...makeSubagentContext(),
				narratorId: PARENT_NARRATOR_ID,
				parentToolUseId: undefined,
			};
			const now = new Date().toISOString();
			await db.insert(narrators).values({
				id: child.narratorId,
				type: "subagent",
				inheritMode: "fresh",
				createdAt: now,
				updatedAt: now,
			});
			try {
				for (const type of ["stream_text", "stream_reasoning"] as const) {
					await processEvent(
						{ type, text: "PREFIX", blockId: type, blockRevision: 1, blockTextOffset: 0 },
						parent,
					);
				}
				await processEvent(
					{
						type: "stream_text",
						text: "CHILD",
						blockId: "child-text",
						blockRevision: 1,
						blockTextOffset: 0,
					},
					child,
				);
				for (const [toolUseId, ctx] of [
					["parent-tool", parent],
					["child-tool", child],
					["sibling-tool", { ...child, narratorId: "sibling", parentToolUseId: "sibling-agent" }],
				] as const) {
					await processEvent(
						{ type: "tool_use_chunk", toolUseId, toolName: "Write", inputCharsTotal: 0 },
						ctx,
					);
				}
				await processEvent(event, child);
				expect(getStreamingSnapshot(child.narratorId)).toBeUndefined();
				for (const type of ["stream_text", "stream_reasoning"] as const) {
					await processEvent(
						{ type, text: "+TAIL", blockId: type, blockRevision: 2, blockTextOffset: 6 },
						parent,
					);
				}
				// This is the source consumed by a fresh messages subscription after switching back.
				const snapshot = getStreamingSnapshot(PARENT_NARRATOR_ID);
				expect(snapshot?.streamingBlocks).toEqual([
					expect.objectContaining({ type: "text", text: "PREFIX+TAIL", textOffset: 0 }),
					expect.objectContaining({ type: "reasoning", text: "PREFIX+TAIL", textOffset: 0 }),
				]);
				expect([...(snapshot?.toolChunks.keys() ?? [])]).toEqual(["parent-tool", "sibling-tool"]);
				// The inverse direction is scoped too: the parent finishing must not erase
				// a child tool that is still streaming in the parent's activity summary.
				await processEvent({ type: "stream_reset" }, parent);
				expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.streamingBlocks).toEqual([]);
				expect([...(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.keys() ?? [])]).toEqual([
					"sibling-tool",
				]);
			} finally {
				await cleanupFileContextNarrator(child.narratorId);
			}
		});
	}
});

describe("queue snapshot clear", () => {
	for (const isSubagent of [false, true]) {
		test(`queue updates only reach their owner (subagent=${isSubagent})`, async () => {
			const ctx = makeSubagentContext();
			if (!isSubagent) {
				ctx.narratorId = PARENT_NARRATOR_ID;
				ctx.parentToolUseId = undefined;
			}
			for (const event of [
				{ type: "queue_status" as const, position: 2, queueDepth: 3 },
				{ type: "queue_status" as const, position: 0 },
				{ type: "queue_status" as const },
			]) {
				await processEvent(event, ctx);
			}
			expect(broadcastTargets).toEqual(Array(3).fill(ctx.narratorId));
			expect(broadcastMessages).toEqual([
				expect.objectContaining({ type: "queue_status", narratorId: ctx.narratorId, position: 2 }),
				expect.objectContaining({ type: "queue_status", narratorId: ctx.narratorId, position: 0 }),
				expect.objectContaining({ type: "queue_status", narratorId: ctx.narratorId }),
			]);
			if (isSubagent) expect(getStreamingSnapshot(PARENT_NARRATOR_ID)).toBeUndefined();
		});
	}
	for (const clear of [
		{ type: "queue_status" as const },
		{ type: "queue_status" as const, position: 0, queueDepth: 0 },
	]) {
		test(`clears queue snapshot before text: ${JSON.stringify(clear)}`, async () => {
			const ctx = makeSubagentContext();
			await processEvent(
				{ type: "queue_status", position: 1, queueDepth: 2, queueMessage: "waiting" },
				ctx,
			);
			await processEvent(clear, ctx);
			const snapshot = getStreamingSnapshot(ctx.narratorId);
			expect(snapshot?.queuePosition).toBeUndefined();
			expect(snapshot?.queueDepth).toBeUndefined();
			expect(snapshot?.queueMessage).toBeUndefined();
			expect(snapshot?.streamingBlocks).toEqual([]);
			expect(broadcastMessages.at(-1)).toMatchObject({ type: "queue_status" });
			clearStreamingSnapshot(ctx.narratorId);
		});
	}
});

describe("assistant file-reference provenance", () => {
	test("a subagent reconnect snapshot belongs to its own text context", async () => {
		const ctx = {
			...makeSubagentContext(),
			getFileReferenceContext: () => ({ deviceId: "ChildDevice", cwd: "/child" }),
		};
		await processEvent({ type: "stream_text", text: "src/a.ts", outputIndex: 0 }, ctx);
		expect(getStreamingSnapshot(ctx.narratorId)?.streamingBlocks[0]).toMatchObject({
			type: "text",
			fileReferenceContext: { deviceId: "ChildDevice", cwd: "/child" },
		});
		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.streamingBlocks ?? []).toHaveLength(0);
		await processEvent({ type: "stream_reset" }, ctx);
		expect(getStreamingSnapshot(ctx.narratorId)).toBeUndefined();
	});

	test("first delta provenance survives device switches, partial persistence and reload", async () => {
		const id = "file-context-main";
		const createdAt = new Date().toISOString();
		await db
			.insert(narrators)
			.values({ id, type: "primary", inheritMode: "fresh", createdAt, updatedAt: createdAt });
		let partialId: string | undefined;
		let source = { deviceId: "DeviceA", cwd: "/repo" };
		let reads = 0;
		const ctx: EventHandlerContext = {
			...makeSubagentContext(),
			narratorId: id,
			broadcastTargetId: id,
			parentToolUseId: undefined,
			getPartialMessageId: () => partialId,
			setPartialMessageId: (value) => {
				partialId = value;
			},
			getFileReferenceContext: () => {
				reads++;
				return source;
			},
		};
		try {
			await processEvent({ type: "stream_text", text: "[file]", outputIndex: 0 }, ctx);
			source = { deviceId: "DeviceB", cwd: "/other" };
			await processEvent({ type: "stream_text", text: "(src/a.ts#L2)", outputIndex: 0 }, ctx);
			expect(reads).toBe(1);
			expect(getStreamingSnapshot(id)?.streamingBlocks[0]).toMatchObject({
				fileReferenceContext: { deviceId: "DeviceA", cwd: "/repo" },
			});
			const deltas = broadcastMessages.filter(
				(m) => (m as { type?: string }).type === "stream_event",
			) as Array<{ event: Record<string, unknown> }>;
			expect(deltas).toHaveLength(2);
			for (const frame of deltas)
				expect(frame.event.fileReferenceContext).toEqual({ deviceId: "DeviceA", cwd: "/repo" });
			await processEvent(
				{
					type: "block_complete",
					block: { type: "text", text: "[file](src/a.ts#L2)", outputIndex: 0 },
				},
				ctx,
			);
			const savedId = partialId;
			await processEvent({ type: "stream_text", text: "next", outputIndex: 0 }, ctx);
			await processEvent(
				{ type: "block_complete", block: { type: "text", text: "next", outputIndex: 0 } },
				ctx,
			);
			await processEvent(
				{ type: "assistant_message", text: "[file](src/a.ts#L2)next", toolUses: [] },
				ctx,
			);
			const reloaded = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, savedId as string),
			});
			expect(reloaded?.contentJson).toMatchObject([
				{ fileReferenceContext: { deviceId: "DeviceA", cwd: "/repo" } },
				{ fileReferenceContext: { deviceId: "DeviceB", cwd: "/other" } },
			]);
			const final = broadcastMessages.findLast(
				(m) => (m as { type?: string }).type === "message",
			) as { message: { contentJson: unknown } };
			expect(final.message.contentJson).toEqual(reloaded?.contentJson);
		} finally {
			clearStreamingSnapshot(id);
			await cleanupFileContextNarrator(id);
		}
	});

	test("a combined provider text block never borrows its last device for earlier text", async () => {
		const id = "file-context-mixed";
		const createdAt = new Date().toISOString();
		await db.insert(narrators).values({ id, createdAt, updatedAt: createdAt });
		let partialId: string | undefined;
		let deviceId = "A";
		const ctx: EventHandlerContext = {
			...makeSubagentContext(),
			narratorId: id,
			broadcastTargetId: id,
			parentToolUseId: undefined,
			getPartialMessageId: () => partialId,
			setPartialMessageId: (value) => {
				partialId = value;
			},
			getFileReferenceContext: () => ({ deviceId, cwd: "/repo" }),
		};
		try {
			await processEvent({ type: "stream_text", text: "first ", outputIndex: 0 }, ctx);
			deviceId = "B";
			await processEvent({ type: "stream_text", text: "second", outputIndex: 1 }, ctx);
			await processEvent(
				{ type: "block_complete", block: { type: "text", text: "first second", outputIndex: 1 } },
				ctx,
			);
			const message = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, partialId as string),
			});
			expect((message?.contentJson as unknown[])?.[0]).toMatchObject({
				type: "text",
				text: "first second",
			});
			expect((message?.contentJson as unknown[])?.[0]).not.toHaveProperty("fileReferenceContext");
		} finally {
			clearStreamingSnapshot(id);
			await cleanupFileContextNarrator(id);
		}
	});

	test("a completed block with no start event does not guess the current location", async () => {
		const id = "file-context-unknown";
		const createdAt = new Date().toISOString();
		await db
			.insert(narrators)
			.values({ id, type: "primary", inheritMode: "fresh", createdAt, updatedAt: createdAt });
		let partialId: string | undefined;
		const ctx: EventHandlerContext = {
			...makeSubagentContext(),
			narratorId: id,
			broadcastTargetId: id,
			parentToolUseId: undefined,
			getPartialMessageId: () => partialId,
			setPartialMessageId: (value) => {
				partialId = value;
			},
			getFileReferenceContext: () => {
				throw new Error("must not read current device at completion");
			},
		};
		try {
			await processEvent(
				{ type: "block_complete", block: { type: "text", text: "src/a.ts" } },
				ctx,
			);
			const message = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, partialId as string),
			});
			expect((message?.contentJson as unknown[])?.[0]).not.toHaveProperty("fileReferenceContext");
		} finally {
			await cleanupFileContextNarrator(id);
		}
	});
});

describe("narrator event handler streaming snapshot", () => {
	test("trusted Edit origin travels in tool_started and reconnect snapshot, never model metadata", async () => {
		const ctx = makeMainContext();
		const input = {
			file_path: "a.ts",
			old_string: "h".repeat(20_000),
			new_string: "new",
			_streamingMetadata: { startLine: 999 },
		};
		const streamingEditOrigin = createStreamingEditOrigin("edit-origin", input, {
			startLine: 42,
			matchStatus: "matched",
		});
		if (!streamingEditOrigin) throw new Error("missing fixture origin");
		await processEvent(
			{ type: "tool_call", toolUseId: "edit-origin", toolName: "Edit", input, streamingEditOrigin },
			ctx,
		);
		const frame = broadcastMessages.find(
			(value) => (value as Record<string, unknown>).type === "tool_started",
		) as Record<string, unknown>;
		expect(frame.streamingEditOrigin).toEqual(streamingEditOrigin);
		expect(
			getStreamingSnapshot(ctx.narratorId)?.toolChunks.get("edit-origin")?.streamingEditOrigin,
		).toEqual(streamingEditOrigin);
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "model-only",
				toolName: "Edit",
				input: { ...input, streamingEditOrigin },
			},
			ctx,
		);
		expect(
			getStreamingSnapshot(ctx.narratorId)?.toolChunks.get("model-only")?.streamingEditOrigin,
		).toBeUndefined();
		clearStreamingSnapshot(ctx.narratorId);
	});
	test("子代理直接 tool_call 向父级发送精简路由身份，self 保留完整 input", async () => {
		const ctx = makeSubagentContext();
		ctx.toolCallIdsMap?.set("direct-tool-call", "tc-direct");
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "direct-tool-call",
				toolName: "Bash",
				input: { command: "pwd" },
			},
			ctx,
		);

		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("direct-tool-call")).toEqual(
			expect.objectContaining({
				toolCallId: "tc-direct",
				parentToolUseId: PARENT_TOOL_USE_ID,
				subagentNarratorId: "subagent-narrator",
				started: true,
			}),
		);
		expect(
			getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("direct-tool-call"),
		).not.toHaveProperty("input");
		const parent = broadcastMessages.find(
			(message): message is Record<string, unknown> =>
				!!message &&
				typeof message === "object" &&
				(message as Record<string, unknown>).type === "tool_started" &&
				(message as Record<string, unknown>).narratorId === PARENT_NARRATOR_ID,
		);
		const self = broadcastMessages.find(
			(message): message is Record<string, unknown> =>
				!!message &&
				typeof message === "object" &&
				(message as Record<string, unknown>).type === "tool_started" &&
				(message as Record<string, unknown>).narratorId === "subagent-narrator",
		);
		expect(parent).toMatchObject({
			toolCallId: "tc-direct",
			parentToolUseId: PARENT_TOOL_USE_ID,
			subagentNarratorId: "subagent-narrator",
		});
		expect(parent).not.toHaveProperty("input");
		expect(self?.input).toEqual({ command: "pwd" });
	});

	test("完整 assistant fallback 会回填稳定 tool-call row id", async () => {
		const createdAt = new Date().toISOString();
		await db.insert(narrators).values([
			{
				id: "fallback-parent",
				type: "primary",
				inheritMode: "fresh",
				createdAt,
				updatedAt: createdAt,
			},
			{
				id: "fallback-subagent",
				type: "subagent",
				subagentType: "general",
				variant: "subagent:general",
				parentNarratorId: "fallback-parent",
				inheritMode: "fresh",
				createdAt,
				updatedAt: createdAt,
			},
		]);
		const ctx: EventHandlerContext = {
			...makeSubagentContext(),
			narratorId: "fallback-subagent",
			broadcastTargetId: "fallback-parent",
			parentToolUseId: "fallback-parent-tool",
			toolCallIdsMap: new Map(),
		};
		await processEvent(
			{
				type: "assistant_message",
				text: "",
				toolUses: [
					{
						toolUseId: "fallback-tool",
						name: "Read",
						input: { file_path: "/tmp/example.ts" },
					},
				],
			},
			ctx,
		);
		const persistedId = ctx.toolCallIdsMap?.get("fallback-tool");
		expect(persistedId).toBeString();

		broadcastMessages.length = 0;
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "fallback-tool",
				toolName: "Read",
				input: { file_path: "/tmp/example.ts" },
			},
			ctx,
		);
		const parentStarted = broadcastMessages.find(
			(message): message is Record<string, unknown> =>
				!!message &&
				typeof message === "object" &&
				(message as Record<string, unknown>).type === "tool_started" &&
				(message as Record<string, unknown>).narratorId === "fallback-parent",
		);
		expect(parentStarted?.toolCallId).toBe(persistedId);
		clearStreamingSnapshot("fallback-parent");
	});

	test("子代理 tool_use_chunk 后的 tool_call 不丢失 parentToolUseId", async () => {
		const ctx = makeSubagentContext();

		await processEvent(
			{
				type: "tool_use_chunk",
				toolUseId: "streamed-tool-call",
				toolName: "Read",
				inputCharsTotal: 24,
				extractedFilePath: "/tmp/example.ts",
				extractedFields: { command: "sensitive streamed input" },
				metadata: { secret: true },
				streamingField: { name: "command", delta: "sensitive streamed input" },
			},
			ctx,
		);
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "streamed-tool-call",
				toolName: "Read",
				input: { file_path: "/tmp/example.ts" },
			},
			ctx,
		);

		const snapshotChunk =
			getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("streamed-tool-call");
		expect(snapshotChunk).toEqual(
			expect.objectContaining({
				toolCallId: null,
				parentToolUseId: PARENT_TOOL_USE_ID,
				subagentNarratorId: "subagent-narrator",
				inputCharsTotal: 24,
				extractedFilePath: "/tmp/example.ts",
				started: true,
			}),
		);
		expect(snapshotChunk).not.toHaveProperty("extractedFields");
		expect(snapshotChunk).not.toHaveProperty("metadata");
		const chunks = broadcastMessages.filter(
			(message): message is Record<string, unknown> =>
				!!message &&
				typeof message === "object" &&
				(message as Record<string, unknown>).type === "tool_use_chunk",
		);
		const parentChunk = chunks.find((message) => message.narratorId === PARENT_NARRATOR_ID);
		const selfChunk = chunks.find((message) => message.narratorId === "subagent-narrator");
		expect(parentChunk).not.toHaveProperty("extractedFields");
		expect(parentChunk).not.toHaveProperty("metadata");
		expect(parentChunk).not.toHaveProperty("streamingField");
		expect(selfChunk?.streamingField).toEqual({
			name: "command",
			delta: "sensitive streamed input",
		});
	});

	test("子代理 tool_completed 向父级隐藏 output/metadata，self 保持完整", async () => {
		const ctx = makeSubagentContext();
		ctx.toolCallIdsMap?.set("completed-tool", "tc-completed");
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "completed-tool",
				toolName: "Read",
				output: "sensitive output",
				isError: false,
				metadata: { secret: true },
			},
			ctx,
		);
		const completed = broadcastMessages.filter(
			(message): message is Record<string, unknown> =>
				!!message &&
				typeof message === "object" &&
				(message as Record<string, unknown>).type === "tool_completed",
		);
		const parent = completed.find((message) => message.narratorId === PARENT_NARRATOR_ID);
		const self = completed.find((message) => message.narratorId === "subagent-narrator");
		expect(parent).toMatchObject({
			toolCallId: "tc-completed",
			parentToolUseId: PARENT_TOOL_USE_ID,
			subagentNarratorId: "subagent-narrator",
			status: "success",
		});
		expect(parent).not.toHaveProperty("output");
		expect(parent).not.toHaveProperty("metadata");
		expect(self?.output).toBe("sensitive output");
		expect(self?.metadata).toEqual({ secret: true });
	});
});

describe("工具展示事件与执行快照解耦", () => {
	test("tool_call/tool_result 不再触发旧快照回调", async () => {
		const ctx = makeSubagentContext();
		const before = mock(() => {
			throw new Error("UI event must not capture before");
		});
		const after = mock(() => {
			throw new Error("UI event must not capture after");
		});
		const hooks = { onSnapshotBefore: before, onSnapshotAfter: after };
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "snapshot-free",
				toolName: "Write",
				input: { file_path: "/tmp/example.ts" },
			},
			ctx,
			hooks,
		);
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "snapshot-free",
				toolName: "Write",
				output: "ok",
				isError: false,
			},
			ctx,
			hooks,
		);
		expect(before).not.toHaveBeenCalled();
		expect(after).not.toHaveBeenCalled();
		expect(broadcastMessages).toContainEqual(
			expect.objectContaining({ type: "tool_started", toolUseId: "snapshot-free" }),
		);
		expect(broadcastMessages).toContainEqual(
			expect.objectContaining({ type: "tool_completed", toolUseId: "snapshot-free" }),
		);
	});
});

describe("完成工具输入传递", () => {
	test("onGitTrack 收到 tool_result 携带的实际完成输入", async () => {
		const ctx = makeSubagentContext();
		const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
		const hooks = {
			onGitTrack: (toolName: string, toolUseId: string, input?: Record<string, unknown>) => {
				calls.push([toolName, toolUseId, input]);
			},
		};

		await processEvent(
			{
				type: "tool_result",
				toolUseId: "bash-completed",
				toolName: "Bash",
				input: { command: "git status" },
				output: "",
				isError: false,
			},
			ctx,
			hooks,
		);

		expect(calls).toEqual([["Bash", "bash-completed", { command: "git status" }]]);
	});

	test("retryable_error 只移除无内容的生图进度并重建其余快照", async () => {
		const sseEmitter = new EventEmitter();
		const sseEvents: unknown[] = [];
		sseEmitter.on("event", (event) => sseEvents.push(event));
		const ctx = makeMainContext(sseEmitter);

		await processEvent({ type: "stream_text", text: "保留的 partial 文本", outputIndex: 0 }, ctx);
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "tool-stays",
				toolName: "Read",
				input: { file_path: "/tmp/keep.txt" },
			},
			ctx,
		);
		await processEvent(
			{ type: "image_generation", id: "image-preparing", status: "in_progress", outputIndex: 1 },
			ctx,
		);
		await processEvent(
			{ type: "image_generation", id: "image-spinning", status: "generating", outputIndex: 2 },
			ctx,
		);
		await processEvent(
			{
				type: "image_generation",
				id: "image-partial",
				status: "generating",
				partialSavedPath: "/tmp/image-partial.png",
				outputIndex: 3,
			},
			ctx,
		);
		await processEvent(
			{
				type: "image_generation",
				id: "image-complete",
				status: "completed",
				savedPath: "/tmp/image-complete.png",
				outputIndex: 4,
			},
			ctx,
		);

		broadcastMessages.length = 0;
		sseEvents.length = 0;
		await processEvent({ type: "retryable_error", message: "temporary gateway failure" }, ctx);

		const snapshot = getStreamingSnapshot(PARENT_NARRATOR_ID);
		expect(snapshot?.streamingBlocks).toEqual([
			{
				type: "text",
				text: "保留的 partial 文本",
				outputIndex: 0,
				id: expect.any(String),
				fileReferenceContext: null,
			},
			{
				type: "image_generation",
				id: "image-partial",
				status: "completed",
				revisedPrompt: undefined,
				partialSavedPath: "/tmp/image-partial.png",
				outputIndex: 3,
			},
			{
				type: "image_generation",
				id: "image-complete",
				status: "completed",
				revisedPrompt: undefined,
				savedPath: "/tmp/image-complete.png",
				outputIndex: 4,
			},
		]);
		expect(snapshot?.toolChunks.has("tool-stays")).toBe(true);
		expect(
			snapshot?.streamingBlocks.some(
				(block) =>
					block.type === "image_generation" &&
					(block.status === "in_progress" || block.status === "generating"),
			),
		).toBe(false);

		const reset = broadcastMessages.find(
			(message) => (message as { type?: string }).type === "streaming_reset",
		) as Record<string, unknown> | undefined;
		const rebuilt = broadcastMessages.find(
			(message) => (message as { type?: string }).type === "streaming_snapshot",
		) as Record<string, unknown> | undefined;
		expect(reset).toMatchObject({ type: "streaming_reset", narratorId: PARENT_NARRATOR_ID });
		expect(rebuilt).toMatchObject({
			type: "streaming_snapshot",
			narratorId: PARENT_NARRATOR_ID,
			streamingBlocks: snapshot?.streamingBlocks,
		});
		expect((rebuilt?.toolChunks as unknown[])?.length).toBe(1);
		expect(sseEvents).toEqual([
			{ type: "streaming_reset" },
			{
				type: "streaming_snapshot",
				data: {
					streamingBlocks: snapshot?.streamingBlocks,
					toolChunks: [...(snapshot?.toolChunks.values() ?? [])],
				},
			},
		]);
	});

	test("没有未完成生图时 retryable_error 不重置 partial 文本、完成图片或工具", async () => {
		const sseEmitter = new EventEmitter();
		const sseEvents: unknown[] = [];
		sseEmitter.on("event", (event) => sseEvents.push(event));
		const ctx = makeMainContext(sseEmitter);
		await processEvent({ type: "stream_text", text: "still here", outputIndex: 0 }, ctx);
		await processEvent(
			{
				type: "image_generation",
				id: "already-done",
				status: "completed",
				savedPath: "/tmp/already-done.png",
				outputIndex: 1,
			},
			ctx,
		);
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "still-running",
				toolName: "Bash",
				input: { command: "sleep 1" },
			},
			ctx,
		);
		const before = getStreamingSnapshot(PARENT_NARRATOR_ID);
		const blocksBefore = before?.streamingBlocks.map((block) => ({ ...block }));

		broadcastMessages.length = 0;
		sseEvents.length = 0;
		await processEvent({ type: "retryable_error", message: "retry without image" }, ctx);

		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.streamingBlocks).toEqual(blocksBefore);
		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.has("still-running")).toBe(true);
		expect(
			broadcastMessages.some((message) =>
				["streaming_reset", "streaming_snapshot"].includes(
					(message as { type?: string }).type ?? "",
				),
			),
		).toBe(false);
		expect(sseEvents).toEqual([]);
	});

	test("子代理 retry 只清自身生图快照，父快照保持不变", async () => {
		const parentCtx = makeMainContext();
		await processEvent(
			{ type: "stream_text", text: "parent live text", outputIndex: 0 },
			parentCtx,
		);

		const childCtx = makeSubagentContext();
		await processEvent(
			{ type: "image_generation", id: "child-ghost", status: "in_progress", outputIndex: 0 },
			childCtx,
		);
		await processEvent(
			{
				type: "image_generation",
				id: "child-partial",
				status: "generating",
				partialSavedPath: "/tmp/child-partial.png",
				outputIndex: 1,
			},
			childCtx,
		);

		broadcastMessages.length = 0;
		await processEvent({ type: "retryable_error", message: "child retry" }, childCtx);

		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.streamingBlocks).toEqual([
			{
				type: "text",
				text: "parent live text",
				outputIndex: 0,
				id: expect.any(String),
				fileReferenceContext: null,
			},
		]);
		expect(getStreamingSnapshot(SUBAGENT_NARRATOR_ID)?.streamingBlocks).toEqual([
			{
				type: "image_generation",
				id: "child-partial",
				status: "completed",
				revisedPrompt: undefined,
				partialSavedPath: "/tmp/child-partial.png",
				outputIndex: 1,
			},
		]);

		const resets = broadcastMessages.filter(
			(message) => (message as { type?: string }).type === "streaming_reset",
		) as Array<Record<string, unknown>>;
		expect(resets).toContainEqual({
			type: "streaming_reset",
			narratorId: PARENT_NARRATOR_ID,
			parentToolUseId: PARENT_TOOL_USE_ID,
		});
		expect(resets).toContainEqual({
			type: "streaming_reset",
			narratorId: SUBAGENT_NARRATOR_ID,
		});
		const snapshots = broadcastMessages.filter(
			(message) => (message as { type?: string }).type === "streaming_snapshot",
		) as Array<Record<string, unknown>>;
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({
			narratorId: SUBAGENT_NARRATOR_ID,
			streamingBlocks: getStreamingSnapshot(SUBAGENT_NARRATOR_ID)?.streamingBlocks,
		});
	});
});

// The parent page renders a subagent's calls as one-line rows, and its copy of every
// tool event deliberately omits `input` (Write/Edit can carry a whole file). These
// tests pin the fix for the resulting bug — the row showed a bare tool name until the
// page was reloaded — and the constraint that makes it safe: a SUMMARY crosses the
// wire, never the input.
describe("子代理工具事件向父级携带输入摘要", () => {
	function subagentBroadcasts(type: string) {
		const messages = broadcastMessages.filter(
			(message): message is Record<string, unknown> =>
				!!message &&
				typeof message === "object" &&
				(message as Record<string, unknown>).type === type,
		);
		return {
			parent: messages.find((message) => message.narratorId === PARENT_NARRATOR_ID),
			self: messages.find((message) => message.narratorId === "subagent-narrator"),
		};
	}

	test("tool_started 父级帧带摘要且不带原始 input", async () => {
		const ctx = makeSubagentContext();
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "summary-bash",
				toolName: "Bash",
				input: { description: "列出文件", command: "ls -la /repo" },
			},
			ctx,
		);
		const { parent, self } = subagentBroadcasts("tool_started");
		// The whole point: a label without the payload.
		expect(parent?.inputSummary).toEqual({ description: "列出文件", command: "ls -la /repo" });
		expect(parent).not.toHaveProperty("input");
		// The subagent's OWN page still gets the complete input — the projection must not
		// have replaced it there.
		expect(self?.input).toEqual({ description: "列出文件", command: "ls -la /repo" });
		expect(self).not.toHaveProperty("inputSummary");
		// A reconnect mid-tool reads the snapshot, so it needs the same label.
		expect(
			getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("summary-bash")?.inputSummary,
		).toEqual({ description: "列出文件", command: "ls -la /repo" });
	});

	test("大字段只贡献白名单键，file content 不上线", async () => {
		const ctx = makeSubagentContext();
		const hugeContent = "x".repeat(200_000);
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "summary-write",
				toolName: "Write",
				input: { file_path: "/repo/big.ts", content: hugeContent },
			},
			ctx,
		);
		const { parent } = subagentBroadcasts("tool_started");
		// `file_path` is exactly the field worth showing for a big write; `content` is
		// exactly the field that must not be broadcast.
		expect(parent?.inputSummary).toEqual({ file_path: "/repo/big.ts" });
		expect(JSON.stringify(parent)).not.toContain(hugeContent);
		expect(JSON.stringify(parent).length).toBeLessThan(1_000);
	});

	test("超长白名单值按 200 字符上限截断", async () => {
		const ctx = makeSubagentContext();
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "summary-long",
				toolName: "Bash",
				input: { description: "d".repeat(5_000) },
			},
			ctx,
		);
		const { parent } = subagentBroadcasts("tool_started");
		const description = (parent?.inputSummary as Record<string, string>).description;
		expect(description).toHaveLength(200);
	});

	test("tool_use_chunk 用已提取字段在输入流完之前就标注行", async () => {
		const ctx = makeSubagentContext();
		await processEvent(
			{
				type: "tool_use_chunk",
				toolUseId: "summary-chunk",
				toolName: "Write",
				inputCharsTotal: 4_096,
				extractedFilePath: "/repo/streamed.ts",
				extractedFields: { file_path: "/repo/streamed.ts", content: "still streaming" },
			},
			ctx,
		);
		const { parent } = subagentBroadcasts("tool_use_chunk");
		// `content` is in extractedFields but not in the whitelist, so it is dropped —
		// the projection is a whitelist, not a passthrough of whatever was extracted.
		expect(parent?.inputSummary).toEqual({ file_path: "/repo/streamed.ts" });
		expect(parent).not.toHaveProperty("extractedFields");
	});

	test("摘要缺失时不发送该字段，父页面保留已显示的标签", async () => {
		const ctx = makeSubagentContext();
		// No whitelisted key at all (AskUserQuestion nests everything).
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "summary-none",
				toolName: "AskUserQuestion",
				input: { questions: [{ header: "选哪个" }] },
			},
			ctx,
		);
		const { parent } = subagentBroadcasts("tool_started");
		// Absent, not `{}`: the frontend merge spreads the incoming header over the
		// existing one, so an empty object would still be a value that overwrites.
		expect(parent).not.toHaveProperty("inputSummary");
	});

	test("tool_completed 只在权限改写过输入时才带摘要", async () => {
		const ctx = makeSubagentContext();
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "summary-plain",
				toolName: "Read",
				output: "ok",
				isError: false,
			},
			ctx,
		);
		// No `updatedInput` → nothing to relabel; the row keeps what tool_started sent.
		expect(subagentBroadcasts("tool_completed").parent).not.toHaveProperty("inputSummary");

		broadcastMessages.length = 0;
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "summary-redirected",
				toolName: "Write",
				output: "ok",
				isError: false,
				updatedInput: { file_path: "/repo/redirected.ts", content: "y".repeat(50_000) },
			},
			ctx,
		);
		const { parent } = subagentBroadcasts("tool_completed");
		// A permission redirect changed the path, so the row must follow it.
		expect(parent?.inputSummary).toEqual({ file_path: "/repo/redirected.ts" });
		expect(parent).not.toHaveProperty("updatedInput");
	});

	test("主叙述者不带摘要（它本来就收到完整 input）", async () => {
		const mainCtx: EventHandlerContext = {
			...makeSubagentContext(),
			narratorId: PARENT_NARRATOR_ID,
			broadcastTargetId: PARENT_NARRATOR_ID,
			parentToolUseId: undefined,
		};
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "main-tool",
				toolName: "Bash",
				input: { description: "构建", command: "bun run build" },
			},
			mainCtx,
		);
		const started = broadcastMessages.find(
			(message): message is Record<string, unknown> =>
				!!message &&
				typeof message === "object" &&
				(message as Record<string, unknown>).type === "tool_started",
		);
		expect(started?.input).toEqual({ description: "构建", command: "bun run build" });
		expect(started).not.toHaveProperty("inputSummary");
	});
});

describe("narrator event handler persistence", () => {
	test("工具结果持久化后将结构化 metadata 交给 hook", async () => {
		let observed: Record<string, unknown> | undefined;
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "missing-workdir-result",
				toolName: "Bash",
				output: "Working directory does not exist: /missing",
				isError: true,
				metadata: {
					cwdRecovery: {
						kind: "missing_working_directory",
						missingCwd: "/missing",
						suggestedCwd: "/workspace",
					},
				},
			},
			makeSubagentContext(),
			{
				onToolResult: (event) => {
					observed = event.metadata;
				},
			},
		);

		expect(observed).toMatchObject({
			cwdRecovery: {
				kind: "missing_working_directory",
				missingCwd: "/missing",
				suggestedCwd: "/workspace",
			},
		});
	});

	test("partial assistant 最终化会按稳定 toolUses 顺序修正 DB 与广播", async () => {
		const narratorId = `tool-order-${Date.now()}`;
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id: narratorId, createdAt: now, updatedAt: now });
		let partialId: string | undefined;
		let savedMessageId: string | undefined;
		const ctx: EventHandlerContext = {
			...makeSubagentContext(),
			narratorId,
			broadcastTargetId: narratorId,
			parentToolUseId: undefined,
			conversationId: `conversation-${narratorId}`,
			getPartialMessageId: () => partialId,
			setPartialMessageId: (id) => {
				partialId = id;
			},
			provider: "test",
			model: "test-model",
		};

		const toolBlock = (toolUseId: string, filePath: string) => ({
			type: "tool_use" as const,
			toolUseId,
			name: "Read",
			input: { file_path: filePath },
		});

		try {
			// Complete B first to model the parallel stop/completion race.
			await processEvent({ type: "block_complete", block: toolBlock("tool-b", "b.txt") }, ctx);
			await processEvent({ type: "block_complete", block: toolBlock("tool-a", "a.txt") }, ctx);
			savedMessageId = partialId;
			expect(savedMessageId).toBeString();
			await processEvent(
				{
					type: "assistant_message",
					text: "",
					toolUses: [
						{ toolUseId: "tool-a", name: "Read", input: { file_path: "a.txt" } },
						{ toolUseId: "tool-b", name: "Read", input: { file_path: "b.txt" } },
					],
				},
				ctx,
			);

			const saved = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, savedMessageId as string),
				columns: { contentJson: true },
			});
			const getToolIds = (contentJson: unknown) =>
				(Array.isArray(contentJson) ? contentJson : [])
					.filter(
						(block): block is { type: "tool_use"; id: string } =>
							!!block &&
							typeof block === "object" &&
							(block as Record<string, unknown>).type === "tool_use" &&
							typeof (block as Record<string, unknown>).id === "string",
					)
					.map((block) => block.id);
			const expected = ["tool-a", "tool-b"];
			expect(getToolIds(saved?.contentJson)).toEqual(expected);

			const messageBroadcast = broadcastMessages.find(
				(message): message is { type: "message"; message?: { contentJson?: unknown } } =>
					!!message &&
					typeof message === "object" &&
					(message as Record<string, unknown>).type === "message",
			);
			expect(getToolIds(messageBroadcast?.message?.contentJson)).toEqual(expected);
		} finally {
			// The functional test DB contains additional historical tables with references
			// to narrator rows; isolate cleanup from those unrelated FK edges.
			sqlite.run("PRAGMA foreign_keys = OFF");
			try {
				if (savedMessageId) {
					await db.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, savedMessageId));
					await db
						.delete(narratorMessageRefs)
						.where(eq(narratorMessageRefs.messageId, savedMessageId));
					await db.delete(narratorMessages).where(eq(narratorMessages.id, savedMessageId));
				}
				await db.delete(narrators).where(eq(narrators.id, narratorId));
			} finally {
				sqlite.run("PRAGMA foreign_keys = ON");
			}
		}
	});

	test("EnterPlanMode 仅在成功结果落库后按 row id 提交一次", async () => {
		const ctx = makeSubagentContext();
		ctx.preparedPlanModeToolCalls = new Map([["reused-call", "tool-row-new"]]);
		const commits: Array<[string, string]> = [];
		const discards: Array<[string, string]> = [];
		const hooks = {
			onEnterPlanMode: async (toolCallId: string, toolUseId: string) => {
				commits.push([toolCallId, toolUseId]);
			},
			onEnterPlanModeFailed: async (toolCallId: string, toolUseId: string) => {
				discards.push([toolCallId, toolUseId]);
			},
		};
		const event = {
			type: "tool_result" as const,
			toolUseId: "reused-call",
			toolName: "EnterPlanMode",
			output: "entered",
			isError: false,
		};

		await processEvent(event, ctx, hooks);
		await processEvent(event, ctx, hooks);

		expect(commits).toEqual([["tool-row-new", "reused-call"]]);
		expect(discards).toEqual([]);
		expect(ctx.preparedPlanModeToolCalls.size).toBe(0);
	});

	test("EnterPlanMode 失败或身份不匹配时只丢弃准备态", async () => {
		const ctx = makeSubagentContext();
		ctx.preparedPlanModeToolCalls = new Map([["failed-call", "tool-row-failed"]]);
		const commits: string[] = [];
		const discards: string[] = [];

		await processEvent(
			{
				type: "tool_result",
				toolUseId: "failed-call",
				toolName: "EnterPlanMode",
				output: "denied",
				isError: true,
			},
			ctx,
			{
				onEnterPlanMode: async (toolCallId) => {
					commits.push(toolCallId);
				},
				onEnterPlanModeFailed: async (toolCallId) => {
					discards.push(toolCallId);
				},
			},
		);

		expect(commits).toEqual([]);
		expect(discards).toEqual(["tool-row-failed"]);
		expect(ctx.preparedPlanModeToolCalls.size).toBe(0);
	});

	test("EnterPlanMode 成功结果缺少 prepared state 时 fail closed", async () => {
		const ctx = makeSubagentContext();
		let committed = false;

		await expect(
			processEvent(
				{
					type: "tool_result",
					toolUseId: "missing-prepared-state",
					toolName: "EnterPlanMode",
					output: "entered",
					isError: false,
				},
				ctx,
				{
					onEnterPlanMode: async () => {
						committed = true;
					},
				},
			),
		).rejects.toBeInstanceOf(CriticalEventPersistenceError);

		expect(committed).toBe(false);
	});

	test("EnterPlanMode 原子提交连续失败时终止事件处理", async () => {
		const ctx = makeSubagentContext();
		ctx.preparedPlanModeToolCalls = new Map([["atomic-failure", "tool-row-atomic-failure"]]);
		let attempts = 0;
		const discards: string[] = [];

		await expect(
			processEvent(
				{
					type: "tool_result",
					toolUseId: "atomic-failure",
					toolName: "EnterPlanMode",
					output: "entered",
					isError: false,
				},
				ctx,
				{
					onEnterPlanMode: async () => {
						attempts += 1;
						throw new Error("database unavailable");
					},
					onEnterPlanModeFailed: async (toolCallId) => {
						discards.push(toolCallId);
					},
				},
			),
		).rejects.toBeInstanceOf(CriticalEventPersistenceError);

		expect(attempts).toBe(2);
		expect(discards).toEqual(["tool-row-atomic-failure"]);
		expect(ctx.preparedPlanModeToolCalls.size).toBe(0);
	});
});

test.each([
	false,
	true,
])("discarded restart reasoning preserves fork (created after COW=%s)", async (lateFork) => {
	const owner = `restart-owner-${Date.now()}`;
	const fork = `${owner}-fork`;
	const now = new Date().toISOString();
	await db.insert(narrators).values([
		{ id: owner, createdAt: now, updatedAt: now },
		{ id: fork, createdAt: now, updatedAt: now },
	]);
	let partialId: string | undefined;
	const ctx: EventHandlerContext = {
		...makeMainContext(),
		narratorId: owner,
		broadcastTargetId: owner,
		conversationId: owner,
		provider: "test",
		model: "test",
		getPartialMessageId: () => partialId,
		setPartialMessageId: (id) => {
			partialId = id;
		},
	};
	try {
		await processEvent(
			{ type: "block_complete", block: { type: "text", text: "historical prefix" } },
			ctx,
		);
		await processEvent(
			{ type: "api_request_start", requestId: "restart-attempt", provider: "test", model: "test" },
			ctx,
		);
		await processEvent(
			{
				type: "block_complete",
				block: { type: "reasoning", text: "current thought", completed: true },
			},
			ctx,
		);
		if (!partialId) throw new Error("Missing persisted partial");
		const sharedId = partialId;
		const createFork = () =>
			db.insert(narratorMessageRefs).values({
				id: `${fork}-ref`,
				narratorId: fork,
				messageId: sharedId,
				seq: 1,
			});
		const { narratorPersistence } = await import("../narrator-persistence");
		const originalCOW = narratorPersistence.copyOnWriteMessage.bind(narratorPersistence);
		let forkCreated = false;
		const cowSpy = lateFork
			? spyOn(narratorPersistence, "copyOnWriteMessage").mockImplementation(async (...args) => {
					const result = await originalCOW(...args);
					if (!forkCreated) {
						forkCreated = true;
						await createFork();
					}
					return result;
				})
			: undefined;
		try {
			if (!lateFork) await createFork();
			await processEvent({ type: "attempt_discarded", requestId: "restart-attempt" }, ctx);
		} finally {
			cowSpy?.mockRestore();
		}
		const current = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, partialId),
		});
		const snapshot = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, sharedId),
		});
		expect(current?.contentJson).toEqual([{ type: "text", text: "historical prefix" }]);
		expect(JSON.stringify(snapshot?.contentJson)).toContain("current thought");
		expect(partialId).not.toBe(sharedId);
		expect(
			broadcastMessages.some((message) => (message as { type: string }).type === "streaming_reset"),
		).toBe(true);
		expect(
			broadcastMessages.some((message) => (message as { type: string }).type === "message_updated"),
		).toBe(true);
	} finally {
		await cleanupFileContextNarrator(fork);
		await cleanupFileContextNarrator(owner);
	}
});

/**
 * Reasoning translation lands asynchronously, and an attempt can be discarded and
 * replayed while it is in flight (`attempt_discarded` truncates that attempt's
 * blocks). Neither locator key is attempt-scoped — a replay reproduces the same
 * `outputIndex` — so without a check the translation of a thrown-away thought can be
 * pasted onto the new attempt's reasoning.
 */
describe("isSameReasoningBlock — the translation write-back guard", () => {
	test("accepts the block whose text is exactly what was translated", () => {
		expect(isSameReasoningBlock({ type: "reasoning", text: "分析中" }, "分析中")).toBe(true);
	});

	test("rejects a DIFFERENT reasoning at the same coordinates (the replay case)", () => {
		// Same outputIndex, different thought: the attempt that produced the original
		// was discarded and replayed.
		expect(
			isSameReasoningBlock({ type: "reasoning", text: "另一段推理", outputIndex: 0 }, "分析中"),
		).toBe(false);
	});

	test("rejects a non-reasoning block, and a missing one", () => {
		expect(isSameReasoningBlock({ type: "text", text: "分析中" }, "分析中")).toBe(false);
		expect(isSameReasoningBlock(undefined, "分析中")).toBe(false);
		expect(isSameReasoningBlock(null, "分析中")).toBe(false);
	});

	test("an empty translated text is still matched exactly, not treated as absent", () => {
		expect(isSameReasoningBlock({ type: "reasoning", text: "" }, "")).toBe(true);
		expect(isSameReasoningBlock({ type: "reasoning" }, "")).toBe(false);
	});
});
