import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE importing any pretext-backed
// module (measure-tool-run → measure-markdown → parse-markdown call pretext at
// prepare time, but only when a ReasoningStepsTrace body is expanded).
beforeAll(() => {
	installCanvasStub();
});

// ── Shared row builders ──────────────────────────────────────────────────────
function toolRows(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		title: `Tool ${i} · did a thing`,
		hasIcon: true,
		iconColor: "gray",
		key: `t-${i}`,
	}));
}
function stepRows(n: number, body?: string) {
	return Array.from({ length: n }, (_, i) => ({
		title: `Step ${i}`,
		body: body ?? `Body of step ${i}.`,
		key: `s-${i}`,
	}));
}

describe("measure-tool-run — fixed chrome constants (CONTRACT §4)", () => {
	it("header band ≈24.8, row ≈18.8, count line ≈20.8 (unrounded xs 16.8)", async () => {
		const m = await import("./measure-tool-run");
		expect(m.TRACE_XS_LINE).toBeCloseTo(16.8, 5);
		expect(m.TRACE_HEADER_BAND_HEIGHT).toBeCloseTo(24.8, 5);
		expect(m.TRACE_ROW_HEIGHT).toBeCloseTo(18.8, 5);
		expect(m.TRACE_COUNT_LINE_HEIGHT).toBeCloseTo(20.8, 5);
		expect(m.TRACE_HEADER_GROUP_HEIGHT).toBeCloseTo(20.8, 5);
	});
});

describe("measureCollapsibleTrace — header + N rows", () => {
	it("height = header band + N × row height (no fold, no expand)", async () => {
		const { measureCollapsibleTrace, TRACE_HEADER_BAND_HEIGHT, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureCollapsibleTrace({ items: toolRows(3), maxVisible: 10 }, 600);
		expect(r.rows).toHaveLength(3);
		expect(r.toggle).toBeNull();
		expect(r.collapsedToHeader).toBe(false);
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT + 3 * TRACE_ROW_HEIGHT, 5);
	});

	it("rows stack right after the header at the measured tops", async () => {
		const { measureCollapsibleTrace, TRACE_HEADER_BAND_HEIGHT, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureCollapsibleTrace({ items: toolRows(2), maxVisible: 10 }, 600);
		// header sits at the outer top padding; first row begins right after the
		// header Group (outer top pad + header group = 2 + 20.8 = 22.8).
		expect(r.header.top).toBeCloseTo(2, 5);
		expect(r.rows[0]?.top).toBeCloseTo(2 + r.header.height, 5);
		expect(r.rows[1]?.top).toBeCloseTo((r.rows[0]?.top ?? 0) + TRACE_ROW_HEIGHT, 5);
		// bottom outer padding (2) keeps total = header band + rows.
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT + 2 * TRACE_ROW_HEIGHT, 5);
	});

	it("row height is independent of title length (truncate → single line)", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const short = measureCollapsibleTrace({ items: [{ title: "hi" }], maxVisible: 10 }, 600);
		const long = measureCollapsibleTrace(
			{ items: [{ title: "x".repeat(500) }], maxVisible: 10 },
			600,
		);
		expect(long.height).toBeCloseTo(short.height, 5);
	});

	it("returns null-shaped empty measure for an empty item list", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const r = measureCollapsibleTrace({ items: [] }, 600);
		expect(r.itemCount).toBe(0);
		expect(r.height).toBe(0);
		expect(r.rows).toHaveLength(0);
		expect(r.blocks).toHaveLength(0);
	});
});

describe("measureCollapsibleTrace — maxVisible fold + show-earlier toggle", () => {
	it("N > maxVisible shows a toggle row + only the last maxVisible rows", async () => {
		const { measureCollapsibleTrace, TRACE_HEADER_BAND_HEIGHT, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureCollapsibleTrace({ items: toolRows(15), maxVisible: 10 }, 600);
		expect(r.rows).toHaveLength(10);
		expect(r.toggle).not.toBeNull();
		expect(r.toggle?.hiddenCount).toBe(5);
		expect(r.toggle?.showEarlier).toBe(false);
		// header band + toggle row + 10 rows.
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT + 11 * TRACE_ROW_HEIGHT, 5);
		// the visible rows are the LAST 10 (indices 5..14).
		expect(r.rows[0]?.itemIndex).toBe(5);
		expect(r.rows[9]?.itemIndex).toBe(14);
	});

	it("showEarlier reveals all rows (toggle stays, grows taller)", async () => {
		const { measureCollapsibleTrace, TRACE_HEADER_BAND_HEIGHT, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const collapsed = measureCollapsibleTrace({ items: toolRows(15), maxVisible: 10 }, 600);
		const expanded = measureCollapsibleTrace({ items: toolRows(15), maxVisible: 10 }, 600, {
			showEarlier: true,
		});
		expect(expanded.rows).toHaveLength(15);
		expect(expanded.toggle?.showEarlier).toBe(true);
		expect(expanded.rows[0]?.itemIndex).toBe(0);
		// header band + toggle + 15 rows.
		expect(expanded.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT + 16 * TRACE_ROW_HEIGHT, 5);
		expect(expanded.height).toBeGreaterThan(collapsed.height);
	});

	it("N === maxVisible shows no toggle", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const r = measureCollapsibleTrace({ items: toolRows(10), maxVisible: 10 }, 600);
		expect(r.toggle).toBeNull();
		expect(r.rows).toHaveLength(10);
	});
});

describe("measureCollapsibleTrace — collapseItems (folded to header only)", () => {
	it("collapseItems + not opened → header band only (≈24.8), no rows", async () => {
		const { measureCollapsibleTrace, TRACE_HEADER_BAND_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureCollapsibleTrace({ items: toolRows(8), maxVisible: 10 }, 600, {
			collapseItems: true,
		});
		expect(r.collapsedToHeader).toBe(true);
		expect(r.rows).toHaveLength(0);
		expect(r.toggle).toBeNull();
		expect(r.header.hasChevron).toBe(true);
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT, 5);
	});

	it("collapseItems + opened → rows revealed again", async () => {
		const { measureCollapsibleTrace, TRACE_HEADER_BAND_HEIGHT, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureCollapsibleTrace({ items: toolRows(4), maxVisible: 10 }, 600, {
			collapseItems: true,
			itemsOpened: true,
		});
		expect(r.collapsedToHeader).toBe(false);
		expect(r.rows).toHaveLength(4);
		expect(r.header.opened).toBe(true);
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT + 4 * TRACE_ROW_HEIGHT, 5);
	});
});

describe("measureToolRunSummary (L3) — titles-only trace, maxVisible=10", () => {
	it("all bodies null → header + min(N,10) rows, no expandable rows", async () => {
		const { measureToolRunSummary, TRACE_HEADER_BAND_HEIGHT, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureToolRunSummary(toolRows(6), 600);
		expect(r.variant).toBe("tool-run-summary");
		expect(r.maxVisible).toBe(10);
		expect(r.rows.every((row) => !row.expandable)).toBe(true);
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT + 6 * TRACE_ROW_HEIGHT, 5);
	});

	it("caps visible rows at 10 and adds a toggle when N>10", async () => {
		const { measureToolRunSummary } = await import("./measure-tool-run");
		const r = measureToolRunSummary(toolRows(12), 600);
		expect(r.rows).toHaveLength(10);
		expect(r.toggle?.hiddenCount).toBe(2);
	});
});

describe("measureToolRunCountLine (L2) — single fixed row", () => {
	it("is a single ≈20.8px row regardless of count", async () => {
		const { measureToolRunCountLine, TRACE_COUNT_LINE_HEIGHT } = await import("./measure-tool-run");
		const a = measureToolRunCountLine(3, 600);
		const b = measureToolRunCountLine(999, 600);
		expect(a.kind).toBe("tool");
		expect(a.count).toBe(3);
		expect(a.height).toBeCloseTo(TRACE_COUNT_LINE_HEIGHT, 5);
		expect(a.height).toBeCloseTo(20.8, 5);
		expect(b.height).toBeCloseTo(a.height, 5);
		expect(a.blocks).toHaveLength(1);
		expect(a.blocks[0]?.kind).toBe("fixed");
	});

	it("width-independent", async () => {
		const { measureToolRunCountLine } = await import("./measure-tool-run");
		const wide = measureToolRunCountLine(5, 2000);
		const narrow = measureToolRunCountLine(5, 80);
		expect(narrow.height).toBeCloseTo(wide.height, 5);
	});
});

describe("measureReasoningCountLine (L1/L2) — single fixed row", () => {
	it("is a single ≈20.8px reasoning row", async () => {
		const { measureReasoningCountLine, TRACE_COUNT_LINE_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureReasoningCountLine(4, 600);
		expect(r.kind).toBe("reasoning");
		expect(r.count).toBe(4);
		expect(r.height).toBeCloseTo(TRACE_COUNT_LINE_HEIGHT, 5);
		expect(r.height).toBeCloseTo(20.8, 5);
	});
});

describe("measureActivityTrace (L1/L2)", () => {
	it("L2 (default) → header + min(N,10) rows", async () => {
		const { measureActivityTrace, TRACE_HEADER_BAND_HEIGHT, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureActivityTrace(toolRows(4), 600);
		expect(r.variant).toBe("activity");
		expect(r.collapsedToHeader).toBe(false);
		expect(r.rows).toHaveLength(4);
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT + 4 * TRACE_ROW_HEIGHT, 5);
	});

	it("L1 (collapsed) → header band only (≈24.8)", async () => {
		const { measureActivityTrace, TRACE_HEADER_BAND_HEIGHT } = await import("./measure-tool-run");
		const r = measureActivityTrace(toolRows(9), 600, { collapsed: true });
		expect(r.collapsedToHeader).toBe(true);
		expect(r.rows).toHaveLength(0);
		expect(r.header.hasChevron).toBe(true);
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT, 5);
	});

	it("caps at 10 visible rows with a toggle when N>10", async () => {
		const { measureActivityTrace } = await import("./measure-tool-run");
		const r = measureActivityTrace(toolRows(14), 600);
		expect(r.rows).toHaveLength(10);
		expect(r.toggle?.hiddenCount).toBe(4);
	});
});

describe("measureReasoningStepsTrace — expandable markdown bodies", () => {
	it("titlesOnly → all rows collapsed (no bodies), height = header + N rows", async () => {
		const { measureReasoningStepsTrace, TRACE_HEADER_BAND_HEIGHT, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureReasoningStepsTrace(stepRows(3), 600, { titlesOnly: true });
		expect(r.variant).toBe("reasoning-steps");
		expect(r.maxVisible).toBe(5);
		expect(r.rows.every((row) => !row.expandable)).toBe(true);
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT + 3 * TRACE_ROW_HEIGHT, 5);
	});

	it("rows are expandable when a body exists, but collapsed adds no height", async () => {
		const { measureReasoningStepsTrace, TRACE_HEADER_BAND_HEIGHT, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureReasoningStepsTrace(stepRows(3), 600);
		expect(r.rows.every((row) => row.expandable)).toBe(true);
		expect(r.rows.every((row) => !row.expanded)).toBe(true);
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT + 3 * TRACE_ROW_HEIGHT, 5);
	});

	it("expanding a step adds bodyPadding*2 + markdown height under its row", async () => {
		const { measureReasoningStepsTrace, TRACE_BODY_PADDING_Y, traceBodyInnerWidth } = await import(
			"./measure-tool-run"
		);
		const { measureMarkdown } = await import("./measure-markdown");

		const body = "Hello world of reasoning.";
		const steps = [
			{ title: "Step 0", body: "irrelevant", key: "s0" },
			{ title: "Step 1", body, key: "s1" },
			{ title: "Step 2", body: "irrelevant", key: "s2" },
		];
		const collapsed = measureReasoningStepsTrace(steps, 600);
		const expanded = measureReasoningStepsTrace(steps, 600, { expandedIndices: [1] });

		const inner = traceBodyInnerWidth(600);
		const md = measureMarkdown(body, inner);
		const delta = TRACE_BODY_PADDING_Y * 2 + md.frame.contentHeight;

		expect(expanded.rows[1]?.expanded).toBe(true);
		expect(expanded.height).toBeCloseTo(collapsed.height + delta, 5);
		// The expanded row carries the markdown body + geometry for the renderer.
		expect(expanded.rows[1]?.body).not.toBeNull();
		expect(expanded.rows[1]?.body?.blocks.length).toBeGreaterThan(0);
		expect(expanded.rows[1]?.bodyLeft).toBe(inner === 600 ? 0 : 600 - inner);
	});

	it("a taller markdown body makes the expanded step taller", async () => {
		const { measureReasoningStepsTrace } = await import("./measure-tool-run");
		const shortBody = [{ title: "S", body: "One line.", key: "s" }];
		const longBody = [{ title: "S", body: "Para one.\n\nPara two.\n\nPara three.", key: "s" }];
		const shortR = measureReasoningStepsTrace(shortBody, 600, { expandedIndices: [0] });
		const longR = measureReasoningStepsTrace(longBody, 600, { expandedIndices: [0] });
		expect(longR.height).toBeGreaterThan(shortR.height);
	});

	it("body wraps to more lines as width shrinks (taller)", async () => {
		const { measureReasoningStepsTrace } = await import("./measure-tool-run");
		const body = "one two three four five six seven eight nine ten eleven twelve thirteen";
		const steps = [{ title: "S", body, key: "s" }];
		const wide = measureReasoningStepsTrace(steps, 2000, { expandedIndices: [0] });
		const narrow = measureReasoningStepsTrace(steps, 160, { expandedIndices: [0] });
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	it("titlesOnly wins over expandedIndices (no body rendered)", async () => {
		const { measureReasoningStepsTrace, TRACE_HEADER_BAND_HEIGHT, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const r = measureReasoningStepsTrace(stepRows(2), 600, {
			titlesOnly: true,
			expandedIndices: [0, 1],
		});
		expect(r.rows.every((row) => !row.expanded)).toBe(true);
		expect(r.height).toBeCloseTo(TRACE_HEADER_BAND_HEIGHT + 2 * TRACE_ROW_HEIGHT, 5);
	});
});

describe("block / frame shape", () => {
	it("produces header + rows + trailing pad fixed blocks with matching frame", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const r = measureCollapsibleTrace({ items: toolRows(2), maxVisible: 10 }, 512);
		// header + 2 rows + pad = 4 blocks (no toggle at N<=maxVisible).
		expect(r.blocks).toHaveLength(4);
		expect(r.blocks.every((b) => b.kind === "fixed")).toBe(true);
		expect(r.frame.contentHeight).toBeCloseTo(r.height, 5);
		expect(r.usedWidth).toBe(512);
		expect(r.contentWidth).toBe(512);
	});
});

/**
 * `identity` turns a folded row into an interactive block (right-click / swipe /
 * multi-select). It is a pure renderer passthrough and MUST NOT influence layout:
 * the interaction wrapper draws selection with `outline` (no box-model effect) and
 * portals its menus/modals. This guards the zero-DOM height contract — if someone
 * ever reads `identity` in the measure math, these go red.
 */
describe("row identity is height-neutral", () => {
	const withIdentity = (rows: ReturnType<typeof toolRows>) =>
		rows.map((row, i) => ({
			...row,
			identity: {
				messageId: "m1",
				blockIndex: i,
				blockIndices: [i, i + 1],
				toolUseId: `tu-${i}`,
				toolName: "Read",
			},
		}));

	it("does not change the collapsed or expanded trace height", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const plain = toolRows(3);
		for (const width of [320, 512, 900]) {
			const a = measureCollapsibleTrace({ items: plain, maxVisible: 10 }, width);
			const b = measureCollapsibleTrace({ items: withIdentity(plain), maxVisible: 10 }, width);
			expect(b.height).toBe(a.height);
			expect(b.frame.contentHeight).toBe(a.frame.contentHeight);
			expect(b.rows.map((r) => r.top)).toEqual(a.rows.map((r) => r.top));
			expect(b.rows.map((r) => r.blockHeight)).toEqual(a.rows.map((r) => r.blockHeight));
		}
	});

	it("does not change height when rows fold behind 'show earlier'", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const plain = toolRows(14);
		const a = measureCollapsibleTrace({ items: plain, maxVisible: 10 }, 512);
		const b = measureCollapsibleTrace({ items: withIdentity(plain), maxVisible: 10 }, 512);
		expect(b.height).toBe(a.height);
		expect(b.toggle?.top).toBe(a.toggle?.top);
	});

	it("passes identity through to the measured rows unchanged", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const r = measureCollapsibleTrace({ items: withIdentity(toolRows(2)), maxVisible: 10 }, 512);
		expect(r.rows[0]?.identity).toEqual({
			messageId: "m1",
			blockIndex: 0,
			blockIndices: [0, 1],
			toolUseId: "tu-0",
			toolName: "Read",
		});
	});

	it("leaves identity undefined when the row carries none", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const r = measureCollapsibleTrace({ items: toolRows(2), maxVisible: 10 }, 512);
		expect(r.rows[0]?.identity).toBeUndefined();
	});
});

/**
 * `unitId` is the LOD-independent identity of a row's content — the same string the
 * full card carries at L3+, so the two renderings of one tool call can be paired
 * across a level change. Like `identity` it is a pure renderer passthrough (emitted
 * as `data-nf-unit`) and must never reach the height math.
 */
describe("row unitId is height-neutral", () => {
	const withUnitId = (rows: ReturnType<typeof toolRows>) =>
		rows.map((row, i) => ({ ...row, unitId: `tool-tu-${i}` }));

	it("does not change any measured geometry", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const plain = toolRows(3);
		for (const width of [320, 512, 900]) {
			const a = measureCollapsibleTrace({ items: plain, maxVisible: 10 }, width);
			const b = measureCollapsibleTrace({ items: withUnitId(plain), maxVisible: 10 }, width);
			expect(b.height).toBe(a.height);
			expect(b.rows.map((r) => r.top)).toEqual(a.rows.map((r) => r.top));
			expect(b.rows.map((r) => r.blockHeight)).toEqual(a.rows.map((r) => r.blockHeight));
		}
	});

	it("reaches the measured rows unchanged, and stays undefined when absent", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const withIds = measureCollapsibleTrace(
			{ items: withUnitId(toolRows(2)), maxVisible: 10 },
			512,
		);
		expect(withIds.rows.map((r) => r.unitId)).toEqual(["tool-tu-0", "tool-tu-1"]);
		const without = measureCollapsibleTrace({ items: toolRows(2), maxVisible: 10 }, 512);
		expect(without.rows[0]?.unitId).toBeUndefined();
	});
});

/**
 * A folded row now shows its OUTCOME (status glyph) and its DURATION, so a reader
 * who drops to a low LOD no longer loses "did it fail" and "how long did it take".
 *
 * Both additions are render-only, and that is exactly what has to be proven: they
 * sit inside the row's existing 16.8px content lane, so a row carrying them must
 * measure identically to one that does not. If either ever grew the row, every
 * committed row below it would shift the moment a live status transition landed —
 * the stable-height invariant this whole layer is built around.
 */
describe("row status + timing are height-neutral", () => {
	const withStatusAndTiming = (rows: ReturnType<typeof toolRows>) =>
		rows.map((row, i) => ({
			...row,
			status: i === 0 ? "running" : i === 1 ? "fail" : "success",
			timing: { createdAt: 1_000 * i, completedAt: 1_000 * i + 4_200, durationMs: 4_200 },
		}));

	it("changes no measured geometry, at any width", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const plain = toolRows(3);
		for (const width of [320, 512, 900]) {
			const a = measureCollapsibleTrace({ items: plain, maxVisible: 10 }, width);
			const b = measureCollapsibleTrace(
				{ items: withStatusAndTiming(plain), maxVisible: 10 },
				width,
			);
			expect(b.height).toBe(a.height);
			expect(b.rows.map((r) => r.top)).toEqual(a.rows.map((r) => r.top));
			expect(b.rows.map((r) => r.blockHeight)).toEqual(a.rows.map((r) => r.blockHeight));
		}
	});

	it("a status TRANSITION cannot move the row (the live case)", async () => {
		// The real failure mode is temporal: one row walks streaming → running →
		// success while the reader is looking at it. Every step must land on the same
		// geometry, not merely "with vs without".
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const heights = new Set<number>();
		for (const status of ["streaming", "running", "success", "fail", "cancelled", ""]) {
			const r = measureCollapsibleTrace(
				{ items: [{ ...toolRows(1)[0], status }], maxVisible: 10 },
				512,
			);
			heights.add(r.height);
			expect(r.rows[0]?.blockHeight).toBeCloseTo(18.8, 5);
		}
		expect(heights.size).toBe(1);
	});

	it("a row's reflection status is height-neutral too", async () => {
		// `reflectionStatus` is a pure renderer passthrough (it picks the shimmer colour
		// when a gate is deliberating). Like `status` it must never reach the height math.
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const base = toolRows(1)[0];
		const heights = new Set<number>();
		for (const reflectionStatus of [undefined, "running", "confirmed", "awaiting_user"]) {
			const r = measureCollapsibleTrace(
				{ items: [{ ...base, status: "pending", reflectionStatus }], maxVisible: 10 },
				512,
			);
			heights.add(r.height);
			expect(r.rows[0]?.blockHeight).toBeCloseTo(18.8, 5);
		}
		expect(heights.size).toBe(1);
		// And it reaches the measured row unchanged, so the renderer can read it.
		const withGate = measureCollapsibleTrace(
			{ items: [{ ...base, status: "pending", reflectionStatus: "running" }], maxVisible: 10 },
			512,
		);
		expect(withGate.rows[0]?.reflectionStatus).toBe("running");
		const without = measureCollapsibleTrace({ items: [base], maxVisible: 10 }, 512);
		expect(without.rows[0]?.reflectionStatus).toBeUndefined();
	});

	it("the five-state SHIMMER cannot move the row either", async () => {
		// A row now animates in one of five states (neutral / purple / blue, plus a
		// one-shot green / red) derived from `status` + `shimmer`. That is safe ONLY
		// because the row shimmer recolours its own text rather than adding a box
		// (frontend/styles/trace-shimmer.css) — a card-style `::after` overlay would need
		// `position: relative` on a row the measure layer positions absolutely.
		//
		// This asserts the measure side of that contract: neither input is readable as
		// geometry. Every combination — including a row carrying both — lands on one
		// height.
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const base = toolRows(1)[0];
		const heights = new Set<number>();
		for (const shimmer of [undefined, false, true]) {
			for (const status of [undefined, "streaming", "running", "success", "fail"]) {
				const r = measureCollapsibleTrace(
					{ items: [{ ...base, ...(status ? { status } : {}), shimmer }], maxVisible: 10 },
					512,
				);
				heights.add(r.height);
				expect(r.rows[0]?.blockHeight).toBeCloseTo(18.8, 5);
			}
		}
		expect(heights.size).toBe(1);
	});

	it("normalizes the stamps once, in the measure layer", async () => {
		// The renderer must never re-parse wire shapes; it indexes `row.timing`
		// directly. Absent timing stays null so the row draws no slot at all.
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const r = measureCollapsibleTrace(
			{
				items: [
					{ ...toolRows(1)[0], status: "success", timing: { createdAt: 5, durationMs: 900 } },
					{ ...toolRows(2)[1], key: "t-plain" },
				],
				maxVisible: 10,
			},
			512,
		);
		expect(r.rows[0]?.status).toBe("success");
		expect(r.rows[0]?.timing).toMatchObject({ createdAt: 5, durationMs: 900 });
		// A row that carried neither reports both as null, not undefined — so the
		// renderer's `row.timing ? …` gate is a single unambiguous check.
		expect(r.rows[1]?.status).toBeNull();
		expect(r.rows[1]?.timing).toBeNull();
	});

	it("the status slot fits inside the row's content lane (why it is free)", async () => {
		// The arithmetic reason the assertions above hold: the xs text line dominates
		// every glyph in the row, so adding a 12px slot cannot raise the max.
		const m = await import("./measure-tool-run");
		expect(m.TRACE_ROW_STATUS).toBeLessThan(m.TRACE_XS_LINE);
		expect(m.TRACE_ROW_CONTENT).toBeCloseTo(m.TRACE_XS_LINE, 5);
	});
});

// ── Drill-down: an expanded tool row nests a real tool card ───────────────────

/** A minimal ToolCallData with a capped code detail (the common Read shape). */
function drillCard(text = "line\n".repeat(4)) {
	return {
		toolName: "Read",
		summary: "src/index.ts",
		category: "read" as const,
		status: "success" as const,
		toolUseId: "tu-0",
		detail: { kind: "capped" as const, cap: "code" as const, text, hasLabel: true },
	};
}

describe("trace row drill-down", () => {
	/** N tool rows, all drillable; `cards` marks which of them carry a card. */
	function drillRows(n: number, cards: readonly number[] = []) {
		const carry = new Set(cards);
		return toolRows(n).map((row, i) => ({
			...row,
			canDrillDown: true,
			...(carry.has(i) ? { card: drillCard() } : {}),
		}));
	}

	it("canDrillDown makes a row expandable WITHOUT changing its collapsed height", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const plain = measureCollapsibleTrace({ items: toolRows(3), maxVisible: 10 }, 600);
		const drill = measureCollapsibleTrace({ items: drillRows(3), maxVisible: 10 }, 600);
		// The chevron replaces the "•" in the same fixed 12px slot → zero cost.
		expect(drill.height).toBeCloseTo(plain.height, 5);
		expect(drill.rows.map((r) => r.blockHeight)).toEqual(plain.rows.map((r) => r.blockHeight));
		expect(plain.rows[0]?.expandable).toBe(false);
		expect(drill.rows[0]?.expandable).toBe(true);
		expect(drill.rows[0]?.canDrillDown).toBe(true);
		// Not opened → no card was measured at all.
		expect(drill.rows[0]?.cardMeasured).toBeNull();
	});

	it("a drillable row with no card yet stays exactly as tall as a plain row", async () => {
		const { measureCollapsibleTrace, TRACE_ROW_HEIGHT } = await import("./measure-tool-run");
		// expandedIndices names row 1, but the adapter has not supplied its card
		// (the state and the payload land on separate renders). The row must not
		// reserve space for content it does not have.
		const r = measureCollapsibleTrace({ items: drillRows(3), maxVisible: 10 }, 600, {
			expandedIndices: [1],
		});
		expect(r.rows[1]?.cardMeasured).toBeNull();
		expect(r.rows[1]?.blockHeight).toBeCloseTo(TRACE_ROW_HEIGHT, 5);
	});

	it("expanding a tool row makes the row block exactly the nested card", async () => {
		const { measureCollapsibleTrace, TRACE_ROW_HEIGHT } = await import("./measure-tool-run");
		const items = drillRows(3, [1]);
		const collapsed = measureCollapsibleTrace({ items, maxVisible: 10 }, 600);
		const expanded = measureCollapsibleTrace({ items, maxVisible: 10 }, 600, {
			expandedIndices: [1],
		});
		const card = expanded.rows[1]?.cardMeasured;
		expect(card).not.toBeNull();
		expect(card?.effectiveOpened).toBe(true);
		// The drilled-in row block IS the card: the summary row is not painted, so no
		// TRACE_ROW_HEIGHT / body padding is added on top of the card's own height.
		expect(expanded.rows[1]?.blockHeight).toBeCloseTo(card?.height ?? 0, 5);
		expect(expanded.height).toBeCloseTo(
			collapsed.height - TRACE_ROW_HEIGHT + (card?.height ?? 0),
			5,
		);
		// Rows after the expanded one shift down by exactly the net growth.
		expect(expanded.rows[2]?.top).toBeCloseTo(
			(collapsed.rows[2]?.top ?? 0) - TRACE_ROW_HEIGHT + (card?.height ?? 0),
			5,
		);
	});

	it("the nested card fills the full row width (no indented body lane)", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const r = measureCollapsibleTrace({ items: drillRows(2, [0]), maxVisible: 10 }, 600, {
			expandedIndices: [0],
		});
		// The card is measured against the row's FULL content width (it replaces the
		// summary row instead of nesting under it), so there is no pl/border to deduct.
		expect(r.rows[0]?.cardMeasured?.usedWidth).toBeCloseTo(600, 5);
	});

	it("exposes the card header rect for the drill-down header morph", async () => {
		const { measureCollapsibleTrace, TRACE_ROW_HEIGHT } = await import("./measure-tool-run");
		const { CARD_BORDER, CARD_PADDING, HEADER_ROW_HEIGHT } = await import("./measure-tool-call");
		const r = measureCollapsibleTrace({ items: drillRows(2, [0]), maxVisible: 10 }, 600, {
			expandedIndices: [0],
		});
		const row = r.rows[0];
		// Drilled-in row: the header morph target is the card's header, sitting at
		// border + padding inside the row block (which starts at the card's top).
		expect(row?.drillHeader).not.toBeNull();
		expect(row?.drillHeader?.top).toBeCloseTo(CARD_BORDER + CARD_PADDING, 5);
		expect(row?.drillHeader?.left).toBeCloseTo(CARD_BORDER + CARD_PADDING, 5);
		expect(row?.drillHeader?.height).toBeCloseTo(HEADER_ROW_HEIGHT, 5);
		expect(row?.drillHeader?.width).toBeCloseTo(600 - 2 * (CARD_BORDER + CARD_PADDING), 5);
		// A folded row has no card and therefore no morph target.
		expect(r.rows[1]?.drillHeader).toBeNull();
		expect(r.rows[1]?.blockHeight).toBeCloseTo(TRACE_ROW_HEIGHT, 5);
	});

	it("opens at every LOD a fold exists at (L1-L4 collapse a standalone card)", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		// `resolveToolCallOpened` returns false for L1-L4, so without the drill-down's
		// lodUserOverride the reader's click would open an empty header.
		for (const lod of [1, 2, 3, 4] as const) {
			const r = measureCollapsibleTrace(
				{ items: drillRows(1, [0]), maxVisible: 10 },
				600,
				{ expandedIndices: [0] },
				lod,
			);
			expect(r.rows[0]?.cardMeasured?.effectiveOpened).toBe(true);
			expect(r.rows[0]?.cardMeasured?.detail).not.toBeNull();
		}
	});

	it("a bigger payload makes the drilled-in row taller (up to the cap)", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const small = measureCollapsibleTrace(
			{ items: [{ title: "t", canDrillDown: true, card: drillCard("a\nb\n") }], maxVisible: 10 },
			600,
			{ expandedIndices: [0] },
		);
		const big = measureCollapsibleTrace(
			{
				items: [{ title: "t", canDrillDown: true, card: drillCard("x\n".repeat(10)) }],
				maxVisible: 10,
			},
			600,
			{ expandedIndices: [0] },
		);
		expect(big.height).toBeGreaterThan(small.height);
	});

	it("a card wins over a markdown bodyText (mutually exclusive reveal channels)", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		const r = measureCollapsibleTrace(
			{
				items: [
					{ title: "t", canDrillDown: true, card: drillCard(), bodyText: "# would be markdown" },
				],
				maxVisible: 10,
			},
			600,
			{ expandedIndices: [0] },
		);
		expect(r.rows[0]?.cardMeasured).not.toBeNull();
		expect(r.rows[0]?.body).toBeNull();
	});

	it("only the named row opens; its siblings stay at the fixed row height", async () => {
		const { measureCollapsibleTrace, TRACE_ROW_HEIGHT } = await import("./measure-tool-run");
		const r = measureCollapsibleTrace({ items: drillRows(4, [0, 1, 2, 3]), maxVisible: 10 }, 600, {
			expandedIndices: [2],
		});
		expect(r.rows.map((row) => row.cardMeasured != null)).toEqual([false, false, true, false]);
		for (const index of [0, 1, 3]) {
			expect(r.rows[index]?.blockHeight).toBeCloseTo(TRACE_ROW_HEIGHT, 5);
		}
	});

	it("indices address the ORIGINAL item list, not the visible slice", async () => {
		const { measureCollapsibleTrace } = await import("./measure-tool-run");
		// 14 rows, maxVisible 10 → the first 4 fold away, so visible row 0 is item 4.
		const r = measureCollapsibleTrace({ items: drillRows(14, [11]), maxVisible: 10 }, 600, {
			expandedIndices: [11],
		});
		const opened = r.rows.filter((row) => row.cardMeasured != null);
		expect(opened).toHaveLength(1);
		expect(opened[0]?.itemIndex).toBe(11);
	});

	it("measureActivityTrace / measureToolRunSummary forward the drill-down", async () => {
		const { measureActivityTrace, measureToolRunSummary, TRACE_ROW_HEIGHT } = await import(
			"./measure-tool-run"
		);
		const rows = [{ title: "Read · a.ts", canDrillDown: true, card: drillCard(), key: "t-0" }];
		const activity = measureActivityTrace(rows, 600, { expandedIndices: [0] }, {}, 2);
		const summary = measureToolRunSummary(rows, 600, { expandedIndices: [0] }, {}, 3);
		for (const measured of [activity, summary]) {
			expect(measured.rows[0]?.cardMeasured).not.toBeNull();
			expect(measured.rows[0]?.blockHeight).toBeGreaterThan(TRACE_ROW_HEIGHT);
		}
	});
});
