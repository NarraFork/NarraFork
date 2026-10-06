import { describe, expect, test } from "bun:test";
import { CHATGPT_CITATION_CLOSE, CHATGPT_CITATION_OPEN } from "@shared/citations";
import type { NarratorMsg } from "../narrator-panel-types";
import {
	buildSelectionIndex,
	computeSelectedRange,
	entriesToBlockMeta,
	entriesToMessageIds,
	entriesToText,
} from "./vlist-selection";

/**
 * Pure selection-index tests for PretextMessageList. Expected values are hard
 * coded to lock the ON-path selection semantics against drift from the
 * ChunkedMessageList reference implementation.
 */

const CITATION_MARKER = `${CHATGPT_CITATION_OPEN}turn204588view0${CHATGPT_CITATION_CLOSE}`;

// biome-ignore lint/suspicious/noExplicitAny: test fixtures are structural
function msg(partial: Record<string, any>): NarratorMsg {
	return {
		children: [],
		contentText: null,
		...partial,
	} as unknown as NarratorMsg;
}

const USER = msg({
	id: "m-user",
	role: "user",
	seq: 1,
	contentText: "hello there",
	contentJson: [{ type: "text", text: "hello there" }],
});

const ASSISTANT = msg({
	id: "m-asst",
	role: "assistant",
	seq: 2,
	contentJson: [
		{ type: "text", text: "first answer" },
		{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/x" } },
		{ type: "text", text: "" }, // not selectable (empty)
		{ type: "web_search", query: "cats", status: "completed" },
	],
});

const AGENT = msg({
	id: "m-agent",
	role: "assistant",
	seq: 3,
	contentJson: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { description: "go" } }],
});

describe("buildSelectionIndex", () => {
	test("indexes selectable blocks in seq/blockIndex order, skips empty text", () => {
		const index = buildSelectionIndex([ASSISTANT, USER, AGENT]); // deliberately unsorted
		const ids = index.entries.map((e) => e.blockId);
		expect(ids).toEqual([
			"msg-m-user-0", // user, seq 1
			"msg-m-asst-0", // "first answer", seq 2 idx 0
			"tc-tool-1", // Read tool, seq 2 idx 1
			// idx 2 empty text skipped
			"msg-m-asst-3", // web_search, seq 2 idx 3
			"sa-agent-1", // Agent → subagent alias, seq 3
		]);
	});

	test("tool entries expose tc-/sa- aliases and stable message:block id", () => {
		const index = buildSelectionIndex([ASSISTANT, AGENT]);
		// Read tool: primary tc-, also stable id + tc-/sa- aliases all resolve.
		expect(index.byBlockId.get("tc-tool-1")?.messageId).toBe("m-asst");
		expect(index.byBlockId.get("sa-tool-1")?.blockId).toBe("tc-tool-1");
		expect(index.byBlockId.get("msg-m-asst-1")?.blockId).toBe("tc-tool-1");
		// Agent tool: primary sa-.
		expect(index.byBlockId.get("sa-agent-1")?.messageId).toBe("m-agent");
		expect(index.byBlockId.get("tc-agent-1")?.blockId).toBe("sa-agent-1");
	});

	test("user message only indexes block 0", () => {
		const multiBlockUser = msg({
			id: "u2",
			role: "user",
			seq: 5,
			contentText: "combined",
			contentJson: [
				{ type: "text", text: "part a" },
				{ type: "text", text: "part b" },
			],
		});
		const index = buildSelectionIndex([multiBlockUser]);
		expect(index.entries.map((e) => e.blockId)).toEqual(["msg-u2-0"]);
		// user copyText prefers contentText
		expect(index.entries[0]?.copyText).toBe("combined");
	});

	test("skips messages without id / seq / contentJson", () => {
		const bad = msg({
			id: "",
			role: "assistant",
			seq: 9,
			contentJson: [{ type: "text", text: "x" }],
		});
		const noSeq = msg({
			id: "n",
			role: "assistant",
			seq: null,
			contentJson: [{ type: "text", text: "x" }],
		});
		expect(buildSelectionIndex([bad, noSeq]).entries).toHaveLength(0);
	});

	/**
	 * Copying is where a leaked internal marker does lasting damage: it leaves the
	 * app and lands in the user's document. Assistant text is therefore cleaned,
	 * while a user quoting the same string keeps it — the asymmetry is the point.
	 */
	test("assistant copyText drops the exact citation envelope", () => {
		const withMarker = msg({
			id: "m-cite",
			role: "assistant",
			seq: 7,
			contentJson: [{ type: "text", text: `已修复${CITATION_MARKER}` }],
		});
		const index = buildSelectionIndex([withMarker]);
		expect(index.entries[0]?.copyText).toBe("已修复");
	});

	test("assistant copyText keeps ref-shaped text from other protocols", () => {
		const text = "见 https://example.com/turn0search1 与 turn204588view0";
		const plain = msg({
			id: "m-plain",
			role: "assistant",
			seq: 9,
			contentJson: [{ type: "text", text }],
		});
		expect(buildSelectionIndex([plain]).entries[0]?.copyText).toBe(text);
	});

	test("user copyText keeps a quoted citation marker verbatim", () => {
		const quoted = `${CITATION_MARKER} 是什么`;
		const quoting = msg({
			id: "u-cite",
			role: "user",
			seq: 8,
			contentText: quoted,
			contentJson: [{ type: "text", text: quoted }],
		});
		const index = buildSelectionIndex([quoting]);
		expect(index.entries[0]?.copyText).toBe(quoted);
	});
});

describe("entriesTo* transforms", () => {
	const index = buildSelectionIndex([USER, ASSISTANT, AGENT]);
	const selected = new Set(["msg-m-user-0", "tc-tool-1", "sa-agent-1"]);

	test("entriesToMessageIds dedups and preserves order", () => {
		expect(entriesToMessageIds(index.entries, selected)).toEqual(["m-user", "m-asst", "m-agent"]);
	});

	test("entriesToBlockMeta expands blockIndices", () => {
		const metas = entriesToBlockMeta(index.entries, new Set(["tc-tool-1"]));
		expect(metas).toEqual([{ blockId: "tc-tool-1", messageId: "m-asst", blockIndex: 1 }]);
	});

	test("entriesToText joins selected copyText with blank-line separators", () => {
		const res = entriesToText(index.entries, new Set(["msg-m-user-0", "msg-m-asst-0"]));
		expect(res.text).toBe("hello there\n\nfirst answer");
		expect(res.truncated).toBe(false);
	});

	test("entriesToText truncates past the char budget", () => {
		const huge = "a".repeat(250_000);
		const bigMsg = msg({
			id: "big",
			role: "assistant",
			seq: 10,
			contentJson: [{ type: "text", text: huge }],
		});
		const idx = buildSelectionIndex([bigMsg]);
		const res = entriesToText(idx.entries, new Set(["msg-big-0"]));
		expect(res.truncated).toBe(true);
		expect(res.text.length).toBeLessThan(huge.length);
	});
});

describe("computeSelectedRange", () => {
	const index = buildSelectionIndex([USER, ASSISTANT, AGENT]);

	test("selects every entry between anchor and target inclusive", () => {
		const anchor = index.byBlockId.get("msg-m-user-0")!;
		const target = index.byBlockId.get("msg-m-asst-3")!;
		const range = computeSelectedRange(index, anchor, target);
		expect(range && [...range]).toEqual([
			"msg-m-user-0",
			"msg-m-asst-0",
			"tc-tool-1",
			"msg-m-asst-3",
		]);
	});

	test("order-independent (anchor after target)", () => {
		const anchor = index.byBlockId.get("sa-agent-1")!;
		const target = index.byBlockId.get("msg-m-asst-0")!;
		const range = computeSelectedRange(index, anchor, target);
		expect(range && [...range]).toEqual([
			"msg-m-asst-0",
			"tc-tool-1",
			"msg-m-asst-3",
			"sa-agent-1",
		]);
	});

	test("clips by blockIndex within the boundary message", () => {
		const anchor = index.byBlockId.get("tc-tool-1")!; // seq 2, blockIndex 1
		const target = index.byBlockId.get("msg-m-asst-3")!; // seq 2, blockIndex 3
		const range = computeSelectedRange(index, anchor, target);
		// msg-m-asst-0 (blockIndex 0) excluded; only 1 and 3 remain
		expect(range && [...range]).toEqual(["tc-tool-1", "msg-m-asst-3"]);
	});

	test("returns null for an empty result", () => {
		const lonely = index.byBlockId.get("msg-m-user-0")!;
		// craft an entry with a seq gap that matches nothing between
		const range = computeSelectedRange({ entries: [], byBlockId: new Map() }, lonely, lonely);
		expect(range).toBeNull();
	});
});
