/**
 * takeover-tree-injection.test.ts
 *
 * `attachTakenOverFlags` is the transport half of "the parent's card says the
 * user is driving this child". It marks the `tool_use` block of a call whose
 * target subagent is currently taken over, so a reload shows the badge instead of
 * a card that merely looks busy.
 *
 * Three properties, each of which fails SILENTLY if broken:
 *
 *  - It must NOT write into `_metadata`. `classifyAwait`
 *    (shared/pretext-layout/tool-detail.ts) turns metadata entries into extra
 *    detail rows, so a flag placed there would grow every Await card — a layout
 *    change caused by a badge. The measure layer must never see this field.
 *  - It must return the SAME references when it writes nothing, so a page with no
 *    live takeover (the overwhelmingly common case) pays no copy.
 *  - It must reach NESTED messages: a subagent's own Await lives in the child
 *    subtree of its parent's tool call.
 */

import { describe, expect, test } from "bun:test";
import { attachTakenOverFlags, TAKEN_OVER_FIELD } from "../await-agent-resolution";

function toolMessage(toolUseId: string, extra: Record<string, unknown> = {}) {
	return {
		id: `m-${toolUseId}`,
		role: "assistant",
		contentJson: [
			{ type: "text", text: "working" },
			{
				type: "tool_use",
				id: toolUseId,
				name: "Agent",
				inputJson: { description: "explore", prompt: "look around" },
				status: "running",
				...extra,
			},
		],
	};
}

describe("attachTakenOverFlags", () => {
	test("marks the matching tool_use block", () => {
		const tree = [toolMessage("tu-1")];
		const out = attachTakenOverFlags(tree, new Set(["tu-1"]));
		expect(out[0].contentJson[1][TAKEN_OVER_FIELD]).toBe(true);
		// The field name is part of the wire contract with the frontend readers.
		expect(TAKEN_OVER_FIELD).toBe("_takenOver");
	});

	/**
	 * The height-neutrality guarantee: a badge must not become a detail row.
	 */
	test("never touches _metadata", () => {
		const tree = [toolMessage("tu-1", { _metadata: { awaitType: "agent" } })];
		const out = attachTakenOverFlags(tree, new Set(["tu-1"]));
		const block = out[0].contentJson[1];
		expect(block._metadata).toEqual({ awaitType: "agent" });
		expect(block._metadata.takenOver).toBeUndefined();
		expect(block._metadata.subagentId).toBeUndefined();
	});

	test("returns the SAME reference when nothing on the page matches", () => {
		const tree = [toolMessage("tu-1")];
		const out = attachTakenOverFlags(tree, new Set(["tu-other"]));
		expect(out).toBe(tree);
		expect(out[0].contentJson[1][TAKEN_OVER_FIELD]).toBeUndefined();
	});

	test("returns the SAME reference for an empty set (the common case)", () => {
		const tree = [toolMessage("tu-1")];
		expect(attachTakenOverFlags(tree, new Set())).toBe(tree);
	});

	test("leaves unmatched sibling messages untouched by identity", () => {
		const other = toolMessage("tu-2");
		const tree = [toolMessage("tu-1"), other];
		const out = attachTakenOverFlags(tree, new Set(["tu-1"]));
		expect(out).not.toBe(tree);
		// The copy is shallow-by-need: an unaffected message keeps its identity, so
		// downstream memoization on that message still hits.
		expect(out[1]).toBe(other);
	});

	test("reaches nested child messages", () => {
		const tree = [
			{
				id: "m-parent",
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "tu-parent", name: "Agent", status: "running" }],
				children: [toolMessage("tu-child")],
			},
		];
		const out = attachTakenOverFlags(tree, new Set(["tu-child"]));
		expect(out[0].children[0].contentJson[1][TAKEN_OVER_FIELD]).toBe(true);
		// The parent's own block was not in the set, so it must stay unflagged.
		expect(out[0].contentJson[0][TAKEN_OVER_FIELD]).toBeUndefined();
	});
});
