import { describe, expect, it } from "bun:test";
import type { BaseContentBlock, TreeMessage } from "@frontend/lib/api/types";
import { projectStreamingDocument, projectStreamingMessage } from "./streaming-handoff";

function message(contentJson: BaseContentBlock[], id = "a1", extra = {}): TreeMessage {
	return {
		id,
		role: "assistant",
		parentToolUseId: null,
		contentJson,
		toolCalls: [],
		children: [],
		...extra,
	} as unknown as TreeMessage;
}
const text = (id: string, revision: number, value = "正文") => ({
	type: "text",
	id,
	revision,
	text: value,
});
const live = (blocks: BaseContentBlock[], liveBlockIndex = -1) =>
	message(blocks, "__streaming__", { liveBlockIndex });
const tool = (id: string) => ({ type: "tool_use", id, name: "Read", input: {} });

describe("block identity/revision handoff projection", () => {
	it("a mid-turn user message does not cut off modern global block ownership", () => {
		const committed = [message([text("global-b", 3, "A")]), message([], "u2", { role: "user" })];
		for (const revision of [2, 3]) {
			const streaming = live([text("global-b", revision, "A")], 0);
			expect(projectStreamingMessage(streaming, committed)).toBeNull();
			expect(projectStreamingDocument(committed, streaming)).toBe(committed);
		}
		const newer = projectStreamingDocument(committed, live([text("global-b", 4, "AB")], 0));
		expect(newer).toHaveLength(2);
		expect(newer[0].contentJson).toEqual([text("global-b", 4, "AB")]);
	});
	it("keeps a different block even when the committed assistant ends in identical text", () => {
		const streaming = live([text("new", 1)]);
		expect(projectStreamingMessage(streaming, [message([text("old", 9)])])).toBe(streaming);
	});
	it("retires each tool independently, never the unrelated text-only remainder", () => {
		const streaming = live([text("r1", 1), tool("t1"), tool("t2")]);
		const afterFirst = projectStreamingMessage(streaming, [message([tool("t1")])]);
		expect(afterFirst?.contentJson).toEqual([text("r1", 1), tool("t2")]);
		expect(
			projectStreamingMessage(afterFirst, [message([tool("t1"), tool("t2")])])?.contentJson,
		).toEqual([text("r1", 1)]);
	});
	it("committed revision wins even when citation cleaning changed its text", () => {
		expect(
			projectStreamingMessage(live([text("b", 3, "RAW marker")], 0), [
				message([text("b", 3, "RAW")]),
			]),
		).toBeNull();
		expect(
			projectStreamingMessage(live([text("b", 4, "RAW marker MORE")], 0), [
				message([text("b", 3, "RAW")]),
			])?.contentJson,
		).toEqual([text("b", 4, "RAW marker MORE")]);
	});
	it("merges a newer live revision into the real block, with no duplicated row or input mutation", () => {
		const committed = [
			message([{ ...text("b", 1), translatedText: "old translation", citations: [] }]),
		];
		const document = projectStreamingDocument(
			committed,
			live([text("b", 2, "正文 continued"), text("new", 1, "NEW")], 0),
		);
		expect(document.map((m) => m.id)).toEqual(["a1", "__streaming__"]);
		expect(document[0].contentJson).toEqual([text("b", 2, "正文 continued")]);
		expect(document[1].contentJson).toEqual([text("new", 1, "NEW")]);
		expect(committed[0].contentJson).toEqual([
			{ ...text("b", 1), translatedText: "old translation", citations: [] },
		]);
	});
	it("a stale published row cannot duplicate an already committed revision", () => {
		const committed = [message([text("b", 5)])];
		expect(projectStreamingDocument(committed, live([text("b", 4)]))).toBe(committed);
	});
	it("legacy completed blocks retain the conservative suffix and active-lane checks", () => {
		const block = { type: "text", text: "suffix", outputIndex: 0 };
		const committed = [message([{ ...block, text: "prefix suffix" }])];
		expect(projectStreamingMessage(live([block]), committed)).toBeNull();
		expect(projectStreamingMessage(live([block], 0), committed)?.contentJson).toEqual([block]);
		expect(
			projectStreamingMessage(live([{ ...block, text: "different" }]), committed),
		).not.toBeNull();
	});
	it("does not match legacy blocks across user turns or parent/child boundaries", () => {
		const block = { type: "text", text: "same" };
		const streaming = live([block]);
		expect(
			projectStreamingMessage(streaming, [message([block]), message([], "u", { role: "user" })]),
		).toBe(streaming);
		const child = message([block], "child", { parentToolUseId: "agent-tool" });
		expect(projectStreamingMessage(streaming, [child])).toBe(streaming);
		expect(projectStreamingMessage(streaming, [child], true)).toBeNull();
	});
	it("projects NEW unchanged after a full handoff or an unrelated lifecycle patch", () => {
		const committed = [message([text("old", 2), tool("t1")])];
		expect(projectStreamingMessage(live([text("old", 1)]), committed)).toBeNull();
		const fresh = live([text("new", 1, "NEW")], 0);
		expect(projectStreamingMessage(fresh, committed)).toBe(fresh);
		expect(
			projectStreamingMessage(
				fresh,
				committed.map((m) => ({ ...m, toolCalls: [] })),
			),
		).toBe(fresh);
	});
});
