/**
 * Guards the narrator-header layout contract after dropping DOM capacity:
 * title width comes from pretext measureText; the tool row is the surfaced
 * zone on the right. Every silent failure mode here reverts to "icons crush
 * the title" without throwing.
 */

import { describe, expect, it } from "bun:test";
import { NARRATOR_TOOLBAR_ITEMS } from "./header/narrator-toolbar-items";

function read(name: string): Promise<string> {
	return Bun.file(new URL(name, import.meta.url)).text();
}

const narratorPanel = () => read("./NarratorPanel.tsx");
const headerTitle = () => read("./header/NarratorPanelHeaderTitle.tsx");
const overflowMenu = () => read("./header/NarratorToolbarOverflowMenu.tsx");
const headerToolbar = () => read("./header/HeaderToolbar.tsx");
const headerToolbarHook = () => read("./header/use-header-toolbar.tsx");
const headerLayout = () => read("./header/NarratorHeaderLayout.tsx");
const titleWidth = () => read("./header/header-title-width.ts");

describe("header layout: pretext title width + right-hand tools", () => {
	it("measures title width with pretext canvas, not DOM toolbar capacity", async () => {
		const widthSrc = await titleWidth();
		expect(widthSrc).toContain("typographyMetrics");
		expect(widthSrc).toContain("measureText");
		expect(widthSrc).toContain("HEADER_TITLE_TEXT_MAX_PX");
		const hook = await headerToolbarHook();
		expect(hook).not.toContain("useNarratorHeaderToolbarCapacity");
		expect(hook).not.toContain("useHeaderToolbarCapacityPartition");
	});

	it("title width is pretext-complete and fixed; tools fitted by arithmetic", async () => {
		const widthSrc = await titleWidth();
		expect(widthSrc).toContain("resolveHeaderLayoutAfterTitle");
		expect(widthSrc).toContain("titleFullWidth");
		expect(widthSrc).toContain("HEADER_TITLE_TEXT_MIN_PX");
		const title = await headerTitle();
		// Fixed width from W — flex 0 0 auto, not flex 1 auto steal-space.
		expect(title).toContain('flex: "0 0 auto"');
		expect(title).toContain("width: boxWidth");
		expect(title).toContain("titleFullWidth");
		const toolbar = await headerToolbar();
		expect(toolbar).toContain("visibleToolCount");
		expect(toolbar).toContain("unmeasured");
		expect(toolbar).toContain("selectHeaderToolbarEntries");
		expect(toolbar).toContain("unmeasured ? null");
		const panel = await narratorPanel();
		const layout = await headerLayout();
		expect(layout).toContain("resolveHeaderLayoutAfterTitle");
		expect(layout).toContain("children(layout)");
		expect(panel).toContain("<NarratorHeaderLayout");
		expect(panel).toContain("titleFullWidth={headerTitleFullWidth}");
		expect(panel).toContain("surfacedToolCount={toolbarController.toolbarSurfacedDefs.length}");
		expect(panel).toContain("visibleToolCount={headerLayout.visibleToolCount}");
		expect(panel).toContain("titleFullWidth={headerLayout.titleWidth}");
		expect(panel).toContain("unmeasured={headerLayout.unmeasured}");
		expect(panel).toContain('flexWrap: "nowrap"');
	});

	it("panel CSS gaps come from the same constants the arithmetic uses", async () => {
		const widthSrc = await titleWidth();
		expect(widthSrc).toContain("HEADER_LEADING_GAP_PX = 8");
		expect(widthSrc).toContain("HEADER_ROW_GAP_PX = 8");
		expect(widthSrc).toContain("HEADER_TOOLBAR_GAP_PX = 10");
		const panel = await narratorPanel();
		expect(panel).toContain("gap: HEADER_LEADING_GAP_PX");
		const layout = await headerLayout();
		expect(layout).toContain("gap: HEADER_LEADING_GAP_PX");
		expect(layout).toContain("HEADER_ROW_PADDING_PX / 2");
	});

	it("keeps raw header-width state and observation out of the full panel", async () => {
		const panel = await narratorPanel();
		for (const oldBinding of [
			"headerRowWidth",
			"setHeaderRowWidth",
			"headerRowReady",
			"headerRowRef",
		]) {
			expect(panel).not.toContain(oldBinding);
		}
		const layout = await headerLayout();
		expect(layout).toContain("new ResizeObserver(read)");
		expect(layout).toContain("sameLayout(published.current, next)");
	});

	it("toolbar slices by arithmetic visibleToolCount; overflow carries the rest", async () => {
		const toolbar = await headerToolbar();
		expect(toolbar).toContain("toolbarSurfacedDefs");
		expect(toolbar).not.toContain("useHeaderToolbarCapacityPartition");
		expect(toolbar).toContain("visibleToolCount");
		expect(toolbar).toContain("noRoomIds={noRoomIds}");
		expect(toolbar).toContain('marginLeft: "auto"');
	});

	it("keeps every registry entry at ActionIcon size=sm", async () => {
		const toolbar = await headerToolbar();
		expect(toolbar).toContain("visibleDefs.map");
		const source = await read("./header/NarratorToolbarItem.tsx");
		const buttons = source.split("<ActionIcon").slice(1);
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) {
			expect(button.slice(0, 200)).toContain('size="sm"');
		}
	});

	it("keeps self-contained menu triggers at the same ActionIcon width", async () => {
		// These render their trigger in their own component; the capacity arithmetic
		// charges each slot a flat ActionIcon size=sm. A wider trigger silently
		// overstates what fits.
		for (const path of ["./model/ExecutionDeviceMenu.tsx", "./lod/NarratorLodMenu.tsx"]) {
			const source = await read(path);
			const triggers = source.split("<ActionIcon").slice(1);
			expect(triggers.length).toBeGreaterThan(0);
			for (const trigger of triggers) {
				expect(trigger.slice(0, 200)).toContain('size="sm"');
			}
		}
	});
});

describe("the overflow menu has three movable zones", () => {
	it("keeps both boundaries droppable but never draggable", async () => {
		const menu = await overflowMenu();
		expect(menu).toContain('entry.kind === "bottom-divider"');
		expect(menu).toContain("return NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID");
		expect(menu).toContain("disabled: { draggable: true, droppable: false }");
		expect(menu).toContain("id={entryId(entry)}");
		expect(menu.indexOf('"toolbar.sectionBottom"')).toBeLessThan(menu.indexOf("{onArchive ?"));
	});

	it("passes the full layout to the tested reorder helper so hidden entries stay in their zones", async () => {
		const menu = await overflowMenu();
		expect(menu).toContain(
			"onSaveLayout(moveToolbarEntry(entries, String(active.id), String(over.id)))",
		);
	});

	it("excludes bottom icons from the fallback menu badge", async () => {
		const menu = await overflowMenu();
		expect(menu).toContain(".slice(dividerIndex + 1, bottomIndex < 0 ? undefined : bottomIndex)");
	});

	it("names the bottom section in both locales", async () => {
		for (const locale of ["en", "zh-CN"]) {
			const json = JSON.parse(await read(`../../locales/${locale}/narrator.json`));
			expect(json.toolbar.sectionBottom).toBeTruthy();
			if (locale === "zh-CN") expect(json.toolbar.sectionBottom).toBe("底部功能图标");
		}
	});
});

describe("self-contained controls are reachable from the overflow menu", () => {
	it("the menu renders inline options instead of a header-only hint", async () => {
		const menu = await overflowMenu();
		expect(menu).toContain("renderInlineOptions");
		expect(menu).toContain("<Collapse expanded={!!expanded}");
		expect(menu).toContain("keepMounted={false}");
		expect(menu).not.toContain("toolbar.headerOnly");
	});

	it("the hint key is removed from both locales", async () => {
		for (const locale of ["en", "zh-CN"]) {
			const json = JSON.parse(await read(`../../locales/${locale}/narrator.json`));
			const toolbar = json.toolbar;
			expect(toolbar.headerOnly).toBeUndefined();
			expect(toolbar.expandOptions).toBeTruthy();
			// Width-collapsed entries still land in the overflow menu; the section
			// label must stay translated.
			expect(toolbar.someHiddenNoRoom).toBeTruthy();
		}
	});

	it("the header supplies options for every self-contained registry id", async () => {
		const toolbar = await headerToolbar();
		expect(toolbar).toContain("renderInlineOptions={renderToolbarInlineOptions}");
		const hook = await headerToolbarHook();
		const start = hook.indexOf("const renderToolbarInlineOptions");
		expect(start).toBeGreaterThan(-1);
		const body = hook.slice(start);
		for (const def of NARRATOR_TOOLBAR_ITEMS.filter((item) => item.selfContained)) {
			expect(body).toContain(`case "${def.id}":`);
		}
	});

	it("keeps the drag listeners off the node that wraps the expansion", async () => {
		const menu = await overflowMenu();
		const rowStart = menu.indexOf("function SortableRow");
		const rowEnd = menu.indexOf("function SortableDivider");
		expect(rowStart).toBeGreaterThan(-1);
		const row = menu.slice(rowStart, rowEnd);
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
