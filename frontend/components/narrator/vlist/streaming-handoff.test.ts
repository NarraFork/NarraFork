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
			narratorId: "n1",
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

describe("reasoning translation handoff", () => {
	it("preserves a validated translated prefix across append-only live growth", () => {
		const part = {
			id: "p",
			generation: "g",
			start: 0,
			end: 3,
			sourceText: "abc",
			translatedText: "甲",
		};
		const original = {
			type: "reasoning",
			id: "r",
			revision: 1,
			text: "abc",
			translationGeneration: "g",
			translationParts: [part],
		};
		const committed = [message([original])];
		const projected = projectStreamingDocument(
			committed,
			live([{ type: "reasoning", id: "r", revision: 2, text: "abcdef" }], 0),
		);
		expect(messageBody(projected[0])[0]).toMatchObject({
			text: "abcdef",
			translationGeneration: "g",
			translationParts: [part],
		});
		expect(messageBody(committed[0])[0]).toEqual(original);
	});

	it("drops translated parts for a rewritten source or changed generation", () => {
		const original = {
			type: "reasoning",
			id: "r",
			revision: 1,
			text: "abc",
			translationGeneration: "g",
			translationParts: [
				{ id: "p", generation: "g", start: 0, end: 3, sourceText: "abc", translatedText: "甲" },
			],
		};
		for (const incoming of [
			{ type: "reasoning", id: "r", revision: 2, text: "different" },
			{ type: "reasoning", id: "r", revision: 2, text: "abcdef", translationGeneration: "new" },
		]) {
			const result = projectStreamingDocument([message([original])], live([incoming], 0));
			expect(messageBody(result[0])[0].translationParts).toBeUndefined();
		}
	});
});

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

const ATTEMPT = "0123456789abcdefghijk";
const RETRY = "ZYXWVUTSRQPONMLKJIHGF";
const reasoning = (order: number, value = String(order + 1), attempt = ATTEMPT, revision = 1) => ({
	type: "reasoning",
	id: `${attempt}:${order}`,
	revision,
	text: value,
});

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

describe("consecutive reasoning checkpoint ownership", () => {
	it("appends only consecutive live lanes after the acknowledged raw lane has been released", () => {
		const committed = [message([reasoning(0, "123")])];
		const streaming = live([reasoning(1, "4"), reasoning(2, "5")], 1);
		const document = projectStreamingDocument(committed, streaming);
		expect(document.map((row) => row.id)).toEqual(["a1"]);
		expect(messageBody(document[0])).toEqual([
			reasoning(0, "123"),
			reasoning(1, "4"),
			reasoning(2, "5"),
		]);
		expect(document[0].liveBlockIndex).toBe(2);
		expect(isLiveStreamingBlock(false, document[0], 2)).toBe(true);
		expect(messageBody(committed[0])).toEqual([reasoning(0, "123")]);
		expect(messageBody(streaming)).toEqual([reasoning(1, "4"), reasoning(2, "5")]);
	});

	it("keeps frozen canonical holders, translations and live holder metadata unchanged", () => {
		const part = {
			id: "p",
			generation: "g",
			start: 0,
			end: 3,
			sourceText: "123",
			translatedText: "一二三",
		};
		const original = message([
			{
				...reasoning(0, "123"),
				translationGeneration: "g",
				translationParts: [part],
			},
		]);
		const owner = {
			...original,
			model: "pool:default",
			blocks: original.blocks.map((holder) => ({
				...holder,
				id: "server-holder",
				named: true,
				revision: 17,
				attemptId: "req_0",
				hasOriginal: true,
			})),
		};
		const streaming = {
			...live([reasoning(1, "4")], 0),
			model: "actual-model",
			provider: "codex",
		};
		const committed = deepFreeze([owner]);
		deepFreeze(streaming);
		const result = projectStreamingDocument(committed, streaming);
		expect(result).toHaveLength(1);
		expect(result[0].blocks[0]).toBe(owner.blocks[0]);
		expect(result[0].blocks[1]).toBe(streaming.blocks[0]);
		expect(result[0].blocks[0]).toMatchObject({
			id: "server-holder",
			named: true,
			revision: 17,
			attemptId: "req_0",
			hasOriginal: true,
		});
		expect(messageBody(result[0])[0].translationParts?.[0]).toBe(part);
		expect(result[0]).toMatchObject({
			model: "actual-model",
			provider: "codex",
			liveContentProjection: true,
			liveBlockIndex: 1,
		});
		expect(owner.model).toBe("pool:default");
		expect(owner.blocks).toHaveLength(1);
		expect(streaming.blocks).toHaveLength(1);
	});

	it("preserves same-id revisions and raw offsets before appending another lane", () => {
		const part = {
			id: "p",
			generation: "g",
			start: 0,
			end: 3,
			sourceText: "123",
			translatedText: "一二三",
		};
		const committed = [
			message([
				{
					...reasoning(0, "123"),
					rawTextLength: 3,
					translationGeneration: "g",
					translationParts: [part],
				},
			]),
		];
		const streaming = live(
			[{ ...reasoning(0, "34", ATTEMPT, 2), textOffset: 2 }, reasoning(1, "5")],
			1,
		);
		const result = projectStreamingDocument(committed, streaming);
		expect(result).toHaveLength(1);
		expect(messageBody(result[0])).toEqual([
			{
				...reasoning(0, "1234", ATTEMPT, 2),
				rawTextLength: 3,
				textOffset: 2,
				translationGeneration: "g",
				translationParts: [part],
			},
			reasoning(1, "5"),
		]);
		expect(result[0].blocks[0].id).toBe(committed[0].blocks[0].id);
		expect(result[0].liveBlockIndex).toBe(1);
	});

	it("preserves the active lane when a late delta reopens the owner or appended prefix", () => {
		const owner = message([reasoning(0, "123")]);
		for (const [streaming, expectedIndex] of [
			[live([reasoning(0, "1235", ATTEMPT, 2), reasoning(1, "4")], 0), 0],
			[live([reasoning(1, "45", ATTEMPT, 2), tool("tu")], 0), 1],
		] as const) {
			const result = projectStreamingDocument([owner], streaming);
			expect(result[0].liveBlockIndex).toBe(expectedIndex);
			expect(isLiveStreamingBlock(false, result[0], expectedIndex)).toBe(true);
			expect(messageBody(result[0])).toHaveLength(2);
			if (result.length > 1) {
				expect(messageBody(result[1])).toEqual([tool("tu")]);
				expect(result[1].liveBlockIndex).toBe(-1);
			}
		}
	});

	it("leaves later live text and tool cards in place and settles the reasoning run", () => {
		for (const suffix of [text(`${ATTEMPT}:2`, 1, "answer"), tool("tu")]) {
			const committed = [message([reasoning(0, "123")])];
			const streaming = live([reasoning(1, "4"), suffix], suffix.type === "text" ? 1 : -1);
			const result = projectStreamingDocument(committed, streaming);
			expect(result.map((row) => row.id)).toEqual(["a1", "__streaming__"]);
			expect(messageBody(result[0])).toEqual([reasoning(0, "123"), reasoning(1, "4")]);
			expect(messageBody(result[1])).toEqual([suffix]);
			expect(result[0].liveBlockIndex).toBe(-1);
			expect(isLiveStreamingBlock(false, result[0], 1)).toBe(false);
			expect(result[1].liveBlockIndex).toBe(suffix.type === "text" ? 0 : -1);
			expect(result[0].blocks[1]).toBe(streaming.blocks[0]);
			expect(result[1].blocks[0]).toBe(streaming.blocks[1]);
		}
	});

	it.each([
		["another attempt or retry", reasoning(1, "4", RETRY)],
		["legacy id", { ...reasoning(1), id: "r2" }],
		["missing id", { type: "reasoning", text: "4", revision: 1 }],
		["short epoch", { ...reasoning(1), id: "attempt:1" }],
		["invalid epoch", { ...reasoning(1), id: "0123456789abcdefghij!:1" }],
		["leading zero", { ...reasoning(1), id: `${ATTEMPT}:01` }],
		["negative order", { ...reasoning(1), id: `${ATTEMPT}:-1` }],
		["unsafe order", { ...reasoning(1), id: `${ATTEMPT}:9007199254740992` }],
		["missing revision", { type: "reasoning", text: "4", id: `${ATTEMPT}:1` }],
		["ordinal gap occupied by an external tool", reasoning(2, "4")],
	] as const)("keeps %s independent", (_name, incoming) => {
		const owner = message([reasoning(0, "123")]);
		const streaming = live([incoming], 0);
		const result = projectStreamingDocument([owner], streaming);
		expect(result).toEqual([owner, streaming]);
		expect(result[0]).toBe(owner);
	});

	it("rejects duplicate or gapped lanes and mixed-attempt reasoning runs", () => {
		for (const [committedBlocks, liveBlocks] of [
			[[reasoning(0), reasoning(0)], [reasoning(1)]],
			[[reasoning(0), reasoning(2)], [reasoning(3)]],
			[[reasoning(0, "old", RETRY), reasoning(0)], [reasoning(1)]],
			[[reasoning(0)], [reasoning(1), reasoning(1)]],
			[[reasoning(0)], [reasoning(1), reasoning(3)]],
			[[reasoning(0)], [reasoning(1), reasoning(2, "retry", RETRY)]],
		]) {
			const owner = message(committedBlocks);
			const streaming = live(liveBlocks);
			expect(projectStreamingDocument([owner], streaming)).toEqual([owner, streaming]);
		}
	});

	it("does not cross text/tool boundaries in either row", () => {
		for (const barrier of [text(`${ATTEMPT}:1`, 1), tool("tu")]) {
			const owner = message([reasoning(0), barrier]);
			const streaming = live([reasoning(2)]);
			expect(projectStreamingDocument([owner], streaming)).toEqual([owner, streaming]);
			const before = message([reasoning(0)]);
			const after = live([barrier, reasoning(2)]);
			expect(projectStreamingDocument([before], after)).toEqual([before, after]);
		}
	});

	it("requires the actual tail owner and rejects COW or another message sharing the epoch", () => {
		const owner = message([reasoning(0)]);
		const streaming = live([reasoning(1)]);
		for (const committed of [
			[owner, message([], "u", { role: "user" })],
			[owner, message([], "t", { role: "tool" })],
			[owner, message([], "system", { role: "system" })],
			[owner, message([reasoning(0, "retry", RETRY)], "next")],
			[message([reasoning(0)], "copy"), owner],
			[message([text(`${ATTEMPT}:9`, 1)], "another"), owner],
		]) {
			expect(projectStreamingDocument(committed, streaming)).toEqual([...committed, streaming]);
		}
		// Existing exact-id revision ownership still survives an interjected user.
		const interjected = [owner, message([], "u", { role: "user" })];
		const revised = projectStreamingDocument(
			interjected,
			live([reasoning(0, "updated", ATTEMPT, 2), reasoning(1)], 1),
		);
		expect(messageBody(revised[0])[0]).toEqual(reasoning(0, "updated", ATTEMPT, 2));
		expect(messageBody(revised[2])).toEqual([reasoning(1)]);
	});

	it("requires the narrator's own nonnested page scope, including a subagent's own page", () => {
		const streaming = live([reasoning(1)]);
		for (const extra of [
			{ narratorId: "other" },
			{ narratorId: undefined },
			{ parentToolUseId: "foreign-agent" },
			{ parentMessageId: "nested" },
		]) {
			const owner = message([reasoning(0)], "a1", extra);
			expect(projectStreamingDocument([owner], streaming)).toEqual([owner, streaming]);
		}
		const owner = message([reasoning(0)]);
		for (const extra of [
			{ narratorId: undefined },
			{ narratorId: "" },
			{ parentToolUseId: "foreign-agent" },
			{ parentMessageId: "nested" },
		]) {
			const foreign = { ...streaming, ...extra } as TreeMessage;
			expect(projectStreamingDocument([owner], foreign)).toEqual([owner, foreign]);
		}
		const child = message([reasoning(0)], "child", { narratorId: "child-narrator" });
		const childLive = { ...streaming, narratorId: "child-narrator" };
		expect(projectStreamingDocument([child], childLive)).toHaveLength(1);
	});

	it("rejects holder ids shared with the owner or retained live suffix", () => {
		const owner = message([reasoning(0)]);
		const raw = live([reasoning(1), text(`${ATTEMPT}:2`, 1)]);
		for (const streaming of [
			{
				...raw,
				blocks: raw.blocks.map((holder, index) => ({
					...holder,
					id: index === 0 ? owner.blocks[0].id : holder.id,
				})),
			},
			{ ...raw, blocks: raw.blocks.map((holder) => ({ ...holder, id: "shared-holder" })) },
			{ ...raw, blocks: [{ ...raw.blocks[0], elements: messageBody(raw) }] },
			{
				...raw,
				blocks: [
					raw.blocks[0],
					{ ...raw.blocks[1], id: "tool-holder", elements: [tool("tu")] },
					{ ...raw.blocks[0], id: "duplicate-element-holder" },
				],
			},
		]) {
			expect(projectStreamingDocument([owner], streaming)).toEqual([owner, streaming]);
		}
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
