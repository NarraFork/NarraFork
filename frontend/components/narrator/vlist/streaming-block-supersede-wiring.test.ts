/**
 * streaming-block-supersede-wiring.test.ts — the per-block hand-off against the
 * surrounding machinery, not just its own decision table.
 *
 * The decision rules are pinned in
 * `frontend/components/narrator/streaming-block-supersede.test.ts`. What is pinned
 * HERE is what the fix could break elsewhere:
 *
 * 1. Ordinary streaming (no backgrounding) still shows the paragraph exactly once —
 *    the live row must not shrink while the partial row is invisible to clients.
 * 2. The reported bug's timeline ends with ONE copy, and text produced after the
 *    catch-up survives.
 * 3. Dropping blocks does not move `commitGrowthSignature`, so the hand-off's
 *    `charsSinceLastCommit` protection is not reset.
 * 4. A mid-turn clear caused by this hand-off does NOT trigger the head trim, whose
 *    edge previously assumed "row cleared" meant "turn ended". A trim there resets
 *    that same protection and endangers the next step's output.
 */

import { describe, expect, it } from "bun:test";
import type { StreamingBlock } from "../message-segments";
import {
	dropSupersededStreamingBlocks,
	type SupersedeCandidateMessage,
} from "../streaming-block-supersede";
import { commitGrowthSignature, type HandoffMessage } from "./streaming-handoff";
import { resolveStreamingClearedTrimEdge } from "./vlist-head-trim";

const PARAGRAPH = "确认了根因，这是我的设计错误。";

function persistedRow(blocks: unknown[]): SupersedeCandidateMessage & HandoffMessage {
	return {
		id: "m-partial",
		role: "assistant",
		parentToolUseId: null,
		contentJson: blocks,
	} as SupersedeCandidateMessage & HandoffMessage;
}

/** How many times the paragraph is visible across document + live row. */
function renderedCopies(
	committed: readonly SupersedeCandidateMessage[],
	blocks: readonly StreamingBlock[],
): number {
	let copies = 0;
	for (const message of committed) {
		if (!Array.isArray(message.contentJson)) continue;
		for (const block of message.contentJson) {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string" && text.includes(PARAGRAPH)) copies++;
		}
	}
	for (const block of blocks) {
		if ((block.type === "text" || block.type === "reasoning") && block.text.includes(PARAGRAPH)) {
			copies++;
		}
	}
	return copies;
}

describe("ordinary streaming — the row does not shrink", () => {
	/**
	 * Mid-turn the server has already archived the block into the partial message, but
	 * that row is invisible to clients (`appendBlockToMessage` neither bumps
	 * `messageVersion` nor broadcasts). The live row is the ONLY view of the content, so
	 * a hand-off that fired here would take it off screen and put nothing in its place —
	 * "writes a paragraph, then the paragraph vanishes".
	 */
	it("keeps the paragraph on screen exactly once while the partial row is undelivered", () => {
		const blocks: StreamingBlock[] = [{ type: "text", text: PARAGRAPH, outputIndex: 0 }];
		const committed: SupersedeCandidateMessage[] = [];

		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(false);
		expect(blocks).toHaveLength(1);
		expect(renderedCopies(committed, blocks)).toBe(1);
	});

	it("still shows it once after the block settles but before any delivery", () => {
		// The lane is no longer live (the model moved to a tool call), which is the most
		// dangerous moment: the guard is off and only "is it in the document" remains.
		const blocks: StreamingBlock[] = [{ type: "text", text: PARAGRAPH, outputIndex: 0 }];
		expect(dropSupersededStreamingBlocks(blocks, [], null)).toBe(false);
		expect(renderedCopies([], blocks)).toBe(1);
	});
});

describe("the reported bug — foreground catch-up delivers the partial row", () => {
	it("collapses the duplicate to one copy", () => {
		const blocks: StreamingBlock[] = [
			{ type: "reasoning", text: "推理内容", id: "rs_1" },
			{ type: "text", text: PARAGRAPH, outputIndex: 0 },
		];
		// Before: the row holds both blocks and the document holds none.
		expect(renderedCopies([], blocks)).toBe(1);

		// The tab returns to the foreground; catch-up appends the partial row, which
		// carries the blocks the live row is still holding.
		const committed = [
			persistedRow([
				{ type: "reasoning", text: "推理内容", providerMetadata: { openai: { itemId: "rs_1" } } },
				{ type: "text", text: PARAGRAPH, outputIndex: 0 },
			]),
		];
		// Both copies are on screen — this is the reported symptom.
		expect(renderedCopies(committed, blocks)).toBe(2);

		// The model has moved on to a tool call, so no lane is live.
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(true);
		expect(blocks).toHaveLength(0);
		expect(renderedCopies(committed, blocks)).toBe(1);
	});

	it("keeps text produced after the catch-up, which was never persisted", () => {
		const newOutput: StreamingBlock = { type: "text", text: "接下来我要改的是", outputIndex: 1 };
		const blocks: StreamingBlock[] = [{ type: "text", text: PARAGRAPH, outputIndex: 0 }, newOutput];
		const committed = [persistedRow([{ type: "text", text: PARAGRAPH, outputIndex: 0 }])];

		expect(dropSupersededStreamingBlocks(blocks, committed, newOutput)).toBe(true);
		expect(blocks).toEqual([newOutput]);
		expect(renderedCopies(committed, blocks)).toBe(1);
	});

	/**
	 * `commitGrowthSignature` is `${length}:${newestId}` over the PERSISTED messages, so
	 * dropping live blocks cannot move it. If it did, the hand-off would read growth,
	 * reset `charsSinceLastCommit`, and an already-stored step could retire a live row
	 * whose text was never stored.
	 */
	it("does not move commitGrowthSignature", () => {
		const committed = [persistedRow([{ type: "text", text: PARAGRAPH, outputIndex: 0 }])];
		const before = commitGrowthSignature(committed);
		const blocks: StreamingBlock[] = [{ type: "text", text: PARAGRAPH, outputIndex: 0 }];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(true);
		expect(commitGrowthSignature(committed)).toBe(before);
	});
});

describe("a mid-turn clear must not trigger the head trim", () => {
	/**
	 * The trim edge is "the live row just cleared", chosen because it used to mean the
	 * turn had ended. This hand-off introduces a second way for the row to empty, in the
	 * middle of a turn — and a trim there resets `charsSinceLastCommit` (pinned in
	 * vlist-head-trim-wiring.test.ts), endangering the next step's output.
	 */
	it("declines while the narrator is still active", () => {
		const edge = resolveStreamingClearedTrimEdge({
			hadStreamingRow: true,
			hasStreamingRow: false,
			isActive: true,
		});
		expect(edge.fire).toBe(false);
	});

	/**
	 * Declining must DEFER, not discard. Consuming the edge here would mean a session
	 * whose rows always empty mid-turn never trims, and the loaded window would grow
	 * without bound — the very thing trimming exists to prevent.
	 */
	it("holds the edge open so a later idle evaluation still trims", () => {
		const declined = resolveStreamingClearedTrimEdge({
			hadStreamingRow: true,
			hasStreamingRow: false,
			isActive: true,
		});
		expect(declined.nextHadStreamingRow).toBe(true);

		// The turn ends; the same pending edge now fires.
		const later = resolveStreamingClearedTrimEdge({
			hadStreamingRow: declined.nextHadStreamingRow,
			hasStreamingRow: false,
			isActive: false,
		});
		expect(later.fire).toBe(true);
		expect(later.nextHadStreamingRow).toBe(false);
	});

	it("still fires on the ordinary turn-end clear", () => {
		const edge = resolveStreamingClearedTrimEdge({
			hadStreamingRow: true,
			hasStreamingRow: false,
			isActive: false,
		});
		expect(edge.fire).toBe(true);
		expect(edge.nextHadStreamingRow).toBe(false);
	});

	it("does not fire while a row is published, or when none ever was", () => {
		expect(
			resolveStreamingClearedTrimEdge({
				hadStreamingRow: true,
				hasStreamingRow: true,
				isActive: true,
			}).fire,
		).toBe(false);
		expect(
			resolveStreamingClearedTrimEdge({
				hadStreamingRow: false,
				hasStreamingRow: false,
				isActive: false,
			}).fire,
		).toBe(false);
	});
});
