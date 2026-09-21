/**
 * partial-assistant-visibility.test.ts — An empty partial assistant shell must not
 * enter the client sync stream; real blocks must.
 *
 * ── The reported bug ──────────────────────────────────────────────────────────
 *
 * "reasoning 之后连续多次调用工具，前端一段时间看不到 reasoning，连带后面的
 * assistant 文本也消失，等一些工具执行完才重新出现。"
 *
 * Cause: `createPartialAssistantMessage` allocated a ref and bumped
 * `messageVersion` on an EMPTY `contentJson` row. Catch-up delivered that blank
 * assistant into the document while `appendBlockToMessage` wrote reasoning/text
 * into the same row WITHOUT bump or broadcast. Live-row hand-off could then retire
 * streaming blocks against a committed copy that still had nothing to show; content
 * only reappeared when a later reload read the DB.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { FileReferenceContext } from "@shared/file-reference";
import { cleanDb, getTestDb } from "../../../tests/setup";
import type { AgentConfig, AgentEvent, ContentBlock } from "../../lib/agent/types";
import type { EventHandlerContext } from "../narrator-event-handler";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

/** Broadcasts are the observable wire contract for the partial publication path. */
interface Broadcast {
	narratorId: string;
	// biome-ignore lint/suspicious/noExplicitAny: websocket frames are dynamic JSON
	message: any;
}
const broadcasts: Broadcast[] = [];
let onBroadcast: ((frame: Broadcast) => void) | undefined;
const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	// biome-ignore lint/suspicious/noExplicitAny: websocket frames are dynamic JSON
	broadcastToNarrator: (narratorId: string, message: any) => {
		onBroadcast?.({ narratorId, message });
		broadcasts.push({ narratorId, message });
	},
}));

// narrator-service must be imported before narrator-persistence: the two form a
// pre-existing import cycle (see seq-store-contract.test.ts).
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const { narratorMessageQueries } = await import("../narrator-messages");
const {
	clearStreamingSnapshot,
	getStreamingSnapshot,
	processEvent,
	CriticalEventPersistenceError,
} = await import("../narrator-event-handler");
const { executeAgentLoop } = await import("../narrator-executor");

const NOW = "2026-08-20T10:00:00.000Z";

function seedNarrator(
	id = "n1",
	options: {
		variant?: string;
		type?: "primary" | "subagent";
		parentNarratorId?: string | null;
	} = {},
) {
	sqlite
		.prepare(
			"INSERT INTO narrators (id, variant, type, parent_narrator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(
			id,
			options.variant ?? "primary",
			options.type ?? "primary",
			options.parentNarratorId ?? null,
			NOW,
			NOW,
		);
}

function messageVersionOf(id = "n1"): number {
	const row = sqlite.prepare("SELECT message_version AS v FROM narrators WHERE id = ?").get(id) as
		| { v: number }
		| undefined;
	return row?.v ?? 0;
}

function makeContext(subagent = false): EventHandlerContext {
	let partialId: string | undefined;
	return {
		narratorId: subagent ? "child" : "n1",
		broadcastTargetId: subagent ? "parent" : "n1",
		parentToolUseId: subagent ? "parent-tool" : undefined,
		conversationId: "s",
		locale: "en",
		getContextUsagePct: () => undefined,
		getMeterUsage: () => undefined,
		getMeterUnit: () => undefined,
		getTokenUsage: () => undefined,
		getPartialMessageId: () => partialId,
		setPartialMessageId: (id) => {
			partialId = id;
		},
		setContextUsagePct: () => {},
		setMeterData: () => {},
		setTokenUsage: () => {},
	};
}

function storedBlocks(messageId: string): Array<Record<string, unknown>> {
	const row = sqlite
		.prepare("SELECT content_json AS c FROM narrator_messages WHERE id = ?")
		.get(messageId) as { c: string };
	return JSON.parse(row.c);
}

function seqOf(messageId: string): number {
	const row = sqlite
		.prepare("SELECT seq FROM narrator_message_refs WHERE message_id = ?")
		.get(messageId) as { seq: number };
	return row.seq;
}

beforeEach(() => {
	cleanDb(sqlite);
	broadcasts.length = 0;
	onBroadcast = undefined;
});

afterEach(() => {
	onBroadcast = undefined;
	for (const id of ["n1", "parent", "child"]) clearStreamingSnapshot(id);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.restore();
	cleanDb(sqlite);
});

describe("partial assistant visibility", () => {
	test("createPartialAssistantMessage does not announce an empty shell", async () => {
		seedNarrator();
		const before = messageVersionOf();
		const partial = await narratorPersistence.createPartialAssistantMessage("n1", {
			uuid: "partial-1",
			session_id: "s",
		});
		expect(partial.id).toBeTruthy();
		expect(partial.seq).toBeGreaterThanOrEqual(0);
		// Ref/seq exist for later appends; sync version must not move.
		expect(messageVersionOf()).toBe(before);
	});

	test("appendBlockToMessage publishes reasoning into the sync stream", async () => {
		seedNarrator();
		const partial = await narratorPersistence.createPartialAssistantMessage("n1", {
			uuid: "partial-2",
			session_id: "s",
		});
		expect(messageVersionOf()).toBe(0);

		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "reasoning",
			text: "**分析**\n\n先确认现状。",
		});

		expect(messageVersionOf()).toBeGreaterThan(0);
		const raw = sqlite
			.prepare("SELECT content_json AS c FROM narrator_messages WHERE id = ?")
			.get(partial.id) as { c: string } | undefined;
		const blocks: unknown[] = raw?.c ? JSON.parse(raw.c) : [];
		expect(blocks.some((b) => (b as { type?: string }).type === "reasoning")).toBe(true);

		// Catch-up that follows a version bump must be able to see the same body.
		const page = await narratorMessageQueries.getPretextDocumentPage("n1", { limit: 10 });
		const delivered = page.messages.find((m) => m.id === partial.id);
		expect(delivered).toBeDefined();
		const deliveredBlocks = Array.isArray(delivered?.contentJson) ? delivered.contentJson : [];
		expect(
			deliveredBlocks.some(
				(b: { type?: string; text?: string }) =>
					b.type === "reasoning" && typeof b.text === "string" && b.text.includes("分析"),
			),
		).toBe(true);
	});

	test("appendBlockToMessage publishes assistant text after reasoning", async () => {
		seedNarrator();
		const partial = await narratorPersistence.createPartialAssistantMessage("n1", {
			uuid: "partial-3",
			session_id: "s",
		});
		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "reasoning",
			text: "想一下",
		});
		const afterReasoning = messageVersionOf();
		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "text",
			text: "我先定位这段逻辑。",
		});
		expect(messageVersionOf()).toBeGreaterThan(afterReasoning);

		const page = await narratorMessageQueries.getPretextDocumentPage("n1", { limit: 10 });
		const delivered = page.messages.find((m) => m.id === partial.id);
		const deliveredBlocks = Array.isArray(delivered?.contentJson) ? delivered.contentJson : [];
		expect(
			deliveredBlocks.some(
				(b: { type?: string; text?: string }) => b.type === "text" && b.text?.includes("定位"),
			),
		).toBe(true);
	});

	test("subagent empty partial waits to bump both versions and broadcasts both copies", async () => {
		seedNarrator("parent");
		seedNarrator("child", {
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: "parent",
		});

		const partial = await narratorPersistence.createPartialAssistantMessage("child", {
			uuid: "partial-child",
			session_id: "s",
			parent_tool_use_id: "toolu-parent",
		});
		expect(messageVersionOf("parent")).toBe(0);
		expect(messageVersionOf("child")).toBe(0);
		expect(broadcasts).toHaveLength(0);

		await narratorPersistence.appendBlockToMessage(partial.id, "child", {
			type: "text",
			text: "子代理已完成。",
		});

		expect(messageVersionOf("parent")).toBe(1);
		expect(messageVersionOf("child")).toBe(1);
		expect(broadcasts).toHaveLength(2);

		const parentFrame = broadcasts.find((frame) => frame.narratorId === "parent");
		const childFrame = broadcasts.find((frame) => frame.narratorId === "child");
		expect(parentFrame?.message.type).toBe("message_updated");
		expect(childFrame?.message.type).toBe("message_updated");
		expect(parentFrame?.message.message.parentToolUseId).toBe("toolu-parent");
		expect(childFrame?.message.message.parentToolUseId).toBeNull();
	});

	test("broadcast tool I/O is projected while the database keeps complete JSON", async () => {
		seedNarrator();
		const partial = await narratorPersistence.createPartialAssistantMessage("n1", {
			uuid: "partial-tool",
			session_id: "s",
		});
		const input = { command: `input-${"i".repeat(2400)}`, short: "kept" };
		const output = { stdout: `output-${"o".repeat(2400)}`, exitCode: 0 };
		const toolUseId = "toolu-projected";
		const toolCallId = await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "tool_use",
			id: toolUseId,
			name: "Bash",
			input,
		});
		expect(toolCallId).toBeTruthy();
		if (!toolCallId) throw new Error("tool_use append must produce a tool-call row id");

		await narratorPersistence.updateToolCallResult(
			toolUseId,
			{ output, status: "success" },
			partial.id,
			toolCallId,
		);
		broadcasts.length = 0;
		await narratorPersistence.appendBlockToMessage(partial.id, "n1", {
			type: "text",
			text: "命令已完成。",
		});

		expect(broadcasts).toHaveLength(1);
		const frame = broadcasts[0];
		expect(frame?.message.type).toBe("message_updated");
		const broadcastMessage = frame?.message.message;
		const broadcastToolCall = broadcastMessage.toolCalls.find(
			(call: { toolUseId?: string }) => call.toolUseId === toolUseId,
		);
		const broadcastToolBlock = broadcastMessage.contentJson.find(
			(block: { type?: string; id?: string }) =>
				block.type === "tool_use" && block.id === toolUseId,
		);
		expect(broadcastToolCall.inputJson.command).toMatchObject({ _truncated: true });
		expect(broadcastToolCall.outputJson.stdout).toMatchObject({ _truncated: true });
		expect(broadcastToolCall.inputJson.command.preview.length).toBeLessThan(input.command.length);
		expect(broadcastToolCall.outputJson.stdout.preview.length).toBeLessThan(output.stdout.length);
		expect(broadcastToolBlock.inputJson.command).toBe(broadcastToolCall.inputJson.command);
		expect(broadcastToolBlock.outputJson.stdout).toBe(broadcastToolCall.outputJson.stdout);

		const stored = sqlite
			.prepare(
				"SELECT input_json AS input, output_json AS output FROM narrator_tool_calls WHERE id = ?",
			)
			.get(toolCallId) as { input: string; output: string };
		expect(JSON.parse(stored.input)).toEqual(input);
		expect(JSON.parse(stored.output)).toEqual(output);
	});
});

describe("identified content checkpoints through the real event consumer", () => {
	for (const subagent of [false, true]) {
		test(`reasoning → text → tool is immediately durable and finalized once (subagent=${subagent})`, async () => {
			const ctx = makeContext(subagent);
			if (subagent) {
				seedNarrator("parent");
				seedNarrator("child", { type: "subagent", parentNarratorId: "parent" });
			} else seedNarrator();
			let source: FileReferenceContext = { deviceId: "DeviceA", cwd: "/repo" };
			ctx.getFileReferenceContext = () => source;
			const reasoning: Extract<ContentBlock, { type: "reasoning" }> = {
				type: "reasoning",
				id: "r1",
				revision: 1,
				text: "First thought",
				providerMetadata: { openai: { itemId: "provider-r1" } },
			};
			const text: Extract<ContentBlock, { type: "text" }> = {
				type: "text",
				id: "t1",
				revision: 1,
				text: "[file](src/a.ts)",
			};
			await processEvent(
				{
					type: "stream_reasoning",
					blockId: reasoning.id,
					blockRevision: 1,
					text: reasoning.text,
					providerMetadata: reasoning.providerMetadata,
				},
				ctx,
			);
			await processEvent(
				{ type: "stream_text", blockId: text.id, blockRevision: 1, text: text.text },
				ctx,
			);
			expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_messages").get()).toEqual({ n: 0 });
			expect(getStreamingSnapshot(ctx.narratorId)?.streamingBlocks).toMatchObject([
				{ type: "reasoning", id: "r1", revision: 1 },
				{ type: "text", id: "t1", revision: 1 },
			]);
			if (subagent) expect(getStreamingSnapshot("parent")).toBeUndefined();
			const streamFrames = broadcasts.filter((frame) => frame.message.type === "stream_event");
			expect(streamFrames.map((frame) => frame.message.event.delta.id)).not.toContain(
				"provider-r1",
			);
			for (const frame of streamFrames) expect(frame.message.event.delta.revision).toBe(1);

			for (const block of [reasoning, text]) {
				onBroadcast = ({ message }) => {
					if (message.type === "message_updated") {
						// Publication, not the start of the DB write, retires the live copy.
						expect(
							getStreamingSnapshot(ctx.narratorId)?.streamingBlocks.some((b) => b.id === block.id),
						).toBe(true);
					}
				};
				await processEvent({ type: "block_complete", block }, ctx);
				expect(
					getStreamingSnapshot(ctx.narratorId)?.streamingBlocks.some((b) => b.id === block.id),
				).toBe(false);
			}
			onBroadcast = undefined;
			const messageId = ctx.getPartialMessageId() as string;
			const seq = seqOf(messageId);
			expect(storedBlocks(messageId).map((block) => block.type)).toEqual(["reasoning", "text"]);
			const published = broadcasts.filter((frame) => frame.message.type === "message_updated");
			expect(published).toHaveLength(subagent ? 4 : 2);
			if (subagent) {
				expect(messageVersionOf("child")).toBe(2);
				expect(messageVersionOf("parent")).toBe(2);
				expect(
					published.filter((frame) => frame.narratorId === "child").at(-1)?.message.message
						.parentToolUseId,
				).toBeNull();
			}

			await processEvent(
				{ type: "tool_use_chunk", toolUseId: "tool1", toolName: "Read", inputCharsTotal: 1 },
				ctx,
			);
			const tool = {
				type: "tool_use" as const,
				toolUseId: "tool1",
				name: "Read",
				input: { file_path: "src/a.ts" },
			};
			await processEvent({ type: "block_complete", block: tool }, ctx);
			expect(storedBlocks(messageId).map((block) => block.type)).toEqual([
				"reasoning",
				"text",
				"tool_use",
			]);

			await narratorPersistence.patchReasoningTranslation(messageId, 0, "原有翻译");
			source = { deviceId: "DeviceB", cwd: "/other" };
			const completeReasoning = {
				...reasoning,
				revision: 2,
				providerMetadata: {
					openai: { reasoningEncryptedContent: "cipher" },
					anthropic: { signature: "signature" },
					signatureSource: "provider:channel",
				},
			};
			const completeText = {
				...text,
				revision: 2,
				citations: [
					{
						startIndex: 0,
						endIndex: 4,
						sources: [{ title: "source", url: "https://example.test" }],
					},
				],
			};
			await processEvent({ type: "block_complete", block: completeReasoning }, ctx);
			await processEvent({ type: "block_complete", block: completeText }, ctx);
			expect(storedBlocks(messageId)[0]).toMatchObject({
				id: "r1",
				revision: 2,
				translatedText: "原有翻译",
				providerMetadata: {
					openai: { itemId: "provider-r1", reasoningEncryptedContent: "cipher" },
					anthropic: { signature: "signature" },
					signatureSource: "provider:channel",
				},
			});
			expect(storedBlocks(messageId)[1]).toMatchObject({
				id: "t1",
				revision: 2,
				citations: completeText.citations,
				fileReferenceContext: { deviceId: "DeviceA", cwd: "/repo" },
			});

			const version = messageVersionOf(ctx.narratorId);
			const frameCount = broadcasts.length;
			await processEvent({ type: "block_complete", block: completeReasoning }, ctx);
			await processEvent({ type: "block_complete", block: completeText }, ctx);
			await processEvent({ type: "block_complete", block: { ...reasoning, text: "stale" } }, ctx);
			await processEvent({ type: "block_complete", block: { ...text, text: "stale" } }, ctx);
			expect(messageVersionOf(ctx.narratorId)).toBe(version);
			expect(broadcasts).toHaveLength(frameCount);
			expect(storedBlocks(messageId)).toHaveLength(3);
			await processEvent(
				{ type: "assistant_message", messageId: "final-uuid", text: text.text, toolUses: [tool] },
				ctx,
			);
			expect(ctx.getPartialMessageId()).toBeUndefined();
			expect(ctx.committedContentSnapshots?.size).toBe(0);
			expect(ctx.fileReferenceContexts?.peek(undefined, "t1")).toBeNull();
			expect(seqOf(messageId)).toBe(seq);
			expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_messages").get()).toEqual({ n: 1 });
			expect(storedBlocks(messageId)).toHaveLength(3);
		});
	}

	test("different IDs never merge, legacy blocks append, later reasoning stays in occurrence order", async () => {
		seedNarrator();
		const ctx = makeContext();
		for (const block of [
			{ type: "reasoning", id: "first", revision: 1, text: "same" },
			{ type: "text", id: "text", revision: 1, text: "text" },
			{ type: "tool_use", toolUseId: "tool", name: "Read", input: {} },
			{ type: "reasoning", id: "second", revision: 1, text: "same" },
			{ type: "text", text: "legacy" },
			{ type: "text", text: "legacy" },
		] satisfies ContentBlock[])
			await processEvent({ type: "block_complete", block }, ctx);
		const blocks = storedBlocks(ctx.getPartialMessageId() as string);
		expect(blocks.map((block) => block.type)).toEqual([
			"reasoning",
			"text",
			"tool_use",
			"reasoning",
			"text",
			"text",
		]);
		expect(blocks[0].id).toBe("first");
		expect(blocks[3].id).toBe("second");
	});

	test("signed functionCall checkpoint preserves its source through stored Gemini history", async () => {
		seedNarrator();
		const ctx = makeContext();
		const { GeminiProvider } = await import("../../lib/agent/gemini-provider");
		const provider = new GeminiProvider({
			id: "gem-checkpoint",
			name: "Gemini checkpoint",
			prefix: "gem-checkpoint",
			apiKey: "test-key",
			baseUrl: "https://gemini.example.test/v1beta",
			defaultModel: "gemini-2.5-flash",
		});
		const tool = {
			type: "tool_use" as const,
			toolUseId: "signed-call",
			name: "Read",
			input: { file_path: "src/a.ts" },
			thoughtSignature: "signed-thought",
			thoughtSignatureSource: provider.getActiveReasoningSource(),
		};
		await processEvent({ type: "block_complete", block: tool }, ctx);
		const messageId = ctx.getPartialMessageId() as string;
		const toolCallId = ctx.toolCallIdsMap?.get(tool.toolUseId);
		await narratorPersistence.updateToolCallResult(
			tool.toolUseId,
			{ output: "file content", status: "success" },
			messageId,
			toolCallId,
		);
		await processEvent({ type: "assistant_message", text: "", toolUses: [tool] }, ctx);
		const reloaded = await narratorMessageQueries.getModelHistorySinceLastCompact("n1");
		expect(reloaded[0]?.toolCalls?.[0]?.inputJson).toMatchObject({
			__geminiThoughtSignature: "signed-thought",
			__geminiThoughtSignatureSource: provider.getActiveReasoningSource(),
		});
		expect(storedBlocks(messageId)[0]).toMatchObject({
			thoughtSignature: "signed-thought",
			thoughtSignatureSource: provider.getActiveReasoningSource(),
		});
		const replay = await provider.buildHistory(reloaded, "gemini-2.5-flash");
		expect(replay.history).toMatchObject([
			{
				role: "model",
				parts: [
					{
						functionCall: { name: "Read", args: { file_path: "src/a.ts" } },
						thoughtSignature: "signed-thought",
					},
				],
			},
		]);
	});

	test("concurrent append/translation cannot downgrade a checkpoint or overwrite its metadata", async () => {
		seedNarrator();
		const partial = await narratorPersistence.createPartialAssistantMessage("n1", {
			uuid: "concurrent",
			session_id: "s",
		});
		const initial = { type: "reasoning" as const, id: "same", revision: 1, text: "original" };
		await narratorPersistence.appendBlockToMessage(partial.id, "n1", initial);
		await Promise.all([
			narratorPersistence.appendBlockToMessage(partial.id, "n1", {
				...initial,
				revision: 3,
				providerMetadata: { openai: { reasoningEncryptedContent: "latest" } },
			}),
			narratorPersistence.appendBlockToMessage(partial.id, "n1", {
				...initial,
				revision: 2,
				text: "stale",
			}),
			narratorPersistence.patchReasoningTranslation(partial.id, 0, "原文翻译", {
				id: "same",
				text: "original",
			}),
		]);
		expect(storedBlocks(partial.id)).toMatchObject([
			{
				id: "same",
				revision: 3,
				text: "original",
				translatedText: "原文翻译",
				providerMetadata: { openai: { reasoningEncryptedContent: "latest" } },
			},
		]);
		expect(messageVersionOf()).toBe(2);
		expect(seqOf(partial.id)).toBe(partial.seq);
	});

	test("indexed blocks retain provider order without conflating same-index IDs", async () => {
		seedNarrator();
		const ctx = makeContext();
		for (const block of [
			{ type: "text", id: "late", revision: 1, text: "same", outputIndex: 2 },
			{ type: "reasoning", id: "first", revision: 1, text: "r", outputIndex: 0 },
			{ type: "text", id: "middle", revision: 1, text: "same", outputIndex: 1 },
			{ type: "text", id: "middle-other", revision: 1, text: "same", outputIndex: 1 },
		] satisfies ContentBlock[])
			await processEvent({ type: "block_complete", block }, ctx);
		expect(storedBlocks(ctx.getPartialMessageId() as string).map((block) => block.id)).toEqual([
			"first",
			"middle",
			"middle-other",
			"late",
		]);
	});

	test("only an unchanged original can retain or receive a translation", async () => {
		seedNarrator();
		const ctx = makeContext();
		await processEvent(
			{
				type: "block_complete",
				block: { type: "reasoning", id: "r", revision: 1, text: "before" },
			},
			ctx,
		);
		const messageId = ctx.getPartialMessageId() as string;
		await narratorPersistence.patchReasoningTranslation(messageId, 0, "旧翻译");
		await processEvent(
			{ type: "block_complete", block: { type: "reasoning", id: "r", revision: 2, text: "after" } },
			ctx,
		);
		expect(storedBlocks(messageId)[0]).not.toHaveProperty("translatedText");
		expect(
			await narratorPersistence.patchReasoningTranslation(messageId, 0, "迟到旧翻译", {
				id: "r",
				text: "before",
			}),
		).toBe(false);
		expect(
			await narratorPersistence.patchReasoningTranslation(messageId, 0, "其他块翻译", {
				id: "other",
				text: "after",
			}),
		).toBe(false);
		expect(
			await narratorPersistence.patchReasoningTranslation(messageId, 0, "新翻译", {
				id: "r",
				text: "after",
			}),
		).toBe(true);
	});

	for (const type of ["text", "reasoning"] as const) {
		test(`${type} checkpoint preserves newer snapshots and resumes from the raw streamed prefix`, async () => {
			seedNarrator();
			const ctx = makeContext();
			ctx.getFileReferenceContext = () => ({ deviceId: "A", cwd: "/a" });
			const streamType = type === "text" ? "stream_text" : "stream_reasoning";
			const rawPrefix = "raw \uD834\uDD1E prefix";
			await processEvent(
				{
					type: streamType,
					blockId: "block",
					blockRevision: 1,
					blockTextOffset: 0,
					text: rawPrefix,
				},
				ctx,
			);
			await processEvent(
				{
					type: "block_complete",
					block: {
						type,
						id: "block",
						revision: 1,
						text: "sanitized prefix",
						rawTextLength: rawPrefix.length,
					},
				},
				ctx,
			);
			ctx.getFileReferenceContext = () => ({ deviceId: "B", cwd: "/b" });
			await processEvent(
				{
					type: streamType,
					blockId: "block",
					blockRevision: 2,
					blockTextOffset: rawPrefix.length,
					text: " suffix",
				},
				ctx,
			);
			expect(getStreamingSnapshot("n1")?.streamingBlocks[0]).toMatchObject({
				id: "block",
				revision: 2,
				text: `${rawPrefix} suffix`,
				textOffset: 0,
			});
			expect(broadcasts.at(-1)?.message.event.delta.textOffset).toBe(rawPrefix.length);
			if (type === "text")
				expect(getStreamingSnapshot("n1")?.streamingBlocks[0]).toMatchObject({
					fileReferenceContext: { deviceId: "A", cwd: "/a" },
				});
			await processEvent(
				{
					type: "block_complete",
					block: {
						type,
						id: "block",
						revision: 1,
						text: "sanitized prefix",
						rawTextLength: rawPrefix.length,
					},
				},
				ctx,
			);
			expect(getStreamingSnapshot("n1")?.streamingBlocks).toHaveLength(1);
			await processEvent(
				{
					type: "block_complete",
					block: {
						type,
						id: "block",
						revision: 2,
						text: "sanitized prefix suffix",
						rawTextLength: rawPrefix.length + " suffix".length,
					},
				},
				ctx,
			);
			expect(getStreamingSnapshot("n1")?.streamingBlocks).toHaveLength(0);
			expect(storedBlocks(ctx.getPartialMessageId() as string)).toMatchObject([
				{ id: "block", revision: 2, rawTextLength: rawPrefix.length + " suffix".length },
			]);
		});
	}

	test("same-index text IDs keep their own devices and only retire the exact identity", async () => {
		seedNarrator();
		const ctx = makeContext();
		ctx.getFileReferenceContext = () => ({ deviceId: "A", cwd: "/a" });
		await processEvent(
			{ type: "stream_text", blockId: "first", blockRevision: 1, text: "same", outputIndex: 0 },
			ctx,
		);
		ctx.getFileReferenceContext = () => ({ deviceId: "B", cwd: "/b" });
		await processEvent(
			{ type: "stream_text", blockId: "second", blockRevision: 1, text: "same", outputIndex: 0 },
			ctx,
		);
		await processEvent(
			{
				type: "block_complete",
				block: { type: "text", id: "first", revision: 1, text: "same", outputIndex: 0 },
			},
			ctx,
		);
		expect(getStreamingSnapshot("n1")?.streamingBlocks).toMatchObject([
			{ id: "second", fileReferenceContext: { deviceId: "B", cwd: "/b" } },
		]);
		await processEvent(
			{
				type: "block_complete",
				block: { type: "text", id: "second", revision: 1, text: "same", outputIndex: 0 },
			},
			ctx,
		);
		expect(storedBlocks(ctx.getPartialMessageId() as string)).toMatchObject([
			{ id: "first", fileReferenceContext: { deviceId: "A", cwd: "/a" } },
			{ id: "second", fileReferenceContext: { deviceId: "B", cwd: "/b" } },
		]);
	});

	for (const type of ["text", "reasoning"] as const) {
		test(`${type} snapshot advanced while publication awaits is not retired by an older checkpoint`, async () => {
			seedNarrator();
			const ctx = makeContext();
			const streamType = type === "text" ? "stream_text" : "stream_reasoning";
			await processEvent(
				{
					type: streamType,
					blockId: "racing",
					blockRevision: 1,
					blockTextOffset: 0,
					text: "first",
				},
				ctx,
			);
			let injected: ReturnType<typeof processEvent> | undefined;
			onBroadcast = ({ message }) => {
				if (message.type !== "message_updated") return;
				onBroadcast = undefined;
				injected = processEvent(
					{
						type: streamType,
						blockId: "racing",
						blockRevision: 2,
						blockTextOffset: 5,
						text: "next",
					},
					ctx,
				);
			};
			await processEvent(
				{
					type: "block_complete",
					block: { type, id: "racing", revision: 1, text: "first", rawTextLength: 5 },
				},
				ctx,
			);
			await injected;
			expect(getStreamingSnapshot("n1")?.streamingBlocks).toMatchObject([
				{ id: "racing", revision: 2, text: "firstnext", textOffset: 0 },
			]);
			const before = broadcasts.length;
			await processEvent(
				{
					type: streamType,
					blockId: "racing",
					blockRevision: 1,
					blockTextOffset: 0,
					text: "stale",
				},
				ctx,
			);
			await processEvent(
				{ type: streamType, blockId: "racing", blockRevision: 2, blockTextOffset: 5, text: "next" },
				ctx,
			);
			expect(broadcasts).toHaveLength(before);
			expect(storedBlocks(ctx.getPartialMessageId() as string)[0]).toMatchObject({
				revision: 1,
				text: "first",
			});
		});

		test(`${type} partial raw snapshot exposes its absolute start instead of inventing a prefix`, async () => {
			const ctx = makeContext();
			const streamType = type === "text" ? "stream_text" : "stream_reasoning";
			await processEvent(
				{
					type: streamType,
					blockId: "partial",
					blockRevision: 8,
					blockTextOffset: 40,
					text: "suffix",
				},
				ctx,
			);
			await processEvent(
				{
					type: streamType,
					blockId: "partial",
					blockRevision: 9,
					blockTextOffset: 46,
					text: "more",
				},
				ctx,
			);
			expect(getStreamingSnapshot("n1")?.streamingBlocks).toMatchObject([
				{ id: "partial", revision: 9, text: "suffixmore", textOffset: 40 },
			]);
			expect(ctx.getPartialMessageId()).toBeUndefined();
		});
	}

	for (const type of ["text", "reasoning"] as const) {
		for (const failure of ["database", "publication"] as const) {
			test(`${type} ${failure} failure retains the snapshot and stops the generator before tools`, async () => {
				seedNarrator();
				const ctx = makeContext();
				let reachedTool = false;
				let closed = false;
				const block = { type, id: "failed-block", revision: 1, text: "must not disappear" };
				if (failure === "database") {
					sqlite.run(
						"CREATE TEMP TRIGGER fail_checkpoint BEFORE UPDATE OF content_json ON narrator_messages BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END",
					);
				} else {
					onBroadcast = ({ message }) => {
						if (message.type === "message_updated") throw new Error("publication unavailable");
					};
				}
				async function* source(): AsyncGenerator<AgentEvent> {
					try {
						yield {
							type: type === "text" ? "stream_text" : "stream_reasoning",
							blockId: block.id,
							blockRevision: 1,
							text: block.text,
						};
						yield { type: "block_complete", block };
						reachedTool = true;
						yield {
							type: "tool_call",
							toolUseId: "forbidden",
							toolName: "Bash",
							input: { command: "pwd" },
						};
					} finally {
						closed = true;
					}
				}
				const config: AgentConfig = {
					narratorId: "n1",
					conversationId: "s",
					model: "test-model",
					provider: "test-provider",
					cwd: "/repo",
					signal: new AbortController().signal,
					permissionHandler: async () => ({ behavior: "allow" }),
				};
				try {
					await expect(
						executeAgentLoop(
							{ config, userText: "", history: [], eventContext: ctx },
							{ eventSource: source() },
						),
					).rejects.toBeInstanceOf(CriticalEventPersistenceError);
					expect(reachedTool).toBe(false);
					expect(closed).toBe(true);
					expect(getStreamingSnapshot("n1")?.streamingBlocks).toMatchObject([block]);
					expect(broadcasts.some((frame) => frame.message.type === "tool_started")).toBe(false);
					expect(storedBlocks(ctx.getPartialMessageId() as string)).toHaveLength(
						failure === "database" ? 0 : 1,
					);
				} finally {
					if (failure === "database") sqlite.run("DROP TRIGGER fail_checkpoint");
					onBroadcast = undefined;
				}
				// Retrying an unacknowledged checkpoint must publish before retiring it,
				// even if its durable write succeeded before the previous publish failed.
				await processEvent({ type: "block_complete", block }, ctx);
				expect(broadcasts.some((frame) => frame.message.type === "message_updated")).toBe(true);
				expect(getStreamingSnapshot("n1")?.streamingBlocks).toHaveLength(0);
			});
		}
	}
});
