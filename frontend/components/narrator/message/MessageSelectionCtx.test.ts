import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	BLOCK_ID_ATTR,
	BLOCK_INDICES_ATTR,
	parseMessageBlockIndices,
	resolveSelectedBlockMeta,
} from "./MessageSelectionCtx";

describe("merged message block selection", () => {
	test("normalizes merged block indices", () => {
		expect(parseMessageBlockIndices("3, 1,2,2,invalid,-1")).toEqual([1, 2, 3]);
		expect(parseMessageBlockIndices(null)).toEqual([]);
	});

	test("expands one selected visual block into every represented original block", () => {
		const { document } = parseHTML("<div id='root'></div>");
		const root = document.getElementById("root");
		if (!root) throw new Error("missing test root");
		const block = document.createElement("div");
		block.setAttribute(BLOCK_ID_ATTR, "msg-m1-4");
		block.setAttribute(BLOCK_INDICES_ATTR, "4,5,6");
		block.setAttribute("data-message-id", "m1");
		block.setAttribute("data-block-index", "4");
		root.appendChild(block);

		expect(resolveSelectedBlockMeta(root as unknown as HTMLElement, new Set(["msg-m1-4"]))).toEqual(
			[
				{ blockId: "msg-m1-4", messageId: "m1", blockIndex: 4 },
				{ blockId: "msg-m1-4", messageId: "m1", blockIndex: 5 },
				{ blockId: "msg-m1-4", messageId: "m1", blockIndex: 6 },
			],
		);
	});
});
