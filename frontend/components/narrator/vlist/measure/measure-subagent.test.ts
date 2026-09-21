import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE importing any pretext-backed
// module (measure-subagent → measure-markdown / measure-permission call pretext
// at prepare time).
beforeAll(() => {
	installCanvasStub();
});

const WIDTH = 600;

/** Minimal terminal card: a finished agent with a short description. */
const BASE = {
	agentType: "explore",
	description: "Investigate the auth flow",
	isTerminal: true,
};

describe("resolveSubagentExpanded — LOD / exemption main switch", () => {
	it("lodExempt (active | selfPermission | pending) is always expanded", async () => {
		const { resolveSubagentExpanded } = await import("./measure-subagent");
		const base = { isRecent: false, opened: false };
		// active
		expect(
			resolveSubagentExpanded(4, {
				...base,
				isActive: true,
				hasSelfPermission: false,
				pendingPermissionCount: 0,
			}),
		).toBe(true);
		// self permission
		expect(
			resolveSubagentExpanded(4, {
				...base,
				isActive: false,
				hasSelfPermission: true,
				pendingPermissionCount: 0,
			}),
		).toBe(true);
		// pending permissions
		expect(
			resolveSubagentExpanded(4, {
				...base,
				isActive: false,
				hasSelfPermission: false,
				pendingPermissionCount: 2,
			}),
		).toBe(true);
	});

	it.each([
		2, 3, 4, 5,
	] as const)("L%i expands untouched cards regardless of recency and honours explicit folding", async (lod) => {
		const { measureSubagentCard, resolveSubagentExpanded } = await import("./measure-subagent");
		for (const isRecent of [false, true]) {
			const input = {
				isActive: false,
				hasSelfPermission: false,
				pendingPermissionCount: 0,
				isRecent,
				opened: false,
			};
			expect(resolveSubagentExpanded(lod, input)).toBe(true);
			expect(resolveSubagentExpanded(lod, { ...input, userCollapsed: true })).toBe(false);
			expect(
				resolveSubagentExpanded(lod, { ...input, userCollapsed: true, lodUserOverride: true }),
			).toBe(true);
			expect(measureSubagentCard(BASE, WIDTH, lod, { isRecent }).effectiveExpanded).toBe(true);
			expect(
				measureSubagentCard(BASE, WIDTH, lod, { isRecent, opened: false }).effectiveExpanded,
			).toBe(false);
			expect(
				measureSubagentCard(BASE, WIDTH, lod, { isRecent, opened: true }).effectiveExpanded,
			).toBe(true);
		}
	});

	it("L1 folds even a sole/default-open card, but keeps manual overrides and live controls", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		for (const opened of [undefined, false, true]) {
			const opts = { opened, isRecent: true };
			expect(measureSubagentCard(BASE, WIDTH, 1, opts).effectiveExpanded).toBe(false);
			expect(
				measureSubagentCard(BASE, WIDTH, 1, { ...opts, lodUserOverride: true }).effectiveExpanded,
			).toBe(true);
			for (const exemption of [
				{ isActive: true },
				{ hasSelfPermission: true },
				{ pendingPermissionCount: 1 },
			]) {
				expect(
					measureSubagentCard(BASE, WIDTH, 1, { ...opts, ...exemption }).effectiveExpanded,
				).toBe(true);
			}
		}
	});

	// L5 used to return a bare `true`, making this card's header chevron dead there
	// (same defect the tool card had): the shell writes the click into the `expanded`
	// map, which that branch never read. `userCollapsed` is deliberately separate
	// from `opened === false` — the latter is also this measure's DEFAULT, so reading
	// it at L5 would collapse every untouched card.
	it("L5 honours an explicit fold but ignores a derived `opened: false`", async () => {
		const { resolveSubagentExpanded } = await import("./measure-subagent");
		const inert = { isActive: false, hasSelfPermission: false, pendingPermissionCount: 0 };
		expect(
			resolveSubagentExpanded(5, {
				...inert,
				isRecent: true,
				opened: false,
				userCollapsed: true,
			}),
		).toBe(false);
		expect(resolveSubagentExpanded(5, { ...inert, isRecent: true, opened: false })).toBe(true);
		// An exempt card (active / awaiting permission) cannot be folded away: its
		// permission form would have nowhere to live.
		expect(
			resolveSubagentExpanded(5, {
				...inert,
				isActive: true,
				isRecent: true,
				opened: false,
				userCollapsed: true,
			}),
		).toBe(true);
	});
});

describe("measureSubagentCard — collapsed header (55-75px)", () => {
	it("collapsed with no result preview ≈ 56px (padding + badge + desc)", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		// Explicitly folded; not recent, terminal, no result.
		const r = measureSubagentCard(BASE, WIDTH, 3, { isRecent: false, opened: false });
		expect(r.effectiveExpanded).toBe(false);
		// header = pad*2 + badge row + descMt + xs line ; + border*2 (not inRun).
		const expectedHeader =
			c.CARD_PADDING * 2 + c.badgeRowHeight() + c.DESC_MARGIN_TOP + c.XS_LINE_HEIGHT;
		expect(r.headerHeight).toBe(expectedHeader);
		expect(r.headerHeight).toBe(56);
		expect(r.hasResultPreview).toBe(false);
		expect(r.height).toBe(expectedHeader + c.CARD_BORDER * 2);
		expect(r.height).toBeGreaterThanOrEqual(55);
		expect(r.height).toBeLessThanOrEqual(75);
	});

	it("collapsed WITH terminal result preview adds one line (≈75px)", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		const r = measureSubagentCard(
			{ ...BASE, resultBody: bodyFixture("output.main", "The auth flow uses JWT bearer tokens.") },
			WIDTH,
			3,
			{ isRecent: false, opened: false },
		);
		expect(r.effectiveExpanded).toBe(false);
		expect(r.hasResultPreview).toBe(true);
		const expectedHeader =
			c.CARD_PADDING * 2 +
			c.badgeRowHeight() +
			c.DESC_MARGIN_TOP +
			c.XS_LINE_HEIGHT +
			(c.RESULT_PREVIEW_MARGIN_TOP + c.XS_LINE_HEIGHT);
		expect(r.headerHeight).toBe(expectedHeader);
		expect(r.headerHeight).toBe(75);
		expect(r.height).toBeLessThanOrEqual(75 + c.CARD_BORDER * 2);
	});

	it("collapsed description is a single fixed line regardless of length", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const short = measureSubagentCard(BASE, WIDTH, 3, { opened: false });
		const long = measureSubagentCard({ ...BASE, description: "x ".repeat(400) }, WIDTH, 3, {
			opened: false,
		});
		expect(short.headerHeight).toBe(long.headerHeight);
		expect(short.descriptionMeasured).toBeNull();
	});
});

describe("measureSubagentCard — expanded body", () => {
	it("expanded wraps a long description into more lines than the collapsed truncate", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		// A long description: collapsed truncates to 1 line; expanded wraps to many.
		const longDesc = { ...BASE, description: "word ".repeat(120).trim() };
		const collapsed = measureSubagentCard(longDesc, WIDTH, 3, { opened: false });
		const expanded = measureSubagentCard(longDesc, WIDTH, 5, {});
		expect(collapsed.effectiveExpanded).toBe(false);
		expect(expanded.effectiveExpanded).toBe(true);
		// Expanded description wraps → carries a measured markdown/inline body.
		expect(expanded.descriptionMeasured).not.toBeNull();
		expect(expanded.descriptionHeight).toBeGreaterThan(collapsed.descriptionHeight);
		expect(expanded.height).toBeGreaterThan(collapsed.height);
	});

	it("expanding a card with a body region is taller than collapsed", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const data = { ...BASE, resultBody: bodyFixture("output.main", "one line result") };
		const collapsed = measureSubagentCard(data, WIDTH, 3, { opened: false });
		const expanded = measureSubagentCard(data, WIDTH, 5, {});
		// Collapsed shows only a result-preview line; expanded reveals the full
		// result ContentViewer block → strictly taller.
		expect(expanded.height).toBeGreaterThan(collapsed.height);
		expect(expanded.resultBlockHeight).toBeGreaterThan(0);
	});

	it("expanded result is capped at maxHeight:300 (min(content, cap))", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		const short = measureSubagentCard(
			{ ...BASE, resultBody: bodyFixture("output.main", "one line result") },
			WIDTH,
			5,
			{},
		);
		const huge = measureSubagentCard(
			{
				...BASE,
				resultBody: bodyFixture(
					"output.main",
					Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n\n"),
				),
			},
			WIDTH,
			5,
			{},
		);
		// Short result block is well under the cap.
		expect(short.resultBlockHeight).toBeLessThan(c.RESULT_MAX_HEIGHT + c.BLOCK_PADDING_BOTTOM);
		// Huge result is clamped to the 300px cap (+ bottom padding chrome).
		expect(huge.resultBlockHeight).toBe(c.RESULT_MAX_HEIGHT + c.BLOCK_PADDING_BOTTOM);
		expect(huge.resultBlockHeight).toBeGreaterThan(short.resultBlockHeight);
	});

	it("prompt block: toggle row only when closed, + capped body when open (maxHeight:200)", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		const closed = measureSubagentCard(
			{ ...BASE, promptBody: bodyFixture("input.prompt", "do the thing"), promptOpen: false },
			WIDTH,
			5,
			{},
		);
		// Closed prompt = toggle row + bottom padding.
		expect(closed.promptBlockHeight).toBe(c.PROMPT_TOGGLE_ROW_HEIGHT + c.BLOCK_PADDING_BOTTOM);

		const openShort = measureSubagentCard(
			{ ...BASE, promptBody: bodyFixture("input.prompt", "short prompt"), promptOpen: true },
			WIDTH,
			5,
			{},
		);
		expect(openShort.promptBlockHeight).toBeGreaterThan(closed.promptBlockHeight);
		expect(openShort.promptMeasured).not.toBeNull();

		const openHuge = measureSubagentCard(
			{
				...BASE,
				promptBody: bodyFixture(
					"input.prompt",
					Array.from({ length: 400 }, (_, i) => `prompt line ${i}`).join("\n"),
				),
				promptOpen: true,
			},
			WIDTH,
			5,
			{},
		);
		// Body is capped at 200 → block = toggle + (mt + 200) + bottom padding.
		expect(openHuge.promptBlockHeight).toBe(
			c.PROMPT_TOGGLE_ROW_HEIGHT +
				c.PROMPT_BODY_MARGIN_TOP +
				c.PROMPT_MAX_HEIGHT +
				c.BLOCK_PADDING_BOTTOM,
		);
	});

	it("expanded body grows monotonically as regions are added", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const bare = measureSubagentCard(BASE, WIDTH, 5, {});
		const withPrompt = measureSubagentCard(
			{ ...BASE, promptBody: bodyFixture("input.prompt", "p") },
			WIDTH,
			5,
			{},
		);
		const withResult = measureSubagentCard(
			{ ...BASE, resultBody: bodyFixture("output.main", "r") },
			WIDTH,
			5,
			{},
		);
		const withBoth = measureSubagentCard(
			{
				...BASE,
				promptBody: bodyFixture("input.prompt", "p"),
				resultBody: bodyFixture("output.main", "r"),
			},
			WIDTH,
			5,
			{},
		);
		expect(withPrompt.height).toBeGreaterThan(bare.height);
		expect(withResult.height).toBeGreaterThan(bare.height);
		expect(withBoth.height).toBeGreaterThan(withPrompt.height);
		expect(withBoth.height).toBeGreaterThan(withResult.height);
	});

	it("resolveOverride adds a button block when present", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		const without = measureSubagentCard(BASE, WIDTH, 5, {});
		const withOverride = measureSubagentCard({ ...BASE, hasResolveOverride: true }, WIDTH, 5, {});
		expect(withOverride.resolveOverrideHeight).toBe(
			c.RESOLVE_OVERRIDE_BUTTON_HEIGHT + c.BLOCK_PADDING_BOTTOM,
		);
		expect(withOverride.height).toBe(without.height + withOverride.resolveOverrideHeight);
	});
});

describe("measureSubagentCard — recent calls (independent of expansion)", () => {
	it("recent calls show even when collapsed; ≤3 rows", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		const none = measureSubagentCard(BASE, WIDTH, 3, { opened: false });
		expect(none.recentCallsHeight).toBe(0);

		const three = measureSubagentCard({ ...BASE, recentCallCount: 3 }, WIDTH, 3, { opened: false });
		expect(three.effectiveExpanded).toBe(false);
		expect(three.recentRowCount).toBe(3);
		expect(three.recentCallsHeight).toBeGreaterThan(0);

		// >3 is clamped to 3 rows.
		const five = measureSubagentCard({ ...BASE, recentCallCount: 5 }, WIDTH, 3, { opened: false });
		expect(five.recentRowCount).toBe(3);
		expect(five.recentCallsHeight).toBe(three.recentCallsHeight);

		// Row math: title + mb + 3 rows + 2 gaps + bottom padding.
		const expected =
			c.XS_LINE_HEIGHT +
			c.RECENT_TITLE_MARGIN_BOTTOM +
			(3 * c.RECENT_ROW_HEIGHT + 2 * c.RECENT_STACK_GAP) +
			c.BLOCK_PADDING_BOTTOM;
		expect(three.recentCallsHeight).toBe(expected);
	});

	it("recent-calls title button row uses the taller compact-xs when present", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		const withBtn = measureSubagentCard(
			{ ...BASE, recentCallCount: 1, hasRecentCallsButton: true },
			WIDTH,
			3,
			{},
		);
		const titleRow = Math.max(c.XS_LINE_HEIGHT, c.BUTTON_COMPACT_XS);
		const expected =
			titleRow + c.RECENT_TITLE_MARGIN_BOTTOM + c.RECENT_ROW_HEIGHT + c.BLOCK_PADDING_BOTTOM;
		expect(withBtn.recentCallsHeight).toBe(expected);
	});
});

describe("measureSubagentCard — timing passthrough (header + recent rows)", () => {
	it("carries the card's own stamps, nulling what is absent", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const m = measureSubagentCard(
			{ ...BASE, timing: { executionStartedAt: 1_000, completedAt: 4_000, durationMs: 3_000 } },
			WIDTH,
			3,
			{},
		);
		expect(m.timing).toEqual({
			startedAt: null,
			streamStartedAt: null,
			streamCompletedAt: null,
			permissionStartedAt: null,
			executionStartedAt: 1_000,
			completedAt: 4_000,
			createdAt: null,
			durationMs: 3_000,
		});
	});

	it("slices recentCallTimings to the DRAWN rows so index i pairs with row i", async () => {
		// The renderer indexes this array positionally against the names it paints; a
		// longer list would mis-pair the 4th call's duration onto no row at all.
		const { measureSubagentCard } = await import("./measure-subagent");
		const m = measureSubagentCard(
			{
				...BASE,
				recentCallCount: 5,
				recentCallTimings: [
					{ status: "success", durationMs: 10 },
					{ status: "success", durationMs: 20 },
					{ status: "running", streamStartedAt: 30 },
					{ status: "success", durationMs: 40 },
				],
			},
			WIDTH,
			3,
			{},
		);
		expect(m.recentRowCount).toBe(3);
		expect(m.recentCallTimings).toHaveLength(3);
		expect(m.recentCallTimings[2]).toMatchObject({ status: "running", streamStartedAt: 30 });
	});

	it("defaults to an empty row list and a null-filled header record", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const m = measureSubagentCard(BASE, WIDTH, 3, { opened: false });
		expect(m.recentCallTimings).toEqual([]);
		expect(m.timing.durationMs).toBeNull();
	});

	it("timing is HEIGHT-NEUTRAL (header row + recent rows are fixed)", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const rows = { ...BASE, recentCallCount: 3 };
		const bare = measureSubagentCard(rows, WIDTH, 5, { opened: true });
		const timed = measureSubagentCard(
			{
				...rows,
				timing: { startedAt: 1, completedAt: 999_999, durationMs: 999_998 },
				recentCallTimings: [
					{ status: "success", durationMs: 111_111 },
					{ status: "success", durationMs: 222_222 },
					{ status: "success", durationMs: 333_333 },
				],
			},
			WIDTH,
			5,
			{ opened: true },
		);
		expect(timed.height).toBe(bare.height);
		expect(timed.headerHeight).toBe(bare.headerHeight);
		expect(timed.recentCallsHeight).toBe(bare.recentCallsHeight);
	});
});

describe("measureSubagentCard — permission integration (P11) + P10 dependency", () => {
	it("selfPermission forces expansion + adds an InlinePermission block (P11)", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const { measureInlinePermission } = await import("./measure-permission");
		const r = measureSubagentCard(
			{
				...BASE,
				isTerminal: true,
				selfPermission: { hasExecutionTarget: true, buttonCount: 2 },
			},
			WIDTH,
			3, // even at L3, a self-permission is lodExempt → expanded.
			{},
		);
		expect(r.effectiveExpanded).toBe(true);
		expect(r.selfPermissionMeasured).not.toBeNull();
		// The measured perm height matches P11's measureInlinePermission at the
		// inset width (contentWidth - 2×mx).
		const permWidth = WIDTH - 10 * 2;
		const perm = measureInlinePermission(
			{ hasExecutionTarget: true, buttonCount: 2 },
			permWidth,
			4,
		);
		expect(r.selfPermissionMeasured?.height).toBe(perm.height);
		expect(r.selfPermissionBlockHeight).toBe(perm.height + 10);
	});

	it("pending permissions force expansion; placeholder used without P10 detail", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		const r = measureSubagentCard(BASE, WIDTH, 3, { pendingPermissionCount: 2 });
		expect(r.effectiveExpanded).toBe(true);
		expect(r.pendingCardCount).toBe(2);
		// 2 placeholder cards (200 each + 2px border) + 1 gap + title + mb + bottom pad.
		const cards =
			2 * (c.PENDING_PERMISSION_CARD_PLACEHOLDER + c.PENDING_CARD_BORDER * 2) + c.PENDING_STACK_GAP;
		const expected =
			c.PENDING_TITLE_ROW_HEIGHT + c.PENDING_TITLE_MARGIN_BOTTOM + cards + c.BLOCK_PADDING_BOTTOM;
		expect(r.pendingBlockHeight).toBe(expected);
	});

	it("pending permissions with P11 detail refine the card estimate", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		const { measureInlinePermission } = await import("./measure-permission");
		const detail = { hasExecutionTarget: true, buttonCount: 2 };
		const r = measureSubagentCard({ ...BASE, pendingPermissions: [detail] }, WIDTH, 3, {
			opened: false,
		});
		expect(r.pendingCardCount).toBe(1);
		const cardInner = WIDTH - c.BLOCK_PADDING_X * 2 - c.PENDING_CARD_BORDER * 2;
		const perm = measureInlinePermission(detail, cardInner, 3);
		const cardBody = c.TOOLCALL_HEADER_ESTIMATE + perm.height + c.PENDING_CARD_BORDER * 2;
		const expected =
			c.PENDING_TITLE_ROW_HEIGHT +
			c.PENDING_TITLE_MARGIN_BOTTOM +
			cardBody +
			c.BLOCK_PADDING_BOTTOM;
		expect(r.pendingBlockHeight).toBe(expected);
	});
});

describe("measureSubagentCard — outer frame (inRun vs Paper)", () => {
	it("inRun=false adds a Paper border; inRun=true removes it", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		const boxed = measureSubagentCard(BASE, WIDTH, 3, { inRun: false });
		const inRun = measureSubagentCard(BASE, WIDTH, 3, { inRun: true, isLast: true });
		expect(boxed.borderHeight).toBe(c.CARD_BORDER * 2);
		expect(inRun.borderHeight).toBe(0);
		expect(inRun.dividerHeight).toBe(0);
		expect(boxed.height).toBe(inRun.height + c.CARD_BORDER * 2);
	});

	it("inRun && !isLast adds a 1px divider", async () => {
		const c = await import("./measure-subagent");
		const { measureSubagentCard } = c;
		const notLast = measureSubagentCard(BASE, WIDTH, 3, { inRun: true, isLast: false });
		const last = measureSubagentCard(BASE, WIDTH, 3, { inRun: true, isLast: true });
		expect(notLast.dividerHeight).toBe(c.DIVIDER_HEIGHT);
		expect(last.dividerHeight).toBe(0);
		expect(notLast.height).toBe(last.height + c.DIVIDER_HEIGHT);
	});
});

describe("measureSubagentCard — width sensitivity + reusable measurer", () => {
	it("expanded description wraps into more lines as width shrinks", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
		const wide = measureSubagentCard({ ...BASE, description: text }, 2000, 5, {});
		const narrow = measureSubagentCard({ ...BASE, description: text }, 160, 5, {});
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	it("re-measures the same subagent data across widths/LODs", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const data = {
			...BASE,
			description: "a recurring subagent description phrase for wrapping",
			resultBody: bodyFixture("output.main", "some result body"),
		};
		const collapsed = measureSubagentCard(data, WIDTH, 3, { opened: false });
		const expanded = measureSubagentCard(data, WIDTH, 5, {});
		expect(collapsed.effectiveExpanded).toBe(false);
		expect(expanded.effectiveExpanded).toBe(true);
		expect(expanded.height).toBeGreaterThan(collapsed.height);
	});
});

/**
 * File changes are the one subagent-card field that is HEIGHT-AFFECTING rather than a
 * height-neutral passthrough: it is a row LIST, so each visible entry makes the card
 * taller. That is why the visible count is capped — one parent in real data
 * aggregated 220 changed files, which uncapped would let a single card fill the
 * viewport.
 */
describe("measureSubagent — file changes", () => {
	/** Minimal terminal card; the file block only exists in the expanded region. */
	const baseCard = () => ({
		agentType: "general",
		description: "do the thing",
		isTerminal: true,
	});
	const file = (filePath: string, over: Record<string, unknown> = {}) => ({
		filePath,
		linesAdded: 1,
		linesRemoved: 0,
		editCount: 1,
		...over,
	});
	const changes = (count: number, over: Record<string, unknown> = {}) => ({
		files: Array.from({ length: count }, (_, i) => file(`f${i}.ts`)),
		totalFiles: count,
		totalUnmeasured: 0,
		bashTouchedCount: 0,
		countsTruncated: false,
		...over,
	});

	it("adds no height when the subagent changed nothing", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const bare = measureSubagentCard(baseCard(), 600, 5);
		const withEmpty = measureSubagentCard({ ...baseCard(), fileChanges: changes(0) }, 600, 5);
		expect(withEmpty.height).toBe(bare.height);
		expect(withEmpty.fileChangesHeight).toBe(0);
	});

	it("grows with each visible file row", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const one = measureSubagentCard({ ...baseCard(), fileChanges: changes(1) }, 600, 5);
		const three = measureSubagentCard({ ...baseCard(), fileChanges: changes(3) }, 600, 5);
		expect(three.height).toBeGreaterThan(one.height);
		expect(three.fileChangeRowCount).toBe(3);
	});

	it("caps the visible rows so a 220-file aggregate cannot fill the viewport", async () => {
		const { measureSubagentCard, FILE_CHANGE_MAX_ROWS, FILE_CHANGE_ROW_HEIGHT } = await import(
			"./measure-subagent"
		);
		const capped = measureSubagentCard({ ...baseCard(), fileChanges: changes(220) }, 600, 5);
		expect(capped.fileChangeRowCount).toBe(FILE_CHANGE_MAX_ROWS);
		// It is taller than an exactly-at-cap card by precisely ONE row — the overflow
		// row, which the at-cap card does not need because it hides nothing. Anything
		// more would mean the hidden 215 files are still costing height.
		const atCap = measureSubagentCard(
			{ ...baseCard(), fileChanges: changes(FILE_CHANGE_MAX_ROWS) },
			600,
			5,
		);
		expect(atCap.hasFileChangeOverflowRow).toBe(false);
		expect(capped.height - atCap.height).toBeCloseTo(FILE_CHANGE_ROW_HEIGHT, 5);
		// The real invariant: 220 files cost the same as 20 do.
		const many = measureSubagentCard({ ...baseCard(), fileChanges: changes(20) }, 600, 5);
		expect(capped.height).toBe(many.height);
	});

	it("draws every row once the reader expands the list", async () => {
		const { measureSubagentCard, FILE_CHANGE_MAX_ROWS } = await import("./measure-subagent");
		const collapsed = measureSubagentCard({ ...baseCard(), fileChanges: changes(12) }, 600, 5);
		const expanded = measureSubagentCard(
			{ ...baseCard(), fileChanges: changes(12), fileChangesExpanded: true },
			600,
			5,
		);
		expect(collapsed.fileChangeRowCount).toBe(FILE_CHANGE_MAX_ROWS);
		expect(expanded.fileChangeRowCount).toBe(12);
		expect(expanded.height).toBeGreaterThan(collapsed.height);
	});

	it("reserves the overflow row whenever anything is hidden or unmeasured", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		// Hidden files.
		expect(
			measureSubagentCard({ ...baseCard(), fileChanges: changes(12) }, 600, 5)
				.hasFileChangeOverflowRow,
		).toBe(true);
		// Nothing hidden, but shell-touched files must still be disclosed.
		expect(
			measureSubagentCard(
				{ ...baseCard(), fileChanges: changes(1, { bashTouchedCount: 4 }) },
				600,
				5,
			).hasFileChangeOverflowRow,
		).toBe(true);
		// Nothing hidden, but an unmeasured tally must not vanish.
		expect(
			measureSubagentCard(
				{ ...baseCard(), fileChanges: changes(1, { totalUnmeasured: 2 }) },
				600,
				5,
			).hasFileChangeOverflowRow,
		).toBe(true);
		// Fully listed, fully measured → no overflow row.
		expect(
			measureSubagentCard({ ...baseCard(), fileChanges: changes(2) }, 600, 5)
				.hasFileChangeOverflowRow,
		).toBe(false);
	});

	it.each([
		{ bashTouchedCount: 3 },
		{ countsTruncated: true },
		{ totalUnmeasured: 2 },
		{ totalFiles: 7 },
	])("reserves summary-only blocks without negative file gaps: %j", async (summary) => {
		const { measureSubagentCard, BLOCK_PADDING_BOTTOM } = await import("./measure-subagent");
		const measured = measureSubagentCard(
			{ ...baseCard(), fileChanges: changes(0, summary) },
			600,
			5,
		);
		expect(measured.fileChangeRowCount).toBe(0);
		expect(measured.hasFileChangeOverflowRow).toBe(true);
		expect(measured.fileChangeNoticeRowCount).toBe(0);
		// Title + summary, and NO seam between nonexistent files.
		expect(measured.fileChangesHeight).toBeCloseTo(
			2 * measured.fileChangeRowHeight + BLOCK_PADDING_BOTTOM,
			5,
		);
	});

	it("reserves legacy and optional boundary notices, including old payloads", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const oldPayload = measureSubagentCard({ ...baseCard(), fileChanges: changes(1) }, 600, 5);
		const scoped = measureSubagentCard(
			{
				...baseCard(),
				fileChanges: changes(1, {
					attributionScope: "legacy_unscoped",
					scope: { sourceToolUseId: "parent-call", startedAt: null, completedAt: null },
				}),
			},
			600,
			5,
		);
		expect(oldPayload.fileChangeNoticeRowCount).toBe(1);
		expect(scoped.fileChangeNoticeRowCount).toBe(2);
		expect(scoped.fileChangesHeight - oldPayload.fileChangesHeight).toBeCloseTo(
			scoped.fileChangeRowHeight,
			5,
		);
	});

	it("keeps a collapse affordance after expanding every file", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const expanded = measureSubagentCard(
			{ ...baseCard(), fileChanges: changes(12), fileChangesExpanded: true },
			600,
			5,
		);
		expect(expanded.fileChangeRowCount).toBe(12);
		expect(expanded.hasFileChangeOverflowRow).toBe(true);
		const folded = measureSubagentCard(
			{ ...baseCard(), fileChanges: changes(0, { bashTouchedCount: 2 }) },
			600,
			5,
			{ opened: false },
		);
		expect(folded.effectiveExpanded).toBe(false);
		expect(folded.fileChangesHeight).toBe(0);
	});

	it("keeps device/workspace/child identity and unknown location distinct", async () => {
		const { subagentFileChangeIdentityKey, measureSubagentCard } = await import(
			"./measure-subagent"
		);
		const rows = [
			{ ...file("same.ts"), deviceId: "remote-a", workspacePath: "/repo" },
			{ ...file("same.ts"), deviceId: "remote-b", workspacePath: "/repo" },
			{ ...file("same.ts"), deviceId: "remote-a", workspacePath: "/other" },
			{
				...file("same.ts"),
				deviceId: "remote-a",
				workspacePath: "/repo",
				subagentNarratorId: "other",
			},
			file("same.ts"),
		];
		expect(new Set(rows.map(subagentFileChangeIdentityKey)).size).toBe(rows.length);
		expect(subagentFileChangeIdentityKey(file("same.ts"))).toBe(
			JSON.stringify([null, null, null, "same.ts"]),
		);
		const measured = measureSubagentCard(
			{ ...baseCard(), fileChanges: { ...changes(5), files: rows } },
			600,
			5,
		);
		expect(measured.fileChangeRowCount).toBe(5);
	});

	it("costs nothing while the card is folded", async () => {
		// The block lives in the EXPANDED region, so a folded card must be unaffected.
		// Low LOD defaults to expanded too, so folding requires a reader preference.
		const { measureSubagentCard } = await import("./measure-subagent");
		const bare = measureSubagentCard(baseCard(), 600, 3, { opened: false });
		const withFiles = measureSubagentCard({ ...baseCard(), fileChanges: changes(20) }, 600, 3, {
			opened: false,
		});
		expect(withFiles.effectiveExpanded).toBe(false);
		expect(withFiles.height).toBe(bare.height);
		expect(withFiles.fileChangesHeight).toBe(0);
	});
});

describe("background launch notice", () => {
	it("also recognizes detached foreground agents, but not quoted or incomplete tags", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		for (const [text, expected] of [
			["<background_task_id>child</background_task_id>\nMoved to background.", true],
			["Example: <background_task_id>child</background_task_id>", false],
			["<background_task_id>incomplete", false],
		] as const) {
			const measured = measureSubagentCard(
				{ ...BASE, isBackground: false, resultBody: bodyFixture("output.main", text) },
				WIDTH,
				5,
				{ opened: true },
			);
			expect(measured.hasBackgroundNotice).toBe(expected);
		}
	});
	it("hides protocol output and reserves no result height", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const data = {
			...BASE,
			isBackground: true,
			resultBody: bodyFixture(
				"output.main",
				"<background_task_id>child</background_task_id>\nBackground task started.",
			),
		};
		const expanded = measureSubagentCard(data, WIDTH, 5, { opened: true });
		expect(expanded.hasBackgroundNotice).toBe(true);
		expect(expanded.resultMeasured).toBeNull();
		expect(expanded.resultBlockHeight).toBe(0);
		const collapsed = measureSubagentCard(data, WIDTH, 5, { opened: false });
		expect(collapsed.hasResultPreview).toBe(false);
		expect(collapsed.resultBlockHeight).toBe(0);
	});

	it("keeps background errors and ordinary results visible", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const measured = measureSubagentCard(
			{
				...BASE,
				isBackground: true,
				resultBody: bodyFixture("output.main", "Error: child could not start"),
			},
			WIDTH,
			5,
			{ opened: true },
		);
		expect(measured.hasBackgroundNotice).toBe(false);
		expect(measured.resultMeasured).not.toBeNull();
	});
});

function bodyFixture(
	source: "input.prompt" | "output.main",
	text: string,
): import("@shared/pretext-layout/tool-detail").ToolCappedDetail {
	return {
		kind: "capped",
		id: JSON.stringify(["fixture-call", source]),
		source,
		cap: source === "input.prompt" ? "code" : "agent-result",
		text,
		format: source === "input.prompt" ? "text" : "markdown",
		live: false,
		followTarget: { kind: "end" },
	};
}
