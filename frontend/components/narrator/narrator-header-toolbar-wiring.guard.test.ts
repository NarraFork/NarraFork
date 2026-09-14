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
// The toolbar row markup lives in HeaderToolbar; the availability / layout /
// activation / inline-options logic lives in its co-located hook.
const headerToolbar = () => read("./header/HeaderToolbar.tsx");
const headerToolbarHook = () => read("./header/use-header-toolbar.tsx");

describe("header capacity measurement is wired to the DOM", () => {
	it("attaches all three refs the budget calculation needs", async () => {
		const source = await narratorPanel();
		// The ROW is the budget source: its width is independent of the decision.
		// Without it the hook can never measure and silently reports null forever,
		// which is exactly the pre-fix behaviour.
		expect(source).toContain("ref={headerRowRef}");
		expect(source).toContain("ref={headerLeadingRef}");
		// The tool row anchor is applied inside HeaderToolbar (on the row it measures).
		const toolbar = await headerToolbar();
		expect(toolbar).toContain("ref={headerToolbarRef}");
	});

	it("marks the title slot so its width is budgeted, not measured", async () => {
		const source = await narratorPanel();
		// The slot is `flex: 1`, so its measured width is whatever the tool row left
		// over. Measuring it would make the budget a function of its own result.
		expect(source).toContain('{...{ [HEADER_TITLE_SLOT_ATTR]: "" }}');
	});

	it("marks every always-present trailing control as fixed", async () => {
		const toolbar = await headerToolbar();
		const menu = await overflowMenu();
		// Close button and the debug mock entry live in HeaderToolbar; the overflow
		// trigger owns its own marker. A missing marker overstates the budget by one
		// button's width, so the row keeps one entry too many and clips it.
		expect(toolbar.match(/\[HEADER_TOOLBAR_FIXED_ATTR\]/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
		expect(menu).toContain("[HEADER_TOOLBAR_FIXED_ATTR]");
	});

	it("feeds the measured capacity into the visible limit", async () => {
		const source = await headerToolbarHook();
		expect(source).toContain("headerCapacity ?? (isMobileViewport ? MOBILE_TOOLBAR_VISIBLE_LIMIT");
		// The partition must stay uncapped: capping there would make the item count
		// fed to the measurement depend on the measurement's own answer.
		expect(source).toContain("visibleLimit: null,");
	});

	it("keeps every registry entry at the width the constant assumes", async () => {
		const source = await headerToolbar();
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
		for (const path of ["./ExecutionDeviceMenu.tsx", "./lod/NarratorLodMenu.tsx"]) {
			const source = await read(path);
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
		const toolbar = await headerToolbar();
		const menu = await overflowMenu();
		// Deriving it from the divider would count only entries the reader tucked
		// away, so an entry collapsed for width would take its unread badge off
		// screen with nothing to show it.
		expect(toolbar).toContain("hiddenDefs={toolbarHiddenDefs}");
		expect(toolbar).toContain("noRoomIds={toolbarNoRoomIds}");
		expect(menu).toContain("aggregateOverflowBadge(hiddenDefs ?? tuckedDefs, badgeCounts)");
	});

	/**
	 * The width shortfall is stated ONCE under the section heading, not per row.
	 * A per-row caption was the first attempt and it read badly: the header fits two
	 * entries on a phone, so all nine remaining rows carried the same words, which
	 * turned the caption into noise and buried the dimming that actually carries the
	 * meaning. A future edit that re-adds a per-row hint would regress that quietly,
	 * since nothing about it errors.
	 */
	it("states the width shortfall once per section, not once per row", async () => {
		const menu = await overflowMenu();
		expect(menu).toContain('t("toolbar.someHiddenNoRoom")');
		expect(menu).toContain("{anyNoRoom ?");
		expect(menu).not.toContain("noRoomHint");

		// The note is a property of the section, so it must be resolved from all
		// surfaced entries rather than inside the row loop.
		const noteAt = menu.indexOf('t("toolbar.someHiddenNoRoom")');
		const loopAt = menu.indexOf("{listedEntries.map(");
		expect(noteAt).toBeGreaterThan(-1);
		expect(noteAt).toBeLessThan(loopAt);
	});

	it("dimming is what marks a row as absent from the header", async () => {
		const menu = await overflowMenu();
		// With the caption gone this is the only per-row signal left, so losing it
		// would make a collapsed entry indistinguishable from a surfaced one.
		expect(menu).toContain('color: tucked ? "var(--mantine-color-dimmed)" : undefined');
	});

	it("the section note exists in both locales", async () => {
		for (const locale of ["en", "zh-CN"]) {
			const json = await read(`../../locales/${locale}/narrator.json`);
			const toolbar = JSON.parse(json).toolbar;
			expect(toolbar.someHiddenNoRoom).toBeTruthy();
			expect(toolbar.hiddenNoRoom).toBeUndefined();
		}
	});
});

/**
 * The self-contained controls (detail level, execution device, plugin picker)
 * render their own Menu in the header, so the overflow menu cannot "activate"
 * them. It used to list them as a dead row labelled "header only" — and on a phone
 * the header keeps two icons while everything else lives in that menu, so those
 * controls had NO reachable entry point at all.
 *
 * They now expand their options inline. Every way of breaking that reverts to the
 * dead row (or to an unscrollable list) without raising anything.
 */
describe("self-contained controls are reachable from the overflow menu", () => {
	it("the menu renders inline options instead of a header-only hint", async () => {
		const menu = await overflowMenu();
		expect(menu).toContain("renderInlineOptions");
		expect(menu).toContain("<Collapse expanded={!!expanded}");
		// A collapsed row must not mount its options: the plugin list fetches on mount,
		// so keeping it mounted would make merely opening this menu do that work.
		expect(menu).toContain("keepMounted={false}");
		// The hint string is gone on purpose: keeping it would keep asserting
		// "this only works from the header", which is no longer true.
		expect(menu).not.toContain("toolbar.headerOnly");
	});

	it("the hint key is removed from both locales", async () => {
		for (const locale of ["en", "zh-CN"]) {
			const json = await read(`../../locales/${locale}/narrator.json`);
			const toolbar = JSON.parse(json).toolbar;
			expect(toolbar.headerOnly).toBeUndefined();
			// The chevron's accessible name.
			expect(toolbar.expandOptions).toBeTruthy();
		}
	});

	it("the header supplies options for every self-contained registry id", async () => {
		const toolbar = await headerToolbar();
		expect(toolbar).toContain("renderInlineOptions={renderToolbarInlineOptions}");
		const hook = await headerToolbarHook();
		const start = hook.indexOf("const renderToolbarInlineOptions");
		expect(start).toBeGreaterThan(-1);
		const body = hook.slice(start);
		// An unhandled id falls through to `null`, which silently restores the dead row.
		for (const id of ["device", "lodlevel", "plugins"]) {
			expect(body).toContain(`case "${id}":`);
		}
	});

	it("keeps the drag listeners off the node that wraps the expansion", async () => {
		const menu = await overflowMenu();
		const rowStart = menu.indexOf("function SortableRow");
		const rowEnd = menu.indexOf("function SortableDivider");
		expect(rowStart).toBeGreaterThan(-1);
		const row = menu.slice(rowStart, rowEnd);
		// `touch-action: none` on an ancestor of the expansion makes a long device or
		// plugin list unscrollable on touch — the platform this whole change is for.
		const nodeRefAt = row.indexOf("ref={setNodeRef}");
		const listenersAt = row.indexOf("{...listeners}");
		const groupAt = row.indexOf("<Group");
		expect(nodeRefAt).toBeGreaterThan(-1);
		expect(listenersAt).toBeGreaterThan(groupAt);
		expect(row.slice(nodeRefAt, groupAt)).not.toContain("touchAction");
	});
});

describe("the file-tree toolbar entry is wired to Dockview", () => {
	it("tracks the Dockview panel's active state", async () => {
		const source = await headerToolbarHook();
		const start = source.indexOf("const toolbarEntryActive");
		const end = source.indexOf("/**\n\t * Activate an entry", start);
		const body = source.slice(start, end);
		expect(body).toContain('case "filetree":');
		expect(body).toContain('dock?.openToolTypes.has("filetree")');
	});

	it("activates the file-tree panel instead of falling through", async () => {
		const source = await headerToolbarHook();
		const start = source.indexOf("const activateToolbarEntry");
		const end = source.indexOf("/**\n\t * Options the overflow menu", start);
		const body = source.slice(start, end);
		expect(body).toContain('case "filetree":');
		expect(body).toContain('dock?.toggleToolPanel("filetree")');
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
