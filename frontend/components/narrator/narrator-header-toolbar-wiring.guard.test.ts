/**
 * Guards the narrator-header capacity wiring, which has an unusual property:
 * every way of breaking it fails SILENTLY by reverting to the old bug.
 *
 * Before this feature, the desktop header rendered every tool entry inline and
 * let the title absorb the shortfall, so a long title compressed to a few
 * characters beside a full row of icons. Nothing errored — the row just looked
 * wrong, which is why it survived so long.
 *
 * The measurement now prevents that, but it depends on markers spread across
 * three files. Drop one and the budget is silently overstated (or the title slot
 * is measured instead of budgeted), the capacity comes out as "everything fits",
 * and the header is back to squeezing the title with no error anywhere.
 */

import { describe, expect, it } from "bun:test";

function read(name: string): Promise<string> {
	return Bun.file(new URL(name, import.meta.url)).text();
}

const narratorPanel = () => read("./NarratorPanel.tsx");
const overflowMenu = () => read("./NarratorToolbarOverflowMenu.tsx");
const capacityHook = () => read("../../hooks/useNarratorHeaderToolbarCapacity.ts");

describe("header capacity measurement is wired to the DOM", () => {
	it("attaches all three refs the budget calculation needs", async () => {
		const source = await narratorPanel();
		// The ROW is the budget source: its width is independent of the decision.
		// Without it the hook can never measure and silently reports null forever,
		// which is exactly the pre-fix behaviour.
		expect(source).toContain("ref={headerRowRef}");
		expect(source).toContain("ref={headerLeadingRef}");
		expect(source).toContain("ref={headerToolbarRef}");
	});

	it("marks the title slot so its width is budgeted, not measured", async () => {
		const source = await narratorPanel();
		// The slot is `flex: 1`, so its measured width is whatever the tool row left
		// over. Measuring it would make the budget a function of its own result.
		expect(source).toContain('{...{ [HEADER_TITLE_SLOT_ATTR]: "" }}');
	});

	it("marks every always-present trailing control as fixed", async () => {
		const panel = await narratorPanel();
		const menu = await overflowMenu();
		// Close button and the debug mock entry live in the panel; the overflow
		// trigger owns its own marker. A missing marker overstates the budget by one
		// button's width, so the row keeps one entry too many and clips it.
		expect(panel.match(/\[HEADER_TOOLBAR_FIXED_ATTR\]/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
		expect(menu).toContain("[HEADER_TOOLBAR_FIXED_ATTR]");
	});

	it("feeds the measured capacity into the visible limit", async () => {
		const source = await narratorPanel();
		expect(source).toContain("headerCapacity ?? (isMobileViewport ? MOBILE_TOOLBAR_VISIBLE_LIMIT");
		// The partition must stay uncapped: capping there would make the item count
		// fed to the measurement depend on the measurement's own answer.
		expect(source).toContain("visibleLimit: null,");
	});

	it("keeps every registry entry at the width the constant assumes", async () => {
		const source = await narratorPanel();
		// HEADER_TOOLBAR_ITEM_WIDTH_PX is `ActionIcon size="sm"`. The registry loop
		// renders one button per entry plus three special-cased controls; each must
		// stay size="sm" or the arithmetic silently drifts.
		const loopStart = source.indexOf("{toolbarVisibleDefs.map((def) => {");
		const loopEnd = source.indexOf("TEMPORARY mock-stream harness", loopStart);
		expect(loopStart).toBeGreaterThan(-1);
		expect(loopEnd).toBeGreaterThan(loopStart);
		const buttons = source.slice(loopStart, loopEnd).split("<ActionIcon").slice(1);
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) {
			expect(button.slice(0, 200)).toContain('size="sm"');
		}
	});

	/**
	 * The self-contained controls render their trigger in their OWN component, so the
	 * loop scan above cannot see them — it only sees `<ExecutionDeviceMenu />`. They
	 * occupy a slot in the row all the same, and the capacity arithmetic charges each
	 * slot a flat `ActionIcon size="sm"`. A trigger that grew (a labelled Button, a
	 * larger icon) would overstate what fits, and the row would clip rather than
	 * collapse — with nothing to attribute it to.
	 *
	 * `PluginContributionPicker` is absent on purpose: NarratorPanel passes its
	 * trigger in, and that trigger IS inside the scanned loop.
	 */
	it("keeps the self-contained controls' own triggers at the same width", async () => {
		for (const name of ["ExecutionDeviceMenu", "NarratorLodMenu"]) {
			const source = await read(`./${name}.tsx`);
			const triggers = source.split("<ActionIcon").slice(1);
			expect(triggers.length).toBeGreaterThan(0);
			for (const trigger of triggers) {
				expect(trigger.slice(0, 200)).toContain('size="sm"');
			}
		}
	});
});

describe("entries collapsed for width stay accounted for", () => {
	it("the overflow menu takes the hidden list from the header, not the divider", async () => {
		const panel = await narratorPanel();
		const menu = await overflowMenu();
		// Deriving it from the divider would count only entries the reader tucked
		// away, so an entry collapsed for width would take its unread badge off
		// screen with nothing to show it.
		expect(panel).toContain("hiddenDefs={toolbarHiddenDefs}");
		expect(panel).toContain("noRoomIds={toolbarNoRoomIds}");
		expect(menu).toContain("aggregateOverflowBadge(hiddenDefs ?? tuckedDefs, badgeCounts)");
		expect(menu).toContain('t("toolbar.hiddenNoRoom")');
	});

	it("the no-room hint exists in both locales", async () => {
		for (const locale of ["en", "zh-CN"]) {
			const json = await read(`../../locales/${locale}/narrator.json`);
			expect(JSON.parse(json).toolbar.hiddenNoRoom).toBeTruthy();
		}
	});
});

describe("the capacity hook observes only stable elements", () => {
	it("never observes the entry wrappers it adds and removes", async () => {
		const source = await capacityHook();
		// Observing them would feed the resolver's own output back in as an input,
		// which is the cascade that collapses a row to a single button.
		expect(source).toContain("observer?.observe(row)");
		expect(source).toContain("observer?.observe(leading)");
		expect(source).not.toContain("observer?.observe(toolbar)");
	});

	it("coalesces triggers into one frame and resolves before paint", async () => {
		const source = await capacityHook();
		expect(source).toContain("requestAnimationFrame");
		expect(source).toContain("useLayoutEffect");
		// A zero budget means "not laid out yet". Reporting 0 would empty the row
		// for a frame instead of waiting for the next observation.
		expect(source).toContain("if (budgetWidth <= 0) return;");
	});

	it("drops the hysteresis baseline when the entry set changes", async () => {
		const source = await capacityHook();
		// Hysteresis absorbs width jitter, so its baseline only means something while
		// the candidate set is fixed. Carried across a change in itemCount (a
		// narrator gaining `git` when a chapter appears) the old smaller answer would
		// pin the row below what fits, and no width change would ever correct it.
		expect(source).toContain("baselineItemCountRef.current === itemCount ? capacityRef.current");
	});
});
