import { describe, expect, test } from "bun:test";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import type { NarratorMsg } from "../narrator-panel-types";
import {
	buildStreamingMsg,
	mergeStreamingSnapshotBlocks,
	resolveAllToolCallsFromMsg,
	type StreamingBlock,
	segmentMessages,
} from "./message-segments";

describe("buildStreamingMsg request identity", () => {
	test("carries actual identity without inferring it from tool chunks", () => {
		const toolChunksMsg = rowWithElements(
			{
				model: "unrelated-model",
				provider: "unrelated-provider",
			},
			[{ type: "tool_use", id: "tool", name: "Read" }],
		) as NarratorMsg;
		expect(
			buildStreamingMsg({
				narratorId: "n",
				model: "gpt-request",
				provider: "openai",
				toolChunksMsg,
			}),
		).toMatchObject({ model: "gpt-request", provider: "openai" });
		const unknownIdentity = buildStreamingMsg({ narratorId: "n", toolChunksMsg });
		expect(unknownIdentity).not.toHaveProperty("model");
		expect(unknownIdentity).not.toHaveProperty("provider");
	});
});

describe("resolveAllToolCallsFromMsg", () => {
	test("accepts numeric tcCreatedAt values", () => {
		const createdAt = 1_700_000_000_000;
		const msg = rowWithElements(
			{
				role: "assistant",
				toolCalls: [],
			},
			[{ type: "tool_use", id: "tool-1", name: "Read", tcCreatedAt: createdAt }],
		) as unknown as NarratorMsg;

		expect(resolveAllToolCallsFromMsg(msg)[0]).toMatchObject({ createdAt, startedAt: createdAt });
	});

	test("accepts ISO tcCreatedAt values", () => {
		const createdAt = "2023-11-14T22:13:20.000Z";
		const msg = rowWithElements(
			{
				role: "assistant",
				toolCalls: [],
			},
			[{ type: "tool_use", id: "tool-1", name: "Read", tcCreatedAt: createdAt }],
		) as unknown as NarratorMsg;

		expect(resolveAllToolCallsFromMsg(msg)[0]).toMatchObject({
			createdAt,
			startedAt: Date.parse(createdAt),
		});
	});

	test("recognizes Send as a subagent card from _subagentActivity without children", () => {
		const msg = rowWithElements(
			{
				id: "message-1",
				narratorId: "narrator-1",
				parentToolUseId: null,
				role: "assistant",
				contentText: null,
				toolCalls: [{ toolUseId: "send-1", toolName: "Send", status: "running" }],
				createdAt: "2026-07-18T00:00:00.000Z",
			},
			[
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
		) as NarratorMsg;
		const segments = segmentMessages([msg]);
		expect(segments[0]).toMatchObject({
			kind: "tool-run",
			items: [{ isSubagent: true, tc: { toolName: "Send" } }],
		});
	});
});

describe("segmentMessages", () => {
	function toolMessage(messageId: string, toolUseId: string, reasoningText: string): NarratorMsg {
		return rowWithElements(
			{
				id: messageId,
				narratorId: "narrator-1",
				parentToolUseId: null,
				role: "assistant",
				contentText: null,
				toolCalls: [
					{
						id: `call-${toolUseId}`,
						toolUseId,
						toolName: "Read",
						status: "success",
					},
				],
				createdAt: "2026-07-19T00:00:00.000Z",
			},
			[
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
		) as NarratorMsg;
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
	const text = (id: string, revision: number, body: string, outputIndex = 0): StreamingBlock => ({
		type: "text",
		id,
		revision,
		textOffset: 0,
		text: body,
		outputIndex,
	});

	test("fills gaps from a snapshot into empty live blocks", () => {
		const blocks: StreamingBlock[] = [];
		const changed = mergeStreamingSnapshotBlocks(blocks, [text("t1", 1, "hello")]);
		expect(changed).toBe(true);
		expect(blocks).toEqual([text("t1", 1, "hello")]);
	});

	test("never replaces live text with an older revision", () => {
		const blocks: StreamingBlock[] = [text("t1", 2, "hello world")];
		const changed = mergeStreamingSnapshotBlocks(blocks, [text("t1", 1, "hello")]);
		expect(changed).toBe(false);
		expect(blocks[0]).toEqual(text("t1", 2, "hello world"));
	});

	test("adopts a newer revision of the same text block", () => {
		const blocks: StreamingBlock[] = [text("t1", 1, "hel")];
		const changed = mergeStreamingSnapshotBlocks(blocks, [text("t1", 2, "hello")]);
		expect(changed).toBe(true);
		expect(blocks[0]).toEqual(text("t1", 2, "hello"));
	});

	test("matches reasoning by id and keeps the newer revision", () => {
		const reasoning = (revision: number, body: string): StreamingBlock => ({
			type: "reasoning",
			id: "r1",
			revision,
			textOffset: 0,
			text: body,
		});
		const blocks: StreamingBlock[] = [reasoning(2, "abcd")];
		const changed = mergeStreamingSnapshotBlocks(blocks, [reasoning(1, "ab")]);
		expect(changed).toBe(false);
		expect(blocks[0]).toEqual(reasoning(2, "abcd"));
	});

	test("ignores a text lane that does not name its element and revision", () => {
		const blocks: StreamingBlock[] = [];
		const unnamed = { type: "text", text: "hello", outputIndex: 0 } as unknown as StreamingBlock;
		expect(mergeStreamingSnapshotBlocks(blocks, [unnamed])).toBe(false);
		expect(blocks).toEqual([]);
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
		const blocks: StreamingBlock[] = [text("t2", 1, "second", 2)];
		mergeStreamingSnapshotBlocks(blocks, [text("t1", 1, "first", 1)]);
		expect(blocks.map((b) => (b.type === "text" ? b.text : ""))).toEqual(["first", "second"]);
	});
});
