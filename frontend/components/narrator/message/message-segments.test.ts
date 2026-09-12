import { describe, expect, test } from "bun:test";
import type { NarratorMsg } from "../narrator-panel-types";
import {
	mergeStreamingSnapshotBlocks,
	resolveAllToolCallsFromMsg,
	type StreamingBlock,
	segmentMessages,
} from "./message-segments";

describe("resolveAllToolCallsFromMsg", () => {
	test("accepts numeric tcCreatedAt values", () => {
		const createdAt = 1_700_000_000_000;
		const msg = {
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tool-1", name: "Read", tcCreatedAt: createdAt }],
			toolCalls: [],
		} as unknown as NarratorMsg;

		expect(resolveAllToolCallsFromMsg(msg)[0]).toMatchObject({ createdAt, startedAt: createdAt });
	});

	test("accepts ISO tcCreatedAt values", () => {
		const createdAt = "2023-11-14T22:13:20.000Z";
		const msg = {
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tool-1", name: "Read", tcCreatedAt: createdAt }],
			toolCalls: [],
		} as unknown as NarratorMsg;

		expect(resolveAllToolCallsFromMsg(msg)[0]).toMatchObject({
			createdAt,
			startedAt: Date.parse(createdAt),
		});
	});

	test("recognizes Send as a subagent card from _subagentActivity without children", () => {
		const msg = {
			id: "message-1",
			narratorId: "narrator-1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{
					type: "tool_use",
					id: "send-1",
					name: "Send",
					_subagentActivity: {
						subagentNarratorId: "subagent-1",
						model: null,
						latestToolCalls: [],
					},
				},
			],
			contentText: null,
			toolCalls: [{ toolUseId: "send-1", toolName: "Send", status: "running" }],
			children: [],
			createdAt: "2026-07-18T00:00:00.000Z",
		} as NarratorMsg;
		const segments = segmentMessages([msg]);
		expect(segments[0]).toMatchObject({
			kind: "tool-run",
			items: [{ isSubagent: true, tc: { toolName: "Send" } }],
		});
	});
});

describe("segmentMessages", () => {
	function toolMessage(messageId: string, toolUseId: string, reasoningText: string): NarratorMsg {
		return {
			id: messageId,
			narratorId: "narrator-1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{
					type: "reasoning",
					text: reasoningText,
					providerMetadata: {
						anthropic: { blockIndex: 0, signature: `signature-${messageId}` },
						signatureSource: "kimi-2",
					},
				},
				{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "a.ts" } },
			],
			contentText: null,
			toolCalls: [
				{
					id: `call-${toolUseId}`,
					toolUseId,
					toolName: "Read",
					status: "success",
				},
			],
			children: [],
			createdAt: "2026-07-19T00:00:00.000Z",
		} as NarratorMsg;
	}

	test("metadata-only empty reasoning does not split consecutive tool runs", () => {
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", ""),
			toolMessage("message-2", "tool-2", ""),
		]);

		expect(segments).toHaveLength(1);
		expect(segments[0]).toMatchObject({
			kind: "tool-run",
			items: [{ tc: { toolUseId: "tool-1" } }, { tc: { toolUseId: "tool-2" } }],
		});
	});

	test("visible reasoning remains a content boundary", () => {
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "first thought"),
			toolMessage("message-2", "tool-2", "second thought"),
		]);

		expect(segments.map((segment) => segment.kind)).toEqual([
			"message",
			"tool-run",
			"message",
			"tool-run",
		]);
	});
});

describe("mergeStreamingSnapshotBlocks", () => {
	test("fills gaps from a snapshot into empty live blocks", () => {
		const blocks: StreamingBlock[] = [];
		const changed = mergeStreamingSnapshotBlocks(blocks, [
			{ type: "text", text: "hello", outputIndex: 0 },
		]);
		expect(changed).toBe(true);
		expect(blocks).toEqual([{ type: "text", text: "hello", outputIndex: 0 }]);
	});

	test("never truncates live text with a shorter/older snapshot", () => {
		const blocks: StreamingBlock[] = [{ type: "text", text: "hello world", outputIndex: 0 }];
		const changed = mergeStreamingSnapshotBlocks(blocks, [
			{ type: "text", text: "hello", outputIndex: 0 },
		]);
		expect(changed).toBe(false);
		expect(blocks[0]).toEqual({ type: "text", text: "hello world", outputIndex: 0 });
	});

	test("adopts a longer snapshot for the same text block", () => {
		const blocks: StreamingBlock[] = [{ type: "text", text: "hel", outputIndex: 0 }];
		const changed = mergeStreamingSnapshotBlocks(blocks, [
			{ type: "text", text: "hello", outputIndex: 0 },
		]);
		expect(changed).toBe(true);
		expect(blocks[0]).toEqual({ type: "text", text: "hello", outputIndex: 0 });
	});

	test("merges text snapshots without outputIndex instead of duplicating them", () => {
		const blocks: StreamingBlock[] = [{ type: "text", text: "hello world" }];
		const changed = mergeStreamingSnapshotBlocks(blocks, [{ type: "text", text: "hello" }]);
		expect(changed).toBe(false);
		expect(blocks).toEqual([{ type: "text", text: "hello world" }]);
	});

	test("matches reasoning by id and keeps the longer text", () => {
		const blocks: StreamingBlock[] = [{ type: "reasoning", id: "r1", text: "abcd" }];
		const changed = mergeStreamingSnapshotBlocks(blocks, [
			{ type: "reasoning", id: "r1", text: "ab" },
		]);
		expect(changed).toBe(false);
		expect(blocks[0]).toEqual({ type: "reasoning", id: "r1", text: "abcd" });
	});

	test("refreshes web_search status from the snapshot", () => {
		const blocks: StreamingBlock[] = [
			{ type: "web_search", id: "s1", status: "in_progress", query: "foo" },
		];
		const changed = mergeStreamingSnapshotBlocks(blocks, [
			{ type: "web_search", id: "s1", status: "completed", query: "foo" },
		]);
		expect(changed).toBe(true);
		expect(blocks[0]).toEqual({
			type: "web_search",
			id: "s1",
			status: "completed",
			query: "foo",
		});
	});

	test("keeps blocks ordered by output index when inserting", () => {
		const blocks: StreamingBlock[] = [{ type: "text", text: "second", outputIndex: 2 }];
		mergeStreamingSnapshotBlocks(blocks, [{ type: "text", text: "first", outputIndex: 1 }]);
		expect(blocks.map((b) => (b.type === "text" ? b.text : ""))).toEqual(["first", "second"]);
	});
});
