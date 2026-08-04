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
		expect(applyExactStreamDelta(blocks, textDelta("Hello"), false).applied).toBe(true);
		expect(applyExactStreamDelta(blocks, textDelta(", world"), false).applied).toBe(true);
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
		expect(applyExactStreamDelta(blocks, reasoningDelta("think", "r1"), false).applied).toBe(true);
		expect(applyExactStreamDelta(blocks, reasoningDelta("ing", "r1"), false).applied).toBe(true);
		expect(blocks).toEqual([{ type: "reasoning", text: "thinking", id: "r1" }]);
	});

	it("ignores non-delta events and empty deltas", () => {
		const blocks: StreamingBlock[] = [];
		expect(applyExactStreamDelta(blocks, { type: "other" }, false).applied).toBe(false);
		expect(applyExactStreamDelta(blocks, textDelta(""), false).applied).toBe(false);
		expect(applyExactStreamDelta(blocks, undefined, false).applied).toBe(false);
		expect(blocks).toEqual([]);
	});

	it("ignores subagent-scoped deltas on a top-level page but keeps them on a subagent page", () => {
		const subagentEvent: StreamDeltaEvent = {
			type: "content_block_delta",
			subagentToolUseId: "child-tool",
			delta: { type: "text_delta", text: "child" },
		};
		const topLevel: StreamingBlock[] = [];
		expect(applyExactStreamDelta(topLevel, subagentEvent, false).applied).toBe(false);
		expect(topLevel).toEqual([]);

		const subagentPage: StreamingBlock[] = [];
		expect(applyExactStreamDelta(subagentPage, subagentEvent, true).applied).toBe(true);
		expect(subagentPage).toEqual([{ type: "text", text: "child" }]);
	});

	// A relay that streams a text block with NO output index, mixed into a stream
	// that does carry them (see the note in anthropic-provider's delta decoder). The
	// un-indexed delta belongs to its own lane: merging it into the last block joined
	// two different provider outputs into one paragraph.
	it("keeps an un-indexed text delta out of an INDEXED block", () => {
		const blocks: StreamingBlock[] = [];
		applyExactStreamDelta(blocks, textDelta("indexed", 0), false);
		applyExactStreamDelta(blocks, textDelta("bare"), false);
		expect(blocks).toEqual([
			{ type: "text", text: "indexed", outputIndex: 0 },
			{ type: "text", text: "bare" },
		]);
	});

	it("accumulates further un-indexed deltas into the un-indexed block", () => {
		const blocks: StreamingBlock[] = [];
		applyExactStreamDelta(blocks, textDelta("indexed", 0), false);
		applyExactStreamDelta(blocks, textDelta("bare"), false);
		applyExactStreamDelta(blocks, textDelta(" more"), false);
		// ...and the indexed lane keeps growing independently.
		applyExactStreamDelta(blocks, textDelta(" tail", 0), false);
		expect(blocks).toEqual([
			{ type: "text", text: "indexed tail", outputIndex: 0 },
			{ type: "text", text: "bare more" },
		]);
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

/**
 * `blockIndex` — the accumulator's live-lane stamp.
 *
 * This is the ONE piece of semantics the shared fold adds beyond "did anything
 * change", and it decides when a reasoning run settles (a folded row stops
 * shimmering, drops its live tail, and rejoins the LOD fold). The consumer side is
 * covered by `@shared/pretext-layout/streaming-live-blocks`, but that test feeds it
 * hand-written `liveBlockIndex` constants — so the seam between "the index the
 * accumulator PRODUCES" and "the index the consumer EXPECTS" had no coverage at all,
 * which is precisely the fact `streaming-delta-fold.ts` documents as impossible to
 * re-derive from array position afterwards.
 */
describe("blockIndex — where the delta landed", () => {
	it("names the actual array position of a newly inserted block", () => {
		const blocks: StreamingBlock[] = [];
		const first = applyExactStreamDelta(blocks, reasoningDelta("think", "r1"), false);
		expect(first.blockIndex).toBe(0);
		expect(blocks[first.blockIndex]).toEqual({ type: "reasoning", text: "think", id: "r1" });

		const second = applyExactStreamDelta(blocks, textDelta("answer"), false);
		expect(second.blockIndex).toBe(1);
		expect(blocks[second.blockIndex]).toEqual({ type: "text", text: "answer" });
	});

	it("returns the EXISTING index when a delta continues a block", () => {
		const blocks: StreamingBlock[] = [];
		applyExactStreamDelta(blocks, reasoningDelta("a", "r1"), false);
		applyExactStreamDelta(blocks, textDelta("b"), false);
		// The reasoning lane reopens: the stamp must point back at index 0, not append.
		const again = applyExactStreamDelta(blocks, reasoningDelta("c", "r1"), false);
		expect(again.blockIndex).toBe(0);
		expect(blocks[0]).toEqual({ type: "reasoning", text: "ac", id: "r1" });
	});

	// The interleaved case the stamp exists for: reasoning → tool → reasoning, where
	// the provider's own output order puts the reopened run BEFORE the trailing lane.
	// Array position ("the last streamable block") would name the wrong one.
	it("points at a MIDDLE block when reasoning reopens after another lane", () => {
		const blocks: StreamingBlock[] = [];
		applyExactStreamDelta(blocks, reasoningDelta("first round", undefined, 0), false);
		applyExactStreamDelta(blocks, textDelta("interim answer", 1), false);
		const reopened = applyExactStreamDelta(blocks, reasoningDelta(" more", undefined, 0), false);
		expect(reopened.blockIndex).toBe(0);
		expect(reopened.blockIndex).toBeLessThan(blocks.length - 1);
		expect(blocks[0]).toEqual({
			type: "reasoning",
			text: "first round more",
			outputIndex: 0,
		});
	});

	it("is -1 when nothing was applied", () => {
		const blocks: StreamingBlock[] = [];
		expect(applyExactStreamDelta(blocks, { type: "other" }, false).blockIndex).toBe(-1);
		expect(applyExactStreamDelta(blocks, textDelta(""), false).blockIndex).toBe(-1);
	});

	// The documented caveat, pinned: an out-of-order insert SHIFTS everything after it,
	// so an index held from an earlier fold silently names a different block. Both
	// callers re-stamp after every delta, which is what makes this safe in practice —
	// this case exists so the constraint stays visible if that ever changes.
	it("invalidates an earlier index once a lower outputIndex is spliced in", () => {
		const blocks: StreamingBlock[] = [];
		const second = applyExactStreamDelta(blocks, textDelta("second", 1), false);
		expect(second.blockIndex).toBe(0);

		const first = applyExactStreamDelta(blocks, textDelta("first", 0), false);
		expect(first.blockIndex).toBe(0);
		// The stale stamp now points at the NEW block, not the one it was taken for.
		expect(blocks[second.blockIndex]).toEqual({ type: "text", text: "first", outputIndex: 0 });
		// ...and a fresh delta for the original lane reports its shifted position.
		const secondAgain = applyExactStreamDelta(blocks, textDelta("!", 1), false);
		expect(secondAgain.blockIndex).toBe(1);
	});

	// The stamp is consumed by resolveLiveBlockIndex on the published row, so the two
	// must agree about what the number means. This closes that seam directly.
	it("feeds resolveLiveBlockIndex to mark the right block live", async () => {
		const { resolveLiveBlockIndex, isLiveStreamingBlock } = await import(
			"@shared/pretext-layout/streaming-live-blocks"
		);
		const blocks: StreamingBlock[] = [];
		applyExactStreamDelta(blocks, reasoningDelta("thinking", undefined, 0), false);
		const answer = applyExactStreamDelta(blocks, textDelta("answer", 1), false);
		const msg = { contentJson: blocks, liveBlockIndex: answer.blockIndex };

		expect(resolveLiveBlockIndex(true, msg)).toBe(answer.blockIndex);
		// The reasoning run has settled; only the text lane is live.
		expect(isLiveStreamingBlock(true, msg, 0)).toBe(false);
		expect(isLiveStreamingBlock(true, msg, answer.blockIndex)).toBe(true);

		// Reasoning reopens mid-turn: the stamp moves back to the middle block, and the
		// consumer follows it rather than the array's tail.
		const reopened = applyExactStreamDelta(blocks, reasoningDelta("!", undefined, 0), false);
		const reopenedMsg = { contentJson: blocks, liveBlockIndex: reopened.blockIndex };
		expect(isLiveStreamingBlock(true, reopenedMsg, 0)).toBe(true);
		expect(isLiveStreamingBlock(true, reopenedMsg, blocks.length - 1)).toBe(false);
	});
});
