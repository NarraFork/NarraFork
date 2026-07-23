import { describe, expect, it } from "bun:test";
import type { StreamingBlock } from "../message-segments";
import {
	applyExactStreamDelta,
	applyExactStreamingSnapshot,
	type StreamDeltaEvent,
} from "./exact-streaming-accumulator";

function textDelta(text: string, outputIndex?: number): StreamDeltaEvent {
	return {
		type: "content_block_delta",
		...(outputIndex != null ? { outputIndex } : {}),
		delta: { type: "text_delta", text },
	};
}

function reasoningDelta(text: string, id?: string, outputIndex?: number): StreamDeltaEvent {
	return {
		type: "content_block_delta",
		delta: {
			type: "reasoning_delta",
			text,
			...(id ? { id } : {}),
			...(outputIndex != null ? { outputIndex } : {}),
		},
	};
}

describe("exact-streaming-accumulator", () => {
	it("accumulates consecutive text deltas into one text block", () => {
		const blocks: StreamingBlock[] = [];
		expect(applyExactStreamDelta(blocks, textDelta("Hello"), false)).toBe(true);
		expect(applyExactStreamDelta(blocks, textDelta(", world"), false)).toBe(true);
		expect(blocks).toEqual([{ type: "text", text: "Hello, world" }]);
	});

	it("keeps distinct output indices as separate ordered text blocks", () => {
		const blocks: StreamingBlock[] = [];
		applyExactStreamDelta(blocks, textDelta("second", 1), false);
		applyExactStreamDelta(blocks, textDelta("first", 0), false);
		applyExactStreamDelta(blocks, textDelta(" more", 0), false);
		expect(blocks).toEqual([
			{ type: "text", text: "first more", outputIndex: 0 },
			{ type: "text", text: "second", outputIndex: 1 },
		]);
	});

	it("accumulates reasoning deltas by id", () => {
		const blocks: StreamingBlock[] = [];
		expect(applyExactStreamDelta(blocks, reasoningDelta("think", "r1"), false)).toBe(true);
		expect(applyExactStreamDelta(blocks, reasoningDelta("ing", "r1"), false)).toBe(true);
		expect(blocks).toEqual([{ type: "reasoning", text: "thinking", id: "r1" }]);
	});

	it("ignores non-delta events and empty deltas", () => {
		const blocks: StreamingBlock[] = [];
		expect(applyExactStreamDelta(blocks, { type: "other" }, false)).toBe(false);
		expect(applyExactStreamDelta(blocks, textDelta(""), false)).toBe(false);
		expect(applyExactStreamDelta(blocks, undefined, false)).toBe(false);
		expect(blocks).toEqual([]);
	});

	it("ignores subagent-scoped deltas on a top-level page but keeps them on a subagent page", () => {
		const subagentEvent: StreamDeltaEvent = {
			type: "content_block_delta",
			subagentToolUseId: "child-tool",
			delta: { type: "text_delta", text: "child" },
		};
		const topLevel: StreamingBlock[] = [];
		expect(applyExactStreamDelta(topLevel, subagentEvent, false)).toBe(false);
		expect(topLevel).toEqual([]);

		const subagentPage: StreamingBlock[] = [];
		expect(applyExactStreamDelta(subagentPage, subagentEvent, true)).toBe(true);
		expect(subagentPage).toEqual([{ type: "text", text: "child" }]);
	});

	it("merges a reconnect snapshot without regressing already-shown longer text", () => {
		const blocks: StreamingBlock[] = [{ type: "text", text: "abcdef", outputIndex: 0 }];
		// A shorter snapshot for the same block must not shrink it.
		const changed = applyExactStreamingSnapshot(blocks, [
			{ type: "text", text: "abc", outputIndex: 0 },
		]);
		expect(changed).toBe(false);
		expect(blocks).toEqual([{ type: "text", text: "abcdef", outputIndex: 0 }]);
	});

	it("fills a gap from the snapshot when the block is missing", () => {
		const blocks: StreamingBlock[] = [];
		const changed = applyExactStreamingSnapshot(blocks, [
			{ type: "reasoning", text: "restored", id: "r9" },
		]);
		expect(changed).toBe(true);
		expect(blocks).toEqual([{ type: "reasoning", text: "restored", id: "r9" }]);
	});

	it("returns false for an empty snapshot", () => {
		const blocks: StreamingBlock[] = [];
		expect(applyExactStreamingSnapshot(blocks, [])).toBe(false);
	});
});
