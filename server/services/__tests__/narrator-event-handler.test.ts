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
	retireSubagentOutputCharCount,
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

describe("reasoning translation durable boundaries", () => {
	const seal = (sourceText = "PRIVATE SOURCE BODY", blockId = "reason") => ({
		type: "reasoning_summary_sealed" as const,
		blockId,
		blockRevision: 1,
		nativePartId: "summary-0",
		nativePartIndex: 0,
		start: 0,
		end: sourceText.length,
		sourceText,
	});
	async function captureDiagnostics() {
		const { logger } = await import("../../lib/logger");
		const logs: Array<Record<string, unknown>> = [];
		const log = spyOn(logger, "info").mockImplementation((message, data) => {
			if (
				message === "Reasoning translation scheduling" ||
				message === "Reasoning translation task"
			)
				logs.push({ message, ...data });
		});
		return { log, logs };
	}

	test("summary seals translate during Await, tool seals reserve only the remaining source", async () => {
		const { settings } = await import("../../lib/settings");
		const agent = await import("../../lib/agent");
		const { narratorPersistence } = await import("../narrator-persistence");
		const { log, logs } = await captureDiagnostics();
		const generate = spyOn(agent, "summaryGenerate").mockResolvedValue({ text: "译文" });
		const patch = spyOn(narratorPersistence, "patchReasoningTranslationPart").mockImplementation(
			async (input) => ({
				messageId: input.messageId,
				blockId: "persisted-reasoning-block",
				elementId: input.elementId,
				blockRevision: 2,
				stateRevision: 7,
				translationGeneration: input.expected.generation,
				part: input.part,
			}),
		);
		const original = settings.agent.translateReasoning;
		settings.agent.translateReasoning = true;
		const id = "translation-durable-boundaries";
		const createdAt = new Date().toISOString();
		await db
			.insert(narrators)
			.values({ id, type: "primary", inheritMode: "fresh", createdAt, updatedAt: createdAt });
		let partialId: string | undefined;
		const ctx: EventHandlerContext = {
			...makeMainContext(),
			narratorId: id,
			broadcastTargetId: id,
			locale: "zh-CN",
			getPartialMessageId: () => partialId,
			setPartialMessageId: (value) => {
				partialId = value;
			},
		};
		const checkpoint = (text: string, revision: number) =>
			processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id: "reason", text, revision },
				},
				ctx,
			);
		try {
			await checkpoint("A", 1);
			await processEvent(
				{ type: "tool_use_chunk", toolUseId: "await", toolName: "Await", inputCharsTotal: 1 },
				ctx,
			);
			expect(generate).not.toHaveBeenCalled();
			await processEvent(
				{
					type: "reasoning_summary_sealed",
					blockId: "reason",
					blockRevision: 1,
					nativePartId: "summary-0",
					nativePartIndex: 0,
					start: 0,
					end: 1,
					sourceText: "A",
				},
				ctx,
			);
			// The foreground is idle inside its Await; the independent scheduler still runs.
			await Bun.sleep(350);
			expect(generate).toHaveBeenCalledTimes(1);
			expect(generate.mock.calls[0]?.[0]).toBe("A");
			const sent = broadcastMessages.find(
				(value) => (value as { type?: string }).type === "reasoning_translation_patch",
			);
			expect(sent).toMatchObject({
				blockId: "persisted-reasoning-block",
				elementId: "reason",
				blockRevision: 2,
				stateRevision: 7,
			});
			await checkpoint("A+B", 2);
			await processEvent(
				{
					type: "block_complete",
					block: { type: "tool_use", toolUseId: "await", name: "Await", input: {} },
				},
				ctx,
			);
			await Bun.sleep(5);
			expect(generate.mock.calls.map((call) => call[0])).toEqual(["A", "+B"]);
			expect(patch.mock.calls[1]?.[0].expected.generation).toBe(
				patch.mock.calls[0]?.[0].expected.generation,
			);
			await processEvent({ type: "done" }, ctx);
			expect(logs.find((entry) => entry.phase === "capture")).toMatchObject({
				reason: "captured",
				enabled: true,
				locale: "zh-CN",
				localeDefaulted: false,
				elementPresent: true,
				previous: false,
				stale: false,
				accepted: true,
				sourceCount: 1,
				sourceLimit: 96,
			});
			expect(
				logs.find((entry) => entry.phase === "schedule" && entry.trigger === "summary"),
			).toMatchObject({
				reason: "scan",
				sourceCount: 1,
				messageMatches: 1,
				boundaryMatches: 1,
				textMatches: 1,
				freezeCalls: 1,
			});
			expect(
				logs.find((entry) => entry.phase === "task" && entry.status === "started"),
			).toMatchObject({ pending: 1, active: 1, queued: 0 });
			expect(logs.find((entry) => entry.status === "idle")).toMatchObject({
				tasks: 2,
				blocks: 1,
				sourceBytes: 3,
				outputBytes: 12,
				skips: 0,
			});
			expect(ctx.reasoningTranslationDiagnostics).toBeUndefined();
		} finally {
			await processEvent({ type: "stream_reset" }, ctx);
			log.mockRestore();
			generate.mockRestore();
			patch.mockRestore();
			settings.agent.translateReasoning = original;
			clearStreamingSnapshot(id);
			await cleanupFileContextNarrator(id);
		}
	});

	test("entry gates report effective locale and summarize bounded suppressed diagnostics", async () => {
		const { settings } = await import("../../lib/settings");
		const { log, logs } = await captureDiagnostics();
		const original = settings.agent.translateReasoning;
		const context = (locale?: string): EventHandlerContext => ({
			...makeMainContext(),
			locale,
			getPartialMessageId: () => "pending",
			reasoningTranslationSources: new Map([
				["reason", { messageId: "pending", generation: "g", text: "PRIVATE SOURCE BODY" }],
			]),
		});
		const disabled = context("zh-CN");
		const defaultLocale = context();
		const explicitEnglish = context("en");
		const noSources = context("PRIVATE LANGUAGE TOKEN");
		noSources.reasoningTranslationSources = undefined;
		const noMessage = context("zh-CN");
		noMessage.getPartialMessageId = () => undefined;
		try {
			settings.agent.translateReasoning = false;
			await processEvent(seal(), disabled);
			settings.agent.translateReasoning = true;
			for (let index = 0; index < 1000; index++) await processEvent(seal(), defaultLocale);
			await processEvent(seal(), explicitEnglish);
			await processEvent(seal(), noSources);
			await processEvent(seal(), noMessage);
			expect(logs.find((entry) => entry.reason === "disabled")).toMatchObject({
				trigger: "summary",
				enabled: false,
				locale: "zh-CN",
				sourceCount: 1,
			});
			const english = logs.filter((entry) => entry.reason === "english");
			expect(english).toHaveLength(3);
			expect(english[0]).toMatchObject({ enabled: true, locale: "en", localeDefaulted: true });
			expect(english[2]).toMatchObject({ locale: "en", localeDefaulted: false });
			expect(logs.find((entry) => entry.reason === "no_sources")).toMatchObject({
				locale: "other",
				localeDefaulted: false,
				sourceCount: 0,
			});
			expect(logs.find((entry) => entry.reason === "no_message")).toMatchObject({
				trigger: "summary",
				boundaryPresent: true,
			});
			await processEvent({ type: "done" }, defaultLocale);
			const summaries = logs.filter((entry) => entry.phase === "response");
			expect(summaries).toHaveLength(1);
			expect(summaries[0]).toMatchObject({
				scheduleCalls: 1000,
				suppressed: 998,
				totalFreezeCalls: 0,
			});
			expect(defaultLocale.reasoningTranslationDiagnostics).toBeUndefined();
			expect(JSON.stringify(logs)).not.toContain("PRIVATE");
			expect(logs.every((entry) => entry.phase !== "task")).toBe(true);
		} finally {
			for (const ctx of [disabled, defaultLocale, explicitEnglish, noSources, noMessage])
				await processEvent({ type: "stream_reset" }, ctx);
			settings.agent.translateReasoning = original;
			log.mockRestore();
		}
	});

	test("source scan counts distinguish message, boundary and text mismatches", async () => {
		const { settings } = await import("../../lib/settings");
		const agent = await import("../../lib/agent");
		const { log, logs } = await captureDiagnostics();
		const generate = spyOn(agent, "summaryGenerate");
		const original = settings.agent.translateReasoning;
		settings.agent.translateReasoning = true;
		const ctx: EventHandlerContext = {
			...makeMainContext(),
			locale: "zh-CN",
			getPartialMessageId: () => "pending",
			reasoningTranslationSources: new Map([
				["wrong-message", { messageId: "another", generation: "g", text: "PRIVATE SOURCE BODY" }],
				["wrong-boundary", { messageId: "pending", generation: "g", text: "PRIVATE SOURCE BODY" }],
				["reason", { messageId: "pending", generation: "g", text: "PRIVATE SOURCE BODY" }],
			]),
		};
		try {
			await processEvent(seal("MISMATCHED PRIVATE BODY"), ctx);
			await processEvent(seal("PRIVATE SOURCE BODY", "missing"), ctx);
			const scans = logs.filter((entry) => entry.phase === "schedule");
			expect(scans[0]).toMatchObject({
				reason: "scan",
				sourceCount: 3,
				messageMatches: 2,
				boundaryMatches: 1,
				textMatches: 0,
				freezeCalls: 0,
				pending: 0,
			});
			expect(scans[1]).toMatchObject({
				messageMatches: 2,
				boundaryMatches: 0,
				textMatches: 0,
				freezeCalls: 0,
			});
			expect(ctx.reasoningTranslations?.blocks.size).toBe(0);
			expect(generate).not.toHaveBeenCalled();
			await processEvent({ type: "done" }, ctx);
			expect(logs.find((entry) => entry.status === "idle")).toMatchObject({
				tasks: 0,
				blocks: 0,
				sourceBytes: 0,
				skips: 0,
			});
			expect(JSON.stringify(logs)).not.toContain("PRIVATE");
		} finally {
			await processEvent({ type: "stream_reset" }, ctx);
			settings.agent.translateReasoning = original;
			generate.mockRestore();
			log.mockRestore();
		}
	});

	test("capture diagnostics preserve missing, stale and full source-map outcomes", async () => {
		const { settings } = await import("../../lib/settings");
		const { narratorStore } = await import("../narrator-store");
		const write = spyOn(narratorStore, "writeStepItem").mockResolvedValue(undefined);
		const { log, logs } = await captureDiagnostics();
		const original = settings.agent.translateReasoning;
		settings.agent.translateReasoning = true;
		const ctx: EventHandlerContext = {
			...makeMainContext(),
			locale: "zh-CN",
			getPartialMessageId: () => "pending",
		};
		const checkpoint = (id?: string, revision = 2) =>
			processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id, text: "PRIVATE SOURCE BODY", revision },
				},
				ctx,
			);
		try {
			await checkpoint();
			await checkpoint("reason");
			await checkpoint("reason", 1);
			await checkpoint("reason", 3);
			settings.agent.translateReasoning = false;
			await checkpoint("disabled");
			settings.agent.translateReasoning = true;
			for (let index = 1; index < 96; index++)
				ctx.reasoningTranslationSources?.set(`source-${index}`, {
					messageId: "pending",
					generation: "g",
					text: "PRIVATE SOURCE BODY",
				});
			await checkpoint("over-limit");
			expect(ctx.reasoningTranslationSources?.size).toBe(96);
			expect(ctx.reasoningTranslationSources?.has("over-limit")).toBe(false);
			const captures = logs.filter((entry) => entry.phase === "capture");
			expect(captures.map((entry) => entry.reason)).toEqual([
				"missing_element",
				"captured",
				"stale",
				"captured",
				"disabled",
				"source_limit",
			]);
			expect(captures[0]).toMatchObject({
				elementPresent: false,
				previous: false,
				accepted: false,
			});
			expect(captures[2]).toMatchObject({ previous: true, stale: true, accepted: false });
			expect(captures[3]).toMatchObject({ previous: true, stale: false, accepted: true });
			expect(captures[5]).toMatchObject({ sourceCount: 96, sourceLimit: 96, accepted: false });
			expect(write).toHaveBeenCalledTimes(6);
			await processEvent({ type: "stream_reset" }, ctx);
			expect(ctx.reasoningTranslationDiagnostics).toBeUndefined();
			expect(ctx.reasoningTranslationSources).toBeUndefined();
			expect(JSON.stringify(logs)).not.toContain("PRIVATE");
		} finally {
			await processEvent({ type: "stream_reset" }, ctx);
			settings.agent.translateReasoning = original;
			write.mockRestore();
			log.mockRestore();
		}
	});

	test("logger failures leave checkpoint capture, translation and publication intact", async () => {
		const { settings } = await import("../../lib/settings");
		const agent = await import("../../lib/agent");
		const { logger } = await import("../../lib/logger");
		const { narratorStore } = await import("../narrator-store");
		const { narratorPersistence } = await import("../narrator-persistence");
		const original = settings.agent.translateReasoning;
		settings.agent.translateReasoning = true;
		const log = spyOn(logger, "info").mockImplementation(() => {
			throw new Error("logger failure");
		});
		const write = spyOn(narratorStore, "writeStepItem").mockResolvedValue(undefined);
		const generate = spyOn(agent, "summaryGenerate").mockResolvedValue({ text: "译文" });
		const patch = spyOn(narratorPersistence, "patchReasoningTranslationPart").mockImplementation(
			async (input) => ({
				messageId: input.messageId,
				blockId: "persisted",
				elementId: input.elementId,
				blockRevision: 1,
				stateRevision: 2,
				translationGeneration: input.expected.generation,
				part: input.part,
			}),
		);
		const ctx: EventHandlerContext = {
			...makeMainContext(),
			locale: "zh-CN",
			getPartialMessageId: () => "pending",
		};
		try {
			await processEvent(
				{
					type: "block_complete",
					block: { type: "reasoning", id: "reason", text: "PRIVATE SOURCE BODY" },
				},
				ctx,
			);
			expect(ctx.reasoningTranslationSources?.size).toBe(1);
			await processEvent(seal(), ctx);
			await Bun.sleep(350);
			expect(generate).toHaveBeenCalledTimes(1);
			expect(patch).toHaveBeenCalledTimes(1);
			expect(
				broadcastMessages.some(
					(value) => (value as { type?: string }).type === "reasoning_translation_patch",
				),
			).toBe(true);
			await processEvent({ type: "done" }, ctx);
			expect(ctx.reasoningTranslations).toBeUndefined();
			expect(ctx.reasoningTranslationDiagnostics).toBeUndefined();
		} finally {
			await processEvent({ type: "stream_reset" }, ctx);
			settings.agent.translateReasoning = original;
			log.mockRestore();
			write.mockRestore();
			generate.mockRestore();
			patch.mockRestore();
		}
	});

	test("a cancelled awaited state commit cannot publish its successful metadata", async () => {
		const { settings } = await import("../../lib/settings");
		const agent = await import("../../lib/agent");
		const { narratorPersistence } = await import("../narrator-persistence");
		const original = settings.agent.translateReasoning;
		settings.agent.translateReasoning = true;
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const generate = spyOn(agent, "summaryGenerate").mockResolvedValue({ text: "译文" });
		const patch = spyOn(narratorPersistence, "patchReasoningTranslationPart").mockImplementation(
			async (input) => {
				entered.resolve();
				await release.promise;
				return {
					messageId: input.messageId,
					blockId: "persisted",
					elementId: input.elementId,
					blockRevision: 1,
					stateRevision: 2,
					translationGeneration: input.expected.generation,
					part: input.part,
				};
			},
		);
		const ctx: EventHandlerContext = {
			...makeMainContext(),
			locale: "zh-CN",
			getPartialMessageId: () => "pending",
			reasoningTranslationSources: new Map([
				["reason", { messageId: "pending", generation: "g", text: "A" }],
			]),
		};
		try {
			await processEvent(
				{
					type: "reasoning_summary_sealed",
					blockId: "reason",
					blockRevision: 1,
					nativePartId: "summary-0",
					nativePartIndex: 0,
					start: 0,
					end: 1,
					sourceText: "A",
				},
				ctx,
			);
			await entered.promise;
			await processEvent({ type: "stream_reset" }, ctx);
			release.resolve();
			await Bun.sleep(5);
			expect(patch.mock.calls[0]?.[0].signal?.aborted).toBe(true);
			expect(
				broadcastMessages.some(
					(value) => (value as { type?: string }).type === "reasoning_translation_patch",
				),
			).toBe(false);
		} finally {
			release.resolve();
			generate.mockRestore();
			patch.mockRestore();
			settings.agent.translateReasoning = original;
		}
	});

	for (const reset of ["stream_reset", "attempt_discarded", "error"] as const) {
		test(`${reset} cancels in-flight translation before state writes or broadcast`, async () => {
			const { settings } = await import("../../lib/settings");
			const agent = await import("../../lib/agent");
			const { narratorPersistence } = await import("../narrator-persistence");
			const { log, logs } = await captureDiagnostics();
			let resolve: (value: { text: string }) => void = () => {};
			const generate = spyOn(agent, "summaryGenerate").mockImplementation(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			);
			const patch = spyOn(narratorPersistence, "patchReasoningTranslationPart");
			const original = settings.agent.translateReasoning;
			settings.agent.translateReasoning = true;
			const ctx: EventHandlerContext = {
				...makeMainContext(),
				locale: "zh-CN",
				getPartialMessageId: () => "pending",
				reasoningTranslationSources: new Map([
					["reason", { messageId: "pending", generation: "g", text: "A" }],
				]),
			};
			try {
				await processEvent(
					{
						type: "reasoning_summary_sealed",
						blockId: "reason",
						blockRevision: 1,
						nativePartId: "summary-0",
						nativePartIndex: 0,
						start: 0,
						end: 1,
						sourceText: "A",
					},
					ctx,
				);
				await Bun.sleep(350);
				expect(generate).toHaveBeenCalledTimes(1);
				await processEvent(
					reset === "stream_reset"
						? { type: reset }
						: reset === "attempt_discarded"
							? { type: reset, requestId: "old" }
							: { type: reset, message: "stopped" },
					ctx,
				);
				resolve({ text: "late" });
				await Bun.sleep(5);
				expect(
					logs.find((entry) => entry.phase === "response" && entry.status === "cancelled"),
				).toMatchObject({ reason: reset, tasks: 1, blocks: 1, sourceBytes: 1, pending: 1 });
				expect(
					logs.find((entry) => entry.phase === "task" && entry.status === "cancelled"),
				).toMatchObject({ abortReason: reset, pending: 0 });
				expect(ctx.reasoningTranslationDiagnostics).toBeUndefined();
				expect(patch).not.toHaveBeenCalled();
				expect(
					broadcastMessages.some(
						(value) => (value as { type?: string }).type === "reasoning_translation_patch",
					),
				).toBe(false);
			} finally {
				log.mockRestore();
				generate.mockRestore();
				patch.mockRestore();
				settings.agent.translateReasoning = original;
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
	// The counters are run-scoped, not snapshot-scoped: clearStreamingSnapshot no
	// longer retires them, so tests retire them explicitly to stay isolated.
	retireSubagentOutputCharCount(PARENT_NARRATOR_ID);
	retireSubagentOutputCharCount(SUBAGENT_NARRATOR_ID);
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
				.select({ content: narratorMessages.contentJson })
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, id))
				.get();
			expect(message?.content).toEqual([
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
				.select({ content: narratorMessages.contentJson })
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, id))
				.get();
			expect(message?.content).toEqual([{ type: "error", message: "internal failure" }]);
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

describe("subagent live output char count", () => {
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
		const sub = makeSubagentContext();
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
		// The snapshot carries the same count so a reconnecting client restores it.
		expect(
			getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get(PARENT_TOOL_USE_ID)?.streamingOutput,
		).toBe("5");
	});

	test("throttled frames keep only the latest cumulative total", async () => {
		await parentAgentChunk();
		const sub = makeSubagentContext();
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
		const sub = makeSubagentContext();
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

	test("skips the broadcast while no card tracks the tool, resuming with the full total", async () => {
		const sub = makeSubagentContext();
		// No Agent chunk yet: nothing to show the count on, so nothing is sent…
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
		expect(toolOutputFrames()).toHaveLength(0);
		// …but the counter keeps accumulating, so a card appearing later resumes
		// from the true total rather than zero.
		await parentAgentChunk();
		await processEvent(
			{ type: "stream_text", blockRevision: 8, blockTextOffset: 43, text: "!", blockId: "blk-1" },
			sub,
		);
		await untilOutput("6");
	});

	test("iteration-level snapshot resets do NOT retire the counter (run-scoped total)", async () => {
		await parentAgentChunk();
		const sub = makeSubagentContext();
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
		const sub = makeSubagentContext();
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
		// The dead-turn reset retracts the streamed text; the count starts over.
		await processEvent({ type: "stream_reset" }, sub);
		await processEvent(
			{ type: "stream_text", blockRevision: 11, blockTextOffset: 54, text: "Hi", blockId: "blk-1" },
			sub,
		);
		await untilOutput("2");
	});

	test("a replay fully inside the streamed span never shrinks the count", async () => {
		await parentAgentChunk();
		const sub = makeSubagentContext();
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

	test("run end flushes the final count and retires the counter", async () => {
		await parentAgentChunk();
		const sub = makeSubagentContext();
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
		retireSubagentOutputCharCount(SUBAGENT_NARRATOR_ID);
		expect(toolOutputFrames().at(-1)?.output).toBe("7");
	});
});
