import { describe, expect, test } from "bun:test";
import {
	applyRecentTabFolderCreate,
	applyRecentTabFolderDissolve,
	applyRecentTabMove,
	applyRecentTabPin,
	applyRecentTabRemove,
	regroupFolders,
} from "./recent-tab-layout";
import type { PersistedRecentTab } from "./recent-tabs";

const tab = (id: string, extra: Partial<PersistedRecentTab> = {}): PersistedRecentTab => ({
	type: "narrator",
	id,
	title: id,
	lastVisitedAt: 1,
	...extra,
});
const folder = (id: string, extra: Partial<PersistedRecentTab> = {}) =>
	tab(id, { type: "folder", ...extra });

/** "id", "id>folder", "*" prefix for pinned, "[id]" for a folder header. */
const shape = (tabs: PersistedRecentTab[]) =>
	tabs.map((item) => {
		const pin = item.pinned ? "*" : "";
		if (item.type === "folder") return `${pin}[${item.id}]`;
		return `${pin}${item.id}${item.folderId ? `>${item.folderId}` : ""}`;
	});

describe("regroupFolders", () => {
	test("pulls members under their header, pinned first, and keeps an in-shape list as is", () => {
		const tabs = [
			tab("m1", { folderId: "f" }),
			folder("f"),
			tab("m2", { folderId: "f", pinned: true }),
		];
		const grouped = regroupFolders(tabs);
		expect(shape(grouped)).toEqual(["[f]", "*m2>f", "m1>f"]);
		expect(regroupFolders(grouped)).toBe(grouped);
	});

	test("without prune keeps orphans and empty folders; with prune drops both", () => {
		const tabs = [folder("empty"), tab("orphan", { folderId: "gone" }), tab("x")];
		expect(shape(regroupFolders(tabs))).toEqual(["[empty]", "orphan>gone", "x"]);
		expect(shape(regroupFolders(tabs, { prune: true }))).toEqual(["orphan", "x"]);
		expect(tabs[1].folderId).toBe("gone");
	});
});

describe("folder operations", () => {
	const base = () => [
		tab("a"),
		folder("f", { pinned: true }),
		tab("m1", { folderId: "f", pinned: true }),
		tab("m2", { folderId: "f" }),
		tab("b", { pinned: true }),
	];

	test("create takes the target's slot and pin, and empties the source's old folder", () => {
		const tabs = [tab("t", { pinned: true }), folder("old"), tab("s", { folderId: "old" })];
		const next = applyRecentTabFolderCreate(tabs, "narrator:t", "narrator:s", folder("new"));
		expect(next && shape(next)).toEqual(["*[new]", "t>new", "s>new"]);
		expect(applyRecentTabFolderCreate(tabs, "narrator:s", "narrator:t", folder("x"))).toBeNull();
		expect(applyRecentTabFolderCreate(tabs, "folder:old", "narrator:t", folder("x"))).toBeNull();
	});

	test("pinning a member moves it inside its folder only", () => {
		expect(shape(applyRecentTabPin(base(), "narrator:m2", true))).toEqual([
			"a",
			"*[f]",
			"*m1>f",
			"*m2>f",
			"*b",
		]);
		expect(shape(applyRecentTabPin(base(), "narrator:m1", false))).toEqual([
			"a",
			"*[f]",
			"m1>f",
			"m2>f",
			"*b",
		]);
	});

	test("dissolve keeps members in place, in the folder's own section", () => {
		// The folder is pinned: its members stay pinned, where the user was looking, instead
		// of dropping into the unpinned area below.
		expect(shape(applyRecentTabFolderDissolve(base(), "f"))).toEqual(["a", "*m1", "*m2", "*b"]);
		const unpinnedFolder = [
			tab("a", { pinned: true }),
			folder("f"),
			tab("m1", { folderId: "f", pinned: true }),
			tab("m2", { folderId: "f" }),
		];
		expect(shape(applyRecentTabFolderDissolve(unpinnedFolder, "f"))).toEqual(["*a", "m1", "m2"]);
		expect(shape(applyRecentTabRemove(base(), "folder:f"))).toEqual(["a", "*b"]);
		const single = applyRecentTabRemove(base(), "narrator:m1");
		expect(shape(applyRecentTabRemove(single, "narrator:m2"))).toEqual(["a", "*b"]);
	});

	test("keepEmptyFolder leaves an emptied folder header in place", () => {
		// 归档是可撤销的：最后一条记录离开时，文件夹不该跟着消失。
		const tabs = [tab("a"), folder("f"), tab("m1", { folderId: "f" })];
		expect(shape(applyRecentTabRemove(tabs, "narrator:m1"))).toEqual(["a"]);
		expect(shape(applyRecentTabRemove(tabs, "narrator:m1", { keepEmptyFolder: true }))).toEqual([
			"a",
			"[f]",
		]);
	});

	test("operations never mutate their input", () => {
		const tabs = base();
		const snapshot = JSON.stringify(tabs);
		applyRecentTabPin(tabs, "narrator:m2", true);
		applyRecentTabFolderDissolve(tabs, "f");
		applyRecentTabRemove(tabs, "narrator:m1");
		applyRecentTabFolderCreate(tabs, "narrator:a", "narrator:m2", folder("n"));
		expect(JSON.stringify(tabs)).toBe(snapshot);
	});
});

describe("moves across the pin divider", () => {
	test("a tab aimed into the pinned block takes that pinned state at its slot", () => {
		const tabs = [tab("p", { pinned: true }), tab("a"), tab("b")];
		expect(
			shape(applyRecentTabMove(tabs, "narrator:b", { beforeKey: "narrator:p", pinned: true })),
		).toEqual(["*b", "*p", "a"]);
		// A pinned tab aimed into the unpinned block is unpinned there.
		expect(
			shape(applyRecentTabMove(tabs, "narrator:p", { afterKey: "narrator:b", pinned: false })),
		).toEqual(["a", "b", "p"]);
		// Inside its own block, `pinned` is simply true again (no surprise unpin).
		expect(
			shape(applyRecentTabMove(tabs, "narrator:p", { afterKey: "narrator:a", pinned: false })),
		).toEqual(["a", "p", "b"]);
	});

	test("a folder crosses as a unit: its head carries the zone, members keep theirs", () => {
		const tabs = [
			tab("a"),
			folder("f"),
			tab("m1", { folderId: "f", pinned: true }),
			tab("m2", { folderId: "f" }),
			tab("p", { pinned: true }),
		];
		expect(
			shape(applyRecentTabMove(tabs, "folder:f", { beforeKey: "narrator:p", pinned: true })),
		).toEqual(["a", "*[f]", "*m1>f", "m2>f", "*p"]);
	});

	test("a member leaving a folder into the pinned block is pinned at the top level", () => {
		const tabs = [folder("f"), tab("m", { folderId: "f" }), tab("p", { pinned: true })];
		expect(
			shape(
				applyRecentTabMove(tabs, "narrator:m", {
					beforeKey: "narrator:p",
					folderId: null,
					pinned: true,
				}),
			),
		).toEqual(["*m", "*p"]);
	});
});
