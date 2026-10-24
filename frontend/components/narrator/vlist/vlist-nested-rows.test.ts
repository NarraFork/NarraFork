/**
 * Rows nested under another row stay flat in the loaded document: each row is
 * followed by the rows nested under it (`message/nested-rows.ts`). These cases pin
 * how every document operation and reader treats them.
 */
import { describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { segmentMessages } from "../message/message-segments";
import {
	endOfNestedRows,
	isForeignSubagentRow,
	isNestedRow,
	nestedRowsByParent,
	withNestedRowIds,
} from "../message/nested-rows";
import type { NarratorMsg } from "../narrator-panel-types";
import { recentRunSegmentMessageIds } from "../trace/run-segments";
import { syncAskInPassingMessage } from "./vlist-ask-in-passing-sync";
import { buildExactCatchUpCursor } from "./vlist-exact-document";
import { trimLoadedHead } from "./vlist-head-trim";
import { appendLoadedMessage, upsertLoadedMessage } from "./vlist-message-append";
import { insertLoadedMessage } from "./vlist-message-insert";
import { removeLoadedMessages } from "./vlist-message-remove";
import { replaceLoadedMessage } from "./vlist-message-replace";
import { buildSelectionIndex } from "./vlist-selection";
import { buildTailMeta } from "./vlist-tail-meta";

const row = (
	id: string,
	seq: number | undefined,
	fields: Partial<Omit<TreeMessage, "blocks">> = {},
	elements: unknown[] = [{ type: "text", text: id }],
) =>
	rowWithElements(
		{
			id,
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			...(seq !== undefined ? { seq } : {}),
			...fields,
		},
		elements,
	) as unknown as TreeMessage;

const parent = () => row("p", 2, {}, [{ type: "tool_use", id: "run", name: "Run", input: {} }]);
const nested = (id: string, parentMessageId = "p") =>
	row(id, undefined, { parentToolUseId: "run", parentMessageId });

/** before (1) · p (2) · c1, c2 nested under p · after (3) */
const document = () => [row("before", 1), parent(), nested("c1"), nested("c2"), row("after", 3)];
const ids = (rows: readonly { id?: unknown }[]) => rows.map((value) => value.id);

describe("nested-rows helpers", () => {
	it("index, expand and bound the rows nested under a row", () => {
		const rows = [...document(), nested("g1", "c1")];
		expect(isNestedRow(rows[2])).toBe(true);
		expect(isNestedRow(rows[1])).toBe(false);
		expect(ids(nestedRowsByParent(rows).get("p") ?? [])).toEqual(["c1", "c2"]);
		expect([...withNestedRowIds(rows, new Set(["p"]))].sort()).toEqual(["c1", "c2", "g1", "p"]);
		expect(endOfNestedRows(document(), 1)).toBe(4);
		expect(endOfNestedRows(document(), 0)).toBe(1);
	});

	it("recognizes the row a subagent's parent page receives as foreign", () => {
		// The same row is dual-broadcast to both pages: the subagent keeps it as one of its
		// own top-level rows, and the parent receives it tagged with `parentToolUseId` — not
		// nested, because a subagent's rows are never nested under its parent's row.
		expect(isForeignSubagentRow(row("plain", 3, { parentToolUseId: "run" }), false)).toBe(true);
		// The subagent's own page receives that same row with the pointer stripped, so its
		// pages must keep treating it as an ordinary row.
		expect(isForeignSubagentRow(row("plain", 3, { parentToolUseId: "run" }), true)).toBe(false);
		expect(isForeignSubagentRow(row("plain", 3), true)).toBe(false);
		// Ordinary rows and legacy inline replies (nested under a parent ROW) stay part of
		// the conversation that holds them.
		expect(isForeignSubagentRow(row("plain", 3), false)).toBe(false);
		expect(isForeignSubagentRow(row("plain", 3, { parentToolUseId: "" }), false)).toBe(false);
		expect(isForeignSubagentRow(undefined, false)).toBe(false);
	});
});

describe("document operations", () => {
	it("a nested row is never appended at the tail", () => {
		const result = appendLoadedMessage(document(), nested("c3"), true);
		expect(result).toMatchObject({ appended: false, reason: "child-message" });
	});

	it("upsert places a new nested row after its parent's nested rows", () => {
		const result = upsertLoadedMessage(document(), nested("c3"), false);
		expect(result.changed).toBe(true);
		expect(ids(result.messages)).toEqual(["before", "p", "c1", "c2", "c3", "after"]);
		const orphan = upsertLoadedMessage(document(), nested("x", "missing"), false);
		expect(orphan).toMatchObject({ changed: false, reason: "child-message" });
	});

	it("upsert of a parent keeps the rows nested under it", () => {
		const loaded = document();
		const result = upsertLoadedMessage(loaded, parent(), false);
		expect(ids(result.messages)).toEqual(ids(loaded));
		expect(result.messages[2]).toBe(loaded[2]);
	});

	it("an append's tail check ignores nested rows' seqs", () => {
		const loaded = [parent(), { ...nested("c1"), seq: 9 }];
		expect(appendLoadedMessage(loaded, row("next", 3), false).appended).toBe(true);
	});

	it("a mid-window insert never lands between a row and its nested rows", () => {
		const loaded = [row("before", 1), parent(), { ...nested("c1"), seq: 3 }, row("after", 4)];
		const result = insertLoadedMessage(loaded, row("marker", 3));
		expect(ids(result.messages)).toEqual(["before", "p", "c1", "marker", "after"]);
	});

	it("removing a row removes the rows nested under it", () => {
		const result = removeLoadedMessages(document(), ["p"]);
		expect(ids(result.messages)).toEqual(["before", "after"]);
	});

	it("a head trim never splits a row from its nested rows", () => {
		const result = trimLoadedHead([...document(), row("tail", 4)], 2);
		expect(ids(result.messages)).toEqual(["after", "tail"]);
		expect(result.oldestKeptSeq).toBe(3);
	});

	it("a copy-on-write replacement takes over the rows nested under the old row", () => {
		const copy = row("p2", 2, {}, [{ type: "tool_use", id: "run", name: "Run", input: {} }]);
		const result = replaceLoadedMessage(document(), copy, { oldMessageId: "p" });
		expect(ids(result.messages)).toEqual(["before", "p2", "c1", "c2", "after"]);
		expect(result.messages[2].parentMessageId).toBe("p2");
	});

	it("an ask-in-passing card goes after its source's nested rows", () => {
		const card = rowWithElements({ ...row("ask", 3), askInsertVersion: 8 }, [
			{ type: "ask_in_passing", status: "pending", sourceMessageId: "p" },
		]) as unknown as TreeMessage;
		const result = syncAskInPassingMessage(document(), card, 7);
		expect(ids(result?.messages ?? [])).toEqual(["before", "p", "c1", "c2", "ask", "after"]);
	});
});

describe("readers", () => {
	it("segmentation skips nested rows and hands them to their tool call", () => {
		const segments = segmentMessages(document() as unknown as NarratorMsg[]);
		const items = segments.flatMap((segment) => (segment.kind === "tool-run" ? segment.items : []));
		expect(items).toHaveLength(1);
		expect(ids(items[0].nestedRows)).toEqual(["c1", "c2"]);
		expect(items[0].isSubagent).toBe(true);
		const shown = segments.flatMap((segment) =>
			segment.kind === "message" ? [segment.msg.id] : segment.sourceMessages.map((msg) => msg.id),
		);
		expect(shown).toEqual(["before", "p", "after"]);
	});

	it("selection, tail meta and the catch-up cursor read the conversation only", () => {
		const rows = [row("before", 1), parent(), { ...nested("c1"), seq: 5 }];
		const selection = buildSelectionIndex(rows as unknown as NarratorMsg[]);
		expect(selection.entries.map((entry) => entry.messageId)).not.toContain("c1");
		expect(selection.byBlockId.get("sa-run")?.messageId).toBe("p");
		const tail = buildTailMeta(rows as never, {
			statusReady: true,
			streamingMsgId: "__streaming__",
			findSpecTasksToolUseId: () => null,
		});
		expect(tail.lastRealMessage?.id).toBe("p");
		expect(buildExactCatchUpCursor(rows)).toEqual({ parentLastMessageId: "p" });
	});

	it("a nested row neither joins nor breaks the recent assistant runs", () => {
		const rows = [row("u", 1, { role: "user" }), parent(), { ...nested("c1"), role: "user" }];
		const recent = recentRunSegmentMessageIds(rows as unknown as NarratorMsg[], 1);
		expect([...recent]).toEqual(["p"]);
	});
});
