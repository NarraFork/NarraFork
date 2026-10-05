/**
 * reasoning-settles-mid-turn.test.ts — Reasoning must settle when the MODEL moves on,
 * not when the turn is persisted.
 *
 * ── The reported bug ──────────────────────────────────────────────────────────
 *
 * "reasoning 从流式归到固定的时机不对：后续 content 已经在输出，甚至后续工具调用都开始
 * 执行了，reasoning 还在流式中。"
 *
 * Cause: the live row is ONE synthetic message (`__streaming__`) that accumulates the
 * whole turn, and every renderer asked "is this the streaming message?" then applied
 * the answer to every block in it. A finished reasoning run therefore kept the live
 * treatment — force-expanded rather than collapsible, shimmering, LOD-fold exempt,
 * labelled with a scrolling live tail — until the turn persisted, which for a
 * tool-calling turn is many seconds and several tool executions later.
 *
 * This exercises the REAL adapter (the layer both message lists share), because the
 * unit test on `streaming-live-blocks` can only prove the predicate, not that the
 * three visual consequences actually follow from it.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import type { NarratorMsg } from "../narrator-panel-types";
import type { MeasuredReasoning } from "./measure/measure-reasoning";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextDocumentLayout } from "./pretext-document-layout";
import { type AdapterSegment, adaptSegment } from "./segment-adapter";
import { projectPendingEmptyReasoning } from "./streaming-handoff";

beforeAll(() => {
	installCanvasStub();
});

/** A reasoning body with a bold title, i.e. the structured (trace) shape. */
const REASONING = { type: "reasoning", text: "**分析步骤**\n\n先读取相关文件确认现状。" };
const TEXT = { type: "text", text: "我先定位这段逻辑。" };
const TOOL = { type: "tool_use", id: "tu-1", name: "Read" };

function liveSegment(
	blocks: Record<string, unknown>[],
	liveBlockIndex: number | undefined,
): AdapterSegment {
	return {
		kind: "message",
		msg: {
			id: "__streaming__",
			model: "gpt-5.6",
			role: "assistant",
			contentJson: blocks as never,
			...(liveBlockIndex != null ? { liveBlockIndex } : {}),
		},
	};
}

/** The reasoning spec of an adapted assistant message (steps trace or plain card). */
function reasoningSpec(seg: AdapterSegment, lod: 2 | 5) {
	const specs = adaptSegment(seg, { lod });
	return specs.find((spec) => spec.kind === "reasoning-steps" || spec.kind === "reasoning");
}

describe("live reasoning settles once the model produces later content", () => {
	it("keeps the run live while it is the only thing streaming", () => {
		const spec = reasoningSpec(liveSegment([REASONING], 0), 5);
		expect(spec?.kind).toBe("reasoning-steps");
		// The last step shimmers, marking it as the one still being written.
		const steps = (spec?.data as { steps: { shimmer?: boolean }[] }).steps;
		expect(steps.at(-1)?.shimmer).toBe(true);
	});

	it("stops shimmering as soon as answer text starts arriving", () => {
		const spec = reasoningSpec(liveSegment([REASONING, TEXT], 1), 5);
		const steps = (spec?.data as { steps: { shimmer?: boolean }[] }).steps;
		expect(steps.every((step) => !step.shimmer)).toBe(true);
	});

	it("stops shimmering as soon as a tool call starts, before the turn persists", () => {
		// The exact reported case: tools already executing, reasoning still "live".
		const spec = reasoningSpec(liveSegment([REASONING, TOOL], -1), 5);
		const steps = (spec?.data as { steps: { shimmer?: boolean }[] }).steps;
		expect(steps.every((step) => !step.shimmer)).toBe(true);
	});

	it("keeps the SAME step-trace shape live and settled (only the shimmer stops)", () => {
		// The trace no longer has a level-dependent mode (`titlesOnly` is gone), so the
		// live→settled transition must not change the element or its opts at all — that
		// identity is what keeps the rows from being rebuilt when a run finishes.
		const live = adaptSegment(liveSegment([REASONING], 0), { lod: 3 });
		const settled = adaptSegment(liveSegment([REASONING, TOOL], -1), { lod: 3 });
		const liveSpec = live.find((s) => s.kind === "reasoning-steps");
		const settledSpec = settled.find((s) => s.kind === "reasoning-steps");
		expect(liveSpec?.key).toBe(settledSpec?.key);
		expect(liveSpec?.opts).toEqual(settledSpec?.opts);
		expect(liveSpec?.opts).not.toHaveProperty("titlesOnly");
	});

	it("settles only the FINISHED run of an interleaved turn", () => {
		// reasoning → tool → reasoning, where the second run is still being written.
		// `buildStreamingMsg` appends the tool card AFTER both text lanes, so array
		// position alone would name the wrong run — the accumulator stamp decides.
		const seg: AdapterSegment = {
			kind: "message",
			msg: {
				id: "__streaming__",
				model: "gpt-5.6",
				role: "assistant",
				contentJson: [
					REASONING,
					{ type: "text", text: "先看第一处。" },
					{ type: "reasoning", text: "**第二轮**\n\n再确认另一处实现。" },
					TOOL,
				] as never,
				liveBlockIndex: 2,
			},
		};
		const specs = adaptSegment(seg, { lod: 5 });
		const runs = specs.filter((s) => s.kind === "reasoning-steps");
		expect(runs).toHaveLength(2);
		const shimmerOf = (spec: (typeof runs)[number] | undefined) =>
			(spec?.data as { steps: { shimmer?: boolean }[] }).steps.some((step) => step.shimmer);
		expect(shimmerOf(runs[0])).toBe(false);
		expect(shimmerOf(runs[1])).toBe(true);
	});

	it("keeps a persisted message settled regardless of its shape", () => {
		const seg: AdapterSegment = {
			kind: "message",
			msg: { id: "real-1", model: "gpt-5.6", role: "assistant", contentJson: [REASONING] as never },
		};
		const spec = reasoningSpec(seg, 5);
		const steps = (spec?.data as { steps: { shimmer?: boolean }[] }).steps;
		expect(steps.every((step) => !step.shimmer)).toBe(true);
	});
});

describe("the folded L1/L2 trace drops the live tail when a run settles", () => {
	/** Adapt ONE folded reasoning row and read its live-tail label, if any. */
	async function foldedRowTail(liveBlockIndex: number, blockIndex: number) {
		const { adaptRenderUnits } = await import("./segment-adapter");
		// A long body, so a live row would definitely carry a tail (short ones never do).
		const longReasoning = { type: "reasoning", text: `**分析步骤**\n\n${"长文本".repeat(120)}` };
		const msg = {
			id: "__streaming__",
			model: "gpt-5.6",
			role: "assistant",
			contentJson: [longReasoning, TOOL] as never,
			liveBlockIndex,
		};
		const specs = adaptRenderUnits(
			[
				{
					kind: "activity",
					key: "activity-0",
					items: [{ kind: "reasoning", msg, blockIndex, block: longReasoning }],
					sourceMessages: [msg],
				},
			],
			{ lod: 2 },
		);
		const trace = specs.find((s) => s.kind === "activity-trace");
		const items = (trace?.data as { items: { liveTail?: unknown }[] }).items;
		return items.map((item) => item.liveTail);
	}

	it("labels the row with a scrolling tail while it is being written", async () => {
		const tails = await foldedRowTail(0, 0);
		expect(tails.some((tail) => tail != null)).toBe(true);
	});

	it("drops the tail once a tool call proves the run finished", async () => {
		// A settled row's title is correct and final, so a scrolling tail there is
		// motion the reader cannot act on.
		const tails = await foldedRowTail(-1, 0);
		expect(tails.every((tail) => tail == null)).toBe(true);
	});
});

describe("the latest sealed empty reasoning stays live at every LOD", () => {
	for (const lod of [1, 2, 3, 4, 5] as const) {
		it(`shows exactly one waiting shimmer at L${lod} and stops when inactive`, () => {
			const messages = ["empty-r1", "empty-r2"].map(
				(id, seq) =>
					({
						id,
						seq,
						role: "assistant",
						parentToolUseId: null,
						contentJson: [{ type: "reasoning", id: `${id}-block`, text: "", revision: 1 }],
						toolCalls: [],
						children: [],
					}) as unknown as TreeMessage,
			);
			const layout = (active: boolean) =>
				buildPretextDocumentLayout(
					projectPendingEmptyReasoning(messages, active) as unknown as NarratorMsg[],
					{
						lod,
						contentWidth: 800,
						widthBucket: "800",
						layoutRevision: `empty-${lod}-${active}`,
						documentRevision: `empty-${lod}`,
					},
				);
			const shimmerCount = (active: boolean) =>
				layout(active).items.reduce((count, item) => {
					if (item.spec.kind === "reasoning") {
						return count + Number((item.measured as MeasuredReasoning).form === "streaming");
					}
					if (item.spec.kind === "activity-trace") {
						return (
							count +
							(item.spec.data as { items: { shimmer?: boolean }[] }).items.filter(
								(row) => row.shimmer,
							).length
						);
					}
					return count;
				}, 0);
			expect(shimmerCount(true)).toBe(1);
			expect(shimmerCount(false)).toBe(0);
		});
	}
});
