import { describe, expect, it } from "bun:test";
import {
	MOBILE_TOOLBAR_VISIBLE_LIMIT,
	NARRATOR_TOOLBAR_DIVIDER_ID,
	NARRATOR_TOOLBAR_IDS,
} from "@shared/narrator-toolbar";
import {
	DEFAULT_TOOLBAR_ENTRIES,
	mergeToolbarLayout,
	type NarratorToolbarEntry,
	partitionToolbar,
	toPersistedToolbarLayout,
} from "./narrator-toolbar-layout";

function ids(entries: readonly NarratorToolbarEntry[]): string[] {
	return entries.map((e) => (e.kind === "divider" ? NARRATOR_TOOLBAR_DIVIDER_ID : e.id));
}

describe("mergeToolbarLayout", () => {
	it("returns every registry id surfaced for a fresh install", () => {
		const merged = mergeToolbarLayout(undefined);
		const divider = ids(merged).indexOf(NARRATOR_TOOLBAR_DIVIDER_ID);
		expect(divider).toBe(NARRATOR_TOOLBAR_IDS.length);
		expect(ids(merged).slice(0, divider)).toEqual([...NARRATOR_TOOLBAR_IDS]);
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
		expect(divider).toBe(flat.length - 1);
	});

	it("survives malformed persisted values", () => {
		for (const bad of [null, 42, "nope", [], { items: "no" }, { items: [null, 7, {}] }]) {
			expect(() => mergeToolbarLayout(bad)).not.toThrow();
			expect(ids(mergeToolbarLayout(bad))).toContain(NARRATOR_TOOLBAR_DIVIDER_ID);
		}
	});

	it("round-trips through the persisted shape", () => {
		const merged = mergeToolbarLayout({
			items: [{ id: "search" }, { id: NARRATOR_TOOLBAR_DIVIDER_ID }, { id: "git" }],
		});
		expect(ids(mergeToolbarLayout(toPersistedToolbarLayout(merged)))).toEqual(ids(merged));
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
		expect(visible).toHaveLength(NARRATOR_TOOLBAR_IDS.length);
		expect(overflow).toHaveLength(0);
	});

	it("caps the mobile host and pushes the remainder into the overflow menu", () => {
		const { visible, overflow } = partitionToolbar({
			entries: all,
			hostCapabilities: ["drawer", "inline"],
			visibleLimit: MOBILE_TOOLBAR_VISIBLE_LIMIT,
		});
		expect(visible).toHaveLength(MOBILE_TOOLBAR_VISIBLE_LIMIT);
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
		const { visible, overflow } = partitionToolbar({
			entries: all,
			hostCapabilities: ["drawer", "inline"],
			visibleLimit: MOBILE_TOOLBAR_VISIBLE_LIMIT,
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
				entryEnabled: (id) => id !== "tasks" && id !== "filemod",
			});
			expect(visible.map((d) => d.id)).toEqual(["details", "terminal"]);
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
				visibleLimit: MOBILE_TOOLBAR_VISIBLE_LIMIT,
				entryEnabled: () => true,
			});
			const uncapped = partitionToolbar({
				entries: all,
				hostCapabilities: ["drawer", "inline"],
				visibleLimit: MOBILE_TOOLBAR_VISIBLE_LIMIT,
			});
			expect(capped.visible.map((d) => d.id)).toEqual(uncapped.visible.map((d) => d.id));
			expect(capped.overflow.map((d) => d.id)).toEqual(uncapped.overflow.map((d) => d.id));
		});
	});
});
