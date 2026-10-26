/**
 * streaming-block-supersede.test.ts
 *
 * The reported bug: returning a backgrounded tab to the foreground showed the same
 * paragraph TWICE, and the duplicate disappeared after the next tool call. The two
 * copies are the persisted partial message (delivered for the first time by the
 * reconnect catch-up) and the live streaming row, which never contracts on its own.
 *
 * Every streamed text/reasoning element names its id and revision, and so does its
 * persisted copy, so a live lane is covered only by its own persisted version — never by
 * text that merely looks the same. A provider tool block (web_search, image_generation)
 * is covered by the current turn's persisted block of the same id. Each case below is a
 * window through which output that was never persisted could otherwise be LOST, which
 * is strictly worse than the duplicate it repairs.
 */

import { describe, expect, it } from "bun:test";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import type { StreamingBlock } from "../message/message-segments";
import {
	blockSupersedes,
	dropSupersededStreamingBlocks,
	type SupersedeCandidateMessage,
} from "./streaming-block-supersede";

const PARAGRAPH_FIXTURE = "确认了根因。";

function assistantWith(blocks: unknown[]): SupersedeCandidateMessage {
	return rowWithElements({ role: "assistant", parentToolUseId: null }, blocks);
}

function liveText(text: string, id = "1:0", revision = 1): StreamingBlock {
	return { type: "text", id, revision, textOffset: 0, text };
}

describe("blockSupersedes — text and reasoning by id and revision", () => {
	it("a persisted copy at the same id and at least the live revision covers it", () => {
		const live = liveText(PARAGRAPH_FIXTURE, "1:0", 3);
		expect(blockSupersedes({ type: "text", id: "1:0", revision: 3 }, live)).toBe(true);
		expect(blockSupersedes({ type: "text", id: "1:0", revision: 4 }, live)).toBe(true);
	});

	it("an older revision, another id or a copy without identity does not", () => {
		const live = liveText(PARAGRAPH_FIXTURE, "1:0", 3);
		expect(blockSupersedes({ type: "text", id: "1:0", revision: 2 }, live)).toBe(false);
		expect(blockSupersedes({ type: "text", id: "1:1", revision: 9 }, live)).toBe(false);
		// Identical text is not evidence: short closers recur across steps and turns.
		expect(blockSupersedes({ type: "text", text: PARAGRAPH_FIXTURE } as never, live)).toBe(false);
	});

	it("reasoning follows the same rule and never matches text", () => {
		const live: StreamingBlock = {
			type: "reasoning",
			id: "1:0",
			revision: 2,
			textOffset: 0,
			text: "思考",
		};
		expect(blockSupersedes({ type: "reasoning", id: "1:0", revision: 2 }, live)).toBe(true);
		expect(blockSupersedes({ type: "text", id: "1:0", revision: 2 }, live)).toBe(false);
	});

	it("a provider tool block is covered by the same id", () => {
		const live: StreamingBlock = { type: "web_search", id: "ws_1", status: "completed" };
		expect(blockSupersedes({ type: "web_search", id: "ws_1" }, live)).toBe(true);
		expect(blockSupersedes({ type: "web_search", id: "ws_2" }, live)).toBe(false);
	});
});

describe("dropSupersededStreamingBlocks — provider tool blocks", () => {
	it("drops web_search / image_generation on provider item id", () => {
		const blocks: StreamingBlock[] = [
			{ type: "web_search", id: "ws_1", status: "completed" },
			{ type: "image_generation", id: "ig_1", status: "completed" },
		];
		const committed = [
			assistantWith([
				{ type: "web_search", id: "ws_1" },
				{ type: "image_generation", id: "ig_1" },
			]),
		];
		expect(dropSupersededStreamingBlocks(blocks, committed)).toBe(true);
		expect(blocks).toHaveLength(0);
	});

	it("never drops a text or reasoning lane: its raw accumulator outlives a checkpoint", () => {
		const live = liveText(PARAGRAPH_FIXTURE);
		const blocks = [live];
		const committed = [assistantWith([{ type: "text", id: "1:0", revision: 1 }])];
		expect(dropSupersededStreamingBlocks(blocks, committed)).toBe(false);
		expect(blocks).toEqual([live]);
	});

	it("keeps a tool block the turn has not persisted, and ignores child messages", () => {
		const live: StreamingBlock = { type: "web_search", id: "ws_1", status: "searching" };
		const blocks = [live];
		const committed: SupersedeCandidateMessage[] = [
			assistantWith([{ type: "web_search", id: "ws_other" }]),
			rowWithElements(
				{
					role: "assistant",
					parentToolUseId: "tool-1",
				},
				[{ type: "web_search", id: "ws_1" }],
			),
		];
		expect(dropSupersededStreamingBlocks(blocks, committed)).toBe(false);
		expect(blocks).toEqual([live]);
	});
});

/** `row`, counting each read of its role. */
function countRoleReads(
	row: SupersedeCandidateMessage,
	onRead: () => void,
): SupersedeCandidateMessage {
	return Object.defineProperty(row, "role", {
		get() {
			onRead();
			return "assistant";
		},
		enumerable: true,
	});
}

describe("dropSupersededStreamingBlocks — cost is bounded to the current turn", () => {
	/**
	 * This runs on every `committedMessages` identity change — several times per turn,
	 * because each live lifecycle patch rebuilds that array — while the loaded window is
	 * allowed to reach TRIM_TRIGGER_MESSAGES (1200) rows. Scanning the whole window per
	 * patch would put an O(window) walk on the streaming path.
	 *
	 * Asserted by counting how many messages are actually examined, rather than by
	 * timing: a wall-clock assertion would be flaky and would not say WHY it regressed.
	 */
	it("examines only messages after the last user turn, not the whole window", () => {
		let inspected = 0;
		const older = Array.from({ length: 1200 }, () =>
			countRoleReads(assistantWith([{ type: "web_search", id: "ws_1" }]), () => inspected++),
		);

		const committed: SupersedeCandidateMessage[] = [
			...older,
			rowWithElements({ role: "user", parentToolUseId: null }, [{ type: "text", text: "新问题" }]),
			assistantWith([{ type: "web_search", id: "ws_1" }]),
		];

		const blocks: StreamingBlock[] = [{ type: "web_search", id: "ws_1", status: "completed" }];
		expect(dropSupersededStreamingBlocks(blocks, committed)).toBe(true);
		expect(blocks).toHaveLength(0);
		// The 1200 older rows were never touched: the walk stopped at the user message.
		expect(inspected).toBe(0);
	});

	/**
	 * Positive control for the assertion above: the SAME instrumented rows are reachable
	 * here (no user message bounds them), so the walk must touch them.
	 */
	it("does reach those same rows when no turn boundary bounds them", () => {
		let inspected = 0;
		const reachable = Array.from({ length: 3 }, () =>
			countRoleReads(assistantWith([{ type: "web_search", id: "ws_other" }]), () => inspected++),
		);

		const blocks: StreamingBlock[] = [{ type: "web_search", id: "ws_1", status: "searching" }];
		expect(dropSupersededStreamingBlocks(blocks, reachable)).toBe(false);
		expect(inspected).toBeGreaterThan(0);
	});
});
