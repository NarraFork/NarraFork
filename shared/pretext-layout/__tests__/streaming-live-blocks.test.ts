/**
 * streaming-live-blocks.test.ts — Only the block STILL BEING WRITTEN counts as live.
 *
 * ── The bug this locks down ───────────────────────────────────────────────────
 *
 * The live row is one synthetic message accumulating a whole turn, and every
 * renderer asked "is this the streaming message?" then applied the answer to every
 * block in it. So reasoning the model had long finished — text already flowing, tools
 * already executing — stayed force-expanded and shimmering until the turn persisted,
 * which for a tool-calling turn is many seconds later.
 *
 * The two halves that make the fix correct are both asserted here:
 *
 *  - the accumulator STAMP wins, because `buildStreamingMsg` appends tool cards after
 *    the text lanes whatever order the provider used, so array position cannot tell a
 *    finished reasoning run from one the model reopened after a tool call;
 *  - the positional fallback still answers for un-stamped rows (reconnect snapshots,
 *    older callers), where the server has already dropped completed blocks.
 */

import { describe, expect, it } from "bun:test";
import {
	isLiveStreamingBlock,
	isLiveStreamingRun,
	resolveLiveBlockIndex,
} from "../streaming-live-blocks";

const REASONING = { type: "reasoning", text: "分析中" };
const TEXT = { type: "text", text: "答案" };
const TOOL = { type: "tool_use", id: "tu-1", name: "Read" };

describe("resolveLiveBlockIndex", () => {
	it("never reports a live block for a persisted message", () => {
		expect(resolveLiveBlockIndex(false, { contentJson: [REASONING] })).toBe(-1);
	});

	it("prefers the accumulator stamp over array position", () => {
		// The provider ran reasoning → tool → reasoning, so the block STILL being
		// written sits before the appended tool card. Position would name the wrong one.
		const msg = { contentJson: [REASONING, REASONING, TOOL], liveBlockIndex: 1 };
		expect(resolveLiveBlockIndex(true, msg)).toBe(1);
	});

	it("honours a stamp of -1 as 'no text lane is open'", () => {
		// A tool started, so the reasoning that preceded it is finished even though the
		// row still ends on a text lane in some orderings.
		const msg = { contentJson: [REASONING, TEXT], liveBlockIndex: -1 };
		expect(resolveLiveBlockIndex(true, msg)).toBe(-1);
	});

	it("falls back to the last text lane when unstamped", () => {
		expect(resolveLiveBlockIndex(true, { contentJson: [REASONING, TEXT] })).toBe(1);
	});

	it("reports no live lane when an unstamped row ends on a tool card", () => {
		expect(resolveLiveBlockIndex(true, { contentJson: [REASONING, TOOL] })).toBe(-1);
	});

	it("handles an empty or absent block list", () => {
		expect(resolveLiveBlockIndex(true, { contentJson: [] })).toBe(-1);
		expect(resolveLiveBlockIndex(true, {})).toBe(-1);
		expect(resolveLiveBlockIndex(true, null)).toBe(-1);
	});
});

describe("isLiveStreamingBlock", () => {
	it("settles an earlier reasoning block once text follows it", () => {
		const msg = { contentJson: [REASONING, TEXT], liveBlockIndex: 1 };
		expect(isLiveStreamingBlock(true, msg, 0)).toBe(false);
		expect(isLiveStreamingBlock(true, msg, 1)).toBe(true);
	});

	it("settles reasoning as soon as a tool call starts", () => {
		// This is the reported symptom: tools were already executing and the reasoning
		// was still rendering as live.
		const msg = { contentJson: [REASONING, TOOL], liveBlockIndex: -1 };
		expect(isLiveStreamingBlock(true, msg, 0)).toBe(false);
	});

	it("keeps the FIRST reasoning block live while it is the only content", () => {
		const msg = { contentJson: [REASONING], liveBlockIndex: 0 };
		expect(isLiveStreamingBlock(true, msg, 0)).toBe(true);
	});

	it("treats a missing block index as not live", () => {
		const msg = { contentJson: [REASONING], liveBlockIndex: 0 };
		expect(isLiveStreamingBlock(true, msg, null)).toBe(false);
		expect(isLiveStreamingBlock(true, msg, undefined)).toBe(false);
	});
});

describe("isLiveStreamingRun", () => {
	it("is live when any member of the run is the live block", () => {
		// Adjacent reasoning blocks render as ONE card, so the run is live while its
		// last member is still being written.
		const msg = { contentJson: [REASONING, REASONING, TEXT], liveBlockIndex: 1 };
		expect(isLiveStreamingRun(true, msg, [0, 1])).toBe(true);
	});

	it("settles a whole run once the model moved past it", () => {
		const msg = { contentJson: [REASONING, REASONING, TEXT], liveBlockIndex: 2 };
		expect(isLiveStreamingRun(true, msg, [0, 1])).toBe(false);
	});

	it("settles every run when no text lane is open", () => {
		const msg = { contentJson: [REASONING, REASONING, TOOL], liveBlockIndex: -1 };
		expect(isLiveStreamingRun(true, msg, [0, 1])).toBe(false);
	});

	it("is never live for a persisted message or an empty run", () => {
		const msg = { contentJson: [REASONING], liveBlockIndex: 0 };
		expect(isLiveStreamingRun(false, msg, [0])).toBe(false);
		expect(isLiveStreamingRun(true, msg, [])).toBe(false);
	});
});
