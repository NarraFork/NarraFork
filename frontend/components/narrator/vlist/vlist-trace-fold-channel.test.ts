/**
 * vlist-trace-fold-channel.test.ts — every trace's row fold must be WRITTEN to the
 * channel its adapter path READS.
 *
 * There are two channels, and the split is deliberate (see
 * `VListInteractionState.expandedTraceRows`): `activity-trace` / `tool-run-summary`
 * fold a live row list and are addressed by ROW KEY, while `reasoning-steps` is
 * append-only and stays on the row INDEX.
 *
 * The regression this pins: the render layer reports BOTH the index and the key for
 * every trace row, so a shell that stores a key unconditionally sends the
 * append-only kinds' folds into `expandedTraceRows` — which their adapter code never
 * consults. The row then paints its chevron, records the click, and does nothing.
 * Nothing else catches that: `toggleVListTraceRow` is correct in isolation and the
 * adapter is correct in isolation; only the pairing is wrong.
 *
 * So this asserts the pairing from both sides:
 *   1. `traceRowFoldChannel` classifies each kind.
 *   2. Each kind's adapter output actually responds to the channel it was assigned.
 */

import { describe, expect, it } from "bun:test";
import { traceRowFoldChannel } from "./vlist-interaction-state";

/** The kinds bound to the trace row toggle in PretextExactMessageList. */
const TRACE_KINDS = ["activity-trace", "tool-run-summary", "reasoning-steps"] as const;

describe("traceRowFoldChannel", () => {
	it("puts the two live-row-list traces on the KEY channel", () => {
		// Only these can gain a row ABOVE an existing one mid-stream (a live reasoning
		// run emits one row per step), which is what invalidates a stored index.
		expect(traceRowFoldChannel("activity-trace")).toBe("key");
		expect(traceRowFoldChannel("tool-run-summary")).toBe("key");
	});

	it("keeps the append-only trace on the INDEX channel", () => {
		// A reasoning-steps element numbers step N as row N however many steps follow,
		// so its ordinals are already stable.
		expect(traceRowFoldChannel("reasoning-steps")).toBe("index");
	});

	it("defaults an unknown kind to the INDEX channel", () => {
		// The index channel is the conservative default: it is what every non-trace
		// row list (the subagent-recovery checkboxes) already uses.
		expect(traceRowFoldChannel("subagent-recovery")).toBe("index");
	});
});

/** A reasoning message whose text parses into two step rows. */
const reasoningMessage = {
	id: "m1",
	seq: 1,
	role: "assistant",
	contentJson: [{ type: "reasoning", text: "**A**\n\nfirst body\n\n**B**\n\nsecond body" }],
	toolCalls: [],
	children: [],
};

/** A finished tool call, the row an `activity-trace` folds. */
const toolItem = {
	kind: "tool" as const,
	msg: { id: "m3", seq: 3, role: "assistant", contentJson: [], toolCalls: [], children: [] },
	blockIndex: 0,
	tc: {
		toolUseId: "tu-1",
		toolName: "Read",
		status: "success",
		inputJson: { file_path: "/a.ts" },
		outputJson: { content: "x" },
	},
};

/** `expandedIndices` the adapter reported for one spec kind, under one channel. */
async function indicesFor(
	kind: (typeof TRACE_KINDS)[number],
	channel: "key" | "index",
): Promise<number[]> {
	const { adaptSegment, adaptActivityUnit } = await import(
		"@shared/pretext-layout/segment-adapter"
	);
	// Open EVERY row on the channel under test, so a non-empty result means the
	// adapter consulted it and an empty one means it did not.
	const ctx = {
		lod: 2,
		...(channel === "key" ? { isRowExpanded: () => true } : { expandedRows: () => [0, 1] }),
	};
	const specs =
		kind === "activity-trace"
			? [adaptActivityUnit([toolItem] as never, "act-1", ctx as never)]
			: kind === "tool-run-summary"
				? adaptSegment(
						{ kind: "tool-run", items: [toolItem] } as never,
						{
							...ctx,
							lod: 3,
						} as never,
					)
				: adaptSegment(
						{
							kind: "message",
							msg: reasoningMessage as never,
							visibleBlockIndices: [0],
						} as never,
						ctx as never,
					);
	const spec = specs.find((s) => s?.kind === kind);
	expect(spec).toBeDefined();
	return [...(((spec?.opts as { expandedIndices?: number[] })?.expandedIndices ?? []) as number[])];
}

describe("each trace kind responds to the channel it is assigned", () => {
	it("opens rows on its OWN channel", async () => {
		const failures: string[] = [];
		for (const kind of TRACE_KINDS) {
			const opened = await indicesFor(kind, traceRowFoldChannel(kind));
			if (opened.length === 0) {
				failures.push(`${kind}: its own channel (${traceRowFoldChannel(kind)}) opened no row`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("ignores the OTHER channel — which is why the shell must route by kind", async () => {
		const failures: string[] = [];
		for (const kind of TRACE_KINDS) {
			const other = traceRowFoldChannel(kind) === "key" ? "index" : "key";
			const opened = await indicesFor(kind, other);
			if (opened.length > 0) {
				failures.push(`${kind}: the ${other} channel unexpectedly opened ${opened}`);
			}
		}
		// Both directions matter: it proves a mis-routed fold is silently DROPPED
		// rather than merely stored twice, i.e. the row stops opening at all.
		expect(failures).toEqual([]);
	});
});

describe("the shell routes the row toggle by kind", () => {
	it("passes a rowKey only for the KEY-addressed kinds", async () => {
		// Source-pinned: the routing lives in a render-time binding that would need a
		// full mount to exercise, and the failure mode is a silent no-op, so the guard
		// is that the dispatcher is derived from `traceRowFoldChannel` rather than
		// handing every trace the key-passing handler.
		const src = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		const block = src.slice(src.indexOf("if (TRACE_KINDS.has(kind)) {"));
		expect(block).toContain('traceRowFoldChannel(kind) === "key"');
		// The index-addressed branch must DROP the key, not forward it.
		expect(block).toContain("(rowIndex: number) => toggles.onToggleRow(rowIndex)");
		// The drilled-in card's own close chevron goes through the same dispatcher, so
		// opening and closing cannot land in different channels.
		expect(block).toContain("toggleRow(row.itemIndex, row.key)");
	});
});
