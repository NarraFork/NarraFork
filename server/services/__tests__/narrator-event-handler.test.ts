import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

mock.module("../../db", () => ({
	db: {},
	sqlite: {},
}));

mock.module("../../websocket/narrator-ws", () => ({
	broadcastToNarrator: () => {},
	getNarratorConnections: () => [],
}));

const { clearStreamingSnapshot, getStreamingSnapshot, processEvent } = await import(
	"../narrator-event-handler"
);

type EventHandlerContext = import("../narrator-event-handler").EventHandlerContext;

const PARENT_NARRATOR_ID = "parent-narrator";
const PARENT_TOOL_USE_ID = "parent-tool-use";

function makeSubagentContext(): EventHandlerContext {
	return {
		narratorId: "subagent-narrator",
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
	};
}

afterEach(() => {
	clearStreamingSnapshot(PARENT_NARRATOR_ID);
});

afterAll(() => {
	mock.restore();
});

describe("narrator event handler streaming snapshot", () => {
	test("子代理直接 tool_call 时保留 parentToolUseId", async () => {
		await processEvent(
			{
				type: "tool_call",
				toolUseId: "direct-tool-call",
				toolName: "Bash",
				input: { command: "pwd" },
			},
			makeSubagentContext(),
		);

		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("direct-tool-call")).toEqual(
			expect.objectContaining({
				parentToolUseId: PARENT_TOOL_USE_ID,
				started: true,
			}),
		);
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

		expect(getStreamingSnapshot(PARENT_NARRATOR_ID)?.toolChunks.get("streamed-tool-call")).toEqual(
			expect.objectContaining({
				parentToolUseId: PARENT_TOOL_USE_ID,
				inputCharsTotal: 24,
				extractedFilePath: "/tmp/example.ts",
				started: true,
			}),
		);
	});
});
