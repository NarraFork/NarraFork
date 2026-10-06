import { describe, expect, it } from "bun:test";
import { CUSTOMIZABLE_NAV_IDS, NAV_DIVIDER_ID } from "@shared/nav-layout";
import { CUSTOMIZABLE_NAV_ITEMS } from "../components/nav/nav-items";
import {
	DEFAULT_NAV_ENTRIES,
	mergeNavLayout,
	projectNavLayout,
	restoreRetiredNavEntries,
	toPersistedNavLayout,
} from "./nav-layout";

/** Ids on each side of the divider, in order. */
function split(entries: ReturnType<typeof mergeNavLayout>): {
	visible: string[];
	tucked: string[];
} {
	const cut = entries.findIndex((entry) => entry.kind === "divider");
	const ids = (from: number, to: number) =>
		entries.slice(from, to).flatMap((entry) => (entry.kind === "item" ? [entry.id] : []));
	return { visible: ids(0, cut), tucked: ids(cut + 1, entries.length) };
}

describe("nav layout defaults", () => {
	it("tucks exactly the entries the registry marks defaultTucked", () => {
		const { visible, tucked } = split(DEFAULT_NAV_ENTRIES);
		const expectedTucked = CUSTOMIZABLE_NAV_ITEMS.filter((def) => def.defaultTucked).map(
			(def) => def.id,
		);
		expect(tucked).toEqual(expectedTucked);
		// Nothing may be dropped: an id on neither side renders nowhere and is
		// unreachable even through the overflow menu.
		expect([...visible, ...tucked].sort()).toEqual([...CUSTOMIZABLE_NAV_IDS].sort());
	});

	it("removes the tutorial entry but preserves the independent learning guide", () => {
		expect(CUSTOMIZABLE_NAV_IDS).not.toContain("tutorial");
		expect(CUSTOMIZABLE_NAV_ITEMS.map((def) => def.to)).not.toContain("/tutorial");
		expect(CUSTOMIZABLE_NAV_ITEMS.find((def) => def.id === "learn")?.to).toBe("/learn");
	});

	it("keeps the historical project preference but removes its presentation", () => {
		expect(split(DEFAULT_NAV_ENTRIES).visible).toContain("projects");
		expect(split(projectNavLayout(DEFAULT_NAV_ENTRIES)).visible).not.toContain("projects");
	});

	it("applies the same defaults to a user with no persisted layout", () => {
		// `{}` is the column default, so this is what every user starts from.
		expect(mergeNavLayout({})).toEqual(DEFAULT_NAV_ENTRIES);
		expect(mergeNavLayout(undefined)).toEqual(DEFAULT_NAV_ENTRIES);
		expect(mergeNavLayout("not an object")).toEqual(DEFAULT_NAV_ENTRIES);
	});
});

describe("nav layout merge", () => {
	it("lets a stored position beat the registry default", () => {
		// `learn` defaults to tucked. A reader who dragged it up must keep it up:
		// re-applying the default here would silently undo a customization on upgrade.
		const { visible } = split(
			mergeNavLayout({
				items: [{ id: "projects" }, { id: "learn" }, { id: NAV_DIVIDER_ID }],
			}),
		);
		expect(visible).toContain("learn");
	});

	it("keeps a stored tucked position for an entry that defaults to visible", () => {
		const { visible, tucked } = split(
			mergeNavLayout({
				items: [{ id: "projects" }, { id: NAV_DIVIDER_ID }, { id: "knowledge" }],
			}),
		);
		expect(tucked).toContain("knowledge");
		expect(visible).not.toContain("knowledge");
	});

	it("places a brand-new registry id by its default, not at the end of the visible rail", () => {
		// Simulates an upgrade: the reader's layout predates every tucked entry.
		const persisted = {
			items: [{ id: "projects" }, { id: "messages" }, { id: NAV_DIVIDER_ID }],
		};
		const { visible, tucked } = split(mergeNavLayout(persisted));
		for (const def of CUSTOMIZABLE_NAV_ITEMS) {
			if (def.id === "projects" || def.id === "messages") continue;
			expect(def.defaultTucked ? tucked : visible).toContain(def.id);
		}
	});

	it("drops stale ids rather than passing them to the server", () => {
		// The server enum rejects unknown ids, which would make the whole layout
		// unsavable — the symptom is a failure toast on every drag.
		const entries = mergeNavLayout({
			items: [{ id: "groups" }, { id: "projects" }, { id: NAV_DIVIDER_ID }],
		});
		const ids = toPersistedNavLayout(entries).items.map((item) => item.id);
		expect(ids).not.toContain("groups");
		for (const id of ids) {
			expect(id === NAV_DIVIDER_ID || CUSTOMIZABLE_NAV_IDS.includes(id as never)).toBe(true);
		}
	});

	it("drops retired tutorial entries without moving the remaining custom layout", () => {
		const currentIds = ["knowledge", "projects", "messages", "routines", "scheduled-tasks"];
		for (const hidden of [undefined, true]) {
			const entries = mergeNavLayout({
				items: [
					{ id: "tutorial", hidden },
					...currentIds.map((id) => ({ id })),
					{ id: NAV_DIVIDER_ID },
					{ id: "tutorial" },
					{ id: "learn" },
				],
			});
			expect(split(entries)).toEqual({ visible: currentIds, tucked: ["learn"] });
			expect(toPersistedNavLayout(entries).items.map((item) => item.id)).not.toContain("tutorial");
		}
	});

	it("keeps only the first divider and ignores duplicates", () => {
		const entries = mergeNavLayout({
			items: [
				{ id: "projects" },
				{ id: NAV_DIVIDER_ID },
				{ id: "learn" },
				{ id: NAV_DIVIDER_ID },
				{ id: "knowledge" },
			],
		});
		expect(entries.filter((entry) => entry.kind === "divider")).toHaveLength(1);
		const { tucked } = split(entries);
		// Everything after the FIRST divider stays tucked, including ids that
		// followed the second one.
		expect(tucked).toContain("learn");
		expect(tucked).toContain("knowledge");
	});

	it("de-duplicates a repeated id, keeping its first position", () => {
		const { visible, tucked } = split(
			mergeNavLayout({
				items: [{ id: "knowledge" }, { id: NAV_DIVIDER_ID }, { id: "knowledge" }],
			}),
		);
		expect(visible.filter((id) => id === "knowledge")).toHaveLength(1);
		expect(tucked).not.toContain("knowledge");
	});

	it("honours the legacy hidden flag over divider position", () => {
		const { tucked } = split(
			mergeNavLayout({
				items: [{ id: "projects" }, { id: "learn", hidden: true }, { id: NAV_DIVIDER_ID }],
			}),
		);
		expect(tucked).toContain("learn");
	});

	it("treats a layout with no divider as everything surfaced", () => {
		const { visible, tucked } = split(
			mergeNavLayout({ items: CUSTOMIZABLE_NAV_IDS.map((id) => ({ id })) }),
		);
		expect(visible).toEqual([...CUSTOMIZABLE_NAV_IDS]);
		expect(tucked).toEqual([]);
	});

	it("round-trips through the persisted shape without moving anything", () => {
		const entries = mergeNavLayout({
			items: [{ id: "projects" }, { id: NAV_DIVIDER_ID }, { id: "learn" }],
		});
		expect(mergeNavLayout(toPersistedNavLayout(entries))).toEqual(entries);
	});
});

describe("retired navigation presentation, shared by desktop and mobile", () => {
	it.each([
		undefined,
		{ items: [{ id: "projects" }, { id: "messages" }, { id: NAV_DIVIDER_ID }] },
		{ items: [{ id: "messages" }, { id: NAV_DIVIDER_ID }, { id: "projects" }] },
		{
			items: [
				{ id: "projects", hidden: false },
				{ id: "learn", hidden: true },
			],
		},
	])("filters both the sidebar and overflow without rewriting preferences: %j", (preferences) => {
		const before = structuredClone(preferences);
		const stored = mergeNavLayout(preferences);
		const projected = projectNavLayout(stored);
		expect(split(projected).visible).not.toContain("projects");
		expect(split(projected).tucked).not.toContain("projects");
		expect(preferences).toEqual(before);
		expect(restoreRetiredNavEntries(projected, stored)).toEqual(stored);
	});

	it("preserves a retired id when saving an explicit reorder", () => {
		const stored = mergeNavLayout({
			items: [{ id: "projects" }, { id: "learn" }, { id: "messages" }, { id: NAV_DIVIDER_ID }],
		});
		const projected = projectNavLayout(stored);
		const reordered = [projected[1], projected[0], ...projected.slice(2)];
		const saved = restoreRetiredNavEntries(reordered, stored);
		expect(saved[0]).toEqual({ kind: "item", id: "projects" });
		expect(projectNavLayout(saved)).toEqual(reordered);
	});
});
