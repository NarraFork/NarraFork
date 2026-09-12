import { describe, expect, test } from "bun:test";
import { segmentMessages } from "./message/message-segments";
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

	test("a pinned latest-tasks card stays a standalone card, in position", () => {
		// tool-2 is a COMPLETED call — only the pin keeps it out of the fold.
		const groups = groupToolRunItemsForLod(
			toolRunItems(["success", "success", "success", "success"]),
			"tool-2",
		);

		expect(groups.map((group) => group.kind)).toEqual(["folded", "active", "folded"]);
		expect(groups[1]).toMatchObject({
			kind: "active",
			index: 2,
			item: { tc: { status: "success" } },
		});
		expect(groups[0]).toMatchObject({ kind: "folded", items: [{}, {}] });
		expect(groups[2]).toMatchObject({ kind: "folded", items: [{}] });
	});

	test("an unknown pinned id changes nothing (fold behaves as before)", () => {
		const groups = groupToolRunItemsForLod(toolRunItems(["success", "success"]), "tool-missing");
		expect(groups.map((group) => group.kind)).toEqual(["folded"]);
	});
});

describe("communication remains chronological conversation content", () => {
	function communicationMessage(messageId: string, status = "success"): NarratorMsg {
		const msg = toolMessage(messageId, "send-1", "", { status });
		msg.contentJson = [
			{
				type: "tool_use",
				id: "send-1",
				name: "Send",
				input: { name: "worker", message: "**hello**" },
			},
		];
		msg.toolCalls = msg.toolCalls.map((tc) => ({ ...tc, toolName: "Send" }));
		return msg;
	}

	test.each([
		true,
		false,
	])("communication handoff deduplicates across boundaries (fold=%s)", (enabled) => {
		const persisted = communicationMessage("persisted");
		const live = communicationMessage("__streaming__", "running");
		for (const messages of [
			[persisted, userMessage("boundary"), live],
			[live, userMessage("boundary"), persisted],
		]) {
			const units = groupRenderUnits(segmentMessages(messages), enabled);
			const tools = units.flatMap((unit) =>
				unit.kind === "segment" && unit.seg.kind === "tool-run" ? unit.seg.items : [],
			);
			expect(tools).toHaveLength(1);
			expect(tools[0]?.msg.id).toBe("persisted");
			expect(tools[0]?.tc.status).toBe("success");
			expect(units.some((unit) => unit.kind === "activity")).toBe(false);
		}
	});

	test.each([
		true,
		false,
	])("persisted retries are not mistaken for live twins (fold=%s)", (enabled) => {
		const units = groupRenderUnits(
			segmentMessages([communicationMessage("retry-one"), communicationMessage("retry-two")]),
			enabled,
		);
		const tools = units.flatMap((unit) =>
			unit.kind === "segment" && unit.seg.kind === "tool-run" ? unit.seg.items : [],
		);
		expect(tools.map((item) => item.msg.id)).toEqual(["retry-one", "retry-two"]);
	});

	test("mixed completed tool groups exempt only Send and TeamStatus send/broadcast", () => {
		const items = toolRunItems(["success", "success", "success", "success", "success", "success"]);
		const names = ["Read", "Send", "Bash", "TeamStatus", "TeamStatus", "TeamStatus"];
		for (const [index, item] of items.entries()) {
			item.tc.toolName = names[index] ?? "Read";
			item.tc.inputJson = {
				action: index === 3 ? "send" : index === 4 ? "list" : "broadcast",
				message: "hello",
			};
		}
		const segments = [
			{ kind: "tool-run" as const, items, sourceMessages: items.map((item) => item.msg) },
		];
		const units = groupRenderUnits(segments, true);
		expect(units.map((unit) => unit.kind)).toEqual([
			"activity",
			"segment",
			"activity",
			"segment",
			"activity",
			"segment",
		]);
		expect(
			units.flatMap((unit) =>
				unit.kind === "activity"
					? unit.items.map((item) => (item.kind === "tool" ? item.tc.toolName : "reasoning"))
					: [],
			),
		).toEqual(["Read", "Bash", "TeamStatus"]);
		expect(groupToolRunItemsForLod(items).map((group) => group.kind)).toEqual([
			"folded",
			"active",
			"folded",
			"active",
			"folded",
			"active",
		]);
		const kept = units.flatMap((unit) =>
			unit.kind === "segment" && unit.seg.kind === "tool-run" ? unit.seg.items : [],
		);
		expect(kept.map((item) => item.tc.toolUseId)).toEqual(["tool-1", "tool-3", "tool-5"]);
	});

	test("reasoning, communication, answer, and tool activity keep original message order", () => {
		const units = groupRenderUnits(
			segmentMessages([
				toolMessage("before", "read-before", "first thought"),
				communicationMessage("sent"),
				userMessage("answer-boundary"),
				toolMessage("after", "read-after", "next thought"),
			]),
			true,
		);
		expect(units.map((unit) => unit.kind)).toEqual(["activity", "segment", "segment", "activity"]);
		expect(
			units.map((unit) =>
				unit.kind === "activity"
					? unit.sourceMessages[0]?.id
					: unit.seg.kind === "tool-run"
						? unit.seg.items[0]?.msg.id
						: unit.seg.kind === "message"
							? unit.seg.msg.id
							: "other",
			),
		).toEqual(["before", "sent", "answer-boundary", "after"]);
	});

	test("TeamStatus streamed action is recognized before full input is committed", () => {
		const items = toolRunItems(["running"]);
		const item = items[0];
		if (!item) throw new Error("missing tool item");
		item.tc.toolName = "TeamStatus";
		item.tc.inputJson = { _streamingFields: { action: "broadcast", message: "live" } };
		const units = groupRenderUnits(
			[{ kind: "tool-run", items, sourceMessages: items.map((item) => item.msg) }],
			true,
		);
		expect(units[0]?.kind).toBe("segment");
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

	test("a RUNNING tool folds too, so the hand-off changes nothing visually", () => {
		// Live content used to be excluded here, which meant it rendered as a full
		// card and was swapped for a trace row the instant it persisted — a change of
		// element identity (bordered Paper + 16px icon at x=10 → borderless 18.8px row
		// + 14px icon at x=18), hence the icon jump. Folding it from the start removes
		// the swap instead of trying to animate it.
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "thought one"),
			toolMessage("message-2", "tool-2", "thought two", { status: "running" }),
		]);
		const units = groupRenderUnits(segments, true);
		expect(units.map((u) => u.kind)).toEqual(["activity"]);
		const activity = units[0];
		if (activity.kind !== "activity") return;
		expect(activity.items.some((i) => i.kind === "tool" && i.tc.toolUseId === "tool-2")).toBe(true);
	});

	test("a tool AWAITING A PERMISSION decision keeps its full card", () => {
		// The only surviving exemption: the approve/deny form can only be hosted by a
		// tool-call / subagent-card (PERMISSION_HOST_KINDS), so folding this row would
		// drop the controls the narrator is blocked on.
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "thought one"),
			toolMessage("message-2", "tool-2", "thought two", { status: "pending" }),
		]);
		const units = groupRenderUnits(segments, true);
		const toolRunUnit = units.find((u) => u.kind === "segment" && u.seg.kind === "tool-run");
		expect(toolRunUnit).toBeDefined();
		const folded = units.filter((u) => u.kind === "activity");
		expect(
			folded.some((u) => u.items.some((i) => i.kind === "tool" && i.tc.toolUseId === "tool-2")),
		).toBe(false);
	});

	test("streaming reasoning folds, and its row key survives persistence", () => {
		// The key must not derive from msg.id: a live run owns "__streaming__" and
		// gains a real id when stored, so an id-derived key would change at the
		// hand-off and React would rebuild a row whose content merely settled.
		const reasoningMessage = (id: string): NarratorMsg =>
			({
				id,
				narratorId: "narrator-1",
				parentToolUseId: null,
				role: "assistant",
				contentJson: [{ type: "reasoning", text: "weighing the options" }],
				contentText: null,
				toolCalls: [],
				children: [],
				createdAt: "2026-07-19T00:00:00.000Z",
			}) as NarratorMsg;

		const liveUnits = groupRenderUnits(segmentMessages([reasoningMessage("__streaming__")]), true);
		const persistedUnits = groupRenderUnits(segmentMessages([reasoningMessage("real-id")]), true);

		expect(liveUnits[0]?.kind).toBe("activity");
		expect(persistedUnits[0]?.kind).toBe("activity");
		if (liveUnits[0]?.kind !== "activity" || persistedUnits[0]?.kind !== "activity") return;

		const keyOf = (unit: typeof liveUnits) => {
			const first = unit[0];
			if (first?.kind !== "activity") return null;
			const item = first.items[0];
			if (item?.kind !== "reasoning") return null;
			return `${item.stableKeyBase}-${item.stableKeyOffset}`;
		};
		expect(keyOf(liveUnits)).toBe(keyOf(persistedUnits));
		expect(keyOf(liveUnits)).toBe("run0-0");
	});

	test("reasoning runs get distinct key bases within one unit", () => {
		// Two runs separated by a tool: each needs its own base, or their rows would
		// collide on the same React key.
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "first thought"),
			toolMessage("message-2", "tool-2", "second thought"),
		]);
		const units = groupRenderUnits(segments, true);
		expect(units).toHaveLength(1);
		if (units[0]?.kind !== "activity") return;
		const bases = units[0].items
			.filter((i) => i.kind === "reasoning")
			.map((i) => (i.kind === "reasoning" ? i.stableKeyBase : null));
		expect(bases).toEqual(["run0", "run1"]);
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

	test("keepToolUseIds keeps ONE call out of the fold, neighbours still fold", () => {
		// Three tool segments: only the middle call's tool-use id is in the keep set.
		// It must stay a plain segment (its card renders in full) while the two
		// neighbours fold into their own activity units on either side.
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "thought one"),
			toolMessage("message-2", "tool-2", "thought two"),
			toolMessage("message-3", "tool-3", "thought three"),
		]);
		const units = groupRenderUnits(segments, true, {
			keepToolUseIds: new Set(["tool-2"]),
		});

		expect(units.map((u) => u.kind)).toEqual(["activity", "segment", "activity"]);
		const kept = units[1];
		if (kept.kind !== "segment" || kept.seg.kind !== "tool-run")
			throw new Error("expected tool-run segment");
		expect(kept.seg.items.map((i) => i.tc.toolUseId)).toEqual(["tool-2"]);
		// The kept call must not also appear inside a folded unit.
		for (const unit of units) {
			if (unit.kind !== "activity") continue;
			expect(unit.items.some((i) => i.kind === "tool" && i.tc.toolUseId === "tool-2")).toBe(false);
		}
	});

	/**
	 * ⚠️ The bug this pins down: a kept call used to take its WHOLE tool-run out of
	 * the fold, so its siblings never became trace rows. Downstream, a plain
	 * tool-run at L1/L2 collapses to a `tool-run-count` — an anonymous "tool calls
	 * ×N" line — so pinning one call silently erased the identity of every call
	 * beside it. Splitting per item keeps the neighbours as named rows.
	 */
	test("a kept call does NOT drag its sibling calls out of the fold", () => {
		// One message issuing three calls in a single run; only the middle is kept.
		const runMessage: NarratorMsg = {
			id: "message-run",
			narratorId: "narrator-1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{ type: "tool_use", id: "tool-a", name: "Read", input: { file_path: "a.ts" } },
				{ type: "tool_use", id: "tool-pinned", name: "Write", input: { file_path: "b.ts" } },
				{ type: "tool_use", id: "tool-c", name: "Bash", input: { command: "ls" } },
			],
			contentText: null,
			toolCalls: [
				{ id: "call-a", toolUseId: "tool-a", toolName: "Read", status: "success" },
				{ id: "call-pinned", toolUseId: "tool-pinned", toolName: "Write", status: "success" },
				{ id: "call-c", toolUseId: "tool-c", toolName: "Bash", status: "success" },
			],
			children: [],
			createdAt: "2026-07-19T00:00:00.000Z",
		} as NarratorMsg;

		const units = groupRenderUnits(segmentMessages([runMessage]), true, {
			keepToolUseIds: new Set(["tool-pinned"]),
		});

		// Source order survives: folded before, kept card, folded after.
		expect(units.map((u) => u.kind)).toEqual(["activity", "segment", "activity"]);
		const foldedIds = units.flatMap((unit) =>
			unit.kind === "activity"
				? unit.items.flatMap((item) => (item.kind === "tool" ? [item.tc.toolUseId] : []))
				: [],
		);
		expect(foldedIds).toEqual(["tool-a", "tool-c"]);
		const kept = units[1];
		if (kept.kind !== "segment" || kept.seg.kind !== "tool-run")
			throw new Error("expected tool-run segment");
		expect(kept.seg.items.map((i) => i.tc.toolUseId)).toEqual(["tool-pinned"]);
		// Every folded unit reports the message it came from, so its key and the L5
		// recency window still resolve.
		for (const unit of units) {
			if (unit.kind !== "activity") continue;
			expect(unit.sourceMessages.map((m) => m.id)).toEqual(["message-run"]);
		}
	});

	test("a permission-blocked call keeps only ITS card, siblings still fold", () => {
		const runMessage: NarratorMsg = {
			id: "message-perm",
			narratorId: "narrator-1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{ type: "tool_use", id: "tool-done", name: "Read", input: { file_path: "a.ts" } },
				{ type: "tool_use", id: "tool-blocked", name: "Bash", input: { command: "rm -rf x" } },
			],
			contentText: null,
			toolCalls: [
				{ id: "call-done", toolUseId: "tool-done", toolName: "Read", status: "success" },
				{ id: "call-blocked", toolUseId: "tool-blocked", toolName: "Bash", status: "pending" },
			],
			children: [],
			createdAt: "2026-07-19T00:00:00.000Z",
		} as NarratorMsg;

		const units = groupRenderUnits(segmentMessages([runMessage]), true);
		expect(units.map((u) => u.kind)).toEqual(["activity", "segment"]);
		const folded = units[0];
		if (folded.kind !== "activity") throw new Error("expected activity unit");
		expect(
			folded.items.flatMap((item) => (item.kind === "tool" ? [item.tc.toolUseId] : [])),
		).toEqual(["tool-done"]);
		const kept = units[1];
		if (kept.kind !== "segment" || kept.seg.kind !== "tool-run")
			throw new Error("expected tool-run segment");
		expect(kept.seg.items.map((i) => i.tc.toolUseId)).toEqual(["tool-blocked"]);
	});

	test("an empty / absent keep set changes nothing about the fold", () => {
		const segments = segmentMessages([
			toolMessage("message-1", "tool-1", "thought one"),
			toolMessage("message-2", "tool-2", "thought two"),
		]);
		const baseline = groupRenderUnits(segments, true);
		const withEmpty = groupRenderUnits(segments, true, { keepToolUseIds: new Set() });
		const withUnknown = groupRenderUnits(segments, true, {
			keepToolUseIds: new Set(["tool-missing"]),
		});
		expect(withEmpty.map((u) => u.kind)).toEqual(baseline.map((u) => u.kind));
		expect(withUnknown.map((u) => u.kind)).toEqual(baseline.map((u) => u.kind));
	});
});
