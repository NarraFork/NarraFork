/**
 * fold-row-key-uniqueness.test.ts — Folded trace rows must have UNIQUE keys.
 *
 * The bug this pins down (reported as visibly overlapping rows)
 * ------------------------------------------------------------
 * Trace rows are absolutely positioned at their measured offsets, so two rows sharing
 * a React key do not merely confuse reconciliation — they paint ON TOP OF EACH OTHER,
 * producing the smeared double-rendered text a reader actually sees.
 *
 * Two ways a duplicate arises, and they need OPPOSITE fixes:
 *
 *  1. HAND-OFF PAIR. For a window, the persisted message has landed while the
 *     synthetic live row for the same tool-use id has not yet been retired by
 *     `dropPersistedStreamingTools`. Before live content folded into the trace these
 *     were separate specs and `buildPretextLayoutManifest` disambiguated them
 *     (`#dup1`); inside one trace there is no such guard. Correct fix: COLLAPSE to one
 *     row, keeping the persisted copy (it holds the settled status, the real message id
 *     that selection needs, and the final output).
 *
 *  2. PROVIDER RETRY. The same tool-use id legitimately appears in two DIFFERENT
 *     persisted messages. Those are two real calls; collapsing them would hide
 *     history. Correct fix: keep BOTH rows and give the later one a suffix.
 *
 * Conflating the two is easy and was in fact the first thing this fix got wrong (it
 * collapsed retries too, silently dropping a row), which is why both are asserted.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

const STREAMING_ID = "__streaming__";

/** One assistant message carrying a single Bash tool call. */
function toolMessage(messageId: string, toolUseId: string, status: string, streaming = false) {
	const input = streaming
		? { command: "rg foo", _streamingChars: 12 }
		: ({ command: "rg foo" } as Record<string, unknown>);
	return {
		id: messageId,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: "Bash", input }],
		toolCalls: [
			{ id: `c-${toolUseId}-${messageId}`, toolUseId, toolName: "Bash", status, inputJson: input },
		],
		children: [],
	};
}

/** One assistant message carrying a single reasoning block. */
function reasoningMessage(messageId: string, text: string) {
	return {
		id: messageId,
		model: "gpt-5.6",
		role: "assistant",
		contentJson: [{ type: "reasoning", text }],
		toolCalls: [],
		children: [],
	};
}

/** Every folded row emitted by the low-LOD pipeline, in order. */
async function foldedRows(messages: unknown[]) {
	const { segmentMessages } = await import("../message/message-segments");
	const { groupRenderUnits } = await import("../trace/render-units");
	const { adaptRenderUnits } = await import("./segment-adapter");
	const units = groupRenderUnits(segmentMessages(messages as never), true);
	const specs = adaptRenderUnits(units as never, { lod: 2 });
	const rows: { key: string; status: unknown; unitId: unknown }[] = [];
	for (const spec of specs) {
		const items = (spec.data as { items?: Record<string, unknown>[] }).items ?? [];
		for (const item of items) {
			rows.push({ key: String(item.key), status: item.status, unitId: item.unitId });
		}
	}
	return rows;
}

const duplicatesOf = (keys: string[]) => [
	...new Set(keys.filter((key, index) => keys.indexOf(key) !== index)),
];

/**
 * Painted rows that visually collide, as `prev@top+height vs next@top` strings.
 *
 * Rows are absolutely positioned and laid out top-to-bottom, so each row must start at
 * or after the previous row's end. Shared by the production sweep and its self-check so
 * the assertion and its proof-of-redness exercise the SAME comparison.
 */
const overlapsOf = (rows: Array<{ key: string; top: number; blockHeight: number }>) => {
	const ordered = [...rows].sort((a, b) => a.top - b.top);
	const collisions: string[] = [];
	for (let index = 1; index < ordered.length; index++) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (current.top < previous.top + previous.blockHeight) {
			collisions.push(
				`${previous.key}@${previous.top}+${previous.blockHeight} vs ${current.key}@${current.top}`,
			);
		}
	}
	return collisions;
};

describe("hand-off pair collapses to ONE row", () => {
	it("emits a single row when persisted and synthetic copies coexist", async () => {
		const rows = await foldedRows([
			toolMessage("real-msg", "tu-1", "success"),
			toolMessage(STREAMING_ID, "tu-1", "running", true),
		]);
		expect(rows.map((row) => row.key)).toEqual(["tool-tu-1"]);
		// The PERSISTED copy must win: keeping the synthetic one would show a finished
		// call as still running.
		expect(rows[0]?.status).toBe("success");
	});

	it("wins for the persisted copy regardless of absorption order", async () => {
		// The synthetic row can be absorbed first (it is the document's last message
		// until the persisted one arrives), so the replacement path matters too.
		const rows = await foldedRows([
			toolMessage(STREAMING_ID, "tu-1", "running", true),
			toolMessage("real-msg", "tu-1", "success"),
		]);
		expect(rows.map((row) => row.key)).toEqual(["tool-tu-1"]);
		expect(rows[0]?.status).toBe("success");
	});

	it("keeps unrelated rows and their order while several tools hand off at once", async () => {
		// Mirrors the reported screenshot: multiple Bash rows mid-hand-off.
		const rows = await foldedRows([
			toolMessage("m1", "tu-a", "success"),
			toolMessage("m2", "tu-b", "success"),
			toolMessage("real-1", "tu-c", "success"),
			toolMessage("real-2", "tu-d", "success"),
			toolMessage(STREAMING_ID, "tu-c", "running", true),
			toolMessage(STREAMING_ID, "tu-d", "running", true),
		]);
		expect(rows.map((row) => row.key)).toEqual([
			"tool-tu-a",
			"tool-tu-b",
			"tool-tu-c",
			"tool-tu-d",
		]);
		expect(duplicatesOf(rows.map((row) => row.key))).toEqual([]);
		// Collapsing must not move surviving rows: a hand-off is not a reorder.
		expect(rows.every((row) => row.status === "success")).toBe(true);
	});
});

describe("provider retry keeps BOTH rows", () => {
	it("suffixes a repeated tool-use id across two PERSISTED messages", async () => {
		const rows = await foldedRows([
			toolMessage("real-1", "tu-x", "fail"),
			toolMessage("real-2", "tu-x", "success"),
		]);
		// Two real calls → two rows. Collapsing them would hide the failed attempt.
		expect(rows.map((row) => row.key)).toEqual(["tool-tu-x", "tool-tu-x#1"]);
		expect(rows.map((row) => row.status)).toEqual(["fail", "success"]);
		// The cross-LOD pairing id must move with the key: two calls sharing an id are
		// still two distinct pieces of content.
		expect(rows[0]?.unitId).not.toBe(rows[1]?.unitId);
	});

	it("still collapses the hand-off pair of a retried call", async () => {
		// Both mechanisms at once: two persisted attempts plus a live row for the second.
		const rows = await foldedRows([
			toolMessage("real-1", "tu-x", "fail"),
			toolMessage("real-2", "tu-x", "success"),
			toolMessage(STREAMING_ID, "tu-x", "running", true),
		]);
		expect(duplicatesOf(rows.map((row) => row.key))).toEqual([]);
		// The synthetic copy collapses into a persisted row rather than adding a third.
		expect(rows).toHaveLength(2);
	});
});

describe("hand-off across an activity-unit boundary", () => {
	/** An assistant message carrying visible answer text, which BREAKS the fold. */
	const textMessage = (messageId: string, text: string) => ({
		id: messageId,
		role: "assistant",
		contentJson: [{ type: "text", text }],
		toolCalls: [],
		children: [],
	});

	it("does not show the same tool twice when text splits the two copies", async () => {
		// The dedupe is per-unit (it scans the unit being accumulated), so this is the
		// shape where it could be bypassed: visible text flushes the unit between the
		// persisted copy and the still-live synthetic one, putting them in two different
		// traces. Rows in separate traces are not React siblings, so this would not
		// OVERLAP — it would be worse in a quieter way: the same call listed twice.
		const { segmentMessages } = await import("../message/message-segments");
		const { groupRenderUnits } = await import("../trace/render-units");
		const { adaptRenderUnits } = await import("./segment-adapter");

		const units = groupRenderUnits(
			segmentMessages([
				toolMessage("real-msg", "tu-1", "success"),
				textMessage("text-msg", "答案正文。"),
				toolMessage(STREAMING_ID, "tu-1", "running", true),
			] as never),
			true,
		);
		const specs = adaptRenderUnits(units as never, { lod: 2 });

		// Collect every tool row across ALL traces in the document.
		const toolRowKeys: string[] = [];
		for (const spec of specs) {
			for (const item of (spec.data as { items?: Record<string, unknown>[] }).items ?? []) {
				const key = String(item.key);
				if (key.startsWith("tool-")) toolRowKeys.push(key);
			}
		}
		// One call → one row, wherever the unit boundary happens to fall.
		expect(toolRowKeys).toEqual(["tool-tu-1"]);
	});
});

/**
 * EXHAUSTIVE invariant, rather than one test per known shape.
 *
 * The three duplication paths found so far (same unit, split across a unit boundary,
 * merged across chunks) were each discovered by hand after the fact, and each needed
 * its own fix. Enumerating shapes cannot keep up with that: the next one will be a
 * combination nobody listed. So this generates every sequence over a small alphabet of
 * message kinds and asserts the invariant directly — "no folded trace may contain two
 * rows with the same key" — which holds regardless of HOW the duplicate would arise.
 *
 * A failure here prints the offending sequence, which is the shape to add a focused
 * test for.
 */
describe("invariant: no folded trace ever holds a duplicate row key", () => {
	/** Message-kind alphabet, chosen to exercise every fold boundary condition. */
	type Kind = "toolA" | "toolB" | "liveA" | "liveB" | "text" | "user" | "reason" | "pendingA";

	const KINDS: Kind[] = ["toolA", "toolB", "liveA", "liveB", "text", "user", "reason", "pendingA"];

	let counter = 0;
	function build(kind: Kind): unknown {
		counter++;
		switch (kind) {
			case "toolA":
				return toolMessage(`m${counter}`, "tu-A", "success");
			case "toolB":
				return toolMessage(`m${counter}`, "tu-B", "success");
			// The synthetic live rows: the same ids, under the streaming message id.
			case "liveA":
				return toolMessage(STREAMING_ID, "tu-A", "running", true);
			case "liveB":
				return toolMessage(STREAMING_ID, "tu-B", "running", true);
			// A tool awaiting permission keeps its full card, which SPLITS the fold.
			case "pendingA":
				return toolMessage(`m${counter}`, "tu-P", "pending");
			case "text":
				return {
					id: `m${counter}`,
					role: "assistant",
					contentJson: [{ type: "text", text: "答案正文。" }],
					toolCalls: [],
					children: [],
				};
			case "user":
				return {
					id: `m${counter}`,
					role: "user",
					contentJson: [{ type: "text", text: "问题" }],
					toolCalls: [],
					children: [],
				};
			case "reason":
				return {
					id: `m${counter}`,
					role: "assistant",
					contentJson: [{ type: "reasoning", text: "**一步**\n\n正文。" }],
					toolCalls: [],
					children: [],
				};
		}
	}

	/** Row keys grouped PER TRACE — a duplicate only overlaps within one trace. */
	async function traceRowKeys(messages: unknown[]): Promise<string[][]> {
		const { segmentMessages } = await import("../message/message-segments");
		const { groupRenderUnits } = await import("../trace/render-units");
		const { adaptRenderUnits } = await import("./segment-adapter");
		const units = groupRenderUnits(segmentMessages(messages as never), true);
		const specs = adaptRenderUnits(units as never, { lod: 2 });
		const perTrace: string[][] = [];
		for (const spec of specs) {
			const items = (spec.data as { items?: Record<string, unknown>[] }).items;
			if (Array.isArray(items)) perTrace.push(items.map((item) => String(item.key)));
		}
		return perTrace;
	}

	it("holds for every sequence of length 1-3 over the message alphabet", async () => {
		const failures: string[] = [];
		const sequences: Kind[][] = [];
		for (const a of KINDS) {
			sequences.push([a]);
			for (const b of KINDS) {
				sequences.push([a, b]);
				for (const c of KINDS) sequences.push([a, b, c]);
			}
		}
		for (const sequence of sequences) {
			counter = 0;
			const viaVlist = await traceRowKeys(sequence.map(build));
			for (const [index, keys] of viaVlist.entries()) {
				const dupes = duplicatesOf(keys);
				if (dupes.length > 0) {
					failures.push(`[${sequence.join(",")}] trace#${index} duplicates: ${dupes.join(", ")}`);
				}
			}
		}
		// Prints the exact shape to reproduce, not just a count.
		expect(failures).toEqual([]);
		// Guard the guard: the sweep must actually have exercised a lot of shapes.
		expect(sequences.length).toBe(KINDS.length + KINDS.length ** 2 + KINDS.length ** 3);
	});

	it("holds through the PRODUCTION entry point, down to the painted rows", async () => {
		// Everything above drives `adaptRenderUnits` directly. Production goes through
		// `buildPretextDocumentLayout`, which is also what mints the activity unit's
		// `spec.key` — driving the adapter directly leaves that key undefined and can
		// therefore take different branches downstream. (That exact shortcut silently
		// disabled the measurement cache in an earlier performance test, so it is worth
		// asserting the real entry point rather than assuming equivalence.)
		//
		// This also checks `measured.rows`, the list the renderer actually paints at
		// absolute offsets — the layer where a duplicate becomes the visible overlap.
		const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
		const { getCategory, getCategoryColor } = await import("../tool-call/tool-display");
		const { recentRunSegmentMessageIds } = await import("../trace/run-segments");

		const withSeq = (message: Record<string, unknown>, seq: number) => ({ ...message, seq });
		const textMessage = (messageId: string, seq: number) => ({
			id: messageId,
			seq,
			role: "assistant",
			contentJson: [{ type: "text", text: "答案正文。" }],
			toolCalls: [],
			children: [],
		});

		const shapes: Array<[string, unknown[]]> = [
			[
				"hand-off pair",
				[
					withSeq(toolMessage("m1", "tu-1", "success"), 1),
					withSeq(toolMessage(STREAMING_ID, "tu-1", "running", true), 999),
				],
			],
			[
				"provider retry",
				[
					withSeq(toolMessage("m1", "tu-x", "fail"), 1),
					withSeq(toolMessage("m2", "tu-x", "success"), 2),
				],
			],
			[
				"text splits the pair",
				[
					withSeq(toolMessage("m1", "tu-1", "success"), 1),
					textMessage("m2", 2),
					withSeq(toolMessage(STREAMING_ID, "tu-1", "running", true), 999),
				],
			],
		];

		const failures: string[] = [];
		let maxPaintedRowsSeen = 0;
		// BOTH folding levels. L1 is not merely "L2 collapsed": it decides per unit
		// whether the row list stays open (the current run does, history folds), and a
		// live hand-off is by definition in the current run — so L1 paints these rows too.
		for (const lod of [1, 2] as const) {
			for (const [label, messages] of shapes) {
				const built = buildPretextDocumentLayout(messages as never, {
					layoutRevision: "r1",
					documentRevision: "v1",
					lod,
					widthBucket: 800,
					contentWidth: 800,
					viewportHeight: 900,
					resolveToolCategory: getCategory,
					resolveToolColor: (name: string, input: unknown) =>
						getCategoryColor(getCategory(name, input)),
					resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
				});
				for (const item of built.items) {
					const adapted = (item.spec.data as { items?: { key: string }[] }).items;
					if (Array.isArray(adapted)) {
						const dupes = duplicatesOf(adapted.map((row) => row.key));
						if (dupes.length > 0) {
							failures.push(`L${lod} ${label}: adapted duplicates ${dupes.join(", ")}`);
						}
					}
					// The painted list: absolutely positioned, so a duplicate here IS the overlap.
					const painted = (
						item.measured as { rows?: { key: string; top: number; blockHeight: number }[] }
					).rows;
					if (Array.isArray(painted)) {
						maxPaintedRowsSeen = Math.max(maxPaintedRowsSeen, painted.length);
						const dupes = duplicatesOf(painted.map((row) => row.key));
						if (dupes.length > 0) {
							failures.push(`L${lod} ${label}: PAINTED duplicates ${dupes.join(", ")}`);
						}
						// Geometry, not just identity. The reported symptom was overprinted TEXT, and
						// unique keys alone do not rule that out: two DIFFERENT rows parked at the
						// same offset overlap just as visibly.
						for (const overlap of overlapsOf(painted)) {
							failures.push(`L${lod} ${label}: PAINTED overlap ${overlap}`);
						}
					}
				}
			}
		}
		expect(failures).toEqual([]);
		// The geometry check above is only meaningful if it actually compared adjacent rows.
		// Pin that it saw multi-row traces, so a layout change that stops emitting
		// `measured.rows` cannot turn the overlap assertion into a silent no-op.
		expect(maxPaintedRowsSeen).toBeGreaterThan(1);
	});

	it("keeps the LIVE run's rows visible at L1 (they must be painted to matter)", async () => {
		// The uniqueness assertions above are only meaningful if L1 actually paints the
		// rows. This pins the L1 behaviour they depend on: history folds behind the
		// header, but the run holding live output stays open — otherwise a "no duplicate
		// painted rows" pass would be vacuously true because nothing was painted.
		const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
		const { recentRunSegmentMessageIds } = await import("../trace/run-segments");

		const built = buildPretextDocumentLayout(
			[
				{ ...toolMessage("m1", "tu-1", "success"), seq: 1 },
				{ ...toolMessage(STREAMING_ID, "tu-1", "running", true), seq: 999 },
			] as never,
			{
				layoutRevision: "r1",
				documentRevision: "v1",
				lod: 1,
				widthBucket: 800,
				contentWidth: 800,
				viewportHeight: 900,
				resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
			},
		);
		const trace = built.items[0]?.measured as {
			rows?: { key: string }[];
			collapsedToHeader?: boolean;
		};
		expect(trace?.collapsedToHeader).toBe(false);
		expect((trace?.rows ?? []).map((row) => row.key)).toEqual(["tool-tu-1"]);
	});

	it("self-check: the sweep DOES detect a duplicate when one exists", async () => {
		// A green invariant is worthless if it cannot go red. Rather than mutate the
		// source (which would mean leaving a broken file on disk mid-run), feed the same
		// detector a shape whose keys are known to collide: the fold's hand-off
		// resolution is bypassed by construction here, because both copies are PERSISTED
		// under the same id in the same unit AND the dedupe suffix is stripped.
		const perTrace = await traceRowKeys([
			toolMessage("m1", "tu-same", "success"),
			toolMessage("m2", "tu-same", "success"),
		]);
		const stripped = perTrace.map((keys) => keys.map((key) => key.replace(/#\d+$/, "")));
		// With the retry suffix removed the two rows collide — proving `duplicatesOf`
		// plus the per-trace grouping really would report a real collision.
		expect(stripped.some((keys) => duplicatesOf(keys).length > 0)).toBe(true);
		// And with the suffix intact (what the code actually emits) they do not.
		expect(perTrace.every((keys) => duplicatesOf(keys).length === 0)).toBe(true);
	});

	it("self-check: the overlap detector DOES fire on real painted geometry", async () => {
		// The key sweep has a self-check; the geometry sweep needs the same guarantee, or a
		// silently-wrong comparison would read as a permanent pass. Take the REAL painted
		// rows from the production layout, then collapse the second row onto the first's
		// offset — the exact shape of the reported overprint. Using measured geometry (not
		// hand-written numbers) also proves `top`/`blockHeight` are populated as assumed.
		const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
		const { getCategory, getCategoryColor } = await import("../tool-call/tool-display");
		const { recentRunSegmentMessageIds } = await import("../trace/run-segments");

		const built = buildPretextDocumentLayout(
			[
				{ ...toolMessage("m1", "tu-a", "success"), seq: 1 },
				{ ...toolMessage("m2", "tu-b", "success"), seq: 2 },
			] as never,
			{
				layoutRevision: "r1",
				documentRevision: "v1",
				lod: 2,
				widthBucket: 800,
				contentWidth: 800,
				viewportHeight: 900,
				resolveToolCategory: getCategory,
				resolveToolColor: (name: string, input: unknown) =>
					getCategoryColor(getCategory(name, input)),
				resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
			},
		);

		type PaintedRow = { key: string; top: number; blockHeight: number };
		const painted = built.items
			.map((item) => (item.measured as { rows?: PaintedRow[] }).rows)
			.find((rows): rows is PaintedRow[] => Array.isArray(rows) && rows.length > 1);
		if (!painted) throw new Error("Expected a multi-row painted trace to self-check against.");
		// Real layout stacks them: no overlap reported.
		expect(overlapsOf(painted)).toEqual([]);
		// Every row carries usable geometry (a zero-height row would make the check vacuous).
		expect(painted.every((row) => row.blockHeight > 0)).toBe(true);
		// Force the collision and the detector must report it.
		const collided = [painted[0], { ...painted[1], top: painted[0].top }];
		expect(overlapsOf(collided)).toHaveLength(1);
	});

	it("also holds when a live row appears TWICE in one sequence", async () => {
		// A stream can republish its row between renders, and the accumulator may hold
		// several live tools at once. Both collapse into the same document.
		const failures: string[] = [];
		for (const sequence of [
			["liveA", "liveA"],
			["liveA", "toolA", "liveA"],
			["toolA", "liveA", "liveB", "toolB"],
			["liveA", "text", "toolA", "text", "liveA"],
			["pendingA", "liveA", "toolA"],
			["toolA", "user", "liveA"],
		] as Kind[][]) {
			counter = 0;
			const perTrace = await traceRowKeys(sequence.map(build));
			for (const [index, keys] of perTrace.entries()) {
				const dupes = duplicatesOf(keys);
				if (dupes.length > 0) {
					failures.push(`[${sequence.join(",")}] trace#${index} duplicates: ${dupes.join(", ")}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});
});

describe("reasoning rows stay unique across the hand-off", () => {
	it("keys a live run apart from the persisted one", async () => {
		const rows = await foldedRows([
			reasoningMessage("real-msg", "**第一步**\n\n分析折叠。"),
			reasoningMessage(STREAMING_ID, "**第二步**\n\n继续分析。"),
		]);
		expect(duplicatesOf(rows.map((row) => row.key))).toEqual([]);
		// Keyed by run ordinal within the unit, which is what makes the key survive the
		// live → persisted transition (see ActivityReasoningInput.stableKeyBase).
		expect(rows.map((row) => row.key)).toEqual(["r-run0-0-step-0", "r-run1-0-step-0"]);
	});

	it("keeps multi-step runs unique when a live run grows", async () => {
		const rows = await foldedRows([
			reasoningMessage("real-msg", "**甲**\n\n正文。\n\n**乙**\n\n正文。"),
			reasoningMessage(STREAMING_ID, "**丙**\n\n正文。\n\n**丁**\n\n正文。"),
		]);
		expect(duplicatesOf(rows.map((row) => row.key))).toEqual([]);
		expect(rows).toHaveLength(4);
	});
});
