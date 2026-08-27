/**
 * message-math-text.test.ts — the per-frame math gate must be cheap AND complete.
 *
 * `collectNewMathCandidateTexts` sits on the streaming path, which publishes on every
 * render version. Two properties matter and they pull against each other:
 *
 *   - COMPLETENESS: a body that just gained a formula must be forwarded, whatever
 *     frame boundary the closing delimiter happened to land on. Withholding it
 *     restores the reported bug (formulas stay literal until a page reload).
 *   - COST: a math-free turn must not re-examine the whole body every frame. That is
 *     what made a long answer O(n²) — invisible in correctness, felt as jank.
 *
 * The tests assert the forwarding DECISION rather than any internal counter: the
 * decision is what `ensureKatexLoaded` acts on, and it is the only thing the rest of
 * the system can observe.
 */

import { describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import {
	collectMathCandidateTexts,
	collectNewMathCandidateTexts,
	createMathScanCursor,
} from "./message-math-text";

/** A streaming-shaped row: text lives in blocks, `contentText` is null. */
function streamingRow(text: string, id = "__streaming__"): TreeMessage {
	return {
		id,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", id: "streaming:text:0", text }],
		contentText: null,
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq: 1,
	} as unknown as TreeMessage;
}

/** A fetched-shaped row: `contentText` carries the whole visible body. */
function fetchedRow(text: string, id = "m1"): TreeMessage {
	return {
		id,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq: 1,
	} as unknown as TreeMessage;
}

describe("collectMathCandidateTexts", () => {
	it("reads block text when contentText is absent (the streaming shape)", () => {
		const texts = collectMathCandidateTexts([streamingRow("公式 $a^2$ 在这里")]);
		expect(texts).toEqual(["公式 $a^2$ 在这里"]);
	});

	it("reads thinking and translated bodies, which are measured as markdown too", () => {
		const row = {
			...fetchedRow("正文"),
			contentJson: [
				{ type: "thinking", thinking: "推理 $x$" },
				{ type: "text", text: "答案", translatedText: "answer $y$" },
			],
		} as unknown as TreeMessage;
		const texts = collectMathCandidateTexts([row]);
		expect(texts).toContain("推理 $x$");
		expect(texts).toContain("answer $y$");
	});

	it("skips null entries so a cleared streaming row is harmless", () => {
		expect(collectMathCandidateTexts([null, undefined])).toEqual([]);
	});
});

describe("collectNewMathCandidateTexts — completeness", () => {
	it("forwards a body on first sight", () => {
		const cursor = createMathScanCursor();
		expect(collectNewMathCandidateTexts([streamingRow("开头")], cursor)).toEqual(["开头"]);
	});

	it("forwards the WHOLE body when the delta closes a formula", () => {
		const cursor = createMathScanCursor();
		collectNewMathCandidateTexts([streamingRow("质能关系 ")], cursor);
		// The opening `$` arrives without a closer: still nothing detectable.
		collectNewMathCandidateTexts([streamingRow("质能关系 $E = mc^2")], cursor);
		const closed = collectNewMathCandidateTexts([streamingRow("质能关系 $E = mc^2$ 完")], cursor);
		// Whole string, not the delta: ensureKatexLoaded runs the authoritative check
		// and a bare delta would split the pair.
		expect(closed).toEqual(["质能关系 $E = mc^2$ 完"]);
	});

	it("still forwards when a two-character closer is split across frames", () => {
		const cursor = createMathScanCursor();
		collectNewMathCandidateTexts([streamingRow("推导 \\(a+b")], cursor);
		// `\` lands in one frame and `)` in the next: without the boundary overlap the
		// gate would see neither half as a closer and withhold the body forever.
		collectNewMathCandidateTexts([streamingRow("推导 \\(a+b\\")], cursor);
		const closed = collectNewMathCandidateTexts([streamingRow("推导 \\(a+b\\)")], cursor);
		expect(closed).toEqual(["推导 \\(a+b\\)"]);
	});

	it("re-forwards a REWRITTEN body rather than trusting the tail", () => {
		const cursor = createMathScanCursor();
		collectNewMathCandidateTexts([streamingRow("第一次回答，很长的一段普通文本内容")], cursor);
		// A retry replaces the body. Its head differs, so nothing about it has been
		// ruled out — scanning only the tail could miss math in the middle.
		const retried = collectNewMathCandidateTexts(
			[streamingRow("重新回答：$$\\int f = 1$$ 后续")],
			cursor,
		);
		expect(retried).toEqual(["重新回答：$$\\int f = 1$$ 后续"]);
	});

	it("re-forwards a front-truncated body (the 120k preview cap)", () => {
		const cursor = createMathScanCursor();
		const long = `${"长".repeat(200)}尾部`;
		collectNewMathCandidateTexts([streamingRow(long)], cursor);
		const truncated = collectNewMathCandidateTexts([streamingRow("…截断后 $z$ 尾部")], cursor);
		expect(truncated).toEqual(["…截断后 $z$ 尾部"]);
	});

	it("tracks each message independently", () => {
		const cursor = createMathScanCursor();
		collectNewMathCandidateTexts([fetchedRow("甲的正文", "a")], cursor);
		const second = collectNewMathCandidateTexts(
			[fetchedRow("甲的正文", "a"), fetchedRow("乙的正文", "b")],
			cursor,
		);
		// Only the newly seen message is forwarded; the settled one is not re-scanned.
		expect(second).toEqual(["乙的正文", "乙的正文"]);
	});
});

describe("collectNewMathCandidateTexts — cost", () => {
	it("withholds an append that cannot have closed a formula", () => {
		const cursor = createMathScanCursor();
		collectNewMathCandidateTexts([streamingRow("普通开头")], cursor);
		expect(collectNewMathCandidateTexts([streamingRow("普通开头，继续写")], cursor)).toEqual([]);
		expect(
			collectNewMathCandidateTexts([streamingRow("普通开头，继续写更多内容")], cursor),
		).toEqual([]);
	});

	it("withholds an unchanged body (the same frame republished)", () => {
		const cursor = createMathScanCursor();
		const row = streamingRow("内容 $a$");
		expect(collectNewMathCandidateTexts([row], cursor)).toEqual(["内容 $a$"]);
		expect(collectNewMathCandidateTexts([row], cursor)).toEqual([]);
	});

	it("stays flat across many math-free frames", () => {
		const cursor = createMathScanCursor();
		let text = "";
		let forwarded = 0;
		for (let i = 0; i < 500; i++) {
			text += "这是一段没有任何公式的普通中文内容。";
			if (collectNewMathCandidateTexts([streamingRow(text)], cursor).length > 0) forwarded++;
		}
		// Only the first frame is unknown; every later one is ruled out by its delta.
		expect(forwarded).toBe(1);
	});

	it("a fresh cursor knows nothing, so a narrator switch cannot suppress a load", () => {
		const cursor = createMathScanCursor();
		collectNewMathCandidateTexts([streamingRow("内容 $a$")], cursor);
		const afterSwitch = createMathScanCursor();
		expect(collectNewMathCandidateTexts([streamingRow("内容 $a$")], afterSwitch)).toEqual([
			"内容 $a$",
		]);
	});
});
