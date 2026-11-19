import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createSqliteMaintenance } from "@server/db/backend/sqlite-maintenance";
import type { ContextUsageSnapshot } from "@shared/context-usage";
import { createStreamingEditOrigin } from "@shared/streaming-edit-origin";
import { eq } from "drizzle-orm";
import { readTestMessageContent } from "../../../tests/setup";
import {
	apiRequests,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { ExecutionOwner, RunControl } from "../agent-runtime/ownership";
import type { TokenUsageSnapshot } from "../narrator-event-handler";
import { captureWorkerRejectionThrower, getNarratorWorkerTestDb } from "./narrator-worker-fixture";

// Functional file-backed test DB lets worker reads observe the same committed rows.
// Bind it before importing modules that open the runtime database singleton.
const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const dbStub = {
	db,
	sqlite,
	databaseMaintenance: createSqliteMaintenance(() => sqlite),
	activeDatabaseBackend: "sqlite" as const,
	postgresRuntime: null,
	startupShutdownState: { canSkipVerification: true },
	markDatabaseCleanShutdown: () => true,
	releaseDatabaseInstanceLockOnly: () => {},
};
// Mock BEFORE any module that transitively imports the runtime DB
// (narrator-ws → services → @server/db opens sqlite and runs drizzle migrations).
mock.module("../../db", () => dbStub);
mock.module("@server/db", () => dbStub);
const { getRunControl, setRunControl, tryClaimExecution } = await import(
	"../agent-runtime/ownership"
);
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
	getSubagentOutputCounts,
	isSameReasoningBlock,
	processEvent,
	retireSubagentOutputCharCount,
	startSubagentOutputCharCount,
} = await import("../narrator-event-handler");
const { reasoningTranslationActivities } = await import("../reasoning-translation-activity");

type EventHandlerContext = import("../narrator-event-handler").EventHandlerContext;
type CountEventContext = EventHandlerContext & {
	subagentOutputIdentity: NonNullable<EventHandlerContext["subagentOutputIdentity"]>;
};

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

describe("reasoning translation durable boundaries", () => {
	const seal = (sourceText = "source", blockId = "reason") => ({
		type: "reasoning_summary_sealed" as const,
		blockId,
		blockRevision: 1,
		nativePartId: "summary-0",
		nativePartIndex: 0,
		start: 0,
		end: sourceText.length,
		sourceText,
	});
	const context = (locale?: string): EventHandlerContext => ({
		...makeMainContext(),
		locale,
		getPartialMessageId: () => "translation-pending",
	});
	const checkpoint = (ctx: EventHandlerContext, text: string, revision = 1, id = "reason") =>
		processEvent({ type: "block_complete", block: { type: "reasoning", id, text, revision } }, ctx);

	type ReasoningSnapshot = {
		type: "reasoning";
		id: string;
		text: string;
		translationGeneration: string;
		translationLocale?: string;
		translationParts?: import("@shared/reasoning-translation").ReasoningTranslationPart[];
		translatedText?: string;
	};
	async function openTranslationFixture(id: string, locale = "zh-CN") {
		const now = new Date().toISOString();
		await db
			.insert(narrators)
			.values({ id, type: "primary", inheritMode: "fresh", createdAt: now, updatedAt: now });
		let partialId: string | undefined;
		const messageIds = new Set<string>();
		const ctx: EventHandlerContext = {
			...context(locale),
			narratorId: id,
			broadcastTargetId: id,
			getPartialMessageId: () => partialId,
			setPartialMessageId: (value) => {
				partialId = value;
				if (value) messageIds.add(value);
			},
		};
		return {
			ctx,
			read: async () => {
				const messageId = [...messageIds].at(-1);
				expect(messageId).toBeString();
				const { readNarratorMessageRow } = await import("../narrator-message-reader");
				const message = await readNarratorMessageRow(messageId as string);
				const block = (message?.contentJson as ReasoningSnapshot[] | undefined)?.find(
					(entry) => entry.type === "reasoning" && entry.id === "reason",
				);
				expect(block).toBeDefined();
				return block as ReasoningSnapshot;
			},
			cleanup: async () => {
				await processEvent({ type: "stream_reset" }, ctx);
				clearStreamingSnapshot(id);
				sqlite.run("PRAGMA foreign_keys = OFF");
				try {
					for (const messageId of messageIds)
						await db.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, messageId));
				} finally {
					sqlite.run("PRAGMA foreign_keys = ON");
				}
				await cleanupFileContextNarrator(id);
			},
		};
	}

	test("summary handoffs and item completion translate while the display lane stays active", async () => {
		const { settings } = await import("../../lib/settings");
		const agent = await import("../../lib/agent");
		const { reasoningTranslationActivities: activity } = await import(
			"../reasoning-translation-activity"
		);
		const { reasoningTranslationVisibility: visibility } = await import(
			"../reasoning-translation-runtime"
		);
		const store = await import("../reasoning-translation-store");
		const { REASONING_TRANSLATION_LIMITS, reasoningTranslationScheduler: scheduler } = await import(
			"../reasoning-translation-scheduler"
		);
		const { eventBus } = await import("../../lib/event-bus");
		const calls: string[] = [];
		const started = new Map(["A", "B+", "C"].map((text) => [text, Promise.withResolvers<void>()]));
		const generate = spyOn(agent, "summaryGenerate").mockImplementation(async (input) => {
			const text = String(input);
			if (text.startsWith('{"parts":')) {
				const payload = JSON.parse(text) as { parts: Array<{ id: string; text: string }> };
				for (const part of payload.parts) {
					calls.push(part.text);
					started.get(part.text.trim())?.resolve();
				}
				return {
					text: JSON.stringify({
						parts: payload.parts.map((part) => ({ id: part.id, translatedText: "译" })),
					}),
				};
			}
			calls.push(text);
			started.get(text.trim())?.resolve();
			return { text: "译" };
		});
		const original = settings.agent.translateReasoning;
		settings.agent.translateReasoning = true;
		const f = await openTranslationFixture("translation-pending-summary");
		const connection = {};
		let subscribed = true;
		const fullTranslationPublished = Promise.withResolvers<void>();
		const onTranslation = (
			event: Extract<
				import("../../lib/event-bus").NarraForkEvent,
				{ type: "narrator:ws_broadcast" }
			>,
		) => {
			if (
				event.narratorId === f.ctx.narratorId &&
				event.message.type === "reasoning_translation_patch" &&
				event.message.part.sourceText.trim() === "C"
			)
				fullTranslationPublished.resolve();
		};
		eventBus.on("narrator:ws_broadcast", onTranslation);
		const waitForPart = async (part: string, ready = started.get(part)?.promise) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					ready,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() =>
								reject(new Error(`Waiting for ${part}; model sources: ${JSON.stringify(calls)}`)),
							3000,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		};
		const passCoalescingWindow = async (part: string, action: () => Promise<unknown>) => {
			const release = scheduler.hold();
			const queued = Promise.withResolvers<void>();
			const originalFreeze = scheduler.freeze.bind(scheduler);
			let deadlineAt = 0;
			const freeze = spyOn(scheduler, "freeze").mockImplementation((response, input) => {
				originalFreeze(response, input);
				if (input.text.slice(input.start ?? 0, input.end ?? input.text.length).trim() === part) {
					const queuedAt = response.queuedAt;
					if (queuedAt === undefined) throw new Error(`Missing queue clock for ${part}`);
					deadlineAt = queuedAt + REASONING_TRANSLATION_LIMITS.deadlineMs;
					queued.resolve();
				}
			});
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await action();
				await Promise.race([
					queued.promise,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(() => reject(new Error(`Waiting for queued ${part}`)), 3000);
					}),
				]);
				expect(calls.some((text) => text.trim() === part)).toBe(false);
				expect(scheduler.stats().queued).toBeGreaterThan(0);
				const dispatchAt = Date.now() + 10_000;
				expect(REASONING_TRANSLATION_LIMITS.coalesceMs).toBe(10_000);
				expect(dispatchAt).toBeLessThan(deadlineAt);
				const clock = spyOn(Date, "now").mockReturnValue(dispatchAt);
				try {
					release();
					// Visibility owns a nested hold until its asynchronous refresh settles.
					// Keep this window mature through that release and live authorization.
					await waitForPart(part);
				} finally {
					clock.mockRestore();
				}
			} finally {
				clearTimeout(timer);
				freeze.mockRestore();
				release();
			}
		};
		const delta = (text: string, revision: number, offset: number, index: number) =>
			processEvent(
				{
					type: "stream_reasoning",
					blockId: "r",
					text,
					blockRevision: revision,
					blockTextOffset: offset,
					reasoningSummaryPart: { id: `native:summary:${index}`, index },
				} as import("../../lib/agent/types").AgentEvent,
				f.ctx,
			);
		const commit = (text: string, revision: number, completed = false) =>
			processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id: "r", text, revision, completed },
				},
				f.ctx,
			);
		const sealPart = (text: string, revision: number, start: number, index: number) =>
			processEvent(
				{
					...seal(text, "r"),
					blockRevision: revision,
					start,
					end: start + text.length,
					nativePartId: `native:summary:${index}`,
					nativePartIndex: index,
				},
				f.ctx,
			);
		try {
			await delta("A", 1, 0, 0);
			await commit("A", 1);
			const target = await store.resolveReasoningTranslationTarget(
				f.ctx.narratorId,
				f.ctx.getPartialMessageId() as string,
				"r",
			);
			if (!target) throw new Error("Missing persisted target");
			visibility.replace(
				connection,
				"body",
				{
					narratorId: f.ctx.narratorId,
					userId: "viewer",
					isCurrent: () => subscribed,
					authorize: async () => subscribed,
				},
				[target],
			);
			await sealPart("A", 1, 0, 0);
			expect(activity.get(f.ctx.narratorId)?.completedRanges).toEqual([]);
			expect(calls).toEqual([]);
			await passCoalescingWindow("A", () => delta("\n\nB", 2, 1, 1));
			await commit("A\n\nB", 2);
			await sealPart("B", 2, 3, 1);
			expect(calls).toEqual(["A"]);
			expect(activity.allows(target, 3, 4)).toBe(false);
			await delta("", 3, 4, 2);
			await delta("+", 3, 4, 1);
			await commit("A\n\nB+", 3);
			await sealPart("B+", 3, 3, 1);
			await sealPart("B+", 3, 3, 1);
			expect(calls).toEqual(["A"]);
			expect(activity.allows(target, 3, 5)).toBe(false);
			await passCoalescingWindow("B+", () => delta("\n\nC", 4, 5, 2));
			expect(calls).toEqual(["A", "B+"]);
			expect(activity.allows(target, 7, 8)).toBe(false);
			await passCoalescingWindow("C", async () => {
				await commit("A\n\nB+\n\nC", 4, true);
				expect(activity.allows(target, 7, 8)).toBe(true);
				expect(activity.get(f.ctx.narratorId)).toMatchObject({
					elementId: "r",
					completedRanges: [{ start: 0, end: 8 }],
					displayTailStart: 5,
				});
			});
			await waitForPart("published C", fullTranslationPublished.promise);
			expect(calls.map((text) => text.trim())).toEqual(["A", "B+", "C"]);
			expect(activity.get(f.ctx.narratorId)).toMatchObject({
				elementId: "r",
				completedRanges: [{ start: 0, end: 8 }],
				displayTailStart: 5,
			});
			const translated = await store.loadVisibleTranslationSource(
				target,
				{
					narratorId: f.ctx.narratorId,
					userId: "viewer",
					isCurrent: () => subscribed,
					authorize: async () => subscribed,
				},
				new AbortController().signal,
			);
			expect(
				translated?.parts?.some(
					(part) => part.sourceText.trim() === "C" && part.translatedText.trim() === "译",
				),
			).toBe(true);
			const snapshot = (broadcastMessages as Array<Record<string, unknown>>).findLast(
				(message) =>
					message.type === "streaming_snapshot" && message.narratorId === f.ctx.narratorId,
			);
			expect(snapshot?.reasoningTranslationActivity).toMatchObject({
				elementId: "r",
				displayTailStart: 5,
			});
			await processEvent({ type: "reasoning_response_complete" }, f.ctx);
			expect(activity.get(f.ctx.narratorId)).toBeNull();
		} finally {
			eventBus.off("narrator:ws_broadcast", onTranslation);
			subscribed = false;
			visibility.release(connection);
			try {
				await f.cleanup();
			} finally {
				generate.mockRestore();
				settings.agent.translateReasoning = original;
			}
		}
	}, 15_000);

	test.each([
		false,
		undefined,
	])("completed=%s persists without releasing the current item", async (completed) => {
		const { reasoningTranslationVisibility: visibility } = await import(
			"../reasoning-translation-runtime"
		);
		const complete = spyOn(visibility, "complete").mockImplementation(() => {});
		const f = await openTranslationFixture(`translation-incomplete-${String(completed)}`);
		try {
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: "reason",
					text: "source",
					blockRevision: 1,
					blockTextOffset: 0,
				},
				f.ctx,
			);
			await processEvent(
				{
					type: "block_complete",
					block: {
						type: "reasoning",
						id: "reason",
						text: "source",
						revision: 1,
						...(completed !== undefined ? { completed } : {}),
					},
				},
				f.ctx,
			);
			expect(await f.read()).toMatchObject({ text: "source" });
			expect(complete).not.toHaveBeenCalled();
			expect(reasoningTranslationActivities.get(f.ctx.narratorId)).toMatchObject({
				elementId: "reason",
				completedRanges: [],
				displayTailStart: 0,
			});
		} finally {
			complete.mockRestore();
			await f.cleanup();
		}
	});

	test("an acknowledged write without matching durable completion cannot release an item", async () => {
		const { narratorStore } = await import("../narrator-store");
		const { reasoningTranslationVisibility: visibility } = await import(
			"../reasoning-translation-runtime"
		);
		const complete = spyOn(visibility, "complete").mockImplementation(() => {});
		const f = await openTranslationFixture("translation-unpersisted-completion");
		const write = spyOn(narratorStore, "writeStepItem");
		try {
			await checkpoint(f.ctx, "source");
			write.mockResolvedValue(undefined);
			await processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id: "reason", text: "source", revision: 2, completed: true },
				},
				f.ctx,
			);
			expect(await f.read()).toMatchObject({ text: "source", revision: 1 });
			expect(complete).not.toHaveBeenCalled();
			expect(reasoningTranslationActivities.get(f.ctx.narratorId)).toMatchObject({
				revision: 1,
				completedRanges: [],
				displayTailStart: 0,
			});
		} finally {
			write.mockRestore();
			complete.mockRestore();
			await f.cleanup();
		}
	});

	test.each([
		false,
		true,
	])("completion waits for persistence and respects terminal cleanup=%s", async (terminate) => {
		const { narratorStore } = await import("../narrator-store");
		const { reasoningTranslationVisibility: visibility } = await import(
			"../reasoning-translation-runtime"
		);
		const complete = spyOn(visibility, "complete").mockImplementation(() => {});
		const f = await openTranslationFixture(`translation-completion-write-${String(terminate)}`);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let pending: Promise<unknown> | undefined;
		await checkpoint(f.ctx, "source");
		const originalWrite = narratorStore.writeStepItem.bind(narratorStore);
		const write = spyOn(narratorStore, "writeStepItem").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return originalWrite(...args);
		});
		try {
			pending = processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id: "reason", text: "source", revision: 2, completed: true },
				},
				f.ctx,
			);
			await Promise.race([entered.promise, pending]);
			expect(complete).not.toHaveBeenCalled();
			expect(reasoningTranslationActivities.get(f.ctx.narratorId)?.completedRanges).toEqual([]);
			if (terminate) await processEvent({ type: "reasoning_response_complete" }, f.ctx);
			release.resolve();
			await pending;
			expect(await f.read()).toMatchObject({ text: "source", revision: 2, completed: true });
			expect(complete).toHaveBeenCalledTimes(1);
			if (terminate) expect(reasoningTranslationActivities.get(f.ctx.narratorId)).toBeNull();
			else
				expect(reasoningTranslationActivities.get(f.ctx.narratorId)).toMatchObject({
					elementId: "reason",
					completedRanges: [{ start: 0, end: 6 }],
					displayTailStart: 0,
				});
		} finally {
			release.resolve();
			await pending?.catch(() => {});
			write.mockRestore();
			complete.mockRestore();
			await f.cleanup();
		}
	});

	test("old completed checkpoints and summary seals cannot reclose a rewritten live tail", async () => {
		const { reasoningTranslationVisibility: visibility } = await import(
			"../reasoning-translation-runtime"
		);
		const complete = spyOn(visibility, "complete").mockImplementation(() => {});
		const f = await openTranslationFixture("translation-complete-rewrite-race");
		const done = () =>
			processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id: "reason", text: "AB", revision: 2, completed: true },
				},
				f.ctx,
			);
		try {
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: "reason",
					text: "AB",
					blockRevision: 1,
					blockTextOffset: 0,
					reasoningSummaryPart: { id: "A", index: 0 },
				},
				f.ctx,
			);
			await done();
			expect(complete).toHaveBeenCalledTimes(1);
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: "reason",
					text: "ZZ",
					blockRevision: 3,
					blockTextOffset: 0,
					reasoningSummaryPart: { id: "B", index: 1 },
				},
				f.ctx,
			);
			await processEvent(
				{
					...seal("AB"),
					blockRevision: 2,
					nativePartId: "A",
					nativePartIndex: 0,
				},
				f.ctx,
			);
			await done();
			expect(complete).toHaveBeenCalledTimes(1);
			expect(reasoningTranslationActivities.get(f.ctx.narratorId)).toMatchObject({
				revision: 3,
				completedRanges: [],
				displayTailStart: 0,
			});
			await checkpoint(f.ctx, "ZZ", 4);
			await done();
			expect(await f.read()).toMatchObject({ text: "ZZ", revision: 4 });
			expect(complete).toHaveBeenCalledTimes(1);
			expect(reasoningTranslationActivities.get(f.ctx.narratorId)).toMatchObject({
				revision: 4,
				completedRanges: [],
				displayTailStart: 0,
			});
		} finally {
			complete.mockRestore();
			await f.cleanup();
		}
	});

	test("full completion preserves the summary handoff boundary in the broadcast activity", async () => {
		const { reasoningTranslationVisibility: visibility } = await import(
			"../reasoning-translation-runtime"
		);
		const complete = spyOn(visibility, "complete").mockImplementation(() => {});
		const f = await openTranslationFixture("translation-full-after-summary");
		try {
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: "reason",
					text: "A",
					blockRevision: 1,
					blockTextOffset: 0,
					reasoningSummaryPart: { id: "A", index: 0 },
				},
				f.ctx,
			);
			await checkpoint(f.ctx, "A");
			await processEvent({ ...seal("A"), nativePartId: "A", nativePartIndex: 0 }, f.ctx);
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: "reason",
					text: "\n\nB",
					blockRevision: 2,
					blockTextOffset: 1,
					reasoningSummaryPart: { id: "B", index: 1 },
				},
				f.ctx,
			);
			await checkpoint(f.ctx, "A\n\nB", 2);
			const done = {
				type: "block_complete" as const,
				block: {
					type: "reasoning" as const,
					id: "reason",
					text: "A\n\nB",
					revision: 3,
					completed: true,
				},
			};
			await processEvent(done, f.ctx);
			expect(complete).toHaveBeenCalledTimes(2);
			await processEvent(done, f.ctx);
			expect(complete).toHaveBeenCalledTimes(2);
			const expected = {
				elementId: "reason",
				revision: 3,
				completedRanges: [{ start: 0, end: 4 }],
				displayTailStart: 1,
			};
			expect(reasoningTranslationActivities.get(f.ctx.narratorId)).toEqual(expected);
			const snapshot = (broadcastMessages as Array<Record<string, unknown>>).findLast(
				(message) =>
					message.type === "streaming_snapshot" && message.narratorId === f.ctx.narratorId,
			);
			expect(snapshot?.reasoningTranslationActivity).toEqual(expected);
			expect(snapshot?.streamingBlocks).toEqual([]);
			await processEvent(
				{
					type: "stream_text",
					blockId: "text",
					text: "body",
					blockRevision: 1,
					blockTextOffset: 0,
				},
				f.ctx,
			);
			expect(reasoningTranslationActivities.get(f.ctx.narratorId)).toBeNull();
			const handedOff = (broadcastMessages as Array<Record<string, unknown>>).findLast(
				(message) =>
					message.type === "streaming_snapshot" && message.narratorId === f.ctx.narratorId,
			);
			expect(handedOff?.reasoningTranslationActivity).toBeNull();
		} finally {
			complete.mockRestore();
			await f.cleanup();
		}
	});

	test("item done keeps authoritative activity until nonempty successor output", async () => {
		const { reasoningTranslationActivities: activity } = await import(
			"../reasoning-translation-activity"
		);
		const { reasoningTranslationVisibility: visibility } = await import(
			"../reasoning-translation-runtime"
		);
		const completed = spyOn(visibility, "complete").mockImplementation(() => {});
		const f = await openTranslationFixture("translation-pending-item");
		try {
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: "reason",
					text: "B",
					blockRevision: 1,
					blockTextOffset: 0,
				},
				f.ctx,
			);
			await processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id: "reason", text: "B", revision: 2, completed: true },
				},
				f.ctx,
			);
			expect(await f.read()).toMatchObject({ text: "B", completed: true });
			expect(activity.get(f.ctx.narratorId)).toMatchObject({
				elementId: "reason",
				revision: 2,
				completedRanges: [{ start: 0, end: 1 }],
				displayTailStart: 0,
			});
			expect(completed.mock.calls.map(([target]) => target.elementId)).toEqual(["reason"]);
			const snapshot = (broadcastMessages as Array<Record<string, unknown>>).findLast(
				(message) =>
					message.type === "streaming_snapshot" && message.narratorId === f.ctx.narratorId,
			);
			expect(snapshot?.reasoningTranslationActivity).toMatchObject({
				elementId: "reason",
				displayTailStart: 0,
				completedRanges: [{ start: 0, end: 1 }],
			});
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: "next",
					text: "",
					blockRevision: 1,
					blockTextOffset: 0,
				},
				f.ctx,
			);
			await processEvent(
				{ type: "stream_text", blockId: "text", text: "", blockRevision: 1, blockTextOffset: 0 },
				f.ctx,
			);
			expect(completed.mock.calls.map(([target]) => target.elementId)).toEqual(["reason"]);
			expect(activity.get(f.ctx.narratorId)?.elementId).toBe("reason");
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: "next",
					text: "C",
					blockRevision: 1,
					blockTextOffset: 0,
				},
				f.ctx,
			);
			expect(completed.mock.calls.map(([target]) => target.elementId)).toEqual([
				"reason",
				"reason",
			]);
			await processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id: "next", text: "C", revision: 2, completed: true },
				},
				f.ctx,
			);
			expect(activity.get(f.ctx.narratorId)?.elementId).toBe("next");
			await processEvent({ type: "reasoning_response_complete" }, f.ctx);
			expect(completed.mock.calls.map(([target]) => target.elementId)).toEqual([
				"reason",
				"reason",
				"next",
				"next",
			]);
			expect(activity.get(f.ctx.narratorId)).toBeNull();
		} finally {
			completed.mockRestore();
			await f.cleanup();
		}
	});

	test("an error releases the last durable pending item even without a successor", async () => {
		const { reasoningTranslationActivities: activity } = await import(
			"../reasoning-translation-activity"
		);
		const { reasoningTranslationVisibility: visibility } = await import(
			"../reasoning-translation-runtime"
		);
		const completed = spyOn(visibility, "complete").mockImplementation(() => {});
		const f = await openTranslationFixture("translation-pending-error");
		try {
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: "reason",
					text: "B",
					blockRevision: 1,
					blockTextOffset: 0,
				},
				f.ctx,
			);
			await processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id: "reason", text: "B", revision: 2, completed: false },
				},
				f.ctx,
			);
			expect(completed).not.toHaveBeenCalled();
			await processEvent({ type: "error", message: "upstream ended" }, f.ctx);
			expect(completed.mock.calls.map(([target]) => target.elementId)).toEqual(["reason"]);
			expect(activity.get(f.ctx.narratorId)).toBeNull();
		} finally {
			completed.mockRestore();
			await f.cleanup();
		}
	});

	test("persisted lane switches and pending summary seals release before the request ends", async () => {
		const { reasoningTranslationActivities: activity } = await import(
			"../reasoning-translation-activity"
		);
		const { reasoningTranslationVisibility: visibility } = await import(
			"../reasoning-translation-runtime"
		);
		const completed = spyOn(visibility, "complete").mockImplementation(() => {});
		const f = await openTranslationFixture("translation-live-lanes");
		const delta = (id: string, text: string, revision = 1, offset = 0) =>
			processEvent(
				{
					type: "stream_reasoning",
					blockId: id,
					blockRevision: revision,
					blockTextOffset: offset,
					text,
				},
				f.ctx,
			);
		const commit = (id: string, text: string, revision = 1, done = false) =>
			processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id, text, revision, completed: done },
				},
				f.ctx,
			);
		try {
			await delta("A", "Alpha");
			await commit("A", "Alpha");
			expect(completed).not.toHaveBeenCalled();
			expect(getStreamingSnapshot(f.ctx.narratorId)?.streamingBlocks).toEqual([]);
			expect(activity.get(f.ctx.narratorId)?.elementId).toBe("A");
			await delta("B", "Beta");
			expect(completed.mock.calls.map(([target]) => target.elementId)).toEqual(["A"]);
			await commit("B", "Beta");
			await delta("C", "😀AB tail");
			expect(completed.mock.calls.map(([target]) => target.elementId)).toEqual(["A", "B"]);
			await commit("C", "😀AB tail");
			await processEvent({ ...seal("😀AB", "C"), end: 4 }, f.ctx);
			expect(completed.mock.calls.map(([target]) => target.elementId)).toEqual(["A", "B"]);
			expect(activity.get(f.ctx.narratorId)?.completedRanges).toEqual([]);
			await delta("C", "+", 3, 9);
			await commit("C", "😀AB tail", 2, true);
			expect(activity.get(f.ctx.narratorId)?.revision).toBe(3);
			expect(completed).toHaveBeenCalledTimes(2);
			await processEvent(
				{ type: "tool_use_chunk", toolUseId: "t", toolName: "Read", inputCharsTotal: 1 },
				f.ctx,
			);
			expect(activity.get(f.ctx.narratorId)).toBeNull();
			expect(completed).toHaveBeenCalledTimes(3);
		} finally {
			completed.mockRestore();
			await f.cleanup();
		}
	});

	test("durable checkpoints notify without creating unsubscribed translation work", async () => {
		const { settings } = await import("../../lib/settings");
		const agent = await import("../../lib/agent");
		const { narratorPersistence } = await import("../narrator-persistence");
		const { reasoningTranslationVisibility } = await import("../reasoning-translation-runtime");
		const generate = spyOn(agent, "summaryGenerate").mockResolvedValue({ text: "译文" });
		const patch = spyOn(narratorPersistence, "patchReasoningTranslationPart");
		const notify = spyOn(reasoningTranslationVisibility, "notify");
		const original = settings.agent.translateReasoning;
		settings.agent.translateReasoning = true;
		const f = await openTranslationFixture("translation-durable-boundaries");
		try {
			await checkpoint(f.ctx, "A");
			const messageId = f.ctx.getPartialMessageId();
			expect(notify.mock.calls.map(([id]) => id)).toEqual([messageId]);
			await processEvent(
				{ type: "tool_use_chunk", toolUseId: "await", toolName: "Await", inputCharsTotal: 1 },
				f.ctx,
			);
			expect(notify).toHaveBeenCalledTimes(2);
			await processEvent(seal("A"), f.ctx);
			expect(notify).toHaveBeenCalledTimes(2);
			await checkpoint(f.ctx, "A+B", 2);
			await processEvent(
				{
					type: "block_complete",
					block: { type: "tool_use", toolUseId: "await", name: "Await", input: {} },
				},
				f.ctx,
			);
			expect(notify).toHaveBeenCalledTimes(4);
			await processEvent(
				{
					type: "assistant_message",
					text: "",
					toolUses: [{ toolUseId: "await", name: "Await", input: {} }],
				},
				f.ctx,
			);
			expect(notify.mock.calls.map(([id]) => id)).toEqual(Array(5).fill(messageId));
			expect((await f.read()).text).toBe("A+B");
			expect(generate).not.toHaveBeenCalled();
			expect(patch).not.toHaveBeenCalled();
			expect(
				broadcastMessages.some(
					(value) => (value as { type?: string }).type === "reasoning_translation_patch",
				),
			).toBe(false);
		} finally {
			await f.cleanup();
			generate.mockRestore();
			patch.mockRestore();
			notify.mockRestore();
			settings.agent.translateReasoning = original;
		}
	});

	test("a terminal partial response preserves translation identity and releases its pending lane", async () => {
		const agent = await import("../../lib/agent");
		const { reasoningTranslationVisibility } = await import("../reasoning-translation-runtime");
		const generate = spyOn(agent, "summaryGenerate").mockResolvedValue({ text: "译文" });
		const notify = spyOn(reasoningTranslationVisibility, "notify");
		const f = await openTranslationFixture("translation-incomplete-boundary");
		try {
			await checkpoint(f.ctx, "A");
			const generation = (await f.read()).translationGeneration;
			notify.mockClear();
			const messageId = f.ctx.getPartialMessageId();
			await processEvent(
				{ type: "assistant_message", text: "", toolUses: [], outputCompleted: false },
				f.ctx,
			);
			expect(notify.mock.calls.map(([id]) => id)).toEqual([messageId]);
			expect(generate).not.toHaveBeenCalled();
			expect(await f.read()).toMatchObject({
				text: "A",
				translationGeneration: generation,
				translationLocale: "zh-CN",
			});
		} finally {
			await f.cleanup();
			generate.mockRestore();
			notify.mockRestore();
		}
	});

	test("append retains the generation, locale and parts while rewrite starts a new lineage", async () => {
		const { narratorPersistence } = await import("../narrator-persistence");
		const f = await openTranslationFixture("translation-checkpoint-lineage");
		try {
			await checkpoint(f.ctx, "A");
			const first = await f.read();
			expect(first.translationGeneration).toBeString();
			expect(first.translationLocale).toBe("zh-CN");
			const part = {
				id: "translated-prefix",
				generation: first.translationGeneration,
				start: 0,
				end: 1,
				sourceText: "A",
				translatedText: "甲",
			};
			const messageId = f.ctx.getPartialMessageId() as string;
			expect(
				await narratorPersistence.patchReasoningTranslationPart({
					messageId,
					elementId: "reason",
					expected: { sourceText: "A", generation: first.translationGeneration },
					part,
				}),
			).not.toBeNull();
			f.ctx.locale = "fr";
			await checkpoint(f.ctx, "AB", 2);
			expect(await f.read()).toMatchObject({
				text: "AB",
				translationGeneration: first.translationGeneration,
				translationLocale: "zh-CN",
				translationParts: [part],
			});
			await narratorPersistence.patchReasoningTranslation(messageId, 0, "旧译", {
				id: "reason",
				text: "AB",
			});
			await checkpoint(f.ctx, "Z", 3);
			const rewritten = await f.read();
			expect(rewritten.translationGeneration).not.toBe(first.translationGeneration);
			expect(rewritten).toMatchObject({ text: "Z", translationLocale: "fr", translationParts: [] });
			expect(rewritten.translatedText).toBeUndefined();
		} finally {
			await f.cleanup();
		}
	});

	test.each([
		undefined,
		"",
		"en",
		"zh-CN",
	])("checkpoints persist locale %s for future demand while translation is disabled", async (locale) => {
		const { settings } = await import("../../lib/settings");
		const agent = await import("../../lib/agent");
		const generate = spyOn(agent, "summaryGenerate").mockResolvedValue({ text: "译文" });
		const original = settings.agent.translateReasoning;
		settings.agent.translateReasoning = false;
		const f = await openTranslationFixture(`translation-disabled-locale-${locale ?? "default"}`);
		f.ctx.locale = locale;
		try {
			await checkpoint(f.ctx, "source");
			const stored = await f.read();
			expect(stored.translationGeneration).toBeString();
			expect(stored).toMatchObject({ text: "source", translationLocale: locale || "en" });
			expect(generate).not.toHaveBeenCalled();
		} finally {
			await f.cleanup();
			settings.agent.translateReasoning = original;
			generate.mockRestore();
		}
	});

	test("summary seals require a matching persisted source and active lane", async () => {
		const agent = await import("../../lib/agent");
		const { reasoningTranslationVisibility } = await import("../reasoning-translation-runtime");
		const generate = spyOn(agent, "summaryGenerate").mockResolvedValue({ text: "译文" });
		const notify = spyOn(reasoningTranslationVisibility, "notify");
		const ctx = context("zh-CN");
		try {
			await processEvent(seal("summary", "missing-source"), ctx);
			expect(notify).not.toHaveBeenCalled();
			ctx.getPartialMessageId = () => undefined;
			await processEvent(seal("summary"), ctx);
			expect(notify).not.toHaveBeenCalled();
			expect(generate).not.toHaveBeenCalled();
		} finally {
			notify.mockRestore();
			generate.mockRestore();
		}
	});

	test("stale checkpoints cannot replace a rewritten generation, locale or valid parts", async () => {
		const { narratorPersistence } = await import("../narrator-persistence");
		const f = await openTranslationFixture("translation-stale-checkpoint");
		try {
			await checkpoint(f.ctx, "A", 2);
			const first = await f.read();
			f.ctx.locale = "fr";
			await checkpoint(f.ctx, "Z", 4);
			const rewritten = await f.read();
			expect(rewritten.translationGeneration).not.toBe(first.translationGeneration);
			expect(rewritten.translationLocale).toBe("fr");
			const part = {
				id: "rewritten-prefix",
				generation: rewritten.translationGeneration,
				start: 0,
				end: 1,
				sourceText: "Z",
				translatedText: "nouveau",
			};
			expect(
				await narratorPersistence.patchReasoningTranslationPart({
					messageId: f.ctx.getPartialMessageId() as string,
					elementId: "reason",
					expected: { sourceText: "Z", generation: rewritten.translationGeneration },
					part,
				}),
			).not.toBeNull();
			const latest = await f.read();
			expect(latest.translationParts).toEqual([part]);
			f.ctx.locale = "de";
			await checkpoint(f.ctx, "old source", 3);
			expect(await f.read()).toEqual(latest);
			await processEvent(
				{ type: "block_complete", block: { type: "reasoning", id: "reason", text: "unversioned" } },
				f.ctx,
			);
			expect(await f.read()).toEqual(latest);
		} finally {
			await f.cleanup();
		}
	});

	test("a replacement event context reuses the persisted translation lineage", async () => {
		const f = await openTranslationFixture("translation-replacement-context");
		try {
			await checkpoint(f.ctx, "A");
			const first = await f.read();
			const replacement: EventHandlerContext = { ...f.ctx, locale: "fr" };
			await checkpoint(replacement, "AB", 2);
			expect(await f.read()).toMatchObject({
				text: "AB",
				translationGeneration: first.translationGeneration,
				translationLocale: "zh-CN",
			});
		} finally {
			await f.cleanup();
		}
	});

	test("reasoning checkpoints notify visible demand only after the write settles", async () => {
		const { narratorStore } = await import("../narrator-store");
		const { reasoningTranslationVisibility } = await import("../reasoning-translation-runtime");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const write = spyOn(narratorStore, "writeStepItem").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return undefined;
		});
		const notify = spyOn(reasoningTranslationVisibility, "notify").mockImplementation(() => {});
		const ctx = context("zh-CN");
		const pending = checkpoint(ctx, "source");
		try {
			await Promise.race([entered.promise, pending]);
			expect(notify).not.toHaveBeenCalled();
			expect(write.mock.calls[0]?.[2]).toMatchObject({
				text: "source",
				translationGeneration: expect.any(String),
				translationLocale: "zh-CN",
			});
			release.resolve();
			await pending;
			expect(notify.mock.calls.map(([id]) => id)).toEqual(["translation-pending"]);
		} finally {
			release.resolve();
			await pending.catch(() => {});
			await processEvent({ type: "stream_reset" }, ctx);
			write.mockRestore();
			notify.mockRestore();
		}
	});

	test("a failed checkpoint preserves persisted translation identity and does not notify demand", async () => {
		const { narratorStore } = await import("../narrator-store");
		const { reasoningTranslationVisibility } = await import("../reasoning-translation-runtime");
		const f = await openTranslationFixture("translation-failed-checkpoint");
		const write = spyOn(narratorStore, "writeStepItem");
		const notify = spyOn(reasoningTranslationVisibility, "notify").mockImplementation(() => {});
		try {
			await checkpoint(f.ctx, "source");
			const previous = await f.read();
			notify.mockClear();
			write.mockRejectedValue(new Error("checkpoint write failed"));
			f.ctx.locale = "fr";
			await expect(checkpoint(f.ctx, "source+", 2)).rejects.toThrow("checkpoint write failed");
			expect(await f.read()).toEqual(previous);
			expect(f.ctx.unpublishedContentBlockIds?.has("reason")).toBe(true);
			expect(notify).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
			notify.mockRestore();
			await f.cleanup();
		}
	});

	for (const reset of ["stream_reset", "attempt_discarded", "error", "done"] as const) {
		test(`${reset} preserves committed translation lineage for the next append`, async () => {
			const { settings } = await import("../../lib/settings");
			const agent = await import("../../lib/agent");
			const { narratorPersistence } = await import("../narrator-persistence");
			const { reasoningTranslationVisibility } = await import("../reasoning-translation-runtime");
			const generate = spyOn(agent, "summaryGenerate").mockResolvedValue({ text: "译文" });
			const notify = spyOn(reasoningTranslationVisibility, "notify");
			const original = settings.agent.translateReasoning;
			settings.agent.translateReasoning = true;
			const f = await openTranslationFixture(`translation-reset-${reset}`);
			try {
				await checkpoint(f.ctx, "A");
				const previous = await f.read();
				const part = {
					id: "committed-prefix",
					generation: previous.translationGeneration,
					start: 0,
					end: 1,
					sourceText: "A",
					translatedText: "甲",
				};
				expect(
					await narratorPersistence.patchReasoningTranslationPart({
						messageId: f.ctx.getPartialMessageId() as string,
						elementId: "reason",
						expected: { sourceText: "A", generation: previous.translationGeneration },
						part,
					}),
				).not.toBeNull();
				await processEvent(seal("A"), f.ctx);
				await processEvent(
					reset === "stream_reset" || reset === "done"
						? { type: reset }
						: reset === "attempt_discarded"
							? { type: reset, requestId: "old" }
							: { type: reset, message: "Aborted" },
					f.ctx,
				);
				expect(notify).toHaveBeenCalledTimes(reset === "attempt_discarded" ? 1 : 2);
				expect(await f.read()).toMatchObject({
					text: "A",
					translationGeneration: previous.translationGeneration,
					translationLocale: "zh-CN",
					translationParts: [part],
				});
				f.ctx.locale = "fr";
				await checkpoint(f.ctx, "AB", 2);
				expect(await f.read()).toMatchObject({
					text: "AB",
					translationGeneration: previous.translationGeneration,
					translationLocale: "zh-CN",
					translationParts: [part],
				});
				expect(generate).not.toHaveBeenCalled();
				expect(
					broadcastMessages.some(
						(value) => (value as { type?: string }).type === "reasoning_translation_patch",
					),
				).toBe(false);
			} finally {
				generate.mockRestore();
				notify.mockRestore();
				settings.agent.translateReasoning = original;
				await f.cleanup();
			}
		});
	}
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
			expect(readTestMessageContent(sqlite, partialId as string)).toMatchObject([
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

test("sealing a streamed assistant retains final duration, TTFT and metering without inserting another reply", async () => {
	const id = "stream-final-metadata";
	const now = new Date().toISOString();
	await db.insert(narrators).values({ id, createdAt: now, updatedAt: now });
	const { createRuntimeEventContext } = await import("../agent-runtime/context");
	const ctx = createRuntimeEventContext({
		narratorId: id,
		conversationId: "stream-session",
		provider: "test",
		model: "test-model",
		locale: "en",
		getTurnStartedAt: () => new Date(Date.now() - 2000).toISOString(),
		getTtftMs: () => 125,
	});
	try {
		await processEvent(
			{
				type: "block_complete",
				block: { type: "text", id: "numbers", text: "[17,203]", revision: 1 },
			},
			ctx,
		);
		const partialId = ctx.getPartialMessageId();
		expect(partialId).toBeDefined();
		ctx.setContextUsagePct(25);
		ctx.setMeterData(1.5, "credits");
		await processEvent(
			{
				type: "assistant_message",
				text: "[17,203]",
				toolUses: [],
				messageId: "upstream-id",
				credentialId: "credential",
			},
			ctx,
		);
		const messages = await db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, id));
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			id: partialId,
			ttftMs: 125,
			contextPercent: 25,
			meterUsage: 1.5,
			meterUnit: "credits",
			credentialId: "credential",
			messageUuid: "upstream-id",
		});
		expect(messages[0]?.durationMs).toBeGreaterThanOrEqual(2000);
		expect(ctx.getPartialMessageId()).toBeUndefined();
		expect(getStreamingSnapshot(id)?.streamingBlocks ?? []).toHaveLength(0);
	} finally {
		clearStreamingSnapshot(id);
		await cleanupFileContextNarrator(id);
	}
});
const outputCountOwners = new Map<string, ExecutionOwner>();

afterEach(() => {
	reasoningTranslationActivities.finish(PARENT_NARRATOR_ID, true);
	reasoningTranslationActivities.finish(SUBAGENT_NARRATOR_ID, true);
	clearStreamingSnapshot(PARENT_NARRATOR_ID);
	clearStreamingSnapshot(SUBAGENT_NARRATOR_ID);
	for (const [id, owner] of outputCountOwners) {
		const runId = getRunControl(id)?.logicalRunId;
		if (runId) retireSubagentOutputCharCount(id, runId);
		clearStreamingSnapshot(id);
		setRunControl(owner, undefined);
		owner.release();
	}
	outputCountOwners.clear();
	broadcastMessages.length = 0;
	broadcastTargets.length = 0;
});

afterAll(async () => {
	// Leave the isolated DB stub in place. Bun's mock.module is process-global and
	// mock.restore() does not undo module mocks; re-pointing at a lazily imported
	// real `../../db` would open the runtime database mid-suite.
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
	(await import("../narrator-block-sync")).stopBlockSyncSweep();
	await (await import("../narrator-prefix-snapshots")).closePrefixSnapshotStore();
	await fixture.close();
});

async function cleanupFileContextNarrator(id: string) {
	// The worker fixture retains historical FK edges beyond the minimal narrator rows.
	sqlite.run("PRAGMA foreign_keys = OFF");
	try {
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
		await db.delete(narrators).where(eq(narrators.id, id));
	} finally {
		sqlite.run("PRAGMA foreign_keys = ON");
	}
}

describe("owned request-end round accounting", () => {
	test("multiple requests, retries, duplicate ends and child broadcasts do not lose or duplicate charges", async () => {
		const parent = makeMainContext();
		const child = makeSubagentContext();
		const parentUsage: Array<TokenUsageSnapshot | undefined> = [];
		const childUsage: Array<TokenUsageSnapshot | undefined> = [];
		parent.accountRequestTokenUsage = (usage) => parentUsage.push(usage);
		child.accountRequestTokenUsage = (usage) => childUsage.push(usage);
		async function start(ctx: EventHandlerContext, requestId: string) {
			await processEvent(
				{ type: "api_request_start", requestId, provider: "anthropic", model: "test" },
				ctx,
			);
		}
		await start(parent, "round-tool");
		const end = {
			type: "api_request_end" as const,
			requestId: "round-tool",
			usage: { inputTokens: 1000, completionTokens: 100 },
		};
		// Concurrent duplicate ends must consume the in-flight ownership only once.
		await Promise.all([processEvent(end, parent), processEvent(end, parent)]);
		await start(parent, "round-retry");
		await processEvent({ ...end, requestId: "round-retry", errorMessage: "retryable" }, parent);
		await start(parent, "round-final");
		await processEvent(
			{ ...end, requestId: "round-final", usage: { inputTokens: 1100, completionTokens: 100 } },
			parent,
		);
		await start(child, "round-child");
		await processEvent({ ...end, requestId: "round-child" }, parent);
		await processEvent({ ...end, requestId: "round-child" }, child);
		await start(parent, "round-empty");
		await processEvent({ type: "api_request_end", requestId: "round-empty" }, parent);
		await processEvent({ ...end, requestId: "round-final" }, parent);
		expect(parentUsage).toEqual([
			end.usage,
			end.usage,
			{ inputTokens: 1100, completionTokens: 100 },
			undefined,
		]);
		expect(childUsage).toEqual([end.usage]);
		expect(parent.apiRequestsMap?.size).toBe(0);
		expect(child.apiRequestsMap?.size).toBe(0);
	});
});

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
					decodeMs: 400,
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
			expect(request?.decodeMs).toBe(400);
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
				output_tokens: 12,
				context_snapshot: snapshot,
				decode_ms: 400,
			});
		} finally {
			await db.delete(apiRequests).where(eq(apiRequests.narratorId, id));
			await cleanupFileContextNarrator(id);
		}
	});
});

describe("durable API error association", () => {
	test("completed request enriches the exact diagnostic object before error persistence and refresh", async () => {
		const id = "error-association-narrator";
		const now = "2026-10-08T00:00:00Z";
		await db.insert(narrators).values({ id, createdAt: now, updatedAt: now });
		const ctx = { ...makeMainContext(), narratorId: id, broadcastTargetId: id };
		const diagnostics = {
			schema: "narrafork.error-diagnostics.v1" as const,
			recordingRequestId: "exact-attempt",
			requestId: "upstream-id",
			providerRequestId: "provider-id",
			statusCode: 503,
			message: "界😀".repeat(8192),
		};
		try {
			// A different, later request must not become this error's association.
			for (const requestId of ["exact-attempt", "other-attempt"]) {
				await processEvent(
					{ type: "api_request_start", requestId, provider: "anthropic", model: "test" },
					ctx,
				);
			}
			await processEvent(
				{
					type: "api_request_end",
					requestId: "exact-attempt",
					errorMessage: "upstream failed",
					diagnostics,
				},
				ctx,
			);
			const request = db.select().from(apiRequests).where(eq(apiRequests.narratorId, id)).get();
			expect(request).toBeDefined();
			expect(diagnostics).toMatchObject({
				apiRequestId: request?.id,
				recordingRequestId: "exact-attempt",
				requestId: "upstream-id",
			});
			expect(ctx.apiRequestsMap?.has("exact-attempt")).toBe(false);
			const { narratorPersistence } = await import("../narrator-persistence");
			await processEvent({ type: "error", message: "upstream failed", diagnostics }, ctx, {
				onErrorCleanup: async (message, errorDiagnostics) => {
					await narratorPersistence.updateStatus(id, "idle", {
						substatus: ["error"],
						errorMessage: message,
						diagnostics: errorDiagnostics,
					});
				},
			});
			// Re-read backing storage (the path used after refresh), not a live broadcast.
			const message = db
				.select({ id: narratorMessages.id })
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, id))
				.get();
			expect(readTestMessageContent(sqlite, message?.id ?? "")).toEqual([
				{ type: "error", message: "upstream failed", diagnostics },
			]);
			expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThanOrEqual(16 * 1024);
			const ref = db
				.select()
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, id))
				.get();
			expect(ref).toBeDefined();
		} finally {
			await db.delete(apiRequests).where(eq(apiRequests.narratorId, id));
			await cleanupFileContextNarrator(id);
		}
	});

	test("legacy errors and internal errors never acquire a nearby API association", async () => {
		const id = "legacy-error-association-narrator";
		const now = "2026-10-08T00:00:00Z";
		await db.insert(narrators).values({ id, createdAt: now, updatedAt: now });
		try {
			const { narratorPersistence } = await import("../narrator-persistence");
			await narratorPersistence.updateStatus(id, "idle", {
				substatus: ["error"],
				errorMessage: "internal failure",
			});
			const message = db
				.select({ id: narratorMessages.id })
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, id))
				.get();
			expect(readTestMessageContent(sqlite, message?.id ?? "")).toEqual([
				{ type: "error", message: "internal failure" },
			]);
			const diagnostics = {
				schema: "narrafork.error-diagnostics.v1" as const,
				requestId: "untrusted-upstream-only",
				recordingRequestId: "different-attempt",
			};
			const ctx = { ...makeMainContext(), narratorId: id, broadcastTargetId: id };
			await processEvent(
				{ type: "api_request_start", requestId: "current", provider: "anthropic", model: "test" },
				ctx,
			);
			await processEvent(
				{ type: "api_request_end", requestId: "current", errorMessage: "failed", diagnostics },
				ctx,
			);
			expect(diagnostics).not.toHaveProperty("apiRequestId");
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
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 1,
				blockTextOffset: 0,
				blockId: "b0",
				text: "src/a.ts",
				outputIndex: 0,
			},
			ctx,
		);
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
			await processEvent(
				{
					type: "stream_text",
					blockRevision: 2,
					blockTextOffset: 8,
					blockId: "b0",
					text: "[file]",
					outputIndex: 0,
				},
				ctx,
			);
			source = { deviceId: "DeviceB", cwd: "/other" };
			await processEvent(
				{
					type: "stream_text",
					blockRevision: 3,
					blockTextOffset: 14,
					blockId: "b0",
					text: "(src/a.ts#L2)",
					outputIndex: 0,
				},
				ctx,
			);
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
					block: { type: "text", id: "b0", text: "[file](src/a.ts#L2)", outputIndex: 0 },
				},
				ctx,
			);
			const savedId = partialId;
			// The provider reuses output index 0 for a new element: it reads its own device.
			await processEvent(
				{
					type: "stream_text",
					blockRevision: 1,
					blockTextOffset: 0,
					blockId: "b1",
					text: "next",
					outputIndex: 0,
				},
				ctx,
			);
			await processEvent(
				{ type: "block_complete", block: { type: "text", id: "b1", text: "next", outputIndex: 0 } },
				ctx,
			);
			await processEvent(
				{ type: "assistant_message", text: "[file](src/a.ts#L2)next", toolUses: [] },
				ctx,
			);
			const reloaded = readTestMessageContent(sqlite, savedId as string);
			expect(reloaded).toMatchObject([
				{ fileReferenceContext: { deviceId: "DeviceA", cwd: "/repo" } },
				{ fileReferenceContext: { deviceId: "DeviceB", cwd: "/other" } },
			]);
			const final = broadcastMessages.findLast(
				(m) => (m as { type?: string }).type === "message",
			) as { message: { contentJson: unknown } };
			expect(final.message.contentJson).toEqual(reloaded);
		} finally {
			clearStreamingSnapshot(id);
			await cleanupFileContextNarrator(id);
		}
	});

	test("a text block without an element id never borrows a streamed element's device", async () => {
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
			await processEvent(
				{
					type: "stream_text",
					blockRevision: 4,
					blockTextOffset: 27,
					blockId: "b0",
					text: "first ",
					outputIndex: 0,
				},
				ctx,
			);
			deviceId = "B";
			await processEvent(
				{
					type: "stream_text",
					blockRevision: 2,
					blockTextOffset: 4,
					blockId: "b1",
					text: "second",
					outputIndex: 1,
				},
				ctx,
			);
			await processEvent(
				{ type: "block_complete", block: { type: "text", text: "first second", outputIndex: 1 } },
				ctx,
			);
			const content = readTestMessageContent(sqlite, partialId as string);
			expect(content[0]).toMatchObject({
				type: "text",
				text: "first second",
			});
			expect(content[0]).not.toHaveProperty("fileReferenceContext");
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
			const content = readTestMessageContent(sqlite, partialId as string);
			expect(content[0]).not.toHaveProperty("fileReferenceContext");
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
		expect(parent).not.toHaveProperty("executionAttempt");
		expect(self).not.toHaveProperty("executionAttempt");
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

describe("native image generation persistence", () => {
	test.each([
		"failed",
		"cancelled",
		"incomplete",
	])("persists %s with errors and partial previews", async (status) => {
		const id = `image-terminal-${status}`;
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id, createdAt: now, updatedAt: now });
		let partialId: string | undefined;
		const ctx: EventHandlerContext = {
			...makeMainContext(),
			narratorId: id,
			broadcastTargetId: id,
			getPartialMessageId: () => partialId,
			setPartialMessageId: (value) => {
				partialId = value;
			},
		};
		try {
			await processEvent(
				{
					type: "image_generation",
					id: "ig",
					status: "generating",
					partialSavedPath: "/tmp/preview.png",
					partialImageIndex: 1,
				},
				ctx,
			);
			await processEvent(
				{
					type: "block_complete",
					block: {
						type: "image_generation",
						id: "ig",
						status,
						error: "image provider rejected",
						errorCode: "content_filter",
						partialImageIndex: 1,
					},
				},
				ctx,
			);
			if (!partialId) throw new Error("missing persisted image message");
			const content = readTestMessageContent(sqlite, partialId);
			expect(content).toEqual([
				expect.objectContaining({
					type: "image_generation",
					status,
					error: "image provider rejected",
					errorCode: "content_filter",
					partialSavedPath: "/tmp/preview.png",
				}),
			]);
			expect(getStreamingSnapshot(id)?.streamingBlocks).toEqual([
				expect.objectContaining({
					status,
					partialSavedPath: "/tmp/preview.png",
					error: "image provider rejected",
				}),
			]);
			expect(broadcastMessages).toContainEqual(
				expect.objectContaining({
					type: "image_generation",
					narratorId: id,
					status,
					errorCode: "content_filter",
					partialSavedPath: "/tmp/preview.png",
				}),
			);
		} finally {
			await cleanupFileContextNarrator(id);
		}
	});

	test.each([
		"completed",
		"incomplete",
	])("stores image bytes for %s without losing a partial-only artifact", async (status) => {
		const id = `image-artifact-${status}`;
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id, createdAt: now, updatedAt: now });
		let partialId: string | undefined;
		const ctx: EventHandlerContext = {
			...makeMainContext(),
			narratorId: id,
			broadcastTargetId: id,
			conversationId: id,
			getPartialMessageId: () => partialId,
			setPartialMessageId: (value) => {
				partialId = value;
			},
		};
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
		try {
			await processEvent(
				{
					type: "block_complete",
					block: {
						type: "image_generation",
						id: "ig_artifact",
						status,
						...(status === "completed"
							? { result: png }
							: { partialImageB64: png, partialImageIndex: 0 }),
					},
				},
				ctx,
			);
			if (!partialId) throw new Error("missing persisted image message");
			const content = readTestMessageContent(sqlite, partialId) as Array<Record<string, unknown>>;
			expect(content).toHaveLength(1);
			expect(content[0]).toMatchObject({ type: "image_generation", status, width: 1, height: 1 });
			const path = content[0][status === "completed" ? "savedPath" : "partialSavedPath"];
			expect(typeof path).toBe("string");
			expect(await Bun.file(String(path)).exists()).toBe(true);
			expect(content[0].result).toBeUndefined();
			expect(content[0].partialImageB64).toBeUndefined();
		} finally {
			await cleanupFileContextNarrator(id);
		}
	});

	test("completed lifecycle alone remains active instead of looking like a generated image", async () => {
		const ctx = makeMainContext();
		await processEvent({ type: "image_generation", id: "ig_lifecycle", status: "completed" }, ctx);
		expect(getStreamingSnapshot(ctx.narratorId)?.streamingBlocks).toContainEqual(
			expect.objectContaining({ id: "ig_lifecycle", status: "generating" }),
		);
		expect(broadcastMessages).toContainEqual(
			expect.objectContaining({
				type: "image_generation",
				id: "ig_lifecycle",
				status: "generating",
			}),
		);
	});

	test("already persisted tool image refs are encoded directly without upload re-save", async () => {
		const { toolResultLedgerOutput } = await import("../narrator-event-handler");
		const uploads = await import("../../lib/uploads");
		const save = spyOn(uploads, "saveUploadedImage");
		try {
			const ref = {
				imageId: "image-from-worker",
				mediaType: "image/png",
				uploadNarratorId: "image-owner",
			};
			const output = await toolResultLedgerOutput("caller", {
				type: "tool_result",
				toolUseId: "image-tool",
				toolName: "Image",
				output: "saved",
				isError: false,
				imageRefs: [ref],
			});
			expect(output).toEqual({ _text: "saved", _images: [ref] });
			expect(save).not.toHaveBeenCalled();
		} finally {
			save.mockRestore();
		}
	});
});

describe("完成工具输入传递", () => {
	test("onGitTrack 的异步意图判断在完成边界内结束，失败工具仍会检查", async () => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const classified = new Promise<void>((resolve) => {
			release = resolve;
		});
		let completed = false;
		const pending = processEvent(
			{
				type: "tool_result",
				toolUseId: "partial-write",
				toolName: "Bash",
				input: { command: "touch changed; false" },
				output: "failed after write",
				isError: true,
			},
			makeSubagentContext(),
			{
				onGitTrack: async () => {
					entered();
					await classified;
				},
			},
		).then(() => {
			completed = true;
		});
		await started;
		expect(completed).toBe(false);
		release();
		await pending;
		expect(completed).toBe(true);
	});

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

		await processEvent(
			{
				type: "stream_text",
				blockRevision: 1,
				blockTextOffset: 0,
				blockId: "text-7",
				text: "保留的 partial 文本",
				outputIndex: 0,
			},
			ctx,
		);
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
				revision: 1,
				textOffset: 0,
				fileReferenceContext: null,
			},
			{
				type: "image_generation",
				id: "image-partial",
				status: "incomplete",
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
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 1,
				blockTextOffset: 0,
				blockId: "text-8",
				text: "still here",
				outputIndex: 0,
			},
			ctx,
		);
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
			{
				type: "stream_text",
				blockRevision: 1,
				blockTextOffset: 0,
				blockId: "text-9",
				text: "parent live text",
				outputIndex: 0,
			},
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
				revision: 1,
				textOffset: 0,
				fileReferenceContext: null,
			},
		]);
		expect(getStreamingSnapshot(SUBAGENT_NARRATOR_ID)?.streamingBlocks).toEqual([
			{
				type: "image_generation",
				id: "child-partial",
				status: "incomplete",
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
		expect(parent).not.toHaveProperty("executionAttempt");
		expect(
			getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("summary-chunk"),
		).not.toHaveProperty("executionAttempt");
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

	test("子代理 started/completed 保留真实 receipt attempt，旧结果不影响新 attempt", async () => {
		const ctx = makeSubagentContext();
		const toolUseId = "receipt-summary";
		const toolCallId = "tc-receipt-summary";
		const messageId = "receipt-summary-message";
		const createdAt = new Date().toISOString();
		const binding = { toolCallId, attempt: 3 };
		const updatedInput = {
			description: "d".repeat(5_000),
			command: "ls /repo",
			content: "SECRET-BODY".repeat(5_000),
		};
		await db.insert(narrators).values({
			id: ctx.narratorId,
			type: "subagent",
			variant: "subagent:general",
			inheritMode: "fresh",
			createdAt,
			updatedAt: createdAt,
		});
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: ctx.narratorId,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: "Bash", input: {} }],
			parentToolUseId: ctx.parentToolUseId,
			createdAt,
		});
		await db.insert(narratorMessageRefs).values({
			id: "ref-receipt-summary",
			narratorId: ctx.narratorId,
			messageId,
			seq: 0,
		});
		await db.insert(narratorToolCalls).values({
			id: toolCallId,
			narratorId: ctx.narratorId,
			messageId,
			toolUseId,
			toolName: "Bash",
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: binding.attempt,
			createdAt,
		});
		ctx.toolCallIdsMap?.set(toolUseId, toolCallId);
		ctx.toolExecutionReceipts = new Map([[toolUseId, { messageId, binding }]]);
		try {
			await processEvent(
				{ type: "tool_call", toolUseId, toolName: "Bash", input: { description: "original" } },
				ctx,
			);
			expect(subagentBroadcasts("tool_started").parent).toMatchObject({
				toolCallId,
				executionAttempt: 3,
				inputSummary: { description: "original" },
			});
			expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get(toolUseId)).toMatchObject({
				toolCallId,
				executionAttempt: 3,
			});
			await processEvent(
				{
					type: "tool_result",
					toolUseId,
					toolName: "Bash",
					output: "sensitive output",
					isError: false,
					durationMs: 17,
					updatedInput,
					metadata: { secret: true },
				},
				ctx,
			);
			const { parent, self } = subagentBroadcasts("tool_completed");
			expect(parent).toMatchObject({
				toolCallId,
				executionAttempt: 3,
				status: "success",
				durationMs: 17,
				inputSummary: { description: "d".repeat(200), command: "ls /repo" },
			});
			expect(self).toMatchObject({ toolCallId, executionAttempt: 3, updatedInput });
			for (const field of ["input", "output", "updatedInput", "metadata"])
				expect(parent).not.toHaveProperty(field);
			expect(JSON.stringify(parent)).not.toContain("SECRET-BODY");
			expect(JSON.stringify(parent).length).toBeLessThan(1_000);
			expect(
				await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, toolCallId) }),
			).toMatchObject({ executionAttempt: 3, status: "success", inputJson: updatedInput });

			await db
				.update(narratorToolCalls)
				.set({ executionAttempt: 4, status: "running" })
				.where(eq(narratorToolCalls.id, toolCallId));
			ctx.toolExecutionReceipts.set(toolUseId, {
				messageId,
				binding: { toolCallId, attempt: 4 },
			});
			await processEvent(
				{ type: "tool_call", toolUseId, toolName: "Bash", input: { description: "new attempt" } },
				ctx,
			);
			broadcastMessages.length = 0;
			const throwStaleResult = await captureWorkerRejectionThrower(
				processEvent(
					{
						type: "tool_result",
						toolUseId,
						toolName: "Bash",
						toolCallBinding: binding,
						output: "late old output",
						isError: false,
						updatedInput: { description: "old attempt" },
					},
					ctx,
				),
			);
			expect(throwStaleResult).toThrow("stale");
			expect(broadcastMessages).toHaveLength(0);
			expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get(toolUseId)).toMatchObject({
				toolCallId,
				executionAttempt: 4,
				inputSummary: { description: "new attempt" },
			});
			expect(
				await db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, toolCallId) }),
			).toMatchObject({ executionAttempt: 4, status: "running", inputJson: updatedInput });
		} finally {
			await db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, toolCallId));
			await cleanupFileContextNarrator(ctx.narratorId);
		}
	});

	test("子代理 discard 帧传递明确 child 身份并移除 pre-start 重连快照", async () => {
		const ctx = makeSubagentContext();
		const toolUseId = "discarded-child-input";
		await processEvent(
			{
				type: "tool_use_chunk",
				toolUseId,
				toolName: "Read",
				inputCharsTotal: 32,
				extractedFilePath: "/repo/unstarted.ts",
			},
			ctx,
		);
		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get(toolUseId)).toMatchObject({
			toolCallId: null,
			subagentNarratorId: ctx.narratorId,
		});
		await processEvent({ type: "tool_use_discarded", toolUseIds: [toolUseId] }, ctx);
		const expected: Extract<
			import("../../websocket/narrator-ws-types").NarratorServerMessage,
			{ type: "tool_use_discarded" }
		> = {
			type: "tool_use_discarded",
			narratorId: PARENT_NARRATOR_ID,
			toolUseIds: [toolUseId],
			parentToolUseId: PARENT_TOOL_USE_ID,
			subagentNarratorId: SUBAGENT_NARRATOR_ID,
		};
		expect(subagentBroadcasts("tool_use_discarded").parent).toEqual(expected);
		expect(subagentBroadcasts("tool_use_discarded").self).toEqual({
			type: "tool_use_discarded",
			narratorId: SUBAGENT_NARRATOR_ID,
			toolUseIds: [toolUseId],
			subagentNarratorId: SUBAGENT_NARRATOR_ID,
		});
		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.has(toolUseId)).toBe(false);
	});

	const ordinaryCompletionInputs: Array<[string, Record<string, unknown>, Record<string, string>]> =
		[
			["Read", { file_path: "/repo/read.ts" }, { file_path: "/repo/read.ts" }],
			["Glob", { pattern: "**/*.ts", path: "/repo" }, { pattern: "**/*.ts" }],
			["Grep", { pattern: "summary", path: "/repo" }, { pattern: "summary" }],
			[
				"Bash",
				{ description: "检查工作区", command: "git status" },
				{ description: "检查工作区", command: "git status" },
			],
		];
	test.each(
		ordinaryCompletionInputs,
	)("tool_completed 普通 %s 最终输入独立提供父级摘要", async (toolName, input, inputSummary) => {
		const ctx = makeSubagentContext();
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "summary-plain",
				toolName,
				input,
				output: "ok",
				isError: false,
				durationMs: 17,
			},
			ctx,
		);
		const { parent, self } = subagentBroadcasts("tool_completed");
		expect(parent).toEqual({
			type: "tool_completed",
			narratorId: PARENT_NARRATOR_ID,
			toolCallId: null,
			toolUseId: "summary-plain",
			toolName,
			status: "success",
			durationMs: 17,
			parentToolUseId: PARENT_TOOL_USE_ID,
			subagentNarratorId: SUBAGENT_NARRATOR_ID,
			inputSummary,
		});
		expect(self).toEqual({
			type: "tool_completed",
			narratorId: SUBAGENT_NARRATOR_ID,
			toolCallId: null,
			toolUseId: "summary-plain",
			toolName,
			status: "success",
			output: "ok",
			durationMs: 17,
			subagentNarratorId: SUBAGENT_NARRATOR_ID,
		});
		for (const field of ["input", "updatedInput", "brokenInputOverride", "output", "metadata"])
			expect(parent).not.toHaveProperty(field);
		expect(self).not.toHaveProperty("input");
		expect(self).not.toHaveProperty("inputSummary");
	});

	test("tool_completed 没有最终输入证据时省略摘要", async () => {
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "summary-no-input",
				toolName: "Read",
				output: "ok",
				isError: false,
			},
			makeSubagentContext(),
		);
		const { parent, self } = subagentBroadcasts("tool_completed");
		expect(parent).toBeDefined();
		expect(parent).not.toHaveProperty("inputSummary");
		expect(self).not.toHaveProperty("inputSummary");
	});

	test("tool_completed 权限改写输入优先于原始输入且仅父级摘要更新", async () => {
		const ctx = makeSubagentContext();
		const updatedInput = { file_path: "/repo/redirected.ts", content: "y".repeat(50_000) };
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "summary-redirected",
				toolName: "Write",
				input: { file_path: "/repo/original.ts", content: "original body" },
				output: "ok",
				isError: false,
				updatedInput,
			},
			ctx,
		);
		const { parent, self } = subagentBroadcasts("tool_completed");
		expect(parent?.inputSummary).toEqual({ file_path: "/repo/redirected.ts" });
		expect(parent).not.toHaveProperty("updatedInput");
		expect(parent).not.toHaveProperty("input");
		expect(JSON.stringify(parent)).not.toContain(updatedInput.content);
		expect(self?.updatedInput).toBe(updatedInput);
		expect(self).not.toHaveProperty("input");
		expect(self).not.toHaveProperty("inputSummary");
	});

	test("tool_completed broken 覆盖优先于权限改写和原始输入", async () => {
		const updatedInput = { file_path: "/repo/redirected.ts", content: "redirected body" };
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "summary-broken",
				toolName: "Write",
				input: { file_path: "/repo/original.ts", content: "original body" },
				updatedInput,
				brokenInputOverride: { file_path: "/repo/sanitized.ts", _broken: true },
				output: "invalid input",
				isError: true,
			},
			makeSubagentContext(),
		);
		const { parent, self } = subagentBroadcasts("tool_completed");
		expect(parent).toMatchObject({
			status: "fail",
			inputSummary: { file_path: "/repo/sanitized.ts" },
		});
		for (const field of ["input", "updatedInput", "brokenInputOverride", "output", "metadata"])
			expect(parent).not.toHaveProperty(field);
		expect(self?.updatedInput).toBe(updatedInput);
		expect(self).not.toHaveProperty("input");
		expect(self).not.toHaveProperty("brokenInputOverride");
		expect(self).not.toHaveProperty("inputSummary");
	});

	const clearingCompletionInputs: Array<
		[
			string,
			Pick<
				Extract<Parameters<typeof processEvent>[0], { type: "tool_result" }>,
				"input" | "updatedInput" | "brokenInputOverride"
			>,
		]
	> = [
		["普通空输入", { input: {} }],
		["普通无白名单输入", { input: { questions: [{ header: "选择" }] } }],
		["权限空覆盖", { input: { file_path: "/repo/original.ts" }, updatedInput: {} }],
		[
			"权限非法摘要覆盖",
			{ input: { file_path: "/repo/original.ts" }, updatedInput: { file_path: { invalid: true } } },
		],
		[
			"broken 空覆盖",
			{
				input: { file_path: "/repo/original.ts" },
				updatedInput: { file_path: "/repo/redirected.ts" },
				brokenInputOverride: {},
			},
		],
		[
			"broken 非法输入覆盖",
			{
				input: { file_path: "/repo/original.ts" },
				updatedInput: { file_path: "/repo/redirected.ts" },
				brokenInputOverride: [] as unknown as Record<string, unknown>,
			},
		],
	];
	test.each(
		clearingCompletionInputs,
	)("tool_completed %s 显式清除而不回退旧路径", async (_label, inputs) => {
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "summary-cleared",
				toolName: "Read",
				...inputs,
				output: "done",
				isError: false,
			},
			makeSubagentContext(),
		);
		const { parent, self } = subagentBroadcasts("tool_completed");
		expect(parent).toHaveProperty("inputSummary", null);
		expect(self).not.toHaveProperty("input");
		expect(self).not.toHaveProperty("inputSummary");
	});

	test("tool_completed 摘要只读取十个白名单键且不查询数据库或传递大字段", async () => {
		const { SUBAGENT_SUMMARY_INPUT_KEYS } = await import("@shared/subagent-tool-summary");
		const readKeys: PropertyKey[] = [];
		const hugeContent = "SECRET-BODY".repeat(20_000);
		const input = new Proxy(
			{ file_path: "/repo/big.ts", description: "d".repeat(5_000), content: hugeContent },
			{
				ownKeys() {
					throw new Error("Input enumeration is forbidden");
				},
				get(target, key, receiver) {
					readKeys.push(key);
					if (key === "content") throw new Error("Body access is forbidden");
					return Reflect.get(target, key, receiver);
				},
			},
		);
		const query = spyOn(sqlite, "query");
		const prepare = spyOn(sqlite, "prepare");
		try {
			await processEvent(
				{
					type: "tool_result",
					toolUseId: "summary-bounded-completion",
					toolName: "Read",
					input,
					output: hugeContent,
					isError: false,
					metadata: { content: hugeContent },
				},
				makeSubagentContext(),
			);
			const { parent, self } = subagentBroadcasts("tool_completed");
			expect(parent?.inputSummary).toEqual({
				file_path: "/repo/big.ts",
				description: "d".repeat(200),
			});
			expect(readKeys).toEqual([...SUBAGENT_SUMMARY_INPUT_KEYS]);
			expect(query).not.toHaveBeenCalled();
			expect(prepare).not.toHaveBeenCalled();
			for (const field of ["input", "updatedInput", "brokenInputOverride", "output", "metadata"])
				expect(parent).not.toHaveProperty(field);
			expect(JSON.stringify(parent)).not.toContain("SECRET-BODY");
			expect(JSON.stringify(parent).length).toBeLessThan(1_000);
			expect(self).not.toHaveProperty("input");
			expect(self).not.toHaveProperty("inputSummary");
		} finally {
			prepare.mockRestore();
			query.mockRestore();
		}
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

describe("ordinary tool result commit boundary", () => {
	async function seedResult(suffix: string) {
		const narratorId = `ordinary-result-${suffix}`;
		const messageId = `${narratorId}-message`;
		const toolUseId = `${narratorId}-call`;
		const binding = { toolCallId: `${narratorId}-tool`, attempt: 1 };
		const now = new Date().toISOString();
		const input = { file_path: "before.txt", content: "before" };
		await db.insert(narrators).values({ id: narratorId, createdAt: now, updatedAt: now });
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: "Write", input }],
			createdAt: now,
		});
		await db.insert(narratorMessageRefs).values({
			id: `${narratorId}-ref`,
			narratorId,
			messageId,
			seq: 1,
		});
		await db.insert(narratorToolCalls).values({
			id: binding.toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName: "Write",
			inputJson: input,
			status: "running",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			executionStartedAt: now,
			createdAt: now,
		});
		const ctx: EventHandlerContext = {
			...makeMainContext(),
			narratorId,
			broadcastTargetId: narratorId,
			conversationId: narratorId,
			requireToolCallBinding: true,
			toolExecutionReceipts: new Map([[toolUseId, { messageId, binding }]]),
		};
		return {
			ctx,
			binding,
			event: {
				type: "tool_result" as const,
				toolUseId,
				toolName: "Write",
				toolCallBinding: binding,
				input,
				updatedInput: { file_path: "after.txt", content: "after" },
				output: "saved",
				isError: false,
			},
			row: () =>
				db.query.narratorToolCalls.findFirst({
					where: eq(narratorToolCalls.id, binding.toolCallId),
				}),
			owner: () => db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) }),
			cleanup: async () => {
				clearStreamingSnapshot(narratorId);
				await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
				await cleanupFileContextNarrator(narratorId);
			},
		};
	}

	test("non-lock persistence failure is attempted once and retains its cause with bounded diagnostics", async () => {
		const f = await seedResult("non-lock");
		const { narratorStore } = await import("../narrator-store");
		const { logger } = await import("../../lib/logger");
		const driver = Object.assign(new Error("constraint failed"), {
			code: "SQLITE_CONSTRAINT",
			errno: 19,
		});
		const failure = new Error("Failed query: update private_sql_secret params: private_input", {
			cause: driver,
		});
		const settle = spyOn(narratorStore, "settleTool").mockRejectedValue(failure);
		const log = spyOn(logger, "error").mockImplementation(() => {});
		const onToolResult = mock(() => {});
		const onGitTrack = mock(() => {});
		try {
			const caught = await processEvent(f.event, f.ctx, { onToolResult, onGitTrack }).catch(
				(error: unknown) => error,
			);
			expect(caught).toBeInstanceOf(CriticalEventPersistenceError);
			expect(caught).toMatchObject({
				cause: failure,
				message: "Tool result could not be persisted: constraint failed",
			});
			expect(settle).toHaveBeenCalledTimes(1);
			expect(log).toHaveBeenCalledWith("Failed to persist tool result", {
				narratorId: f.ctx.narratorId,
				toolUseId: f.event.toolUseId,
				phase: "settle-tool",
				code: "SQLITE_CONSTRAINT",
				errno: 19,
			});
			expect(JSON.stringify(log.mock.calls)).not.toContain("private_");
			expect(onToolResult).not.toHaveBeenCalled();
			expect(onGitTrack).not.toHaveBeenCalled();
			expect(broadcastMessages).toEqual([]);
		} finally {
			settle.mockRestore();
			log.mockRestore();
			await f.cleanup();
		}
	});

	test("exhausted transaction locks do not publish completion, hand off Write input or run hooks", async () => {
		const f = await seedResult("locked");
		const { narratorStore } = await import("../narrator-store");
		const { toolInputStreamSource } = await import("../tool-input-stream-source");
		const failure = Object.assign(new Error("SQLITE_BUSY: database is locked"), {
			code: "SQLITE_BUSY",
			errno: 5,
		});
		const transaction = spyOn(db, "transaction").mockImplementation(() => {
			throw failure;
		});
		const settle = spyOn(narratorStore, "settleTool");
		const handoff = spyOn(toolInputStreamSource, "handoff");
		const onToolResult = mock(() => {});
		const onGitTrack = mock(() => {});
		try {
			const caught = await processEvent(f.event, f.ctx, { onToolResult, onGitTrack }).catch(
				(error: unknown) => error,
			);
			expect(caught).toBeInstanceOf(CriticalEventPersistenceError);
			expect(caught).toMatchObject({ cause: failure });
			expect(settle).toHaveBeenCalledTimes(1);
			expect(transaction).toHaveBeenCalledTimes(5);
			expect(await f.row()).toMatchObject({
				status: "running",
				outputJson: null,
				inputJson: f.event.input,
			});
			expect((await f.owner())?.messageVersion).toBe(0);
			expect(handoff).not.toHaveBeenCalled();
			expect(onToolResult).not.toHaveBeenCalled();
			expect(onGitTrack).not.toHaveBeenCalled();
			expect(broadcastMessages).toEqual([]);
		} finally {
			transaction.mockRestore();
			settle.mockRestore();
			handoff.mockRestore();
			await f.cleanup();
		}
	});

	test("a committed retry hands off Write input, completes and runs each hook in order once", async () => {
		const f = await seedResult("retry-success");
		const { narratorStore } = await import("../narrator-store");
		const { toolInputStreamSource } = await import("../tool-input-stream-source");
		const order: string[] = [];
		const original = toolInputStreamSource.handoff.bind(toolInputStreamSource);
		const handoff = spyOn(toolInputStreamSource, "handoff").mockImplementation(async (...args) => {
			order.push("handoff");
			return original(...args);
		});
		const settle = spyOn(narratorStore, "settleTool");
		const originalTransaction = db.transaction.bind(db);
		let attempt = 0;
		const transaction = spyOn(db, "transaction").mockImplementation((write, config) => {
			if (++attempt < 5) throw new Error("SQLITE_BUSY: database is locked");
			return originalTransaction(write, config);
		});
		const onToolResult = mock(() => {
			expect(broadcastMessages).toContainEqual(
				expect.objectContaining({ type: "tool_completed", toolUseId: f.event.toolUseId }),
			);
			order.push("onToolResult");
		});
		const onGitTrack = mock(() => {
			order.push("onGitTrack");
		});
		try {
			await processEvent(f.event, f.ctx, { onToolResult, onGitTrack });
			expect(settle).toHaveBeenCalledTimes(1);
			expect(transaction).toHaveBeenCalledTimes(5);
			expect(settle.mock.calls[0]?.[1]).toMatchObject({
				expectedBinding: { ...f.binding, narratorId: f.ctx.narratorId },
				includeLegacyParentVersions: true,
			});
			expect(await f.row()).toMatchObject({
				status: "success",
				outputJson: "saved",
				inputJson: f.event.updatedInput,
			});
			expect((await f.owner())?.messageVersion).toBe(1);
			expect(handoff).toHaveBeenCalledTimes(1);
			expect(handoff.mock.calls[0]?.[3]).toBe(true);
			expect(onToolResult).toHaveBeenCalledTimes(1);
			expect(onGitTrack).toHaveBeenCalledTimes(1);
			expect(order).toEqual(["handoff", "onToolResult", "onGitTrack"]);
			expect(
				(broadcastMessages as Array<{ type: string }>).filter(
					(message) => message.type === "tool_completed",
				),
			).toHaveLength(1);
		} finally {
			transaction.mockRestore();
			settle.mockRestore();
			handoff.mockRestore();
			await f.cleanup();
		}
	});

	test("a binding retired during backoff cannot overwrite the next execution attempt", async () => {
		const f = await seedResult("stale-backoff");
		const { narratorStore } = await import("../narrator-store");
		const { toolInputStreamSource } = await import("../tool-input-stream-source");
		let release: (() => void) | undefined;
		const failed = new Promise<void>((resolve) => {
			release = resolve;
		});
		const originalTransaction = db.transaction.bind(db);
		const transaction = spyOn(db, "transaction")
			.mockImplementation(originalTransaction)
			.mockImplementationOnce(() => {
				release?.();
				throw new Error("SQLITE_BUSY: database is locked");
			});
		const settle = spyOn(narratorStore, "settleTool");
		const handoff = spyOn(toolInputStreamSource, "handoff");
		const onToolResult = mock(() => {});
		const onGitTrack = mock(() => {});
		const pending = processEvent(f.event, f.ctx, { onToolResult, onGitTrack }).catch(
			(error: unknown) => error,
		);
		try {
			await failed;
			expect(sqlite.inTransaction).toBe(false);
			const nextInput = { file_path: "next.txt", content: "next attempt" };
			await db
				.update(narratorToolCalls)
				.set({ executionAttempt: 2, inputJson: nextInput })
				.where(eq(narratorToolCalls.id, f.binding.toolCallId));
			const caught = await pending;
			expect(caught).toBeInstanceOf(CriticalEventPersistenceError);
			expect(settle).toHaveBeenCalledTimes(1);
			expect(transaction).toHaveBeenCalledTimes(2);
			expect(await f.row()).toMatchObject({
				executionAttempt: 2,
				status: "running",
				outputJson: null,
				inputJson: nextInput,
			});
			expect((await f.owner())?.messageVersion).toBe(0);
			expect(handoff).not.toHaveBeenCalled();
			expect(onToolResult).not.toHaveBeenCalled();
			expect(onGitTrack).not.toHaveBeenCalled();
			expect(broadcastMessages).toEqual([]);
		} finally {
			await pending;
			transaction.mockRestore();
			settle.mockRestore();
			handoff.mockRestore();
			await f.cleanup();
		}
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

			const saved = readTestMessageContent(sqlite, savedMessageId as string);
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
			expect(getToolIds(saved)).toEqual(expected);

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

	test("EnterPlanMode 在自身 block_complete 落库时准备，assistant_message 不再重复准备", async () => {
		const narratorId = `enter-plan-prepare-${Date.now()}`;
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
		const order: string[] = [];
		const prepared: Array<[string, string]> = [];
		const hooks = {
			onPrepareEnterPlanMode: async (toolCallId: string, toolUseId: string) => {
				order.push("prepare");
				prepared.push([toolCallId, toolUseId]);
			},
			onAssistantMessageFinalized: async () => {
				order.push("finalized");
			},
		};

		try {
			await processEvent(
				{
					type: "block_complete",
					block: { type: "tool_use", toolUseId: "enter-plan", name: "EnterPlanMode", input: {} },
					// The loop may start the call once it holds the binding: prepared state
					// must already exist by then.
					onToolPersisted: () => {
						order.push("persisted");
					},
				},
				ctx,
				hooks,
			);
			savedMessageId = partialId;
			expect(order).toEqual(["prepare", "persisted"]);
			expect(prepared).toHaveLength(1);
			expect(prepared[0]?.[1]).toBe("enter-plan");
			expect(ctx.preparedPlanModeToolCalls?.get("enter-plan")).toBe(prepared[0]?.[0]);

			await processEvent(
				{
					type: "assistant_message",
					text: "",
					toolUses: [{ toolUseId: "enter-plan", name: "EnterPlanMode", input: {} }],
				},
				ctx,
				hooks,
			);
			expect(prepared).toHaveLength(1);
			expect(order).toEqual(["prepare", "persisted", "finalized"]);
			expect(partialId).toBeUndefined();
		} finally {
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
					input: { description: "original plan" },
					updatedInput: { description: "uncommitted redirect" },
					brokenInputOverride: { description: "uncommitted repair" },
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
		const completed = broadcastMessages.filter(
			(message) => (message as { type?: string }).type === "tool_completed",
		) as Array<Record<string, unknown>>;
		expect(completed).toHaveLength(2);
		for (const message of completed) {
			expect(message.status).toBe("fail");
			expect(message).not.toHaveProperty("input");
			expect(message).not.toHaveProperty("updatedInput");
			expect(message).not.toHaveProperty("inputSummary");
		}
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
					input: { description: "original plan" },
					updatedInput: { description: "uncommitted redirect" },
					brokenInputOverride: { description: "uncommitted repair" },
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
		const completed = broadcastMessages.filter(
			(message) => (message as { type?: string }).type === "tool_completed",
		) as Array<Record<string, unknown>>;
		expect(completed).toHaveLength(2);
		for (const message of completed) {
			expect(message.status).toBe("fail");
			expect(message).not.toHaveProperty("input");
			expect(message).not.toHaveProperty("updatedInput");
			expect(message).not.toHaveProperty("inputSummary");
		}
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
		const current = readTestMessageContent(sqlite, partialId);
		const snapshot = readTestMessageContent(sqlite, sharedId);
		expect(current).toEqual([{ type: "text", text: "historical prefix" }]);
		expect(JSON.stringify(snapshot)).toContain("current thought");
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

describe("subagent live output char count", () => {
	function startOutputContext(
		ctx = makeSubagentContext(),
		logicalRunId = "count-run",
		toolCallId = "agent-tool-pk",
		attempt = 0,
		keepAnnouncements = false,
	): CountEventContext {
		// A newly admitted child run owns a fresh stream; its parent's card state survives.
		clearStreamingSnapshot(ctx.narratorId);
		let owner = outputCountOwners.get(ctx.narratorId);
		if (!owner) {
			owner = tryClaimExecution(ctx.narratorId, "run") ?? undefined;
			if (!owner) throw new Error("Expected a fresh count run owner");
			outputCountOwners.set(ctx.narratorId, owner);
		}
		const run: RunControl = {
			logicalRunId,
			deliverTo: {
				narratorId: ctx.broadcastTargetId,
				toolUseId: ctx.parentToolUseId ?? PARENT_TOOL_USE_ID,
				toolCallId,
				attempt,
			},
			startedAt: Date.now(),
			cancel: new AbortController(),
			timedOut: false,
			terminal: new Promise(() => {}),
		};
		setRunControl(owner, run);
		const identity = {
			childNarratorId: ctx.narratorId,
			logicalRunId,
			toolUseId: run.deliverTo?.toolUseId ?? PARENT_TOOL_USE_ID,
			toolCallId,
			attempt,
		};
		startSubagentOutputCharCount(ctx.narratorId, logicalRunId);
		if (!keepAnnouncements) {
			broadcastMessages.length = 0;
			broadcastTargets.length = 0;
		}
		return { ...ctx, subagentOutputIdentity: identity };
	}

	function startRequest(ctx: EventHandlerContext, requestId: string) {
		return processEvent(
			{ type: "api_request_start", requestId, provider: "test", model: "test" },
			ctx,
		);
	}

	function body(ctx: EventHandlerContext, text: string, offset = 0, blockId = "body") {
		return processEvent(
			{ type: "stream_text", blockRevision: offset + 1, blockTextOffset: offset, text, blockId },
			ctx,
		);
	}

	/** The parent's own Agent call owns a snapshot chunk once `tool_call` ran. */
	async function parentAgentChunk(toolUseId = PARENT_TOOL_USE_ID) {
		await processEvent(
			{
				type: "tool_call",
				toolUseId,
				toolName: "Agent",
				input: { prompt: "go" },
			},
			makeMainContext(),
		);
	}

	function toolOutputFrames() {
		return (broadcastMessages as Array<Record<string, unknown>>).filter(
			(message) => message.type === "tool_output",
		);
	}

	/** Wait for the throttled trailing flush to land a given cumulative count. */
	async function untilOutput(count: string) {
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline) {
			if (toolOutputFrames().at(-1)?.output === count) return;
			await Bun.sleep(10);
		}
		expect(toolOutputFrames().at(-1)?.output).toBe(count);
	}

	test("counts a subagent's streamed text and ticks the parent's Agent card", async () => {
		await parentAgentChunk();
		const sub = startOutputContext();
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 1,
				blockTextOffset: 0,
				text: "Hello",
				blockId: "blk-1",
			},
			sub,
		);
		const frames = toolOutputFrames();
		expect(frames.at(-1)).toMatchObject({
			type: "tool_output",
			narratorId: PARENT_NARRATOR_ID,
			toolUseId: PARENT_TOOL_USE_ID,
			output: "5",
		});
		// Not a child-tool frame: the parent page must fold this into its OWN card.
		expect(frames.at(-1)).not.toHaveProperty("parentToolUseId");
		expect(frames.at(-1)?.subagentOutputCount).toMatchObject({
			...sub.subagentOutputIdentity,
			count: 5,
			active: true,
		});
		// Run projections restore the count independently of transient tool chunks.
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([
			{ ...sub.subagentOutputIdentity, count: 5, active: true },
		]);
		expect(
			getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get(PARENT_TOOL_USE_ID)?.streamingOutput,
		).toBeUndefined();
	});

	test("throttled frames keep only the latest cumulative total", async () => {
		await parentAgentChunk();
		const sub = startOutputContext();
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 2,
				blockTextOffset: 5,
				text: "Hello",
				blockId: "blk-1",
			},
			sub,
		);
		// Inside the throttle window this only arms the trailing flush.
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 3,
				blockTextOffset: 10,
				text: ", world",
				blockId: "blk-1",
			},
			sub,
		);
		expect(toolOutputFrames()).toHaveLength(1);
		// The trailing flush lands the FULL accumulated count ("Hello, world"), not
		// the last delta.
		await untilOutput("12");
	});

	test("an overlapping replay does not double-count", async () => {
		await parentAgentChunk();
		const sub = startOutputContext();
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 4,
				blockTextOffset: 17,
				text: "Hello",
				blockId: "blk-1",
			},
			sub,
		);
		// A resend with an absolute offset overlapping the streamed prefix (resume).
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 5,
				text: "Hello, world",
				blockId: "blk-1",
				blockTextOffset: 0,
			},
			sub,
		);
		// "Hello, world".length — never 5 + 12.
		await untilOutput("12");
	});

	test("a primary narrator's own text never enters the subagent counter", async () => {
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 6,
				blockTextOffset: 34,
				text: "mine",
				blockId: "blk-1",
			},
			makeMainContext(),
		);
		expect(toolOutputFrames()).toHaveLength(0);
	});

	test("broadcasts the accumulated total while the parent has no transient tool chunk", async () => {
		const sub = startOutputContext();
		// The durable Agent card remains a destination even when its stream chunk is gone.
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 7,
				blockTextOffset: 38,
				text: "Hello",
				blockId: "blk-1",
			},
			sub,
		);
		expect(toolOutputFrames().at(-1)?.output).toBe("5");
		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)).toBeUndefined();
		await parentAgentChunk();
		await processEvent(
			{ type: "stream_text", blockRevision: 8, blockTextOffset: 43, text: "!", blockId: "blk-1" },
			sub,
		);
		await untilOutput("6");
	});

	test("iteration-level snapshot resets do NOT retire the counter (run-scoped total)", async () => {
		await parentAgentChunk();
		const sub = startOutputContext();
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 9,
				blockTextOffset: 44,
				text: "Hello",
				blockId: "blk-1",
			},
			sub,
		);
		// A child with no subagents of its own hits `clearStreamingSnapshot` via
		// `clearAuthorStreamingSnapshot` on EVERY `assistant_message` — the counter
		// must survive it, or the badge would restart from zero between iterations.
		clearStreamingSnapshot(SUBAGENT_NARRATOR_ID);
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 1,
				blockTextOffset: 0,
				text: ", world",
				blockId: "blk-2",
			},
			sub,
		);
		await untilOutput("12");
	});

	test("a discarded attempt restarts the count with the replayed stream", async () => {
		await parentAgentChunk();
		const sub = startOutputContext();
		await startRequest(sub, "discarded-body-request");
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 10,
				blockTextOffset: 49,
				text: "Hello",
				blockId: "blk-1",
			},
			sub,
		);
		await untilOutput("5");
		// The dead-turn reset retracts this provider request's body.
		await processEvent({ type: "stream_reset" }, sub);
		await startRequest(sub, "retried-body-request");
		await processEvent(
			{ type: "stream_text", blockRevision: 11, blockTextOffset: 54, text: "Hi", blockId: "blk-1" },
			sub,
		);
		await untilOutput("2");
	});

	test("a successful response survives a later reasoning-only request's stream reset", async () => {
		const sub = startOutputContext();
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id: sub.narratorId, createdAt: now, updatedAt: now });
		try {
			await startRequest(sub, "completed-response-request");
			await body(sub, "successful reply");
			await processEvent({ type: "api_request_end", requestId: "completed-response-request" }, sub);
			await processEvent(
				{ type: "assistant_message", text: "successful reply", toolUses: [] },
				sub,
			);
			expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)[0]?.count).toBe(16);
			await startRequest(sub, "reasoning-only-request");
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: "reasoning",
					blockRevision: 1,
					blockTextOffset: 0,
					text: "thinking only",
				},
				sub,
			);
			await processEvent({ type: "api_request_end", requestId: "reasoning-only-request" }, sub);
			await processEvent({ type: "stream_reset" }, sub);
			expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([
				{ ...sub.subagentOutputIdentity, count: 16, active: true },
			]);
		} finally {
			await cleanupFileContextNarrator(sub.narratorId);
		}
	});

	test("discard retracts only its real provider request while completed and newer requests survive", async () => {
		const sub = startOutputContext();
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id: sub.narratorId, createdAt: now, updatedAt: now });
		try {
			await startRequest(sub, "retained-response-request");
			await body(sub, "kept");
			await processEvent({ type: "api_request_end", requestId: "retained-response-request" }, sub);
			await processEvent({ type: "assistant_message", text: "kept", toolUses: [] }, sub);
			await startRequest(sub, "retracted-response-request");
			await body(sub, "temporary", 0, "reused-body-id");
			expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)[0]?.count).toBe(13);
			await processEvent(
				{ type: "attempt_discarded", requestId: "retracted-response-request" },
				sub,
			);
			expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)[0]?.count).toBe(4);
			expect(toolOutputFrames().at(-1)?.subagentOutputCount).toMatchObject({
				count: 4,
				active: true,
			});
			await processEvent({ type: "api_request_end", requestId: "retracted-response-request" }, sub);
			await startRequest(sub, "retry-response-request");
			await body(sub, "retry", 0, "reused-body-id");
			await processEvent(
				{ type: "attempt_discarded", requestId: "retracted-response-request" },
				sub,
			);
			expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)[0]?.count).toBe(9);
			await processEvent({ type: "api_request_end", requestId: "retry-response-request" }, sub);
			await processEvent({ type: "assistant_message", text: "retry", toolUses: [] }, sub);
			await processEvent({ type: "stream_reset" }, sub);
			expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)[0]?.count).toBe(9);
		} finally {
			await cleanupFileContextNarrator(sub.narratorId);
		}
	});

	test("a replay fully inside the streamed span never shrinks the count", async () => {
		await parentAgentChunk();
		const sub = startOutputContext();
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 12,
				text: "x".repeat(100),
				blockId: "blk-1",
				blockTextOffset: 0,
			},
			sub,
		);
		await untilOutput("100");
		// A resend covering [20, 50) — entirely inside the existing span.
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 13,
				text: "y".repeat(30),
				blockId: "blk-1",
				blockTextOffset: 20,
			},
			sub,
		);
		await processEvent(
			{ type: "stream_text", blockRevision: 14, text: "z", blockId: "blk-1", blockTextOffset: 100 },
			sub,
		);
		await untilOutput("101");
	});

	test("registers zero without text and excludes reasoning from the JS string-length count", async () => {
		const sub = startOutputContext(makeSubagentContext(), "zero-run", "zero-pk", 0, true);
		expect(toolOutputFrames().at(-1)).toMatchObject({
			output: "0",
			subagentOutputCount: { ...sub.subagentOutputIdentity, count: 0, active: true },
		});
		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)).toBeUndefined();
		await processEvent(
			{
				type: "stream_reasoning",
				text: "private reasoning",
				blockId: "reasoning",
				blockRevision: 1,
				blockTextOffset: 0,
			},
			sub,
		);
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)[0]?.count).toBe(0);
		await body(sub, "𠮷");
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([
			{ ...sub.subagentOutputIdentity, count: 2, active: true },
		]);
		expect(JSON.stringify(getSubagentOutputCounts(PARENT_NARRATOR_ID))).not.toContain("private");
	});

	test("parent tool result, persisted response and turn cleanup preserve a background child's total", async () => {
		const parentId = "output-count-parent-boundaries";
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id: parentId, createdAt: now, updatedAt: now });
		const parent = { ...makeMainContext(), narratorId: parentId, broadcastTargetId: parentId };
		const sub = startOutputContext({ ...makeSubagentContext(), broadcastTargetId: parentId });
		try {
			await processEvent(
				{
					type: "tool_call",
					toolUseId: PARENT_TOOL_USE_ID,
					toolName: "Agent",
					input: { prompt: "go" },
				},
				parent,
			);
			await body(sub, "first");
			await processEvent(
				{
					type: "tool_result",
					toolUseId: PARENT_TOOL_USE_ID,
					toolName: "Agent",
					output: "background_task_id: child",
					isError: false,
				},
				parent,
			);
			expect(getStreamingSnapshot(parentId)?.toolChunks.has(PARENT_TOOL_USE_ID)).toBe(false);
			await body(sub, "-second", 5);
			await processEvent({ type: "assistant_message", text: "Delegated", toolUses: [] }, parent);
			clearStreamingSnapshot(parentId);
			await body(sub, "-third", 12);
			await untilOutput("18");
			expect(getStreamingSnapshot(parentId)).toBeUndefined();
			expect(getSubagentOutputCounts(parentId)).toEqual([
				{ ...sub.subagentOutputIdentity, count: 18, active: true },
			]);
		} finally {
			clearStreamingSnapshot(parentId);
			await cleanupFileContextNarrator(parentId);
		}
	});

	test("exact trusted receipt attempts travel with tool_started and its reconnect chunk", async () => {
		const parent = makeMainContext();
		parent.toolExecutionReceipts = new Map([
			[
				PARENT_TOOL_USE_ID,
				{ messageId: "saved-step", binding: { toolCallId: "exact-pk", attempt: 3 } },
			],
		]);
		await processEvent(
			{
				type: "tool_call",
				toolUseId: PARENT_TOOL_USE_ID,
				toolName: "Agent",
				input: { prompt: "go" },
			},
			parent,
		);
		expect(broadcastMessages.at(-1)).toMatchObject({
			type: "tool_started",
			toolCallId: "exact-pk",
			executionAttempt: 3,
		});
		expect(
			getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get(PARENT_TOOL_USE_ID),
		).toMatchObject({
			toolCallId: "exact-pk",
			executionAttempt: 3,
		});
	});

	test("a new run retires its exact predecessor before announcing zero and ignores late old events", async () => {
		await parentAgentChunk();
		const parentSnapshot = getStreamingSnapshot(PARENT_NARRATOR_ID);
		const old = startOutputContext();
		await body(old, "old body");
		const oldIdentity = old.subagentOutputIdentity;
		broadcastMessages.length = 0;
		const next = startOutputContext(makeSubagentContext(), "next-run", "agent-tool-pk", 0, true);
		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)).toBe(parentSnapshot);
		expect(toolOutputFrames()).toEqual([
			expect.objectContaining({ subagentOutputCount: { ...oldIdentity, count: 8, active: false } }),
			expect.objectContaining({
				subagentOutputCount: { ...next.subagentOutputIdentity, count: 0, active: true },
			}),
		]);
		await body(next, "next");
		await body(old, "late old body", 8, "late-old-run-body");
		expect(
			getStreamingSnapshot(SUBAGENT_NARRATOR_ID)?.streamingBlocks.some(
				(block) => block.type === "text" && block.id === "late-old-run-body",
			),
		).toBe(true);
		await processEvent({ type: "stream_reset" }, old);
		retireSubagentOutputCharCount(SUBAGENT_NARRATOR_ID, "count-run");
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([
			{ ...next.subagentOutputIdentity, count: 4, active: true },
		]);
		startSubagentOutputCharCount(SUBAGENT_NARRATOR_ID, "next-run");
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)[0]?.count).toBe(4);
	});

	test("late attempts and reused wire ids stay isolated by narrator and persisted tool PK", async () => {
		const old = startOutputContext();
		await body(old, "old");
		const next = startOutputContext(makeSubagentContext(), "attempt-run", "replacement-pk", 1);
		const peer = startOutputContext(
			{
				...makeSubagentContext(),
				narratorId: "other-count-child",
				broadcastTargetId: "other-count-parent",
			},
			"peer-run",
			"peer-pk",
		);
		await body(next, "new");
		await body(peer, "peer body");
		await body(old, "late", 3, "late-old-attempt-body");
		const currentIdentity = next.subagentOutputIdentity;
		if (!currentIdentity) throw new Error("Expected exact count identity");
		await body(
			{ ...next, subagentOutputIdentity: { ...currentIdentity, attempt: 0 } },
			"wrong attempt",
			0,
			"wrong-attempt-body",
		);
		await body(
			{ ...next, subagentOutputIdentity: { ...currentIdentity, toolCallId: "old-pk" } },
			"wrong PK",
			0,
			"wrong-pk-body",
		);
		const receivedBlocks = getStreamingSnapshot(SUBAGENT_NARRATOR_ID)
			?.streamingBlocks.filter((block) => block.type === "text")
			.map((block) => block.id);
		expect(receivedBlocks).toContain("late-old-attempt-body");
		expect(receivedBlocks).toContain("wrong-attempt-body");
		expect(receivedBlocks).toContain("wrong-pk-body");
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([
			{ ...next.subagentOutputIdentity, count: 3, active: true },
		]);
		expect(getSubagentOutputCounts("other-count-parent")).toEqual([
			{ ...peer.subagentOutputIdentity, count: 9, active: true },
		]);
	});

	test("two live child runs sharing one parent's wire id retain separate persisted-tool identities", async () => {
		const first = startOutputContext();
		const second = startOutputContext(
			{ ...makeSubagentContext(), narratorId: "same-parent-other-child" },
			"same-parent-other-run",
			"same-parent-other-pk",
		);
		await body(first, "one");
		await body(second, "second");
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([
			{ ...first.subagentOutputIdentity, count: 3, active: true },
			{ ...second.subagentOutputIdentity, count: 6, active: true },
		]);
		retireSubagentOutputCharCount(first.narratorId, "count-run");
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([
			{ ...second.subagentOutputIdentity, count: 6, active: true },
		]);
	});

	test("retirement cancels its trailing timer and an already-queued old callback cannot emit a new run", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(10_000);
		const timers = spyOn(globalThis, "setTimeout");
		const cancelled = spyOn(globalThis, "clearTimeout");
		try {
			const sub = startOutputContext();
			await body(sub, "a");
			await body(sub, "b", 1);
			const scheduled = timers.mock.calls.at(-1);
			if (!scheduled || typeof scheduled[0] !== "function")
				throw new Error("Expected a count timer");
			retireSubagentOutputCharCount(SUBAGENT_NARRATOR_ID, "count-run");
			expect(cancelled).toHaveBeenCalled();
			expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([]);
			const next = startOutputContext(makeSubagentContext(), "timer-next-run");
			await body(next, "next");
			const emitted = toolOutputFrames().length;
			scheduled[0]();
			expect(toolOutputFrames()).toHaveLength(emitted);
			expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)[0]?.count).toBe(4);
		} finally {
			timers.mockRestore();
			cancelled.mockRestore();
			clock.mockRestore();
		}
	});

	test("live owner cancellation removes its projection and prevents late body events from reviving it", async () => {
		const sub = startOutputContext();
		await body(sub, "a");
		await body(sub, "b", 1);
		getRunControl(SUBAGENT_NARRATOR_ID)?.cancel.abort("cancelled");
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([]);
		expect(toolOutputFrames().at(-1)?.subagentOutputCount).toMatchObject({
			count: 2,
			active: false,
		});
		const emitted = toolOutputFrames().length;
		await body(sub, "late", 2);
		startSubagentOutputCharCount(SUBAGENT_NARRATOR_ID, "count-run");
		expect(toolOutputFrames()).toHaveLength(emitted);
	});

	test("Watch registration and completion leave live counts on the spawning Agent card", async () => {
		const main = makeMainContext();
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "watch-child",
				toolName: "Watch",
				input: { id: SUBAGENT_NARRATOR_ID, type: "agent" },
			},
			main,
		);
		const sub = startOutputContext();
		await body(sub, "child");
		expect(toolOutputFrames().every((frame) => frame.toolUseId === PARENT_TOOL_USE_ID)).toBe(true);
		expect(toolOutputFrames().at(-1)).toMatchObject({
			output: "5",
			subagentOutputCount: { count: 5, active: true },
		});
		expect(
			getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("watch-child")?.streamingOutput,
		).toBeUndefined();
		await processEvent(
			{
				type: "tool_result",
				toolUseId: "watch-child",
				toolName: "Watch",
				output: "Observation registered",
			},
			main,
		);
		broadcastMessages.length = 0;
		await body(sub, "!", 5);
		await untilOutput("6");
		expect(toolOutputFrames().every((frame) => frame.toolUseId === PARENT_TOOL_USE_ID)).toBe(true);
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)[0]?.count).toBe(6);
	});

	test("ordinary numeric stdout never gains Agent run metadata", async () => {
		await parentAgentChunk("plain-output");
		await processEvent(
			{ type: "tool_output", toolUseId: "plain-output", output: "123" },
			makeMainContext(),
		);
		expect(toolOutputFrames().at(-1)).toMatchObject({ output: "123" });
		expect(toolOutputFrames().at(-1)).not.toHaveProperty("subagentOutputCount");
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([]);
	});

	test("run end flushes the final count and retires the counter", async () => {
		await parentAgentChunk();
		const sub = startOutputContext();
		await processEvent(
			{
				type: "stream_text",
				blockRevision: 15,
				blockTextOffset: 59,
				text: "Hello",
				blockId: "blk-1",
			},
			sub,
		);
		// Inside the throttle window; the flush happens synchronously on retire.
		await processEvent(
			{ type: "stream_text", blockRevision: 16, blockTextOffset: 64, text: "!!", blockId: "blk-1" },
			sub,
		);
		expect(toolOutputFrames()).toHaveLength(1);
		retireSubagentOutputCharCount(SUBAGENT_NARRATOR_ID, "count-run");
		expect(toolOutputFrames().at(-1)).toMatchObject({
			output: "7",
			subagentOutputCount: { ...sub.subagentOutputIdentity, count: 7, active: false },
		});
		expect(getSubagentOutputCounts(PARENT_NARRATOR_ID)).toEqual([]);
	});
});

describe("quota and payment frames stay with their own session", () => {
	const framesOf = (type: string) =>
		(broadcastMessages as Array<Record<string, unknown>>).filter(
			(message) => message.type === type,
		);
	/** The frame delivered to `narratorId`; the mock records target and payload in lockstep. */
	const deliveredTo = (type: string, narratorId: string) =>
		(broadcastMessages as Array<Record<string, unknown>>).filter(
			(message, index) => message.type === type && broadcastTargets[index] === narratorId,
		)[0];

	test("a subagent quota frame is tagged for the parent and stripped for its own page", async () => {
		await processEvent(
			{ type: "quota_balance", quotaBalance: "sub-12", detailedQuotaBalance: "sub details" },
			makeSubagentContext(),
		);
		expect(framesOf("quota_balance")).toHaveLength(2);
		// The parent page must be able to tell this balance is not its own.
		expect(deliveredTo("quota_balance", PARENT_NARRATOR_ID)).toMatchObject({
			narratorId: PARENT_NARRATOR_ID,
			quotaBalance: "sub-12",
			isSubagent: true,
		});
		const self = deliveredTo("quota_balance", SUBAGENT_NARRATOR_ID);
		expect(self).toMatchObject({
			narratorId: SUBAGENT_NARRATOR_ID,
			quotaBalance: "sub-12",
			detailedQuotaBalance: "sub details",
		});
		expect(self).not.toHaveProperty("isSubagent");
	});

	test("a primary narrator quota frame carries no subagent marker", async () => {
		await processEvent({ type: "quota_balance", quotaBalance: "12.5" }, makeMainContext());
		const [frame] = framesOf("quota_balance");
		expect(frame).toMatchObject({ narratorId: PARENT_NARRATOR_ID, quotaBalance: "12.5" });
		expect(frame).not.toHaveProperty("isSubagent");
	});

	test("a frame routed to another narrator is tagged even without a tool_use link", async () => {
		// The route, not the placement, decides the audience: a child session addressed
		// to its parent must still be recognizable as such on the parent's page.
		const ctx = { ...makeSubagentContext(), parentToolUseId: undefined };
		await processEvent({ type: "quota_balance", quotaBalance: "sub-9" }, ctx);
		expect(broadcastTargets).toEqual([PARENT_NARRATOR_ID]);
		expect(framesOf("quota_balance")[0]).toMatchObject({
			narratorId: PARENT_NARRATOR_ID,
			isSubagent: true,
		});
	});

	test("a subagent payment_required is tagged for the parent and stripped for its own page", async () => {
		await processEvent(
			{
				type: "payment_required",
				message: "insufficient balance",
				providerId: "nug-1",
				providerPrefix: "nug",
				balance: 0,
				required: 5,
				resumeAction: "retry",
			},
			makeSubagentContext(),
		);
		expect(deliveredTo("payment_required", PARENT_NARRATOR_ID)).toMatchObject({
			narratorId: PARENT_NARRATOR_ID,
			isSubagent: true,
		});
		const self = deliveredTo("payment_required", SUBAGENT_NARRATOR_ID);
		expect(self).toMatchObject({ narratorId: SUBAGENT_NARRATOR_ID });
		expect(self).not.toHaveProperty("isSubagent");
	});
});
