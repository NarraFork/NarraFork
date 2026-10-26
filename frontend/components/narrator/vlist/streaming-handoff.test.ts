import { describe, expect, it } from "bun:test";
import type { BaseContentBlock, TreeMessage } from "@frontend/lib/api/types";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { isLiveStreamingBlock } from "@shared/pretext-layout/streaming-live-blocks";
import {
	projectPendingEmptyReasoning,
	projectStreamingDocument,
	projectStreamingMessage,
} from "./streaming-handoff";

function message(contentJson: BaseContentBlock[], id = "a1", extra = {}): TreeMessage {
	return rowWithElements(
		{
			id,
			role: "assistant",
			parentToolUseId: null,
			toolCalls: [],
			...extra,
		},
		contentJson,
	) as unknown as TreeMessage;
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
		expect(messageBody(newer[0])).toEqual([text("global-b", 4, "AB")]);
	});
	it("keeps a different block even when the committed assistant ends in identical text", () => {
		const streaming = live([text("new", 1)]);
		expect(projectStreamingMessage(streaming, [message([text("old", 9)])])).toBe(streaming);
	});
	it("retires each tool independently, never the unrelated text-only remainder", () => {
		const streaming = live([text("r1", 1), tool("t1"), tool("t2")]);
		const afterFirst = projectStreamingMessage(streaming, [message([tool("t1")])]);
		expect(messageBody(afterFirst)).toEqual([text("r1", 1), tool("t2")]);
		expect(
			messageBody(projectStreamingMessage(afterFirst, [message([tool("t1"), tool("t2")])])),
		).toEqual([text("r1", 1)]);
	});
	it("committed revision wins even when citation cleaning changed its text", () => {
		expect(
			projectStreamingMessage(live([text("b", 3, "RAW marker")], 0), [
				message([text("b", 3, "RAW")]),
			]),
		).toBeNull();
		expect(
			messageBody(
				projectStreamingMessage(live([text("b", 4, "RAW marker MORE")], 0), [
					message([text("b", 3, "RAW")]),
				]),
			),
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
		expect(messageBody(document[0])).toEqual([text("b", 2, "正文 continued")]);
		expect(messageBody(document[1])).toEqual([text("new", 1, "NEW")]);
		expect(messageBody(committed[0])).toEqual([
			{ ...text("b", 1), translatedText: "old translation", citations: [] },
		]);
	});
	it("a newer checkpoint projection uses actual request identity without mutating history", () => {
		const committed = [message([text("b", 1)], "a1", { model: "pool:default" })];
		const streaming = {
			...live([text("b", 2)], 0),
			model: "gpt-5.6",
			provider: "codex",
		};
		const document = projectStreamingDocument(committed, streaming);
		expect(document[0].model).toBe("gpt-5.6");
		expect(document[0].provider).toBe("codex");
		expect(committed[0].model).toBe("pool:default");
		expect(committed[0].provider).toBeUndefined();
		const legacy = projectStreamingDocument(committed, live([text("b", 2)], 0));
		expect(legacy[0].model).toBe("pool:default");
	});
	it("a stale published row cannot duplicate an already committed revision", () => {
		const committed = [message([text("b", 5)])];
		expect(projectStreamingDocument(committed, live([text("b", 4)]))).toBe(committed);
	});
	it("text that only looks the same never covers a lane", () => {
		const block = { type: "text", text: "suffix", outputIndex: 0 };
		const committed = [message([{ ...block, text: "prefix suffix" }])];
		const streaming = live([block]);
		expect(projectStreamingMessage(streaming, committed)).toBe(streaming);
	});
	it("does not match provider tool blocks across user turns or parent/child boundaries", () => {
		const search = { type: "web_search", id: "ws_1", status: "completed" };
		const streaming = live([search]);
		expect(
			projectStreamingMessage(streaming, [message([search]), message([], "u", { role: "user" })]),
		).toBe(streaming);
		const child = message([search], "child", { parentToolUseId: "agent-tool" });
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

describe("pending empty reasoning display projection", () => {
	const empty = { type: "reasoning", text: "" };
	const isLive = (msg: TreeMessage, index = 0) => isLiveStreamingBlock(false, msg, index);

	it("keeps only the last empty block live after persistence without changing stored messages", () => {
		const committed = [message([empty], "r1"), message([empty], "r2")];
		const projected = projectPendingEmptyReasoning(committed, true);
		expect(projected).toHaveLength(2);
		expect(projected[0]).toBe(committed[0]);
		expect(isLive(projected[0])).toBe(false);
		expect(isLive(projected[1])).toBe(true);
		expect(isLive(committed[1])).toBe(false);
		expect(messageBody(projected[1])).toBe(messageBody(committed[1]));
	});

	it("stops on idle, interruption or failure (inactive session)", () => {
		const committed = [message([empty])];
		expect(projectPendingEmptyReasoning(committed, false)).toBe(committed);
	});

	it("stops when text or a tool follows in the same or a later message", () => {
		for (const output of [text("t", 1), tool("tu"), { type: "text", text: "" }]) {
			for (const committed of [
				[message([empty, output])],
				[message([empty]), message([output], "next")],
			]) {
				expect(projectPendingEmptyReasoning(committed, true)).toBe(committed);
			}
		}
	});

	it("does not reopen nonempty reasoning or an earlier turn", () => {
		for (const block of [
			{ ...empty, text: "visible reasoning" },
			{ type: "thinking", thinking: "visible thought" },
			{ ...empty, translatedText: "translation" },
		]) {
			const committed = [message([block])];
			expect(projectPendingEmptyReasoning(committed, true)).toBe(committed);
		}
		const nextTurn = [message([empty]), message([], "user", { role: "user" })];
		expect(projectPendingEmptyReasoning(nextTurn, true)).toBe(nextTurn);
	});

	it("supports hidden/encrypted and thinking blocks on reconnect without a live row", () => {
		for (const block of [
			{ type: "thinking", thinking: "" },
			{ ...empty, providerMetadata: { hasEncryptedReasoning: true } },
		]) {
			const committed = [message([block])];
			const projected = projectPendingEmptyReasoning(
				projectStreamingDocument(committed, null),
				true,
			);
			expect(isLive(projected[0])).toBe(true);
		}
	});

	it("does not mistake child output for the parent's later output, but supports a child page", () => {
		const committed = [
			message([empty]),
			message([text("child", 1)], "child", { parentToolUseId: "agent" }),
		];
		expect(isLive(projectPendingEmptyReasoning(committed, true)[0])).toBe(true);
		const child = [message([empty], "child", { parentToolUseId: "agent" })];
		expect(projectPendingEmptyReasoning(child, true)).toBe(child);
		expect(isLive(projectPendingEmptyReasoning(child, true, true)[0])).toBe(true);
	});

	it("does not revive a synthetic lane already closed by a tool event", () => {
		const messages = [message([empty]), live([empty], -1)];
		expect(projectPendingEmptyReasoning(messages, true)).toBe(messages);
	});
});
