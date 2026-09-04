/**
 * tree-store.test.ts — the layered cache's patch behaviour.
 *
 * The distinction under test throughout: an invalidated directory KEEPS its rows and
 * is marked stale, while a deleted one is evicted. Getting that backwards is not a
 * crash — it either collapses the user's expanded tree on every background event, or
 * leaves rows on screen that assert a file exists when it does not.
 */

import { describe, expect, it } from "bun:test";
import { TREE_ROOT_KEY, type TreeChange } from "./tree-patch";
import {
	applyTreePatch,
	buildTreeLineStats,
	emptyTreeState,
	ingestChanges,
	loadedDirs,
	markDirReadFailed,
	setDirEntries,
	staleDirs,
	type TreeEntry,
	type TreeState,
} from "./tree-store";

function file(path: string): TreeEntry {
	const name = path.split("/").pop() ?? path;
	return { name, path, isDirectory: false, isSymlink: false, size: 1 };
}

function dir(path: string): TreeEntry {
	const name = path.split("/").pop() ?? path;
	return { name, path, isDirectory: true, isSymlink: false };
}

/** A tree with the root, `src`, and `src/a` loaded. */
function seeded(): TreeState {
	let state = emptyTreeState();
	state = setDirEntries(state, TREE_ROOT_KEY, [dir("src"), file("README.md")]);
	state = setDirEntries(state, "src", [dir("src/a"), file("src/index.ts")]);
	state = setDirEntries(state, "src/a", [file("src/a/b.ts")]);
	return state;
}

const changed = (path: string, kind: TreeChange["kind"] = "updated"): TreeChange[] => [
	{ path, kind },
];

describe("buildTreeLineStats", () => {
	it("indexes files and aggregates every ancestor directory", () => {
		const stats = buildTreeLineStats([
			{ path: "src/a.ts", linesAdded: 3, linesRemoved: 1 },
			{ path: "src/nested/b.ts", linesAdded: 2, linesRemoved: 4 },
			{ path: "./docs/readme.md", linesAdded: 1, linesRemoved: 0 },
		]);

		expect(stats.get("src/a.ts")).toEqual({ added: 3, removed: 1 });
		expect(stats.get("src/nested/b.ts")).toEqual({ added: 2, removed: 4 });
		expect(stats.get("src/nested")).toEqual({ added: 2, removed: 4 });
		expect(stats.get("src")).toEqual({ added: 5, removed: 5 });
		expect(stats.get("docs/readme.md")).toEqual({ added: 1, removed: 0 });
		expect(stats.get("docs")).toEqual({ added: 1, removed: 0 });
	});

	it("ignores paths outside the tree instead of attaching them to a parent", () => {
		const stats = buildTreeLineStats([
			{ path: "../outside.ts", linesAdded: 9, linesRemoved: 2 },
			{ path: "/absolute.ts", linesAdded: 4, linesRemoved: 0 },
		]);

		expect(stats.has("../outside.ts")).toBe(false);
		expect(stats.has("/absolute.ts")).toBe(false);
		expect(stats.has("absolute.ts")).toBe(false);
	});
});

describe("setDirEntries", () => {
	it("records a listing as fresh", () => {
		const state = setDirEntries(emptyTreeState(), "src", [file("src/a.ts")]);

		expect(state.get("src")?.stale).toBe(false);
		expect(state.get("src")?.entries).toHaveLength(1);
	});

	it("clears staleness when a listing is re-read", () => {
		const stale = ingestChanges(seeded(), changed("src/a/b.ts"), false);
		expect(stale.get("src/a")?.stale).toBe(true);

		const refreshed = setDirEntries(stale, "src/a", [file("src/a/b.ts")]);
		expect(refreshed.get("src/a")?.stale).toBe(false);
	});

	it("returns a new map so React can compare by identity", () => {
		const before = seeded();
		const after = setDirEntries(before, "src", []);

		expect(after).not.toBe(before);
	});
});

describe("ingestChanges — invalidation keeps rows visible", () => {
	it("marks the parent stale without discarding its entries", () => {
		// Dropping the rows would collapse the view for the duration of a refetch that
		// usually returns nearly the same listing.
		const state = ingestChanges(seeded(), changed("src/a/b.ts"), false);

		expect(state.get("src/a")?.stale).toBe(true);
		expect(state.get("src/a")?.entries).toHaveLength(1);
	});

	it("leaves unrelated directories untouched", () => {
		const state = ingestChanges(seeded(), changed("src/a/b.ts"), false);

		expect(state.get("src")?.stale).toBe(false);
		expect(state.get(TREE_ROOT_KEY)?.stale).toBe(false);
	});

	it("keeps the same state object when nothing is affected", () => {
		// A change under an unexpanded subtree must not trigger a re-render.
		const before = seeded();
		const after = ingestChanges(before, changed("unloaded/deep/x.ts"), false);

		expect(after).toBe(before);
	});
});

describe("ingestChanges — deletions evict", () => {
	it("removes a deleted directory and marks its parent stale", () => {
		const state = ingestChanges(seeded(), changed("src/a", "deleted"), false);

		expect(state.has("src/a")).toBe(false);
		expect(state.get("src")?.stale).toBe(true);
	});

	it("removes loaded descendants of a deleted directory", () => {
		let state = seeded();
		state = setDirEntries(state, "src/a/deep", [file("src/a/deep/x.ts")]);

		const after = ingestChanges(state, changed("src/a", "deleted"), false);

		expect(after.has("src/a")).toBe(false);
		expect(after.has("src/a/deep")).toBe(false);
	});

	it("keeps a deleted file's parent loaded, only stale", () => {
		// A deleted file was never a directory key; only its parent listing changed.
		const state = ingestChanges(seeded(), changed("src/index.ts", "deleted"), false);

		expect(state.has("src")).toBe(true);
		expect(state.get("src")?.stale).toBe(true);
	});
});

describe("ingestChanges — truncated batches", () => {
	it("marks every loaded directory stale", () => {
		const state = ingestChanges(seeded(), changed("src/a/b.ts"), true);

		expect(state.get(TREE_ROOT_KEY)?.stale).toBe(true);
		expect(state.get("src")?.stale).toBe(true);
		expect(state.get("src/a")?.stale).toBe(true);
	});

	it("still evicts directories it saw deleted", () => {
		const state = ingestChanges(seeded(), changed("src/a", "deleted"), true);

		expect(state.has("src/a")).toBe(false);
		expect(state.get("src")?.stale).toBe(true);
	});

	it("retains all rows so the tree keeps rendering", () => {
		const state = ingestChanges(seeded(), changed("src/a/b.ts"), true);

		expect(state.get("src")?.entries).toHaveLength(2);
	});
});

describe("applyTreePatch", () => {
	it("never inserts an entry for a directory that is not loaded", () => {
		// An inserted empty entry would render as "this directory is empty" — a claim
		// the store has no basis for.
		const state = applyTreePatch(seeded(), {
			invalidated: ["not/loaded"],
			dropped: [],
			revalidateAll: false,
		});

		expect(state.has("not/loaded")).toBe(false);
	});

	it("drops before invalidating, so a deleted subtree cannot be resurrected", () => {
		const state = applyTreePatch(seeded(), {
			invalidated: ["src/a"],
			dropped: ["src/a"],
			revalidateAll: false,
		});

		expect(state.has("src/a")).toBe(false);
	});
});

describe("markDirReadFailed", () => {
	it("clears staleness so the revalidation loop can terminate", () => {
		// The bug this prevents: revalidation loops until nothing is stale, so a
		// directory whose read fails while still marked stale would be retried
		// continuously — a client-side hot loop against a synchronous server route.
		const stale = ingestChanges(seeded(), changed("src/a/b.ts"), false);
		expect(stale.get("src/a")?.stale).toBe(true);

		const after = markDirReadFailed(stale, "src/a");
		expect(after.get("src/a")?.stale).toBe(false);
		expect(staleDirs(after)).toEqual([]);
	});

	it("keeps the existing entries visible", () => {
		// The read failed, so the last known listing is the best available answer.
		const stale = ingestChanges(seeded(), changed("src/a/b.ts"), false);
		const after = markDirReadFailed(stale, "src/a");

		expect(after.get("src/a")?.entries).toHaveLength(1);
	});

	it("does not invent an entry for a directory that is not loaded", () => {
		// Inserting one would claim an empty listing for a directory we failed to read.
		const after = markDirReadFailed(seeded(), "never/loaded");

		expect(after.has("never/loaded")).toBe(false);
	});

	it("is identity-stable when the directory was not stale", () => {
		const before = seeded();

		expect(markDirReadFailed(before, "src")).toBe(before);
	});
});

describe("staleDirs", () => {
	it("returns shallower directories first", () => {
		// A parent's refetch can reveal that a child is gone, dropping pending work
		// rather than spending a request on it.
		let state = seeded();
		state = setDirEntries(state, "src/a/deep", [file("src/a/deep/x.ts")]);
		const stale = ingestChanges(state, [], true);

		expect(staleDirs(stale)).toEqual([TREE_ROOT_KEY, "src", "src/a", "src/a/deep"]);
	});

	it("omits fresh directories", () => {
		const state = ingestChanges(seeded(), changed("src/a/b.ts"), false);

		expect(staleDirs(state)).toEqual(["src/a"]);
	});
});

describe("loadedDirs", () => {
	it("reports exactly the loaded keys, bounding any patch's work", () => {
		expect([...loadedDirs(seeded())].sort()).toEqual([TREE_ROOT_KEY, "src", "src/a"]);
	});
});

describe("file-tree line-stat wiring", () => {
	it("fetches status for the narrator and refreshes it from both workspace signals", async () => {
		const panel = await Bun.file(new URL("./FileTreePanel.tsx", import.meta.url)).text();
		expect(panel).toContain("useFileTreeStatus(");
		expect(panel).toContain("onWorkspacePathsChanged");
		expect(panel).toContain("onGitStatus: refreshLineStats");
		expect(panel).toContain("lineStats={lineStats}");
	});

	it("paints added and removed counts beside both file and directory rows", async () => {
		const content = await Bun.file(new URL("./FileTreeContent.tsx", import.meta.url)).text();
		expect(content).toContain("lineStats?.get(entry.path)");
		expect(content).toContain("+{stats.added}");
		expect(content).toContain("-{stats.removed}");
		expect(content).toContain("entry.isDirectory && lineStatsTruncated");
	});
});
