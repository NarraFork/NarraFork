import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE importing any pretext-backed
// module (measure-tool-call builds inline blocks for the pretext-measured detail
// kinds + reuses measure-permission, all of which call pretext at prepare time).
beforeAll(() => {
	installCanvasStub();
});

// ── Shared builders ──────────────────────────────────────────────────────────
async function mod() {
	return import("./measure-tool-call");
}

function baseCard(overrides: Partial<import("./measure-tool-call").ToolCallData> = {}) {
	return {
		toolName: "Read",
		summary: "src/index.ts",
		category: "read" as const,
		status: "success" as const,
		...overrides,
	};
}

// ── Fixed chrome constants ────────────────────────────────────────────────────
describe("measure-tool-call — fixed chrome (CONTRACT §4 ToolCallCard)", () => {
	it("header text line uses base line-height 1.55 → 19px; header row = 19", async () => {
		const m = await mod();
		expect(m.HEADER_TEXT_LINE_HEIGHT).toBe(19);
		expect(m.HEADER_CATEGORY_ICON).toBe(16);
		// The 19px text line is taller than the 16px icon lane.
		expect(m.HEADER_ROW_HEIGHT).toBe(19);
	});

	it("standalone collapsed card ≈ 41px (10*2 padding + 1*2 border + 19 header)", async () => {
		const m = await mod();
		const expected = m.CARD_PADDING * 2 + m.CARD_BORDER * 2 + m.HEADER_ROW_HEIGHT;
		expect(expected).toBe(41);
		// Within the 40-42px target from CONTRACT §4.
		expect(expected).toBeGreaterThanOrEqual(40);
		expect(expected).toBeLessThanOrEqual(42);
	});

	it("exposes the maxHeight cap table (code/term/diff=200, bash=60, media=400, streaming-bash=120)", async () => {
		const { DETAIL_CAPS } = await mod();
		expect(DETAIL_CAPS.code).toBe(200);
		expect(DETAIL_CAPS.term).toBe(200);
		expect(DETAIL_CAPS.diff).toBe(200);
		expect(DETAIL_CAPS["bash-cmd"]).toBe(60);
		expect(DETAIL_CAPS.media).toBe(400);
		expect(DETAIL_CAPS.skill).toBe(400);
		expect(DETAIL_CAPS.knowledge).toBe(400);
		expect(DETAIL_CAPS["streaming-bash"]).toBe(120);
	});
});

// ── Collapsed vs expanded ─────────────────────────────────────────────────────
describe("measureToolCall — collapsed = header only", () => {
	it("a folded card (L4) is exactly the collapsed height, with no detail", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(
			baseCard({ detail: { kind: "capped", cap: "code", contentLines: 50 } }),
			600,
			4,
		);
		expect(r.effectiveOpened).toBe(false);
		expect(r.detail).toBeNull();
		expect(r.height).toBe(r.collapsedHeight);
	});

	it("collapsed height is independent of summary length (header truncates)", async () => {
		const { measureToolCall } = await mod();
		const short = measureToolCall(baseCard({ summary: "a" }), 600, 4);
		const long = measureToolCall(baseCard({ summary: "x".repeat(500) }), 600, 4);
		expect(long.height).toBe(short.height);
	});

	it("in-run card drops the border but adds a 1px divider unless last", async () => {
		const { measureToolCall, CARD_PADDING, HEADER_ROW_HEIGHT, CARD_DIVIDER } = await mod();
		const notLast = measureToolCall(baseCard({ inRun: true, isLast: false }), 600, 4);
		const last = measureToolCall(baseCard({ inRun: true, isLast: true }), 600, 4);
		expect(notLast.hasBorder).toBe(false);
		// in-run chrome = padding only (no border) + divider when not last.
		expect(last.height).toBe(CARD_PADDING * 2 + HEADER_ROW_HEIGHT);
		expect(notLast.height).toBe(last.height + CARD_DIVIDER);
	});
});

describe("measureToolCall — expanded capped detail = min(content, cap)", () => {
	it("short code content is not capped (height grows with content)", async () => {
		const { measureToolCall, DETAIL_CONTENT_LINE_HEIGHT } = await mod();
		const few = measureToolCall(
			baseCard({ detail: { kind: "capped", cap: "code", contentLines: 3 } }),
			600,
			6,
		);
		const more = measureToolCall(
			baseCard({ detail: { kind: "capped", cap: "code", contentLines: 6 } }),
			600,
			6,
		);
		expect(few.detail).not.toBeNull();
		expect(more.detail!.height).toBe(few.detail!.height + 3 * DETAIL_CONTENT_LINE_HEIGHT);
	});

	it("long code content is clamped at the 200px cap", async () => {
		const {
			measureToolCall,
			DETAIL_CAPS,
			DETAIL_LABEL_LINE_HEIGHT,
			DETAIL_LABEL_MARGIN_BOTTOM,
			DETAIL_TOP_MARGIN,
		} = await mod();
		const r = measureToolCall(
			baseCard({ detail: { kind: "capped", cap: "code", contentLines: 500 } }),
			600,
			6,
		);
		// The region = mt="xs" gap + label chrome + body clamped to the cap.
		const labelH = DETAIL_LABEL_LINE_HEIGHT + DETAIL_LABEL_MARGIN_BOTTOM;
		expect(r.detail!.appliedCap).toBe(DETAIL_CAPS.code);
		expect(r.detail!.height).toBe(DETAIL_TOP_MARGIN + labelH + DETAIL_CAPS.code);
	});

	it("bash command cap is 60 (no label)", async () => {
		const { measureToolCall, DETAIL_CAPS, DETAIL_TOP_MARGIN } = await mod();
		const r = measureToolCall(
			baseCard({
				category: "bash",
				detail: { kind: "capped", cap: "bash-cmd", contentLines: 999 },
			}),
			600,
			6,
		);
		expect(r.detail!.appliedCap).toBe(DETAIL_CAPS["bash-cmd"]);
		// bash-cmd has no leading label → region = mt="xs" gap + clamped body.
		expect(r.detail!.height).toBe(DETAIL_TOP_MARGIN + DETAIL_CAPS["bash-cmd"]);
	});

	it("media detail uses a direct pixel estimate clamped at 400", async () => {
		const { measureToolCall, DETAIL_CAPS, DETAIL_TOP_MARGIN } = await mod();
		const small = measureToolCall(
			baseCard({ category: "browser", detail: { kind: "capped", cap: "media", contentPx: 150 } }),
			600,
			6,
		);
		const huge = measureToolCall(
			baseCard({ category: "browser", detail: { kind: "capped", cap: "media", contentPx: 5000 } }),
			600,
			6,
		);
		expect(small.detail!.height).toBe(DETAIL_TOP_MARGIN + 150);
		expect(huge.detail!.height).toBe(DETAIL_TOP_MARGIN + DETAIL_CAPS.media);
	});

	it("plan cap = round(0.85 × viewportHeight), falling back to 400", async () => {
		const { measureToolCall, DETAIL_CAPS, DETAIL_TOP_MARGIN } = await mod();
		const withVp = measureToolCall(
			baseCard({ category: "plan", detail: { kind: "capped", cap: "plan", contentLines: 999 } }),
			600,
			6,
			{ viewportHeight: 1000 },
		);
		// 0.85 × 1000 = 850.
		expect(withVp.detail!.appliedCap).toBe(850);
		expect(withVp.detail!.height).toBe(DETAIL_TOP_MARGIN + 850);
		const noVp = measureToolCall(
			baseCard({ category: "plan", detail: { kind: "capped", cap: "plan", contentLines: 999 } }),
			600,
			6,
		);
		expect(noVp.detail!.appliedCap).toBe(DETAIL_CAPS.plan);
	});

	it("generic detail sums an input + optional output section (each capped 200)", async () => {
		const { measureToolCall } = await mod();
		const inputOnly = measureToolCall(
			baseCard({ category: "generic", detail: { kind: "generic", inputLines: 3 } }),
			600,
			6,
		);
		const both = measureToolCall(
			baseCard({ category: "generic", detail: { kind: "generic", inputLines: 3, outputLines: 3 } }),
			600,
			6,
		);
		expect(inputOnly.detail!.blocks).toHaveLength(1);
		expect(both.detail!.blocks).toHaveLength(2);
		expect(both.detail!.height).toBeGreaterThan(inputOnly.detail!.height);
	});
});

// ── Pretext-measured detail kinds (🔴) ────────────────────────────────────────
describe("measureToolCall — pretext-measured detail (spec-tasks / structured / error)", () => {
	it("spec-tasks height grows with the number of tasks", async () => {
		const { measureToolCall } = await mod();
		const two = measureToolCall(
			baseCard({ category: "tasks", detail: { kind: "spec-tasks", tasks: ["a", "b"] } }),
			600,
			6,
		);
		const four = measureToolCall(
			baseCard({ category: "tasks", detail: { kind: "spec-tasks", tasks: ["a", "b", "c", "d"] } }),
			600,
			6,
		);
		expect(four.detail!.height).toBeGreaterThan(two.detail!.height);
	});

	it("spec-tasks long task text wraps into more lines as width shrinks", async () => {
		const { measureToolCall } = await mod();
		const task = "one two three four five six seven eight nine ten eleven twelve thirteen";
		const wide = measureToolCall(
			baseCard({ category: "tasks", detail: { kind: "spec-tasks", tasks: [task] } }),
			2000,
			6,
		);
		const narrow = measureToolCall(
			baseCard({ category: "tasks", detail: { kind: "spec-tasks", tasks: [task] } }),
			160,
			6,
		);
		expect(narrow.detail!.height).toBeGreaterThan(wide.detail!.height);
	});

	it("structured detail adds a badge row + a body line above the plain-body case", async () => {
		const { measureToolCall, STRUCT_BADGE_ROW, STRUCT_BADGE_GAP, DETAIL_TOP_MARGIN } = await mod();
		const noBadge = measureToolCall(
			baseCard({ category: "recall", detail: { kind: "structured", bodyLines: ["one"] } }),
			600,
			6,
		);
		const withBadge = measureToolCall(
			baseCard({
				category: "recall",
				detail: { kind: "structured", badgeRows: 1, bodyLines: ["one"] },
			}),
			600,
			6,
		);
		// With a badge: mt gap(10) → badge row(16) → badge-gap(4) → body line.
		// Without:      mt gap(10) → body line. The mt="xs" gap simply moves onto
		// the badge block, so the delta is the badge row + the badge-gap.
		expect(DETAIL_TOP_MARGIN).toBeGreaterThan(0); // (documents the cancelled term)
		expect(withBadge.detail!.height).toBe(
			noBadge.detail!.height + STRUCT_BADGE_ROW + STRUCT_BADGE_GAP,
		);
		expect(withBadge.detail!.height).toBeGreaterThan(noBadge.detail!.height);
	});

	it("error detail wraps into more lines as width shrinks", async () => {
		const { measureToolCall } = await mod();
		const text =
			"Command failed with a fairly long multi word error message that must wrap somewhere";
		const wide = measureToolCall(
			baseCard({ status: "fail", detail: { kind: "error", text } }),
			2000,
			6,
		);
		const narrow = measureToolCall(
			baseCard({ status: "fail", detail: { kind: "error", text } }),
			160,
			6,
		);
		expect(narrow.detail!.height).toBeGreaterThan(wide.detail!.height);
	});
});

// ── LOD / effectiveOpened combinations ────────────────────────────────────────
describe("resolveToolCallOpened — LOD gate mirrors ToolCallCard :5594", () => {
	it("L6 always expands; L4 always collapses", async () => {
		const { resolveToolCallOpened } = await mod();
		const base = { lodExempt: false, isRecent: true, opened: true };
		expect(resolveToolCallOpened(6, base)).toBe(true);
		expect(resolveToolCallOpened(4, base)).toBe(false);
	});

	it("L5 follows `opened` for recent cards, collapses older cards", async () => {
		const { resolveToolCallOpened } = await mod();
		expect(resolveToolCallOpened(5, { lodExempt: false, isRecent: true, opened: true })).toBe(true);
		expect(resolveToolCallOpened(5, { lodExempt: false, isRecent: true, opened: false })).toBe(
			false,
		);
		// Older card at L5 collapses regardless of `opened`.
		expect(resolveToolCallOpened(5, { lodExempt: false, isRecent: false, opened: true })).toBe(
			false,
		);
	});

	it("lodExempt (running / streaming / pending) always expands, even at L1", async () => {
		const { resolveToolCallOpened } = await mod();
		expect(resolveToolCallOpened(1, { lodExempt: true, isRecent: false, opened: false })).toBe(
			true,
		);
		expect(resolveToolCallOpened(4, { lodExempt: true, isRecent: false, opened: false })).toBe(
			true,
		);
	});

	it("L1-L3 collapse (upstream tool-run gate owns these levels)", async () => {
		const { resolveToolCallOpened } = await mod();
		const base = { lodExempt: false, isRecent: true, opened: true };
		expect(resolveToolCallOpened(1, base)).toBe(false);
		expect(resolveToolCallOpened(2, base)).toBe(false);
		expect(resolveToolCallOpened(3, base)).toBe(false);
	});

	it("explicit LOD override expands L4 and old-L5 cards", async () => {
		const { resolveToolCallOpened } = await mod();
		expect(
			resolveToolCallOpened(4, {
				lodExempt: false,
				isRecent: true,
				opened: false,
				lodUserOverride: true,
			}),
		).toBe(true);
		expect(
			resolveToolCallOpened(5, {
				lodExempt: false,
				isRecent: false,
				opened: false,
				lodUserOverride: true,
			}),
		).toBe(true);
	});
});

describe("measureToolCall — running/pending cards are lodExempt", () => {
	it("a running card stays expanded at L4 (would otherwise collapse)", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(
			baseCard({ status: "running", detail: { kind: "capped", cap: "term", contentLines: 5 } }),
			600,
			4,
		);
		expect(r.lodExempt).toBe(true);
		expect(r.effectiveOpened).toBe(true);
		expect(r.detail).not.toBeNull();
		expect(r.height).toBeGreaterThan(r.collapsedHeight);
	});

	it("computeDefaultOpen auto-opens tasks/recall/plan and failed cards", async () => {
		const { computeDefaultOpen } = await mod();
		expect(computeDefaultOpen(baseCard({ category: "tasks" }), false)).toBe(true);
		expect(computeDefaultOpen(baseCard({ category: "recall" }), false)).toBe(true);
		expect(computeDefaultOpen(baseCard({ category: "plan" }), false)).toBe(true);
		expect(computeDefaultOpen(baseCard({ status: "fail" }), false)).toBe(true);
		// A plain successful read is collapsed by default.
		expect(computeDefaultOpen(baseCard(), false)).toBe(false);
		// Pending permission forces open regardless of category.
		expect(computeDefaultOpen(baseCard(), true)).toBe(true);
	});
});

// ── Pending permission ────────────────────────────────────────────────────────
describe("measureToolCall — pendingPermission adds the InlinePermission UI", () => {
	it("pending card is lodExempt, expanded, and includes the permission region", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(baseCard({ category: "file", toolName: "Write" }), 600, 4, {
			pendingPermission: { hasExecutionTarget: true, feedbackRows: 1, buttonCount: 2 },
		});
		expect(r.lodExempt).toBe(true);
		expect(r.effectiveOpened).toBe(true);
		expect(r.permission).not.toBeNull();
		// Permission region (+ its own top margin) is added on top of the header.
		expect(r.height).toBeGreaterThan(r.collapsedHeight);
	});

	it("permission height matches measureInlinePermission at the inner width", async () => {
		const { measureToolCall, toolCardInnerWidth } = await mod();
		const { measureInlinePermission } = await import("./measure-permission");
		const perm = { hasExecutionTarget: true, feedbackRows: 2, buttonCount: 2 } as const;
		const r = measureToolCall(baseCard({ category: "file", toolName: "Write" }), 600, 6, {
			pendingPermission: perm,
		});
		const inner = toolCardInnerWidth(600, false);
		const direct = measureInlinePermission(perm, inner, 6);
		expect(r.permission!.height).toBe(direct.height);
		// The card height includes the permission top margin + its height.
		expect(r.height).toBe(
			r.chromeY + r.headerHeight + r.permission!.topMargin + r.permission!.height,
		);
	});

	it("detail + permission stack: permissionTop sits below the detail region", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(
			baseCard({
				category: "file",
				toolName: "Write",
				detail: { kind: "capped", cap: "diff", contentLines: 4 },
			}),
			600,
			6,
			{ pendingPermission: { hasExecutionTarget: true, buttonCount: 2 } },
		);
		expect(r.detail).not.toBeNull();
		expect(r.permission).not.toBeNull();
		expect(r.permissionTop).toBe(r.headerHeight + r.detail!.height);
	});
});

// ── Grouped card ──────────────────────────────────────────────────────────────
describe("measureToolCallGroup — header + accumulated child cards", () => {
	it("collapsed group is header only (default)", async () => {
		const { measureToolCallGroup } = await mod();
		const g = measureToolCallGroup(
			[baseCard({ toolName: "Read" }), baseCard({ toolName: "Read" })],
			600,
		);
		expect(g.expanded).toBe(false);
		expect(g.children).toHaveLength(0);
		expect(g.height).toBe(g.collapsedHeight);
		expect(g.childCount).toBe(2);
	});

	it("expanded group height = header + margin + Σ child card heights", async () => {
		const {
			measureToolCallGroup,
			toolGroupBodyInnerWidth,
			measureToolCall,
			GROUP_BODY_MARGIN_TOP,
		} = await mod();
		const cards = [baseCard({ toolName: "Read" }), baseCard({ toolName: "Read" })];
		const g = measureToolCallGroup(cards, 600, 5, { expanded: true });
		expect(g.children).toHaveLength(2);

		const inner = toolGroupBodyInnerWidth(600);
		const childSum = cards
			.map((c) => measureToolCall({ ...c, inRun: false }, inner, 5, { isRecent: true }).height)
			.reduce((a, b) => a + b, 0);
		expect(g.height).toBe(g.chromeY + g.headerHeight + GROUP_BODY_MARGIN_TOP + childSum);
	});

	it("more children → taller expanded group", async () => {
		const { measureToolCallGroup } = await mod();
		const two = measureToolCallGroup([baseCard(), baseCard()], 600, 5, { expanded: true });
		const three = measureToolCallGroup([baseCard(), baseCard(), baseCard()], 600, 5, {
			expanded: true,
		});
		expect(three.height).toBeGreaterThan(two.height);
	});
});

// ── Structural MeasuredElement contract ───────────────────────────────────────
describe("measureToolCall — MeasuredElement shape", () => {
	it("returns a well-formed MeasuredElement (blocks/frame/contentWidth/usedWidth)", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(baseCard(), 600, 6);
		expect(r.blocks.length).toBeGreaterThan(0);
		expect(r.blocks[0]?.kind).toBe("fixed");
		expect(r.frame.blocks.length).toBe(r.blocks.length);
		expect(r.usedWidth).toBe(600);
		expect(r.contentWidth).toBeLessThan(600); // inner width < outer
	});

	it("prepareToolCallMeasurer re-measures across widths/LODs", async () => {
		const { prepareToolCallMeasurer } = await mod();
		const measure = prepareToolCallMeasurer(
			baseCard({ category: "tasks", detail: { kind: "spec-tasks", tasks: ["x".repeat(80)] } }),
		);
		const collapsed = measure(600, 4);
		const wide = measure(2000, 6);
		const narrow = measure(160, 6);
		expect(collapsed.effectiveOpened).toBe(false);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});
});
