import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narratorSidecars,
	narrators,
	narratorToolCalls,
} from "../../db/schema";

// Functional in-memory test db (not empty stubs): Bun's mock.module is global
// and leaks across files, so `{}` stubs would break `db.*` in later real-db suites.
const { db, sqlite } = getTestDb();
// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../db", () => ({ db, sqlite }));

const broadcastMessages: unknown[] = [];
mock.module("../../websocket/narrator-ws", () => ({
	broadcastToNarrator: (_narratorId: string, message: unknown) => {
		broadcastMessages.push(message);
	},
	getNarratorConnections: () => [],
}));

const {
	clearStreamingSnapshot,
	CriticalEventPersistenceError,
	getStreamingSnapshot,
	processEvent,
} = await import("../narrator-event-handler");
const { getPipelineState, markPipelineUsed, startPipelineState } = await import(
	"../../lib/agent/pipeline-state"
);

type EventHandlerContext = import("../narrator-event-handler").EventHandlerContext;

const PARENT_NARRATOR_ID = "parent-narrator";
const SUBAGENT_NARRATOR_ID = "subagent-narrator";
const PARENT_TOOL_USE_ID = "parent-tool-use";

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
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("narrator event handler streaming snapshot", () => {
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

	test("子代理 tool_completed 向父级隐藏 output/metadata/sidecars，self 保持完整", async () => {
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
				sideCars: [{ target: "tool_result", source: "test", content: "sensitive sidecar" }],
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
		expect(parent).not.toHaveProperty("sideCars");
		expect(self?.output).toBe("sensitive output");
		expect(self?.metadata).toEqual({ secret: true });
		expect(self?.sideCars).toHaveLength(1);
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
			{ type: "text", text: "保留的 partial 文本", outputIndex: 0 },
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
			{ type: "text", text: "parent live text", outputIndex: 0 },
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
					await db.delete(narratorSidecars).where(eq(narratorSidecars.messageId, savedMessageId));
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

	test("Pipeline exit confirmation 仅在 SideCar 成功持久化后确认消费", async () => {
		const narratorId = `pipeline-sidecar-${Date.now()}`;
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id: narratorId, createdAt: now, updatedAt: now });
		try {
			const state = await startPipelineState(narratorId);
			await markPipelineUsed(narratorId, state.id);
			expect((await getPipelineState(narratorId))?.exitConfirmationPending).toBe(true);

			const ctx = makeSubagentContext();
			ctx.narratorId = narratorId;
			await processEvent(
				{
					type: "tool_result",
					toolUseId: "pipeline-confirmation-result",
					toolName: "Read",
					output: "captured",
					isError: false,
					metadata: { pipelineExitConfirmationStateId: state.id },
					sideCars: [
						{
							target: "tool_result",
							source: "pipeline_exit_confirmation",
							content: "confirm pipeline exit",
							toolUseId: "pipeline-confirmation-result",
						},
					],
				},
				ctx,
			);

			expect((await getPipelineState(narratorId))?.exitConfirmationPending).toBe(false);
		} finally {
			await db.delete(narrators).where(eq(narrators.id, narratorId));
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
