import type { ContentBlock, ToolCallRecord, TreeMessage } from "../../frontend/lib/api";

const NOW = new Date("2025-01-01T00:00:00.000Z").toISOString();

export function makeMessage(
	partial: Partial<TreeMessage> & Pick<TreeMessage, "id" | "role">,
): TreeMessage {
	return {
		id: partial.id,
		narratorId: partial.narratorId ?? "n-main",
		parentToolUseId: partial.parentToolUseId ?? null,
		messageUuid: partial.messageUuid,
		role: partial.role,
		contentJson: (partial.contentJson ?? []) as ContentBlock[],
		contentText: partial.contentText ?? null,
		toolCalls: (partial.toolCalls ?? []) as ToolCallRecord[],
		tokensIn: partial.tokensIn ?? null,
		costUsd: partial.costUsd ?? null,
		turnUsageJson: partial.turnUsageJson ?? null,
		contextPercent: partial.contextPercent ?? null,
		meterUsage: partial.meterUsage ?? null,
		meterUnit: partial.meterUnit ?? null,
		subagentModel: partial.subagentModel ?? null,
		seq: partial.seq,
		createdAt: partial.createdAt ?? NOW,
		children: partial.children ?? [],
	};
}

export function createStreamingChunksFixture() {
	const regular = makeMessage({
		id: "m-regular",
		role: "assistant",
		contentJson: [{ type: "text", text: "normal message" }],
	});
	const streaming = makeMessage({
		id: "__streaming_tool_chunks__",
		role: "assistant",
		contentJson: [{ type: "tool_use", id: "stream-1", name: "Write", input: {} }],
		toolCalls: [
			{ toolUseId: "stream-1", toolName: "Write", status: "initializing", createdAt: NOW },
		],
	});
	const tail = makeMessage({
		id: "m-tail",
		role: "assistant",
		contentJson: [{ type: "text", text: "tail" }],
	});

	return {
		regular,
		streaming,
		tail,
	};
}
