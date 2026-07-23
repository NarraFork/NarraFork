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

	it("non-exempt: L6 expands; L4 collapses; L5 follows recent+opened", async () => {
		const { resolveSubagentExpanded } = await import("./measure-subagent");
		const inert = { isActive: false, hasSelfPermission: false, pendingPermissionCount: 0 };
		expect(resolveSubagentExpanded(6, { ...inert, isRecent: false, opened: false })).toBe(true);
		expect(resolveSubagentExpanded(4, { ...inert, isRecent: true, opened: true })).toBe(false);
		// L5: recent card follows `opened`; old card always collapses.
		expect(resolveSubagentExpanded(5, { ...inert, isRecent: true, opened: true })).toBe(true);
		expect(resolveSubagentExpanded(5, { ...inert, isRecent: true, opened: false })).toBe(false);
		expect(resolveSubagentExpanded(5, { ...inert, isRecent: false, opened: true })).toBe(false);
		// L1-L3 follow the upstream gate (`opened`).
		expect(resolveSubagentExpanded(3, { ...inert, isRecent: false, opened: true })).toBe(true);
		expect(resolveSubagentExpanded(1, { ...inert, isRecent: false, opened: false })).toBe(false);
		expect(
			resolveSubagentExpanded(4, {
				...inert,
				isRecent: false,
				opened: false,
				lodUserOverride: true,
			}),
		).toBe(true);
	});
});

describe("measureSubagentCard — collapsed header (55-75px)", () => {
	it("collapsed with no result preview ≈ 56px (padding + badge + desc)", async () => {
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		// L4 forces collapse; not recent, not opened, terminal, no result.
		const r = measureSubagentCard(BASE, WIDTH, 4, { isRecent: false, opened: false });
		expect(r.effectiveExpanded).toBe(false);
		const c = MEASURE_SUBAGENT_CONSTANTS;
		// header = pad*2 + badge row + descMt + xs line ; + border*2 (not inRun).
		const expectedHeader =
			c.CARD_PADDING * 2 + c.BADGE_ROW_HEIGHT + c.DESC_MARGIN_TOP + c.XS_LINE_HEIGHT;
		expect(r.headerHeight).toBe(expectedHeader);
		expect(r.headerHeight).toBe(56);
		expect(r.hasResultPreview).toBe(false);
		expect(r.height).toBe(expectedHeader + c.CARD_BORDER * 2);
		expect(r.height).toBeGreaterThanOrEqual(55);
		expect(r.height).toBeLessThanOrEqual(75);
	});

	it("collapsed WITH terminal result preview adds one line (≈75px)", async () => {
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		const r = measureSubagentCard(
			{ ...BASE, resultText: "The auth flow uses JWT bearer tokens." },
			WIDTH,
			4,
			{ isRecent: false, opened: false },
		);
		expect(r.effectiveExpanded).toBe(false);
		expect(r.hasResultPreview).toBe(true);
		const c = MEASURE_SUBAGENT_CONSTANTS;
		const expectedHeader =
			c.CARD_PADDING * 2 +
			c.BADGE_ROW_HEIGHT +
			c.DESC_MARGIN_TOP +
			c.XS_LINE_HEIGHT +
			(c.RESULT_PREVIEW_MARGIN_TOP + c.XS_LINE_HEIGHT);
		expect(r.headerHeight).toBe(expectedHeader);
		expect(r.headerHeight).toBe(75);
		expect(r.height).toBeLessThanOrEqual(75 + c.CARD_BORDER * 2);
	});

	it("collapsed description is a single fixed line regardless of length", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const short = measureSubagentCard(BASE, WIDTH, 4, {});
		const long = measureSubagentCard({ ...BASE, description: "x ".repeat(400) }, WIDTH, 4, {});
		expect(short.headerHeight).toBe(long.headerHeight);
		expect(short.descriptionMeasured).toBeNull();
	});
});

describe("measureSubagentCard — expanded body", () => {
	it("expanded wraps a long description into more lines than the collapsed truncate", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		// A long description: collapsed truncates to 1 line; expanded wraps to many.
		const longDesc = { ...BASE, description: "word ".repeat(120).trim() };
		const collapsed = measureSubagentCard(longDesc, WIDTH, 4, {});
		const expanded = measureSubagentCard(longDesc, WIDTH, 6, {});
		expect(collapsed.effectiveExpanded).toBe(false);
		expect(expanded.effectiveExpanded).toBe(true);
		// Expanded description wraps → carries a measured markdown/inline body.
		expect(expanded.descriptionMeasured).not.toBeNull();
		expect(expanded.descriptionHeight).toBeGreaterThan(collapsed.descriptionHeight);
		expect(expanded.height).toBeGreaterThan(collapsed.height);
	});

	it("expanding a card with a body region is taller than collapsed", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const data = { ...BASE, resultText: "one line result" };
		const collapsed = measureSubagentCard(data, WIDTH, 4, {});
		const expanded = measureSubagentCard(data, WIDTH, 6, {});
		// Collapsed shows only a result-preview line; expanded reveals the full
		// result ContentViewer block → strictly taller.
		expect(expanded.height).toBeGreaterThan(collapsed.height);
		expect(expanded.resultBlockHeight).toBeGreaterThan(0);
	});

	it("expanded result is capped at maxHeight:300 (min(content, cap))", async () => {
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		const c = MEASURE_SUBAGENT_CONSTANTS;
		const short = measureSubagentCard({ ...BASE, resultText: "one line result" }, WIDTH, 6, {});
		const huge = measureSubagentCard(
			{ ...BASE, resultText: Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n\n") },
			WIDTH,
			6,
			{},
		);
		// Short result block is well under the cap.
		expect(short.resultBlockHeight).toBeLessThan(c.RESULT_MAX_HEIGHT + c.BLOCK_PADDING_BOTTOM);
		// Huge result is clamped to the 300px cap (+ bottom padding chrome).
		expect(huge.resultBlockHeight).toBe(c.RESULT_MAX_HEIGHT + c.BLOCK_PADDING_BOTTOM);
		expect(huge.resultBlockHeight).toBeGreaterThan(short.resultBlockHeight);
	});

	it("prompt block: toggle row only when closed, + capped body when open (maxHeight:200)", async () => {
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		const c = MEASURE_SUBAGENT_CONSTANTS;
		const closed = measureSubagentCard(
			{ ...BASE, prompt: "do the thing", promptOpen: false },
			WIDTH,
			6,
			{},
		);
		// Closed prompt = toggle row + bottom padding.
		expect(closed.promptBlockHeight).toBe(c.PROMPT_TOGGLE_ROW_HEIGHT + c.BLOCK_PADDING_BOTTOM);

		const openShort = measureSubagentCard(
			{ ...BASE, prompt: "short prompt", promptOpen: true },
			WIDTH,
			6,
			{},
		);
		expect(openShort.promptBlockHeight).toBeGreaterThan(closed.promptBlockHeight);
		expect(openShort.promptMeasured).not.toBeNull();

		const openHuge = measureSubagentCard(
			{
				...BASE,
				prompt: Array.from({ length: 400 }, (_, i) => `prompt line ${i}`).join("\n"),
				promptOpen: true,
			},
			WIDTH,
			6,
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
		const bare = measureSubagentCard(BASE, WIDTH, 6, {});
		const withPrompt = measureSubagentCard({ ...BASE, prompt: "p" }, WIDTH, 6, {});
		const withResult = measureSubagentCard({ ...BASE, resultText: "r" }, WIDTH, 6, {});
		const withBoth = measureSubagentCard({ ...BASE, prompt: "p", resultText: "r" }, WIDTH, 6, {});
		expect(withPrompt.height).toBeGreaterThan(bare.height);
		expect(withResult.height).toBeGreaterThan(bare.height);
		expect(withBoth.height).toBeGreaterThan(withPrompt.height);
		expect(withBoth.height).toBeGreaterThan(withResult.height);
	});

	it("resolveOverride adds a button block when present", async () => {
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		const c = MEASURE_SUBAGENT_CONSTANTS;
		const without = measureSubagentCard(BASE, WIDTH, 6, {});
		const withOverride = measureSubagentCard({ ...BASE, hasResolveOverride: true }, WIDTH, 6, {});
		expect(withOverride.resolveOverrideHeight).toBe(
			c.RESOLVE_OVERRIDE_BUTTON_HEIGHT + c.BLOCK_PADDING_BOTTOM,
		);
		expect(withOverride.height).toBe(without.height + withOverride.resolveOverrideHeight);
	});
});

describe("measureSubagentCard — recent calls (independent of expansion)", () => {
	it("recent calls show even when collapsed; ≤3 rows", async () => {
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		const c = MEASURE_SUBAGENT_CONSTANTS;
		const none = measureSubagentCard(BASE, WIDTH, 4, {});
		expect(none.recentCallsHeight).toBe(0);

		const three = measureSubagentCard({ ...BASE, recentCallCount: 3 }, WIDTH, 4, {});
		expect(three.effectiveExpanded).toBe(false);
		expect(three.recentRowCount).toBe(3);
		expect(three.recentCallsHeight).toBeGreaterThan(0);

		// >3 is clamped to 3 rows.
		const five = measureSubagentCard({ ...BASE, recentCallCount: 5 }, WIDTH, 4, {});
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
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		const c = MEASURE_SUBAGENT_CONSTANTS;
		const withBtn = measureSubagentCard(
			{ ...BASE, recentCallCount: 1, hasRecentCallsButton: true },
			WIDTH,
			4,
			{},
		);
		const titleRow = Math.max(c.XS_LINE_HEIGHT, c.BUTTON_COMPACT_XS);
		const expected =
			titleRow + c.RECENT_TITLE_MARGIN_BOTTOM + c.RECENT_ROW_HEIGHT + c.BLOCK_PADDING_BOTTOM;
		expect(withBtn.recentCallsHeight).toBe(expected);
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
			4, // even at L4, a self-permission is lodExempt → expanded.
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
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		const c = MEASURE_SUBAGENT_CONSTANTS;
		const r = measureSubagentCard(BASE, WIDTH, 4, { pendingPermissionCount: 2 });
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
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		const { measureInlinePermission } = await import("./measure-permission");
		const c = MEASURE_SUBAGENT_CONSTANTS;
		const detail = { hasExecutionTarget: true, buttonCount: 2 };
		const r = measureSubagentCard({ ...BASE, pendingPermissions: [detail] }, WIDTH, 4, {});
		expect(r.pendingCardCount).toBe(1);
		const cardInner = WIDTH - c.BLOCK_PADDING_X * 2 - c.PENDING_CARD_BORDER * 2;
		const perm = measureInlinePermission(detail, cardInner, 4);
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
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		const c = MEASURE_SUBAGENT_CONSTANTS;
		const boxed = measureSubagentCard(BASE, WIDTH, 4, { inRun: false });
		const inRun = measureSubagentCard(BASE, WIDTH, 4, { inRun: true, isLast: true });
		expect(boxed.borderHeight).toBe(c.CARD_BORDER * 2);
		expect(inRun.borderHeight).toBe(0);
		expect(inRun.dividerHeight).toBe(0);
		expect(boxed.height).toBe(inRun.height + c.CARD_BORDER * 2);
	});

	it("inRun && !isLast adds a 1px divider", async () => {
		const { measureSubagentCard, MEASURE_SUBAGENT_CONSTANTS } = await import("./measure-subagent");
		const c = MEASURE_SUBAGENT_CONSTANTS;
		const notLast = measureSubagentCard(BASE, WIDTH, 4, { inRun: true, isLast: false });
		const last = measureSubagentCard(BASE, WIDTH, 4, { inRun: true, isLast: true });
		expect(notLast.dividerHeight).toBe(c.DIVIDER_HEIGHT);
		expect(last.dividerHeight).toBe(0);
		expect(notLast.height).toBe(last.height + c.DIVIDER_HEIGHT);
	});
});

describe("measureSubagentCard — width sensitivity + reusable measurer", () => {
	it("expanded description wraps into more lines as width shrinks", async () => {
		const { measureSubagentCard } = await import("./measure-subagent");
		const text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
		const wide = measureSubagentCard({ ...BASE, description: text }, 2000, 6, {});
		const narrow = measureSubagentCard({ ...BASE, description: text }, 160, 6, {});
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	it("prepareSubagentMeasurer measures once and re-runs across widths/LODs", async () => {
		const { prepareSubagentMeasurer } = await import("./measure-subagent");
		const measure = prepareSubagentMeasurer({
			...BASE,
			description: "a recurring subagent description phrase for wrapping",
			resultText: "some result body",
		});
		const collapsed = measure(WIDTH, 4, {});
		const expanded = measure(WIDTH, 6, {});
		expect(collapsed.effectiveExpanded).toBe(false);
		expect(expanded.effectiveExpanded).toBe(true);
		expect(expanded.height).toBeGreaterThan(collapsed.height);
	});
});
