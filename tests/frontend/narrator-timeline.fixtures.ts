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
		createdAt: partial.createdAt ?? NOW,
		children: partial.children ?? [],
		_noMerge: partial._noMerge,
	};
}

export function createLegacyToolRunFixture() {
	const taskToolUseId = "tool-task-1";
	const bashToolUseId = "tool-bash-1";

	const childFromTask = makeMessage({
		id: "child-1",
		narratorId: "n-sub",
		parentToolUseId: taskToolUseId,
		role: "assistant",
		contentJson: [{ type: "text", text: "subagent response" }],
	});

	const first = makeMessage({
		id: "m-tool-1",
		role: "assistant",
		contentJson: [
			{ type: "reasoning", text: "先规划再执行" },
			{ type: "tool_use", id: taskToolUseId, name: "Task", input: { prompt: "探索" } },
		],
		toolCalls: [
			{
				id: "tc-task-1",
				toolUseId: taskToolUseId,
				toolName: "Task",
				status: "running",
				inputJson: { prompt: "探索" },
				createdAt: NOW,
			},
		],
		children: [childFromTask],
	});

	const second = makeMessage({
		id: "m-tool-2",
		role: "assistant",
		contentJson: [
			{ type: "tool_use", id: bashToolUseId, name: "Bash", input: { command: "ls -la" } },
		],
		toolCalls: [
			{
				id: "tc-bash-1",
				toolUseId: bashToolUseId,
				toolName: "Bash",
				status: "success",
				inputJson: { command: "ls -la" },
				outputJson: "ok",
				createdAt: NOW,
			},
		],
	});

	return {
		run: [first, second],
		taskToolUseId,
		bashToolUseId,
		childFromTask,
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
		_noMerge: true,
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
