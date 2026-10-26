/**
 * streaming-block-supersede-wiring.test.ts — the per-block hand-off against the
 * surrounding machinery, not just its own decision table.
 *
 * The decision rules are pinned in
 * `frontend/components/narrator/streaming/streaming-block-supersede.test.ts`. Here the
 * live row is published through `projectStreamingMessage`, which leaves out every lane
 * the document holds at the same id and revision. What is pinned HERE is what the fix
 * could break elsewhere:
 *
 * 1. Ordinary streaming (no backgrounding) still shows the paragraph exactly once —
 *    the live row must not shrink while the partial row is invisible to clients.
 * 2. The reported bug's timeline ends with ONE copy, and text produced after the
 *    catch-up survives.
 * 3. Leaving out display copies never mutates the committed evidence or the raw lanes.
 * 4. A mid-turn clear does NOT trigger head trim; an empty row is not turn-end.
 */

import { describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { buildStreamingMsg, type StreamingBlock } from "../message/message-segments";
import { type HandoffMessage, projectStreamingMessage } from "./streaming-handoff";
import { resolveStreamingClearedTrimEdge } from "./vlist-head-trim";

const PARAGRAPH = "确认了根因，这是我的设计错误。";

function persistedRow(blocks: unknown[]): HandoffMessage {
	return rowWithElements({ id: "m-partial", role: "assistant", parentToolUseId: null }, blocks);
}

function lane(
	type: "text" | "reasoning",
	id: string,
	revision: number,
	text: string,
): StreamingBlock {
	return { type, id, revision, textOffset: 0, text };
}

/** The live row as published: the accumulated lanes minus what the document now holds. */
function published(
	blocks: StreamingBlock[],
	committed: readonly HandoffMessage[],
): TreeMessage | null {
	return projectStreamingMessage(
		buildStreamingMsg({ narratorId: "n", streamingBlocks: blocks }) as TreeMessage,
		committed,
	);
}

/** How many times the paragraph is visible across document + live row. */
function renderedCopies(committed: readonly HandoffMessage[], row: TreeMessage | null): number {
	let copies = 0;
	for (const message of [...committed, ...(row ? [row] : [])]) {
		for (const block of messageBody(message)) {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string" && text.includes(PARAGRAPH)) copies++;
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
		const blocks = [lane("text", "1:0", 3, PARAGRAPH)];
		expect(renderedCopies([], published(blocks, []))).toBe(1);
	});
});

describe("the reported bug — foreground catch-up delivers the partial row", () => {
	it("collapses the duplicate to one copy", () => {
		const blocks = [lane("reasoning", "1:0", 2, "推理内容"), lane("text", "1:1", 4, PARAGRAPH)];
		expect(renderedCopies([], published(blocks, []))).toBe(1);

		// The tab returns to the foreground; catch-up appends the partial row, which
		// carries the elements the live row is still holding, at the same revisions.
		const committed = [
			persistedRow([
				{ type: "reasoning", id: "1:0", revision: 2, text: "推理内容" },
				{ type: "text", id: "1:1", revision: 4, text: PARAGRAPH },
			]),
		];
		expect(published(blocks, committed)).toBeNull();
		expect(renderedCopies(committed, published(blocks, committed))).toBe(1);
		// The raw accumulator is untouched: a newer revision can still reopen the lane.
		expect(blocks).toHaveLength(2);
	});

	it("keeps text produced after the catch-up, which was never persisted", () => {
		const blocks = [lane("text", "1:0", 4, PARAGRAPH), lane("text", "1:1", 1, "接下来我要改的是")];
		const committed = [persistedRow([{ type: "text", id: "1:0", revision: 4, text: PARAGRAPH }])];

		const row = published(blocks, committed);
		expect(messageBody(row).map((block) => (block as { id?: unknown }).id)).toEqual(["1:1"]);
		expect(renderedCopies(committed, row)).toBe(1);
	});

	it("keeps a lane whose live revision is newer than the persisted one", () => {
		const blocks = [lane("text", "1:0", 6, `${PARAGRAPH}还在写`)];
		const committed = [persistedRow([{ type: "text", id: "1:0", revision: 4, text: PARAGRAPH }])];
		expect(messageBody(published(blocks, committed))).toHaveLength(1);
	});

	it("does not mutate the persisted messages during display handoff", () => {
		const committed = [persistedRow([{ type: "text", id: "1:0", revision: 4, text: PARAGRAPH }])];
		const before = structuredClone(committed);
		published([lane("text", "1:0", 4, PARAGRAPH)], committed);
		expect(committed).toEqual(before);
	});
});

describe("a mid-turn clear must not trigger the head trim", () => {
	/**
	 * The trim edge is "the live row just cleared", chosen because it used to mean the
	 * turn had ended. This hand-off introduces a second way for the row to empty, in the
	 * middle of a turn. Active-session head-trim protection must remain unchanged.
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
