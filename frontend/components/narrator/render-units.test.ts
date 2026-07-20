import { describe, expect, test } from "bun:test";
import { segmentMessages } from "./message-segments";
import type { NarratorMsg } from "./narrator-panel-types";
import { groupRenderUnits, groupToolRunItemsForLod } from "./render-units";

function toolMessage(
	messageId: string,
	toolUseId: string,
	reasoningText: string,
	opts: { status?: string } = {},
): NarratorMsg {
	return {
		id: messageId,
		narratorId: "narrator-1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [
			{ type: "reasoning", text: reasoningText },
			{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "a.ts" } },
		],
		contentText: null,
		toolCalls: [
			{
				id: `call-${toolUseId}`,
				toolUseId,
				toolName: "Read",
				status: opts.status ?? "success",
			},
		],
		children: [],
		createdAt: "2026-07-19T00:00:00.000Z",
	} as NarratorMsg;
}

function userMessage(messageId: string): NarratorMsg {
	return {
		id: messageId,
		narratorId: "narrator-1",
		parentToolUseId: null,
		role: "user",
		contentJson: [{ type: "text", text: "hi" }],
		contentText: "hi",
		toolCalls: [],
		children: [],
		createdAt: "2026-07-19T00:00:00.000Z",
	} as NarratorMsg;
}

function toolRunItems(statuses: string[]) {
	const segments = segmentMessages(
		statuses.map((status, index) =>
			toolMessage(`message-${index}`, `tool-${index}`, "", { status }),
		),
	);
	const toolRun = segments.find((segment) => segment.kind === "tool-run");
	if (toolRun?.kind !== "tool-run") throw new Error("expected a tool-run segment");
	return toolRun.items;
}

describe("groupToolRunItemsForLod", () => {
	test("keeps a trailing live tool below earlier folded calls", () => {
		const groups = groupToolRunItemsForLod(toolRunItems(["success", "success", "running"]));

		expect(groups.map((group) => group.kind)).toEqual(["folded", "active"]);
		expect(groups[0]).toMatchObject({
			kind: "folded",
			startIndex: 0,
			items: [{ tc: { toolUseId: "tool-0" } }, { tc: { toolUseId: "tool-1" } }],
		});
		expect(groups[1]).toMatchObject({
			kind: "active",
			index: 2,
			item: { tc: { toolUseId: "tool-2" } },
		});
	});

	test("preserves interleaved active and completed positions", () => {
		const groups = groupToolRunItemsForLod(
			toolRunItems(["success", "running", "success", "pending", "success"]),
		);

		expect(groups.map((group) => group.kind)).toEqual([
			"folded",
			"active",
			"folded",
			"active",
			"folded",
		]);
		expect(
			groups.map((group) =>
				group.kind === "active" ? group.item.tc.toolUseId : group.items[0]?.tc.toolUseId,
			),
		).toEqual(["tool-0", "tool-1", "tool-2", "tool-3", "tool-4"]);
	});
});

describe("groupRenderUnits (L1/L2 unified activity fold)", () => {
	test("disabled → identity (one unit per segment)", () => {
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "thought one"),
			toolMessage("message-2", "tool-2", "thought two"),
		]);
		const units = groupRenderUnits(segments, false);
		expect(units).toHaveLength(segments.length);
		expect(units.every((u) => u.kind === "segment")).toBe(true);
	});

	test("adjacent reasoning + tool segments fold into ONE activity unit, in order", () => {
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "thought one"),
			toolMessage("message-2", "tool-2", "thought two"),
		]);
		// sanity: without folding these alternate message/tool-run
		expect(segments.map((s) => s.kind)).toEqual(["message", "tool-run", "message", "tool-run"]);

		const units = groupRenderUnits(segments, true);
		expect(units).toHaveLength(1);
		const unit = units[0];
		expect(unit.kind).toBe("activity");
		if (unit.kind !== "activity") return;
		expect(unit.items.map((i) => i.kind)).toEqual(["reasoning", "tool", "reasoning", "tool"]);
		expect(unit.sourceMessages.map((m) => m.id)).toEqual(["message-1", "message-2"]);
		// item-level keys are stable (toolUseId for tools) for future animation
		const toolItems = unit.items.filter((i) => i.kind === "tool");
		expect(toolItems.map((i) => (i.kind === "tool" ? i.tc.toolUseId : null))).toEqual([
			"tool-1",
			"tool-2",
		]);
		const reasoningItems = unit.items.filter((i) => i.kind === "reasoning");
		expect(reasoningItems.map((i) => `r-${i.msg.id}-${i.blockIndex}`)).toEqual([
			"r-message-1-0",
			"r-message-2-0",
		]);
	});

	test("text content flushes the activity group (text is NOT folded)", () => {
		const msgWithText: NarratorMsg = {
			id: "message-text",
			narratorId: "narrator-1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "thinking" },
				{ type: "text", text: "answer body" },
				{ type: "tool_use", id: "tool-x", name: "Read", input: { file_path: "a.ts" } },
			],
			contentText: "answer body",
			toolCalls: [{ id: "call-tool-x", toolUseId: "tool-x", toolName: "Read", status: "success" }],
			children: [],
			createdAt: "2026-07-19T00:00:00.000Z",
		} as NarratorMsg;
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "thought one"),
			msgWithText,
		]);
		const units = groupRenderUnits(segments, true);
		// The text message segment must remain a plain message unit, not folded.
		const kinds = units.map((u) => u.kind);
		expect(kinds).toContain("segment");
		// The activity unit (if any) must not contain the text block.
		const activity = units.find((u) => u.kind === "activity");
		if (activity && activity.kind === "activity") {
			expect(
				activity.items.every(
					(i) =>
						!(i.kind === "reasoning" && i.msg.id === "message-text" && i.block.type === "text"),
				),
			).toBe(true);
		}
	});

	test("extracts reasoning from a mixed reasoning/text segment without folding the text", () => {
		const mixedMessage: NarratorMsg = {
			id: "message-mixed",
			narratorId: "narrator-1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "reasoning before the answer" },
				{ type: "text", text: "visible answer body" },
				{ type: "tool_use", id: "tool-mixed", name: "Read", input: { file_path: "a.ts" } },
			],
			contentText: "visible answer body",
			toolCalls: [
				{
					id: "call-tool-mixed",
					toolUseId: "tool-mixed",
					toolName: "Read",
					status: "success",
				},
			],
			children: [],
			createdAt: "2026-07-19T00:00:00.000Z",
		} as NarratorMsg;

		const segments = segmentMessages([mixedMessage]);
		expect(segments.map((segment) => segment.kind)).toEqual(["message", "tool-run"]);

		const units = groupRenderUnits(segments, true);
		expect(units.map((unit) => unit.kind)).toEqual(["activity", "segment", "activity"]);
		expect(units[0]).toMatchObject({
			kind: "activity",
			items: [{ kind: "reasoning", blockIndex: 0 }],
		});
		expect(units[1]).toMatchObject({
			kind: "segment",
			seg: { kind: "message", visibleBlockIndices: [1] },
		});
		expect(units[2]).toMatchObject({
			kind: "activity",
			items: [{ kind: "tool", blockIndex: 2 }],
		});
	});

	test("active tool-run flushes the group (in-flight tools stay full)", () => {
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "thought one"),
			toolMessage("message-2", "tool-2", "thought two", { status: "running" }),
		]);
		const units = groupRenderUnits(segments, true);
		// The running tool-run must NOT be absorbed into the activity unit.
		const activity = units.find((u) => u.kind === "activity");
		const toolRunUnit = units.find((u) => u.kind === "segment" && u.seg.kind === "tool-run");
		expect(toolRunUnit).toBeDefined();
		if (activity && activity.kind === "activity") {
			expect(activity.items.some((i) => i.kind === "tool" && i.tc.toolUseId === "tool-2")).toBe(
				false,
			);
		}
	});

	test("user message flushes the group", () => {
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "thought one"),
			userMessage("user-1"),
			toolMessage("message-2", "tool-2", "thought two"),
		]);
		const units = groupRenderUnits(segments, true);
		const kinds = units.map((u) => u.kind);
		// activity, then user message segment, then activity again
		expect(kinds[0]).toBe("activity");
		expect(kinds).toContain("segment");
		expect(kinds[kinds.length - 1]).toBe("activity");
	});

	test("pure reasoning message (no tool) still folds into an activity unit", () => {
		const reasoningOnly: NarratorMsg = {
			id: "message-r",
			narratorId: "narrator-1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [{ type: "reasoning", text: "just thinking" }],
			contentText: null,
			toolCalls: [],
			children: [],
			createdAt: "2026-07-19T00:00:00.000Z",
		} as NarratorMsg;
		const segments = segmentMessages([reasoningOnly]);
		const units = groupRenderUnits(segments, true);
		expect(units).toHaveLength(1);
		expect(units[0].kind).toBe("activity");
		if (units[0].kind === "activity") {
			expect(units[0].items.map((i) => i.kind)).toEqual(["reasoning"]);
		}
	});
});
