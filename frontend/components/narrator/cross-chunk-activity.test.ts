import { describe, expect, test } from "bun:test";
import type { ActivityInput } from "./ActivityTrace";
import {
	type ActivityRenderUnitOptions,
	buildCrossChunkActivityOverrides,
	buildCrossChunkActivityRenderPlan as buildRenderPlan,
	type ChunkActivityUnits,
	type CrossChunkActivityOverrides,
	computeChunkActivityUnits,
	type TailActivityOverlay,
} from "./cross-chunk-activity";
import type { ContentBlock, NarratorMsg, ToolCallRow } from "./narrator-panel-types";
import type { RenderUnit } from "./render-units";

function reasoningItem(id: string): ActivityInput {
	return {
		kind: "reasoning",
		msg: { id } as ActivityInput["msg"],
		blockIndex: 0,
		block: { type: "reasoning", text: id },
	};
}

function activity(...ids: string[]): Extract<RenderUnit, { kind: "activity" }> {
	return {
		kind: "activity",
		items: ids.map(reasoningItem),
		sourceMessages: ids.map((id) => ({ id }) as ActivityInput["msg"]),
		sourceSegments: [],
	};
}

function boundary(): RenderUnit {
	return { kind: "segment", seg: { kind: "prune-divider", label: "boundary" } };
}

function chunks(...entries: Array<RenderUnit[] | null>): ChunkActivityUnits[] {
	return entries.map((units, index) => ({ chunkId: `chunk-${index}`, units }));
}

function message(
	id: string,
	contentJson: ContentBlock[],
	toolCalls: ToolCallRow[] = [],
): NarratorMsg {
	return {
		id,
		narratorId: "narrator-1",
		parentToolUseId: null,
		role: "assistant",
		contentJson,
		contentText: null,
		toolCalls,
		children: [],
		createdAt: "2026-07-20T00:00:00.000Z",
	} as NarratorMsg;
}

function reasoningMessage(id: string, text = id): NarratorMsg {
	return message(id, [{ type: "reasoning", text }]);
}

function toolMessage(id: string, toolUseId: string, status: string): NarratorMsg {
	return message(
		id,
		[{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "a.ts" } }],
		[
			{
				id: `call-${toolUseId}`,
				toolUseId,
				toolName: "Read",
				status,
			} as ToolCallRow,
		],
	);
}

function streamingMessage(contentJson: ContentBlock[], toolCalls: ToolCallRow[] = []): NarratorMsg {
	return message("__streaming__", contentJson, toolCalls);
}

function itemIds(unit: Extract<RenderUnit, { kind: "activity" }>): string[] {
	return unit.items.map((item) =>
		item.kind === "reasoning" ? (item.msg.id ?? "") : (item.tc.toolUseId ?? ""),
	);
}

function allToolIds(units: readonly RenderUnit[]): string[] {
	const ids: string[] = [];
	for (const unit of units) {
		if (unit.kind === "activity") {
			for (const item of unit.items) {
				if (item.kind === "tool" && item.tc.toolUseId) ids.push(item.tc.toolUseId);
			}
		} else if (unit.seg.kind === "tool-run") {
			ids.push(...unit.seg.items.flatMap((item) => (item.tc.toolUseId ? [item.tc.toolUseId] : [])));
		}
	}
	return ids;
}

const L2_OPTIONS = { renderLod: 2 } as const;

function activityPlan(
	base: readonly ChunkActivityUnits[],
	tailOverlay: TailActivityOverlay | null,
	options: ActivityRenderUnitOptions,
	baseOverrides: CrossChunkActivityOverrides = buildCrossChunkActivityOverrides(base),
) {
	return buildRenderPlan(base, baseOverrides, tailOverlay, options);
}

describe("buildCrossChunkActivityOverrides", () => {
	test("merges touching tail/head activities into the earlier owner", () => {
		const overrides = buildCrossChunkActivityOverrides(
			chunks([boundary(), activity("a")], [activity("b"), boundary()]),
		);

		expect(
			overrides
				.get("chunk-0")
				?.get(0)
				?.appendItems?.map((item) => item.msg.id),
		).toEqual(["b"]);
		expect(overrides.get("chunk-1")?.get(0)).toEqual({ hidden: true });
	});

	test("merges transitively through a chunk containing only activity", () => {
		const overrides = buildCrossChunkActivityOverrides(
			chunks([activity("a")], [activity("b")], [activity("c")]),
		);

		expect(
			overrides
				.get("chunk-0")
				?.get(0)
				?.appendItems?.map((item) => item.msg.id),
		).toEqual(["b", "c"]);
		expect(overrides.get("chunk-1")?.get(0)).toEqual({ hidden: true });
		expect(overrides.get("chunk-2")?.get(0)).toEqual({ hidden: true });
	});

	test("does not merge across a visible-content boundary", () => {
		const overrides = buildCrossChunkActivityOverrides(
			chunks([activity("a"), boundary()], [activity("b")]),
		);

		expect(overrides.size).toBe(0);
	});

	test("does not merge across an unloaded chunk", () => {
		const overrides = buildCrossChunkActivityOverrides(
			chunks([activity("a")], null, [activity("c")]),
		);

		expect(overrides.size).toBe(0);
	});

	test("keeps head and tail chains separate when content divides the middle chunk", () => {
		const overrides = buildCrossChunkActivityOverrides(
			chunks(
				[activity("left")],
				[activity("middle-head"), boundary(), activity("middle-tail")],
				[activity("right")],
			),
		);

		expect(
			overrides
				.get("chunk-0")
				?.get(0)
				?.appendItems?.map((item) => item.msg.id),
		).toEqual(["middle-head"]);
		expect(overrides.get("chunk-1")?.get(0)).toEqual({ hidden: true });
		expect(
			overrides
				.get("chunk-1")
				?.get(1)
				?.appendItems?.map((item) => item.msg.id),
		).toEqual(["right"]);
		expect(overrides.get("chunk-2")?.get(0)).toEqual({ hidden: true });
	});
});

describe("buildCrossChunkActivityRenderPlan", () => {
	test("reuses base references when there is no streaming overlay", () => {
		const base = chunks([activity("a")], [activity("b")]);
		const baseOverrides = buildCrossChunkActivityOverrides(base);

		const plan = activityPlan(base, null, L2_OPTIONS, baseOverrides);

		expect(plan.chunkUnits).toBe(base);
		expect(plan.overrides).toBe(baseOverrides);
		expect(plan.overrides.get("chunk-0")).toBe(baseOverrides.get("chunk-0"));
		expect(plan.overrides.get("chunk-0")?.get(0)).toBe(baseOverrides.get("chunk-0")?.get(0));
	});

	test("reuses base references when the streaming tail is not mounted", () => {
		const base = chunks([activity("a")], [activity("b")]);
		const baseOverrides = buildCrossChunkActivityOverrides(base);
		const plan = activityPlan(
			base,
			{
				chunkId: "unmounted-tail",
				messages: [reasoningMessage("tail")],
				streamingMsg: streamingMessage([{ type: "reasoning", text: "live" }]),
			},
			L2_OPTIONS,
			baseOverrides,
		);

		expect(plan.chunkUnits).toBe(base);
		expect(plan.overrides).toBe(baseOverrides);
		expect(plan.overrides.get("chunk-0")).toBe(baseOverrides.get("chunk-0"));
	});

	test("patches the tail chain without rebuilding unrelated historical overrides", () => {
		const tailMessages = [
			reasoningMessage("tail-reasoning"),
			toolMessage("tail-tool-message", "persisted-tool", "success"),
		];
		const base = [
			...chunks([activity("history-owner")], [activity("history-child"), boundary()]),
			computeChunkActivityUnits("near-tail", [reasoningMessage("near-tail")], L2_OPTIONS),
			computeChunkActivityUnits("tail", tailMessages, L2_OPTIONS),
		];
		const baseOverrides = buildCrossChunkActivityOverrides(base);
		const historicalOwnerMap = baseOverrides.get("chunk-0");
		const historicalOwnerOverride = historicalOwnerMap?.get(0);
		const historicalChildMap = baseOverrides.get("chunk-1");
		const nearTailMap = baseOverrides.get("near-tail");
		const liveToolCall = {
			id: "call-live-tool",
			toolUseId: "live-tool",
			toolName: "Read",
			status: "running",
		} as ToolCallRow;

		const plan = activityPlan(
			base,
			{
				chunkId: "tail",
				messages: tailMessages,
				streamingMsg: streamingMessage(
					[{ type: "tool_use", id: "live-tool", name: "Read", input: {} }],
					[liveToolCall],
				),
			},
			L2_OPTIONS,
			baseOverrides,
		);

		expect(plan.chunkUnits[0]).toBe(base[0]);
		expect(plan.chunkUnits[1]).toBe(base[1]);
		expect(plan.chunkUnits[2]).toBe(base[2]);
		expect(plan.chunkUnits[3]).not.toBe(base[3]);
		expect(plan.overrides).not.toBe(baseOverrides);
		expect(plan.overrides.get("chunk-0")).toBe(historicalOwnerMap);
		expect(plan.overrides.get("chunk-0")?.get(0)).toBe(historicalOwnerOverride);
		expect(plan.overrides.get("chunk-1")).toBe(historicalChildMap);
		expect(plan.overrides.get("near-tail")).not.toBe(nearTailMap);
		// The chain now runs THROUGH the live content: a running tool folds like any
		// other (see render-units.ts), so it joins the same continuous run instead of
		// breaking it into a separate trailing card.
		expect(
			plan.overrides
				.get("near-tail")
				?.get(0)
				?.appendItems?.map((item) => (item.kind === "reasoning" ? item.msg.id : item.tc.toolUseId)),
		).toEqual(["tail-reasoning", "persisted-tool", "live-tool"]);
	});

	test("preserves the historical remainder when the overlay breaks the old tail chain", () => {
		const tailMessages = [toolMessage("tail-tool", "persisted-tool", "success")];
		const base = [
			computeChunkActivityUnits("owner", [reasoningMessage("owner")], L2_OPTIONS),
			computeChunkActivityUnits("middle", [reasoningMessage("middle")], L2_OPTIONS),
			computeChunkActivityUnits("tail", tailMessages, L2_OPTIONS),
		];
		const baseOverrides = buildCrossChunkActivityOverrides(base);
		const liveToolCall = {
			id: "call-live-tool",
			toolUseId: "live-tool",
			toolName: "Read",
			status: "running",
		} as ToolCallRow;

		const plan = activityPlan(
			base,
			{
				chunkId: "tail",
				messages: tailMessages,
				streamingMsg: streamingMessage(
					[{ type: "tool_use", id: "live-tool", name: "Read", input: {} }],
					[liveToolCall],
				),
			},
			L2_OPTIONS,
			baseOverrides,
		);

		// The live tool folds into the tail's activity unit, so the tail now PARTICIPATES
		// in the cross-chunk chain (it used to be cut out of it by the un-foldable live
		// card): the owner absorbs the whole remainder and the tail is hidden.
		expect(
			plan.overrides
				.get("owner")
				?.get(0)
				?.appendItems?.map((item) => (item.kind === "reasoning" ? item.msg.id : item.tc.toolUseId)),
		).toEqual(["middle", "persisted-tool", "live-tool"]);
		expect(plan.overrides.get("middle")?.get(0)).toEqual({ hidden: true });
		expect(plan.overrides.get("tail")?.get(0)).toEqual({ hidden: true });
	});

	test("uses the streaming tail for appearance, growth, and clearing", () => {
		const headMessages = [reasoningMessage("head")];
		const tailMessages = [reasoningMessage("tail")];
		const base = [
			computeChunkActivityUnits("head-chunk", headMessages, L2_OPTIONS),
			computeChunkActivityUnits("tail-chunk", tailMessages, L2_OPTIONS),
		];

		const firstStreaming = streamingMessage([{ type: "reasoning", text: "one" }]);
		const appeared = activityPlan(
			base,
			{
				chunkId: "tail-chunk",
				messages: tailMessages,
				streamingMsg: firstStreaming,
			},
			L2_OPTIONS,
		);
		// Live reasoning is a ROW of the same activity unit now, not a separate trailing
		// segment. That is the whole point: the row it occupies while streaming is the
		// row it keeps once persisted, so the hand-off moves nothing.
		const appearedTail = appeared.chunkUnits[1]?.units ?? [];
		expect(appearedTail.map((unit) => unit.kind)).toEqual(["activity"]);
		expect(appeared.overrides.get("tail-chunk")?.get(0)).toEqual({ hidden: true });
		const appearedActivity = appearedTail[0];
		if (appearedActivity?.kind !== "activity") throw new Error("expected an activity unit");
		expect(itemIds(appearedActivity)).toEqual(["tail", "__streaming__"]);

		const grownStreaming = streamingMessage([{ type: "reasoning", text: "one two three" }]);
		const grown = activityPlan(
			base,
			{
				chunkId: "tail-chunk",
				messages: tailMessages,
				streamingMsg: grownStreaming,
			},
			L2_OPTIONS,
		);
		const grownTail = grown.chunkUnits[1]?.units ?? [];
		const grownActivity = grownTail[0];
		if (grownActivity?.kind !== "activity") throw new Error("expected an activity unit");
		// Growth updates the live row's text in place; the unit shape is unchanged.
		expect(grownActivity.items.at(-1)).toMatchObject({
			kind: "reasoning",
			msg: { id: "__streaming__", contentJson: [{ text: "one two three" }] },
		});
		expect(
			grown.overrides
				.get("head-chunk")
				?.get(0)
				?.appendItems?.map((item) => item.msg.id),
		).toEqual(["tail", "__streaming__"]);

		const cleared = activityPlan(
			base,
			{ chunkId: "tail-chunk", messages: tailMessages, streamingMsg: null },
			L2_OPTIONS,
		);
		expect(cleared.chunkUnits).toBe(base);
		expect(cleared.chunkUnits[1]?.units?.map((unit) => unit.kind)).toEqual(["activity"]);
	});

	test("keeps activity ordinals aligned when a live tool changes tail grouping", () => {
		const headMessages = [reasoningMessage("head")];
		const tailMessages = [
			reasoningMessage("tail-reasoning"),
			toolMessage("tail-tool-message", "persisted-tool", "success"),
		];
		const base = [
			computeChunkActivityUnits("head-chunk", headMessages, L2_OPTIONS),
			computeChunkActivityUnits("tail-chunk", tailMessages, L2_OPTIONS),
		];
		const liveToolCall = {
			id: "call-live-tool",
			toolUseId: "live-tool",
			toolName: "Read",
			status: "running",
		} as ToolCallRow;
		const streaming = streamingMessage(
			[{ type: "tool_use", id: "live-tool", name: "Read", input: { file_path: "b.ts" } }],
			[liveToolCall],
		);

		const plan = activityPlan(
			base,
			{ chunkId: "tail-chunk", messages: tailMessages, streamingMsg: streaming },
			L2_OPTIONS,
		);
		// A live tool no longer splits the tail: reasoning, the persisted tool and the
		// running tool are one continuous run, in the order the model produced them.
		const tailUnits = plan.chunkUnits[1]?.units ?? [];
		expect(tailUnits.map((unit) => unit.kind)).toEqual(["activity"]);
		const tailActivity = tailUnits[0];
		if (tailActivity?.kind !== "activity") throw new Error("expected tail activity");
		expect(itemIds(tailActivity)).toEqual(["tail-reasoning", "persisted-tool", "live-tool"]);
		expect(plan.overrides.get("tail-chunk")?.get(0)).toEqual({ hidden: true });
		// Ordinals stay aligned: the head chunk owns the merged run and lists every
		// member exactly once, still in source order.
		expect(
			plan.overrides
				.get("head-chunk")
				?.get(0)
				?.appendItems?.map((item) => (item.kind === "reasoning" ? item.msg.id : item.tc.toolUseId)),
		).toEqual(["tail-reasoning", "persisted-tool", "live-tool"]);
		expect(allToolIds(tailUnits)).toEqual(["persisted-tool", "live-tool"]);
	});

	test("does not cross unloaded or prune boundaries", () => {
		const unloadedBase = [
			computeChunkActivityUnits("chunk-0", [reasoningMessage("a")], L2_OPTIONS),
			computeChunkActivityUnits("chunk-1", null, L2_OPTIONS),
			computeChunkActivityUnits("chunk-2", [reasoningMessage("c")], L2_OPTIONS),
		];
		expect(activityPlan(unloadedBase, null, L2_OPTIONS).overrides.size).toBe(0);

		const pruneOptions = {
			...L2_OPTIONS,
			pruneBoundaryMessageId: "a",
			pruneDividerLabel: "pruned",
		};
		const pruneBase = [
			computeChunkActivityUnits("chunk-0", [reasoningMessage("a")], pruneOptions),
			computeChunkActivityUnits("chunk-1", [reasoningMessage("b")], pruneOptions),
		];
		expect(activityPlan(pruneBase, null, pruneOptions).overrides.size).toBe(0);
		expect(pruneBase[0]?.units?.map((unit) => unit.kind)).toEqual(["activity", "segment"]);
	});

	test("handles an empty session and a streaming-only render input", () => {
		const empty = activityPlan([], null, L2_OPTIONS);
		expect(empty.chunkUnits).toEqual([]);
		expect(empty.overrides.size).toBe(0);

		const streamingOnly = computeChunkActivityUnits(
			"__streaming_only__",
			[],
			L2_OPTIONS,
			streamingMessage([{ type: "reasoning", text: "starting" }]),
		);
		expect(streamingOnly.units).toHaveLength(1);
		// Even with no persisted history, live reasoning opens the activity unit it will
		// stay in — so the first row the reader sees is already its final form.
		const onlyUnit = streamingOnly.units?.[0];
		expect(onlyUnit?.kind).toBe("activity");
		if (onlyUnit?.kind !== "activity") return;
		expect(itemIds(onlyUnit)).toEqual(["__streaming__"]);
	});

	test("disables cross-chunk overrides outside L1/L2", () => {
		const options = { renderLod: 3 } as const;
		const base = [
			computeChunkActivityUnits("chunk-0", [reasoningMessage("a")], options),
			computeChunkActivityUnits("chunk-1", [reasoningMessage("b")], options),
		];
		const plan = activityPlan(base, null, options);
		expect(plan.overrides.size).toBe(0);
		expect(base[0]?.units?.[0]?.kind).toBe("segment");
	});
});
