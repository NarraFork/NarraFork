/**
 * vlist-trace-row-drilldown-stability.test.ts — A folded trace row the reader
 * drilled into must STAY the row they opened while the turn streams.
 *
 * The reported symptom
 * --------------------
 * At a low LOD, during live output, manually expanding an activity row produced a
 * wrong height and rows painted over each other. The cause was not the height
 * arithmetic (that is self-consistent at every fold state — asserted below) but WHICH
 * ROW the expansion was addressed to.
 *
 * The activity fold expands one live reasoning block into one row PER STEP. So the
 * moment the model writes another `**title**`, every row after it shifts down by one
 * index. While the reader's intent was stored as a row INDEX, that shift silently
 * re-pointed it: the tool card they opened folded shut and a neighbouring row opened
 * instead. Two consequences, both visible:
 *
 *   1. The card the reader asked for disappears mid-read.
 *   2. A committed row changes height with no user action behind it, which is exactly
 *      the invariant CONTRACT §0 rule 2 protects.
 *
 * The fix addresses the drill-down by ROW KEY (`isRowExpanded`), which is stable
 * across precisely these frames: `tool-<toolUseId>` is identical live and persisted,
 * and a reasoning row keys on its run ordinal within the unit. The row INDEX is still
 * what reaches the measure layer, but it is now DERIVED from the emitted rows in the
 * same pass, so the two sides cannot disagree.
 *
 * Driven through `buildPretextDocumentLayout` (the shell's real entry point) rather
 * than the adapter directly: that is what mints an activity unit's `spec.key` and
 * engages the measurement cache, and shortcutting it has silently disarmed vlist
 * guards before (see the note in low-lod-streaming-cost.test.ts).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

/** A persisted, finished tool call — a plain folded row. */
function tool(seq: number, id: string) {
	const input = { command: `echo ${id}` };
	return {
		id: `m${seq}`,
		seq,
		role: "assistant",
		contentJson: [{ type: "tool_use", id, name: "Bash", input }],
		toolCalls: [
			{
				id: `c-${id}`,
				toolUseId: id,
				toolName: "Bash",
				status: "success",
				inputJson: input,
				outputJson: { stdout: `out ${id}\nsecond\nthird` },
				durationMs: 900,
			},
		],
		children: [],
	};
}

/** The LIVE row: a reasoning block whose steps arrive one at a time. */
function live(text: string) {
	return {
		id: "__streaming__",
		model: "gpt-5.6",
		seq: 999,
		role: "assistant",
		contentJson: [{ type: "reasoning", text }],
		toolCalls: [],
		children: [],
	};
}

const STEPS = ["**甲**\n\n正文。", "**乙**\n\n正文。", "**丙**\n\n正文。", "**丁**\n\n正文。"];
const reasoningAt = (steps: number) => STEPS.slice(0, steps).join("\n\n");

type PaintedRow = {
	itemIndex: number;
	key: string;
	top: number;
	blockHeight: number;
	expanded: boolean;
	cardMeasured: { height: number } | null;
};
type PaintedTrace = {
	height: number;
	rows: PaintedRow[];
	header: { top: number; height: number };
	toggle: { top: number; height: number } | null;
};

/**
 * The document at one streaming frame, with `openKeys` drilled in.
 *
 * The live reasoning is placed FIRST so growing it shifts every tool row below —
 * which is the shape that made an index-addressed expansion drift.
 */
async function frame(steps: number, openKeys: readonly string[], lod: 1 | 2 | 3 = 2) {
	const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
	const { getCategory, getCategoryColor } = await import("../tool-call/tool-display");
	const { recentRunSegmentMessageIds } = await import("../trace/run-segments");
	const messages = [
		live(reasoningAt(steps)),
		...Array.from({ length: 5 }, (_, i) => tool(i, `tu-${i}`)),
	];
	return buildPretextDocumentLayout(messages as never[], {
		layoutRevision: "r1",
		documentRevision: "v1",
		lod,
		widthBucket: 800,
		contentWidth: 800,
		viewportHeight: 900,
		isRowExpanded: (_traceKey: string, rowKey: string) => openKeys.includes(rowKey),
		resolveToolCategory: getCategory,
		resolveToolColor: (name: string, input: unknown) => getCategoryColor(getCategory(name, input)),
		resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
	});
}

/** Every trace in the document, paired with its manifest height. */
function traces(built: Awaited<ReturnType<typeof frame>>) {
	const out: { key: string; trace: PaintedTrace; manifestHeight: number | undefined }[] = [];
	for (const item of built.items) {
		const trace = item.measured as unknown as PaintedTrace;
		if (!Array.isArray(trace.rows)) continue;
		out.push({
			key: item.spec.key,
			trace,
			manifestHeight: built.index.manifest.items.find((m) => m.itemKey === item.spec.key)?.height,
		});
	}
	return out;
}

/** Rows (plus the header/toggle chrome) that visually collide, as readable strings. */
function overlapsOf(trace: PaintedTrace): string[] {
	const parts = [
		{ key: "header", top: trace.header.top, blockHeight: trace.header.height },
		...(trace.toggle
			? [{ key: "toggle", top: trace.toggle.top, blockHeight: trace.toggle.height }]
			: []),
		...trace.rows,
	].sort((a, b) => a.top - b.top);
	const collisions: string[] = [];
	for (let i = 1; i < parts.length; i++) {
		const prev = parts[i - 1]!;
		const cur = parts[i]!;
		if (cur.top < prev.top + prev.blockHeight - 1e-6) {
			collisions.push(`${prev.key}@${prev.top}+${prev.blockHeight} vs ${cur.key}@${cur.top}`);
		}
	}
	return collisions;
}

describe("a drilled-in trace row survives a growing live reasoning run", () => {
	it("keeps the SAME tool open as steps arrive (its index moves, its key does not)", async () => {
		const opened: Record<number, { keys: string[]; indices: number[] }> = {};
		for (let steps = 1; steps <= STEPS.length; steps++) {
			const built = await frame(steps, ["tool-tu-0"]);
			const trace = traces(built)[0]!.trace;
			const open = trace.rows.filter((row) => row.expanded);
			opened[steps] = {
				keys: open.map((row) => row.key),
				indices: open.map((row) => row.itemIndex),
			};
		}
		// The reader's row stays open at every frame — the actual reported bug.
		for (let steps = 1; steps <= STEPS.length; steps++) {
			expect(opened[steps]?.keys).toEqual(["tool-tu-0"]);
		}
		// And it really did move: the run emitted one more row above it each time, so
		// an index recorded at the first frame would be addressing a different row by
		// the last. That is the proof this test is not vacuous.
		expect(opened[1]?.indices).not.toEqual(opened[STEPS.length]?.indices);
	});

	it("opens exactly ONE card, and it is the requested tool's", async () => {
		const built = await frame(3, ["tool-tu-2"]);
		const trace = traces(built)[0]!.trace;
		const withCard = trace.rows.filter((row) => row.cardMeasured != null);
		expect(withCard.map((row) => row.key)).toEqual(["tool-tu-2"]);
		// A revealed card is real height, not a zero-height stub.
		expect(withCard[0]?.cardMeasured?.height).toBeGreaterThan(0);
	});

	it("leaves every row folded when nothing was drilled into", async () => {
		const trace = traces(await frame(2, []))[0]!.trace;
		expect(trace.rows.some((row) => row.expanded)).toBe(false);
		expect(trace.rows.some((row) => row.cardMeasured != null)).toBe(false);
	});

	/**
	 * The geometry half of the report ("高度不对，导致重叠").
	 *
	 * Even with the addressing fixed, the reserved height and the painted offsets have
	 * to agree at every frame — the manifest is what the canvas positions rows from,
	 * and the rows are absolutely positioned inside it, so a disagreement either clips
	 * the revealed card or lets the next row paint over it.
	 */
	it("keeps manifest height, row stacking and containment consistent at every frame", async () => {
		const failures: string[] = [];
		let checked = 0;
		for (const lod of [1, 2, 3] as const) {
			for (const open of [[], ["tool-tu-0"], ["tool-tu-4"], ["tool-tu-0", "tool-tu-4"]]) {
				for (let steps = 1; steps <= STEPS.length; steps++) {
					for (const { key, trace, manifestHeight } of traces(await frame(steps, open, lod))) {
						checked++;
						const at = `L${lod} steps=${steps} open=[${open}] ${key}`;
						// The canvas reserves the manifest height; the trace paints `trace.height`.
						if (manifestHeight !== trace.height) {
							failures.push(`${at}: manifest ${manifestHeight} vs painted ${trace.height}`);
						}
						for (const overlap of overlapsOf(trace)) failures.push(`${at}: overlap ${overlap}`);
						// Nothing may extend past the reserved box (a clipped card).
						const last = [...trace.rows].sort((a, b) => a.top - b.top).at(-1);
						if (last && last.top + last.blockHeight > trace.height + 1e-6) {
							failures.push(
								`${at}: overflow ${last.top + last.blockHeight} > height ${trace.height}`,
							);
						}
					}
				}
			}
		}
		expect(failures).toEqual([]);
		// Guard the guard: an empty sweep would pass silently.
		expect(checked).toBeGreaterThan(20);
	});

	/**
	 * The measurement cache keys on content, and a live trace is re-adapted every
	 * delta. If the drill-down state did not reach the cache key, a warm build would
	 * serve the height captured at another fold state — the "wrong height" symptom
	 * arriving through a second route entirely.
	 */
	it("serves the same height warm as cold (drill-down state reaches the cache key)", async () => {
		const { measureCache } = await import("./measure-cache");
		const failures: string[] = [];
		for (let steps = 1; steps <= STEPS.length; steps++) {
			const warm = traces(await frame(steps, ["tool-tu-1"]))[0]!.trace;
			measureCache.clear();
			const cold = traces(await frame(steps, ["tool-tu-1"]))[0]!.trace;
			if (warm.height !== cold.height) {
				failures.push(`steps=${steps}: warm ${warm.height} vs cold ${cold.height}`);
			}
			if (
				JSON.stringify(warm.rows.filter((r) => r.expanded).map((r) => r.key)) !==
				JSON.stringify(cold.rows.filter((r) => r.expanded).map((r) => r.key))
			) {
				failures.push(`steps=${steps}: warm/cold opened rows differ`);
			}
		}
		expect(failures).toEqual([]);
	});
});
