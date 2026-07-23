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
