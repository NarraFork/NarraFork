import { describe, expect, it } from "bun:test";
import {
	NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID,
	NARRATOR_TOOLBAR_DIVIDER_ID,
	NARRATOR_TOOLBAR_IDS,
} from "@shared/narrator-toolbar";
import {
	DEFAULT_TOOLBAR_ENTRIES,
	mergeToolbarLayout,
	moveToolbarEntry,
	type NarratorToolbarEntry,
	partitionToolbar,
	toPersistedToolbarLayout,
} from "./narrator-toolbar-layout";

function ids(entries: readonly NarratorToolbarEntry[]): string[] {
	return toPersistedToolbarLayout(entries).items.map((e) => e.id);
}

describe("mergeToolbarLayout", () => {
	it("defaults fresh installs to header entries and bottom path rules/terminal", () => {
		const merged = mergeToolbarLayout(undefined);
		const flat = ids(merged);
		const divider = flat.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID);
		expect(divider).toBe(NARRATOR_TOOLBAR_IDS.length - 2);
		expect(flat.slice(0, divider)).toEqual(
			NARRATOR_TOOLBAR_IDS.filter((id) => id !== "terminal" && id !== "path-rules"),
		);
		expect(flat.slice(divider + 1)).toEqual([
			NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID,
			"path-rules",
			"terminal",
		]);
		expect(merged).toEqual(DEFAULT_TOOLBAR_ENTRIES);
	});

	it("preserves the persisted order and the tucked zone", () => {
		const merged = mergeToolbarLayout({
			items: [
				{ id: "git" },
				{ id: "search" },
				{ id: NARRATOR_TOOLBAR_DIVIDER_ID },
				{ id: "details" },
			],
		});
		const flat = ids(merged);
		expect(flat.slice(0, 2)).toEqual(["git", "search"]);
		// `details` was explicitly tucked, so it must stay after the divider even
		// though the merge appends the remaining registry ids before it.
		expect(flat.indexOf("details")).toBeGreaterThan(flat.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID));
	});

	it("appends newly shipped registry ids before the divider so they are discoverable", () => {
		// A layout saved before `browser` existed.
		const merged = mergeToolbarLayout({
			items: [{ id: "git" }, { id: NARRATOR_TOOLBAR_DIVIDER_ID }, { id: "details" }],
		});
		const flat = ids(merged);
		expect(flat.indexOf("browser")).toBeLessThan(flat.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID));
	});

	it("surfaces the lodlevel entry for layouts saved before it existed", () => {
		// `lodlevel` ships as the Alt-gesture-independent detail-level entry point;
		// existing users (no stored id) must get it surfaced, not tucked away.
		const merged = mergeToolbarLayout({
			items: [{ id: "git" }, { id: NARRATOR_TOOLBAR_DIVIDER_ID }],
		});
		const flat = ids(merged);
		expect(flat.indexOf("lodlevel")).toBeLessThan(flat.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID));
	});

	it("removes retired filemod while retaining saved zones and remaining order", () => {
		const flat = ids(
			mergeToolbarLayout({
				items: [
					{ id: "git" },
					{ id: "filemod" },
					{ id: NARRATOR_TOOLBAR_DIVIDER_ID },
					{ id: "filetree" },
					{ id: NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID },
					{ id: "terminal" },
				],
			}),
		);
		expect(flat).not.toContain("filemod");
		expect(flat[0]).toBe("git");
		expect(flat.indexOf("filetree")).toBeGreaterThan(flat.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID));
		expect(flat.indexOf("terminal")).toBeGreaterThan(
			flat.indexOf(NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID),
		);
	});

	it("drops unknown ids rather than resurrecting a removed feature", () => {
		const merged = mergeToolbarLayout({
			items: [{ id: "git" }, { id: "mock-stream-debug" }, { id: NARRATOR_TOOLBAR_DIVIDER_ID }],
		});
		expect(ids(merged)).not.toContain("mock-stream-debug");
	});

	it("keeps only the first occurrence of a duplicated id", () => {
		const merged = mergeToolbarLayout({
			items: [{ id: "git" }, { id: "git" }, { id: NARRATOR_TOOLBAR_DIVIDER_ID }, { id: "git" }],
		});
		expect(ids(merged).filter((id) => id === "git")).toHaveLength(1);
	});

	it("treats a layout with no divider as everything surfaced", () => {
		const merged = mergeToolbarLayout({ items: [{ id: "git" }, { id: "search" }] });
		const flat = ids(merged);
		const divider = flat.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID);
		expect(flat.slice(divider)).toEqual([
			NARRATOR_TOOLBAR_DIVIDER_ID,
			NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID,
			"path-rules",
		]);
	});

	it("survives malformed persisted values", () => {
		for (const bad of [null, 42, "nope", [], { items: "no" }, { items: [null, 7, {}] }]) {
			expect(() => mergeToolbarLayout(bad)).not.toThrow();
			expect(ids(mergeToolbarLayout(bad))).toContain(NARRATOR_TOOLBAR_DIVIDER_ID);
		}
	});

	it("preserves legacy header/menu terminal positions and adds only path rules below", () => {
		for (const items of [
			[{ id: "terminal" }, { id: NARRATOR_TOOLBAR_DIVIDER_ID }, { id: "git" }],
			[{ id: "git" }, { id: NARRATOR_TOOLBAR_DIVIDER_ID }, { id: "terminal" }],
		]) {
			const flat = ids(mergeToolbarLayout({ items }));
			expect(flat.indexOf("terminal") < flat.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID)).toBe(
				items[0].id === "terminal",
			);
			expect(flat.slice(flat.indexOf(NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID) + 1)).toEqual([
				"path-rules",
			]);
		}
	});

	it("keeps saved path rules positions and deduplicates reversed markers without leaving bottom", () => {
		const merged = mergeToolbarLayout({
			items: [
				{ id: "path-rules" },
				{ kind: "bottom-divider" },
				{ id: "terminal" },
				{ kind: "divider" },
				{ id: "git" },
				{ id: "terminal" },
				{ id: NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID },
				{ id: "path-rules" },
			],
		});
		const flat = ids(merged);
		expect(flat[0]).toBe("path-rules");
		expect(flat.filter((id) => id === NARRATOR_TOOLBAR_DIVIDER_ID)).toHaveLength(1);
		expect(flat.filter((id) => id === NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID)).toHaveLength(1);
		expect(flat.slice(flat.indexOf(NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID) + 1)).toEqual([
			"terminal",
			"git",
		]);
		expect(mergeToolbarLayout(toPersistedToolbarLayout(merged))).toEqual(merged);
	});

	it("round-trips through the persisted shape", () => {
		const merged = mergeToolbarLayout({
			items: [{ id: "search" }, { id: NARRATOR_TOOLBAR_DIVIDER_ID }, { id: "git" }],
		});
		expect(ids(mergeToolbarLayout(toPersistedToolbarLayout(merged)))).toEqual(ids(merged));
	});
});

describe("moveToolbarEntry", () => {
	const entries: NarratorToolbarEntry[] = [
		{ kind: "item", id: "appearance" },
		{ kind: "item", id: "search" },
		{ kind: "divider" },
		{ kind: "item", id: "git" },
		{ kind: "bottom-divider" },
		{ kind: "item", id: "filetree" },
		{ kind: "item", id: "path-rules" },
		{ kind: "item", id: "terminal" },
	];

	it("keeps desktop-only items in their original zones when mobile reorders a tool", () => {
		const moved = moveToolbarEntry(entries, "search", "terminal");
		const { visible, overflow, bottom } = partitionToolbar({
			entries: moved,
			hostCapabilities: ["dock", "drawer", "inline"],
			visibleLimit: null,
		});
		expect(visible.map((def) => def.id)).toEqual(["appearance"]);
		expect(overflow.map((def) => def.id)).toEqual(["git"]);
		expect(bottom.map((def) => def.id)).toEqual(["filetree", "path-rules", "terminal", "search"]);
		expect(ids(entries)).toContain("search");
	});

	it("drops into a section boundary from either direction, including empty sections", () => {
		// Drag DOWN to divider → menu zone (right after the divider).
		const fromHeader = moveToolbarEntry(entries, "search", NARRATOR_TOOLBAR_DIVIDER_ID);
		const flatDown = ids(fromHeader);
		expect(flatDown[flatDown.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID) + 1]).toBe("search");
		// Drag UP to divider → header zone (right before the divider).
		const fromBottom = moveToolbarEntry(entries, "terminal", NARRATOR_TOOLBAR_DIVIDER_ID);
		const flatUp = ids(fromBottom);
		expect(flatUp[flatUp.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID) - 1]).toBe("terminal");
		// Empty header zone: restore by dragging up to the divider.
		const emptyHeader: NarratorToolbarEntry[] = [
			{ kind: "divider" },
			{ kind: "bottom-divider" },
			{ kind: "item", id: "terminal" },
		];
		const restored = moveToolbarEntry(emptyHeader, "terminal", NARRATOR_TOOLBAR_DIVIDER_ID);
		expect(ids(restored)[0]).toBe("terminal");
		// Bottom boundary: enter bottom zone from either direction.
		const emptyBottom = entries.slice(0, 5);
		const moved = moveToolbarEntry(emptyBottom, "search", NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID);
		expect(ids(moved).slice(-2)).toEqual([NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID, "search"]);
		const fromDeepBottom = moveToolbarEntry(
			entries,
			"terminal",
			NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID,
		);
		const flatBottom = ids(fromDeepBottom);
		expect(flatBottom[flatBottom.indexOf(NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID) + 1]).toBe("terminal");
	});

	it("never moves boundary markers or unknown ids", () => {
		for (const id of [NARRATOR_TOOLBAR_DIVIDER_ID, NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID, "unknown"]) {
			expect(moveToolbarEntry(entries, id, "terminal")).toEqual(entries);
		}
		expect(moveToolbarEntry(entries, "terminal", "unknown")).toEqual(entries);
		expect(moveToolbarEntry(entries, "terminal", "terminal")).toEqual(entries);
	});
});

describe("partitionToolbar", () => {
	const all = DEFAULT_TOOLBAR_ENTRIES;

	it("gives the desktop host every available entry when uncapped", () => {
		const { visible, overflow } = partitionToolbar({
			entries: all,
			hostCapabilities: ["dock", "drawer", "inline"],
			visibleLimit: null,
		});
		expect(visible).toHaveLength(NARRATOR_TOOLBAR_IDS.length - 2);
		expect(overflow).toHaveLength(0);
	});

	it("caps the host when a caller passes a numeric limit and pushes the rest to overflow", () => {
		const { visible, overflow } = partitionToolbar({
			entries: all,
			hostCapabilities: ["drawer", "inline"],
			visibleLimit: 2,
		});
		expect(visible).toHaveLength(2);
		expect(overflow.length).toBeGreaterThan(0);
	});

	it("keeps layout order across the visible/overflow boundary", () => {
		const { visible, overflow } = partitionToolbar({
			entries: all,
			hostCapabilities: ["drawer", "inline"],
			visibleLimit: 2,
		});
		const surfaced = [...visible, ...overflow].map((d) => d.id);
		const expected = all
			.filter(
				(e): e is { kind: "item"; id: (typeof NARRATOR_TOOLBAR_IDS)[number] } => e.kind === "item",
			)
			.map((e) => e.id)
			.filter((id) => surfaced.includes(id));
		expect(surfaced).toEqual(expected);
	});

	it("hides dock-only entries from a drawer-only host instead of showing dead controls", () => {
		const { visible, overflow } = partitionToolbar({
			entries: all,
			hostCapabilities: ["drawer", "inline"],
			visibleLimit: null,
		});
		const shown = [...visible, ...overflow].map((d) => d.id);
		// `plugins` needs a live Dockview api to add a panel to.
		expect(shown).not.toContain("plugins");
	});

	it("offers git/search/browser/userchat on a mobile (drawer) host", () => {
		// The regression this whole change exists for: these four had no mobile
		// entry point at all, because the header gated them behind `dock`.
		// Uncapped: the header measures width separately; availability is the point.
		const { visible, overflow } = partitionToolbar({
			entries: all,
			hostCapabilities: ["drawer", "inline"],
			visibleLimit: null,
		});
		const reachable = [...visible, ...overflow].map((d) => d.id as string);
		for (const id of ["git", "search", "browser", "userchat"]) {
			expect(reachable).toContain(id);
		}
	});

	it("shows only inline entries on a preview host with no panel surface", () => {
		const { visible, overflow } = partitionToolbar({
			entries: all,
			hostCapabilities: ["inline"],
			visibleLimit: null,
		});
		// `lodlevel` (detail-level menu) and `device` are self-contained inline
		// controls; everything else needs a panel surface.
		expect([...visible, ...overflow].map((d) => d.id)).toEqual(["lodlevel", "device"]);
	});

	it("treats a zero cap as everything tucked", () => {
		const { visible, overflow } = partitionToolbar({
			entries: all,
			hostCapabilities: ["dock", "drawer", "inline"],
			visibleLimit: 0,
		});
		expect(visible).toHaveLength(0);
		expect(overflow.length).toBeGreaterThan(0);
	});

	it("respects an explicit tucked zone even when the cap would allow more", () => {
		const entries: NarratorToolbarEntry[] = [
			{ kind: "item", id: "git" },
			{ kind: "divider" },
			{ kind: "item", id: "search" },
		];
		const { visible, overflow } = partitionToolbar({
			entries,
			hostCapabilities: ["dock", "drawer", "inline"],
			visibleLimit: 5,
		});
		expect(visible.map((d) => d.id)).toEqual(["git"]);
		expect(overflow.map((d) => d.id)).toEqual(["search"]);
	});

	it("keeps bottom separate from header overflow and filters all zones", () => {
		const entries: NarratorToolbarEntry[] = [
			{ kind: "item", id: "tasks" },
			{ kind: "item", id: "git" },
			{ kind: "divider" },
			{ kind: "item", id: "search" },
			{ kind: "bottom-divider" },
			{ kind: "item", id: "terminal" },
			{ kind: "item", id: "path-rules" },
			{ kind: "item", id: "plugins" },
		];
		const result = partitionToolbar({
			entries,
			hostCapabilities: ["drawer", "inline"],
			visibleLimit: 1,
			entryEnabled: (id) => id !== "path-rules",
		});
		expect(result.visible.map((d) => d.id)).toEqual(["tasks"]);
		expect(result.overflow.map((d) => d.id)).toEqual(["git", "search"]);
		expect(result.bottom.map((d) => d.id)).toEqual(["terminal"]);
	});

	it("supports a bottom-only boundary and never caps bottom entries", () => {
		const result = partitionToolbar({
			entries: [
				{ kind: "item", id: "git" },
				{ kind: "bottom-divider" },
				{ kind: "item", id: "terminal" },
				{ kind: "item", id: "terminal" },
				{ kind: "divider" },
				{ kind: "item", id: "search" },
			],
			hostCapabilities: ["drawer", "inline"],
			visibleLimit: 0,
		});
		expect(result.visible).toEqual([]);
		expect(result.overflow.map((d) => d.id)).toEqual(["git"]);
		expect(result.bottom.map((d) => d.id)).toEqual(["terminal", "search"]);
	});

	describe("entryEnabled", () => {
		// The first two surfaced entries are exactly the ones a standalone narrator
		// disables (no chapter for git, no spec support) — the setup that made a
		// capped mobile row render fewer buttons than its cap allows when the
		// filter ran after the slice.
		it("back-fills past disabled entries when capping, instead of showing a short row", () => {
			const { visible } = partitionToolbar({
				entries: all,
				hostCapabilities: ["drawer", "inline"],
				visibleLimit: 2,
				entryEnabled: (id) => id !== "tasks",
			});
			// filetree is drawer-capable since MobileToolPanelHost grew a tree drawer,
			// so on this host it legitimately takes the first capped slot.
			expect(visible.map((d) => d.id)).toEqual(["filetree", "details"]);
		});

		it("drops disabled entries from both lists on an uncapped host", () => {
			const { visible, overflow } = partitionToolbar({
				entries: all,
				hostCapabilities: ["dock", "drawer", "inline"],
				visibleLimit: null,
				entryEnabled: (id) => id !== "git" && id !== "plugins",
			});
			const shown = [...visible, ...overflow].map((d) => d.id);
			expect(shown).not.toContain("git");
			expect(shown).not.toContain("plugins");
		});

		it("keeps a tucked disabled entry out of the overflow list too", () => {
			const entries: NarratorToolbarEntry[] = [
				{ kind: "item", id: "git" },
				{ kind: "divider" },
				{ kind: "item", id: "search" },
			];
			const { visible, overflow } = partitionToolbar({
				entries,
				hostCapabilities: ["dock", "drawer", "inline"],
				visibleLimit: null,
				entryEnabled: (id) => id !== "search",
			});
			expect(visible.map((d) => d.id)).toEqual(["git"]);
			expect(overflow).toHaveLength(0);
		});

		it("changes nothing when every entry is enabled", () => {
			const capped = partitionToolbar({
				entries: all,
				hostCapabilities: ["drawer", "inline"],
				visibleLimit: 2,
				entryEnabled: () => true,
			});
			const uncapped = partitionToolbar({
				entries: all,
				hostCapabilities: ["drawer", "inline"],
				visibleLimit: 2,
			});
			expect(capped.visible.map((d) => d.id)).toEqual(uncapped.visible.map((d) => d.id));
			expect(capped.overflow.map((d) => d.id)).toEqual(uncapped.overflow.map((d) => d.id));
		});
	});
});
