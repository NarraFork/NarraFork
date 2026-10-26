import { describe, expect, test } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { segmentMessages } from "../message/message-segments";
import { type AdapterSegment, adaptSegments } from "./segment-adapter";
import { resolveVListBlockTarget } from "./vlist-block-target";

/**
 * Every message keys its elements by block id (§8.3), so a row keeps its key when a block
 * before it is deleted: the blocks a message names, or for a row the client builds, the
 * blocks the server would split it into.
 */

/** A block the server named, over the elements `[from, to)` of the row's texts. */
interface Named {
	id: string;
	from: number;
	to: number;
}
const ref = (id: string, from: number, to = from + 1): Named => ({ id, from, to });

function message(texts: string[], named?: Named[]): TreeMessage {
	const elements = texts.map((text) => ({ type: "text", text }));
	const row = {
		id: "m1",
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentText: null,
		createdAt: "2026-10-01T00:00:00.000Z",
		toolCalls: [],
	} as unknown as TreeMessage;
	if (!named) return rowWithElements(row, elements);
	return {
		...row,
		blocks: named.map(({ id, from, to }) => ({
			id,
			kind: "output",
			subtype: null,
			phase: "done",
			revision: 1,
			wireId: null,
			attemptId: null,
			hasOriginal: false,
			named: true,
			elements: elements.slice(from, to),
		})),
	};
}

const keysOf = (msg: TreeMessage) =>
	adaptSegments(segmentMessages([msg]) as unknown as AdapterSegment[], { lod: 5 })
		.map((spec) => spec.key)
		.filter((key) => key.startsWith("m1-blk"));

describe("element keys", () => {
	test("block-keyed rows keep their key when a block before them goes", () => {
		const before = keysOf(message(["first", "second"], [ref("bA", 0), ref("bB", 1)]));
		expect(before).toEqual(["m1-blk[bA]", "m1-blk[bB]"]);
		const after = keysOf(message(["second"], [ref("bB", 0)]));
		expect(after).toEqual(["m1-blk[bB]"]);
	});

	test("a row built on the client is keyed by the blocks the server would split it into", () => {
		expect(keysOf(message(["first", "second"]))).toEqual(["m1-blk[m1:0]", "m1-blk[m1:1]"]);
	});

	test("a block-keyed row resolves, through the document's row, to the element it renders", () => {
		const row = message(["a", "b", "c"], [ref("bA", 0, 2), ref("bB", 2)]);
		const messageOf = (id: string) => (id === row.id ? row : undefined);
		expect(resolveVListBlockTarget("markdown", "m1-blk[bB]", ["m1"], messageOf)).toMatchObject({
			messageId: "m1",
			blockIndex: 2,
		});
		expect(resolveVListBlockTarget("markdown", "m1-blk[bA]+1", ["m1"], messageOf)).toMatchObject({
			blockIndex: 1,
		});
		// A block that is not one of the row's message's resolves to no target, as does a
		// message the document does not hold.
		expect(resolveVListBlockTarget("markdown", "m1-blk[elsewhere]", ["m1"], messageOf)).toBeNull();
		expect(resolveVListBlockTarget("markdown", "m1-blk[bB]", ["m1"], () => undefined)).toBeNull();
	});
});
