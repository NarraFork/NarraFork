import { describe, expect, test } from "bun:test";
import type { ToolCallRecord, TreeMessage } from "../../../lib/api";
import { mergeToolCallFieldsInTree } from "../message-tree-utils";
import {
	getSyntheticTopLevelStreamingChunks,
	splitTopLevelStreamingChunksByPersistedToolUse,
	type TopLevelStreamingChunk,
	topLevelStreamingChunkMatchesPersistedTool,
	topLevelStreamingChunkToToolFields,
} from "../narrator-message-helpers";

const NARRATOR_ID = "narrator-1";
const TOOL_USE_ID = "tool-use-1";

function persistedToolMessage(
	toolUseId = TOOL_USE_ID,
	options: { withToolCall?: boolean; status?: string } = {},
): TreeMessage {
	const status = options.status ?? "pending";
	const permissionDecisionReason = "Danger reflection in progress";
	const toolCall: ToolCallRecord = {
		toolUseId,
		toolName: "Bash",
		inputJson: { command: "bun test" },
		status,
		permissionDecisionReason,
		createdAt: "2026-04-11T10:00:00.000Z",
	};
	return {
		id: `message-${toolUseId}`,
		narratorId: NARRATOR_ID,
		parentToolUseId: null,
		role: "assistant",
		contentJson: [
			{
				type: "tool_use",
				id: toolUseId,
				name: "Bash",
				input: { command: "bun test" },
				inputJson: { command: "bun test" },
				status,
				permissionDecisionReason,
			},
		],
		contentText: null,
		toolCalls: options.withToolCall === false ? [] : [toolCall],
		createdAt: "2026-04-11T10:00:00.000Z",
		children: [],
	};
}

function startedChunk(toolUseId = TOOL_USE_ID): TopLevelStreamingChunk {
	return {
		toolUseId,
		toolName: "Bash",
		inputCharsTotal: -1,
		_started: true,
		_input: { command: "bun test --watch=false" },
		_status: "running",
		_startedAt: 1_765_000_000_000,
		_streamingOutput: "1 pass",
		_metadata: { executionDeviceId: "local" },
	};
}

function reconcile(
	messages: TreeMessage[],
	chunks: TopLevelStreamingChunk[],
): { messages: TreeMessage[]; synthetic: TopLevelStreamingChunk[] } {
	const { matched, unmatched } = splitTopLevelStreamingChunksByPersistedToolUse(chunks, messages);
	let nextMessages = messages;
	for (const chunk of matched) {
		nextMessages = mergeToolCallFieldsInTree(
			nextMessages,
			chunk.toolUseId,
			topLevelStreamingChunkToToolFields(chunk),
		).messages;
	}
	return { messages: nextMessages, synthetic: unmatched };
}

function mergedToolState(messages: TreeMessage[]) {
	const message = messages[0];
	const toolCall = message.toolCalls[0] as ToolCallRecord & {
		startedAt?: number;
		_streamingOutput?: string;
	};
	const toolBlock = message.contentJson.find(
		(block) => block.type === "tool_use" && block.id === TOOL_USE_ID,
	);
	return { toolCall, toolBlock };
}

describe("catch-up top-level tool reconciliation", () => {
	test("snapshot first, history later replaces the synthetic card by toolUseId", () => {
		const chunk = startedChunk();
		const beforeHistory = reconcile([], [chunk]);
		expect(beforeHistory.synthetic).toHaveLength(1);

		const afterHistory = reconcile([persistedToolMessage()], beforeHistory.synthetic);
		expect(afterHistory.synthetic).toHaveLength(0);
		const { toolCall, toolBlock } = mergedToolState(afterHistory.messages);
		expect(toolCall.status).toBe("running");
		expect(toolCall.inputJson).toEqual({ command: "bun test --watch=false" });
		expect(toolCall.permissionDecisionReason).toBe("Danger reflection in progress");
		expect(toolBlock?.status).toBe("running");
		expect(toolBlock?.permissionDecisionReason).toBe("Danger reflection in progress");
	});

	test("history first, snapshot later updates the existing card without adding a synthetic one", () => {
		const result = reconcile([persistedToolMessage()], [startedChunk()]);
		expect(result.synthetic).toHaveLength(0);
		const { toolCall, toolBlock } = mergedToolState(result.messages);
		expect(toolCall.status).toBe("running");
		expect(toolCall.startedAt).toBe(1_765_000_000_000);
		expect(toolCall._streamingOutput).toBe("1 pass");
		expect(toolBlock?.status).toBe("running");
		expect(toolBlock?._metadata).toEqual({ executionDeviceId: "local" });
	});

	test("only unmatched snapshot tools remain synthetic", () => {
		const liveId = "not-persisted-yet";
		const result = reconcile([persistedToolMessage()], [startedChunk(), startedChunk(liveId)]);
		expect(result.synthetic.map((chunk) => chunk.toolUseId)).toEqual([liveId]);
		expect(result.messages[0].toolCalls[0].toolUseId).toBe(TOOL_USE_ID);
		expect(result.messages[0].toolCalls[0].status).toBe("running");
	});

	test("contentJson-only partial messages still match and receive live state", () => {
		const result = reconcile(
			[persistedToolMessage(TOOL_USE_ID, { withToolCall: false })],
			[startedChunk()],
		);
		expect(result.synthetic).toHaveLength(0);
		expect(result.messages[0].toolCalls).toHaveLength(0);
		const toolBlock = result.messages[0].contentJson.find(
			(block) => block.type === "tool_use" && block.id === TOOL_USE_ID,
		);
		expect(toolBlock?.status).toBe("running");
		expect(toolBlock?.inputJson).toEqual({ command: "bun test --watch=false" });
		expect(toolBlock?.permissionDecisionReason).toBe("Danger reflection in progress");
	});

	test("streaming input markers augment rather than erase persisted input", () => {
		const result = reconcile(
			[persistedToolMessage()],
			[
				{
					toolUseId: TOOL_USE_ID,
					toolName: "Bash",
					inputCharsTotal: 42,
					extractedFields: { command: "bun test" },
				},
			],
		);
		const { toolCall, toolBlock } = mergedToolState(result.messages);
		expect(toolCall.inputJson).toEqual({
			command: "bun test",
			_streamingChars: 42,
			_streamingFields: { command: "bun test" },
		});
		expect(toolBlock?.inputJson).toEqual(toolCall.inputJson);
	});

	test("reconciliation ownership keeps a matched tool synthetic-hidden after history eviction", () => {
		const chunk = startedChunk();
		const reconciled = new Set([TOOL_USE_ID]);
		expect(
			getSyntheticTopLevelStreamingChunks([chunk], [persistedToolMessage()], reconciled),
		).toHaveLength(0);
		expect(getSyntheticTopLevelStreamingChunks([chunk], [], reconciled)).toHaveLength(0);
	});

	test("detects when a refreshed history object dropped live runtime fields", () => {
		const chunk = startedChunk();
		const merged = reconcile([persistedToolMessage()], [chunk]).messages;
		expect(topLevelStreamingChunkMatchesPersistedTool(merged, chunk)).toBe(true);
		expect(topLevelStreamingChunkMatchesPersistedTool([persistedToolMessage()], chunk)).toBe(false);
	});
});
