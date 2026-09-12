/**
 * streaming-block-supersede.test.ts
 *
 * The reported bug: returning a backgrounded tab to the foreground showed the same
 * paragraph TWICE, and the duplicate disappeared after the next tool call. The two
 * copies are the persisted partial message (delivered for the first time by the
 * reconnect catch-up) and the live streaming row, which never contracts on its own.
 *
 * Every case below is a window through which the fix could instead LOSE output that
 * was never persisted, which is strictly worse than the duplicate it repairs. They
 * are written as executable facts rather than comments because each one is invisible
 * in normal use: a wrongly dropped block simply is not on screen.
 */

import { describe, expect, it } from "bun:test";
import type { StreamingBlock } from "../message-segments";
import {
	dropSupersededStreamingBlocks,
	type SupersedeCandidateMessage,
} from "./streaming-block-supersede";

const PARAGRAPH_FIXTURE = "确认了根因。";

function assistantWith(blocks: unknown[]): SupersedeCandidateMessage {
	return { role: "assistant", parentToolUseId: null, contentJson: blocks };
}

function liveText(text: string, outputIndex?: number): StreamingBlock {
	return outputIndex == null ? { type: "text", text } : { type: "text", text, outputIndex };
}

function liveReasoning(
	text: string,
	extra?: { id?: string; outputIndex?: number },
): StreamingBlock {
	return { type: "reasoning", text, ...extra };
}

describe("dropSupersededStreamingBlocks — the duplicate is removed", () => {
	it("drops a text block whose persisted counterpart matches by outputIndex", () => {
		const blocks = [liveText("确认了根因。", 0)];
		const committed = [assistantWith([{ type: "text", text: "确认了根因。", outputIndex: 0 }])];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(true);
		expect(blocks).toHaveLength(0);
	});

	it("drops a reasoning block matched via providerMetadata.openai.itemId", () => {
		const blocks = [liveReasoning("推理内容", { id: "rs_1" })];
		const committed = [
			assistantWith([
				{
					type: "reasoning",
					text: "推理内容",
					providerMetadata: { openai: { itemId: "rs_1" } },
				},
			]),
		];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(true);
		expect(blocks).toHaveLength(0);
	});

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
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(true);
		expect(blocks).toHaveLength(0);
	});

	it("drops only the superseded block and leaves siblings still streaming", () => {
		const stillStreaming = liveText("第二段还在写", 1);
		const blocks = [liveText("第一段已存", 0), stillStreaming];
		const committed = [assistantWith([{ type: "text", text: "第一段已存", outputIndex: 0 }])];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(true);
		expect(blocks).toEqual([stillStreaming]);
	});

	it("survives the 120k trailing truncation, where the live text is only a suffix", () => {
		// `appendStreamingTextPreview` keeps the LAST 120k chars, so the live side
		// legitimately holds a suffix of what was stored. Equality would never match.
		const blocks = [liveText("尾部内容", 0)];
		const committed = [
			assistantWith([{ type: "text", text: "很长的开头……尾部内容", outputIndex: 0 }]),
		];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(true);
		expect(blocks).toHaveLength(0);
	});

	it("is unaffected by reasoning translation, which only ADDS translatedText", () => {
		const blocks = [liveReasoning("original thought", { id: "rs_2" })];
		const committed = [
			assistantWith([
				{
					type: "reasoning",
					text: "original thought",
					translatedText: "原始思考",
					providerMetadata: { openai: { itemId: "rs_2" } },
				},
			]),
		];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(true);
		expect(blocks).toHaveLength(0);
	});
});

describe("dropSupersededStreamingBlocks — un-persisted output is never dropped", () => {
	/**
	 * The coordinate alone is NOT an identity. Every tool round in a multi-step turn is
	 * a new API request whose output index restarts at 0, while all blocks append to one
	 * partial row — so step two's live text shares step one's coordinate. Dropping on
	 * the coordinate would delete output that was never stored.
	 */
	it("keeps a block that reuses an earlier step's outputIndex with different text", () => {
		const secondStep = liveText("第二段全新内容", 0);
		const blocks = [secondStep];
		const committed = [assistantWith([{ type: "text", text: "第一段已存内容", outputIndex: 0 }])];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(false);
		expect(blocks).toEqual([secondStep]);
	});

	it("keeps a reasoning block whose id matches but whose text does not", () => {
		const live = liveReasoning("新的思考", { id: "rs_3" });
		const blocks = [live];
		const committed = [
			assistantWith([
				{
					type: "reasoning",
					text: "旧的思考",
					providerMetadata: { openai: { itemId: "rs_3" } },
				},
			]),
		];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(false);
		expect(blocks).toEqual([live]);
	});

	it("keeps everything while the document holds no persisted blocks (normal streaming)", () => {
		// Mid-turn the partial row is invisible to clients, so this is the state during
		// EVERY ordinary turn. The live row must not shrink at all here.
		const blocks = [liveText("正在写的内容", 0), liveReasoning("推理", { outputIndex: 1 })];
		const before = [...blocks];
		expect(dropSupersededStreamingBlocks(blocks, [], null)).toBe(false);
		expect(dropSupersededStreamingBlocks(blocks, [assistantWith([])], null)).toBe(false);
		expect(blocks).toEqual(before);
	});

	it("never matches on empty text", () => {
		const fresh = liveText("", 0);
		const blocks = [fresh];
		const committed = [assistantWith([{ type: "text", text: "任意已存内容", outputIndex: 0 }])];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(false);
		expect(blocks).toEqual([fresh]);
	});

	it("ignores child messages, which can never own a parent row's text", () => {
		// A parent's live row never receives a child's text: deltas carrying a
		// subagentToolUseId are discarded by the accumulator. Matching against children
		// could therefore only produce false hits.
		const live = liveText("父级正在写", 0);
		const blocks = [live];
		const committed: SupersedeCandidateMessage[] = [
			{
				role: "assistant",
				parentToolUseId: "tool-1",
				contentJson: [{ type: "text", text: "父级正在写", outputIndex: 0 }],
			},
		];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(false);
		expect(blocks).toEqual([live]);
	});

	/**
	 * The live row only ever holds the CURRENT turn's output, so an older assistant
	 * message cannot legitimately supersede it — but it could accidentally match, since
	 * the discriminator is a suffix test and short closers recur. The scan therefore
	 * stops at the turn boundary.
	 */
	it("ignores an earlier turn's message that happens to end with the same text", () => {
		const live = liveText("好的。", 0);
		const blocks = [live];
		const committed: SupersedeCandidateMessage[] = [
			// An earlier turn whose reply ends with the same closer.
			assistantWith([{ type: "text", text: "上一轮的结论。好的。", outputIndex: 0 }]),
			{ role: "user", parentToolUseId: null, contentJson: [{ type: "text", text: "下一个问题" }] },
			// The current turn has persisted nothing yet.
			assistantWith([]),
		];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(false);
		expect(blocks).toEqual([live]);
	});

	it("ignores user messages that happen to quote the same text", () => {
		const live = liveText("请修复这个 bug", 0);
		const blocks = [live];
		const committed: SupersedeCandidateMessage[] = [
			{
				role: "user",
				parentToolUseId: null,
				contentJson: [{ type: "text", text: "请修复这个 bug", outputIndex: 0 }],
			},
		];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(false);
		expect(blocks).toEqual([live]);
	});
});

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
		const older = Array.from({ length: 1200 }, () => ({
			get role() {
				inspected++;
				return "assistant";
			},
			parentToolUseId: null,
			contentJson: [{ type: "text", text: "历史内容", outputIndex: 0 }],
		})) as unknown as SupersedeCandidateMessage[];

		const committed: SupersedeCandidateMessage[] = [
			...older,
			{ role: "user", parentToolUseId: null, contentJson: [{ type: "text", text: "新问题" }] },
			assistantWith([{ type: "text", text: PARAGRAPH_FIXTURE, outputIndex: 0 }]),
		];

		const blocks = [liveText(PARAGRAPH_FIXTURE, 0)];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(true);
		expect(blocks).toHaveLength(0);
		// The 1200 older rows were never touched: the walk stopped at the user message.
		expect(inspected).toBe(0);
	});

	/**
	 * Positive control for the assertion above.
	 *
	 * `inspected === 0` would also hold if the counter simply never fired — a green test
	 * that proves nothing. Here the SAME instrumented rows are reachable (no user message
	 * bounds them), so the walk must touch them. The two cases together show the counter
	 * responds to the turn boundary rather than being constant.
	 */
	it("does reach those same rows when no turn boundary bounds them", () => {
		let inspected = 0;
		const reachable = Array.from({ length: 3 }, () => ({
			get role() {
				inspected++;
				return "assistant";
			},
			parentToolUseId: null,
			contentJson: [{ type: "text", text: "同一轮内的内容", outputIndex: 0 }],
		})) as unknown as SupersedeCandidateMessage[];

		const blocks = [liveText("未被覆盖的新内容", 0)];
		expect(dropSupersededStreamingBlocks(blocks, reachable, null)).toBe(false);
		expect(inspected).toBeGreaterThan(0);
	});
});

describe("dropSupersededStreamingBlocks — the live lane guard", () => {
	/**
	 * A lane's FIRST delta is a few characters long, and short openers ("好的。", "让我",
	 * "确认") recur at the start of every step. With the coordinate reused across
	 * requests, such an opener can satisfy the text discriminator against an earlier
	 * step's stored text — so the block still being written is never judged at all.
	 */
	it("keeps the block being written even when its short opener matches", () => {
		const opener = liveText("好的。", 0);
		const blocks = [opener];
		const committed = [
			assistantWith([{ type: "text", text: "先看一下代码。好的。", outputIndex: 0 }]),
		];
		expect(dropSupersededStreamingBlocks(blocks, committed, opener)).toBe(false);
		expect(blocks).toEqual([opener]);
	});

	it("drops that same block once the model moves on to a tool call", () => {
		// onToolUseChunk clears the live lane, which is the state in the reported bug:
		// the duplicated paragraph had already settled.
		const settled = liveText("好的。", 0);
		const blocks = [settled];
		const committed = [
			assistantWith([{ type: "text", text: "先看一下代码。好的。", outputIndex: 0 }]),
		];
		expect(dropSupersededStreamingBlocks(blocks, committed, null)).toBe(true);
		expect(blocks).toHaveLength(0);
	});

	/**
	 * Why the guard is passed BY REFERENCE rather than as an array index.
	 *
	 * `upsertStreaming*Block` splices a native block in by outputIndex and does not
	 * update `liveBlockIndexRef`, so after a reordering the stored index names a
	 * different block. Guarding by index would protect that neighbour and leave the
	 * growing lane exposed — the exact failure this guard exists to prevent.
	 */
	it("protects the growing lane, not whatever ends up at its old index", () => {
		const growing = liveText("好的。", 5);
		const blocks: StreamingBlock[] = [growing];
		// A native block with a LOWER outputIndex arrives and is spliced in ahead, so the
		// growing lane moves from index 0 to index 1.
		blocks.splice(0, 0, { type: "web_search", id: "ws_9", status: "completed", outputIndex: 1 });
		expect(blocks.indexOf(growing)).toBe(1);

		const committed = [
			assistantWith([
				{ type: "text", text: "先看一下代码。好的。", outputIndex: 5 },
				{ type: "web_search", id: "ws_9" },
			]),
		];
		// Identity guard: the growing text lane survives...
		expect(dropSupersededStreamingBlocks(blocks, committed, growing)).toBe(true);
		expect(blocks).toEqual([growing]);
		// ...and the neighbour that now sits at the old index 0 was dropped, as it should
		// be. An index-based guard would have inverted both outcomes.
	});
});
