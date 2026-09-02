/**
 * tree-patch.test.ts — the mapping from watcher path events to directory-level
 * invalidations.
 *
 * These cases pin the decisions where a wrong answer is SILENT rather than a crash:
 * invalidating a level the tree never loaded (turning a background event into
 * unbounded fetching), trusting a truncated batch as if it were complete (leaving
 * real changes invisible), and re-reading directories that no longer exist.
 */

import { describe, expect, it } from "bun:test";
import { computeTreePatch, parentPath, TREE_ROOT_KEY, type TreeChange } from "./tree-patch";

const loaded = (...dirs: string[]) => new Set([TREE_ROOT_KEY, ...dirs]);

function patch(changes: TreeChange[], loadedDirs: ReadonlySet<string>, truncated = false) {
	const result = computeTreePatch({ changes, truncated, loadedDirs });
	return {
		...result,
		invalidated: [...result.invalidated].sort(),
		dropped: [...result.dropped].sort(),
	};
}

describe("parentPath", () => {
	it("maps a top-level entry to the root key", () => {
		// The root must not need a special case at the call sites.
		expect(parentPath("README.md")).toBe(TREE_ROOT_KEY);
	});

	it("returns the containing directory for a nested path", () => {
		expect(parentPath("src/a/b.ts")).toBe("src/a");
	});

	it("ignores a trailing slash so a directory reported either way agrees", () => {
		// `src/a/` must not resolve to `src/a` — that would invalidate the level
		// BELOW the one whose listing actually names it.
		expect(parentPath("src/a/")).toBe("src");
		expect(parentPath("src/a")).toBe("src");
	});
});

describe("computeTreePatch — invalidation targets the parent", () => {
	it("invalidates the containing directory, not the changed path", () => {
		// The parent's listing is what names the file; the file has no listing.
		const result = patch([{ path: "src/a/b.ts", kind: "updated" }], loaded("src", "src/a"));

		expect(result.invalidated).toEqual(["src/a"]);
	});

	it("invalidates the root for a top-level change", () => {
		const result = patch([{ path: "README.md", kind: "added" }], loaded("src"));

		expect(result.invalidated).toEqual([TREE_ROOT_KEY]);
	});

	it("coalesces many changes in one directory into a single invalidation", () => {
		const result = patch(
			[
				{ path: "src/a.ts", kind: "updated" },
				{ path: "src/b.ts", kind: "updated" },
				{ path: "src/c.ts", kind: "added" },
			],
			loaded("src"),
		);

		expect(result.invalidated).toEqual(["src"]);
	});

	it("skips directories the tree has not loaded", () => {
		// The regression this guards: invalidating an unloaded level makes the tree
		// fetch subtrees nobody expanded, so a build touching deep paths would
		// schedule work across the whole repository.
		const result = patch([{ path: "deep/nested/x.ts", kind: "updated" }], loaded("src"));

		expect(result.invalidated).toEqual([]);
	});
});

describe("computeTreePatch — deletions", () => {
	it("drops a deleted directory and re-reads its parent", () => {
		const result = patch([{ path: "src/a", kind: "deleted" }], loaded("src", "src/a"));

		expect(result.dropped).toEqual(["src/a"]);
		// The parent listing is what still shows the directory that went away.
		expect(result.invalidated).toEqual(["src"]);
	});

	it("drops loaded descendants of a deleted directory", () => {
		// Re-reading them would only produce failed requests for paths that are gone.
		const result = patch(
			[{ path: "src/a", kind: "deleted" }],
			loaded("src", "src/a", "src/a/b", "src/a/b/c"),
		);

		expect(result.dropped).toEqual(["src/a", "src/a/b", "src/a/b/c"]);
		expect(result.invalidated).toEqual(["src"]);
	});

	it("never re-reads a directory inside a deleted subtree", () => {
		// A file change and the deletion of its ancestor can arrive in the same batch;
		// the deletion wins.
		const result = patch(
			[
				{ path: "src/a/b/x.ts", kind: "updated" },
				{ path: "src/a", kind: "deleted" },
			],
			loaded("src", "src/a", "src/a/b"),
		);

		expect(result.invalidated).toEqual(["src"]);
		expect(result.invalidated).not.toContain("src/a/b");
	});

	it("treats a deleted file as a plain parent invalidation", () => {
		// A deletion event cannot say whether the path was a file or a directory. A
		// deleted FILE was never a loaded directory key, so it must not be dropped —
		// only its parent listing changed.
		const result = patch([{ path: "src/gone.ts", kind: "deleted" }], loaded("src"));

		expect(result.dropped).toEqual([]);
		expect(result.invalidated).toEqual(["src"]);
	});

	it("does not drop a directory whose name merely shares a prefix", () => {
		// `src/abc` is not under `src/a`, despite the string prefix.
		const result = patch([{ path: "src/a", kind: "deleted" }], loaded("src", "src/abc"));

		expect(result.dropped).toEqual([]);
	});
});

describe("computeTreePatch — truncated batches", () => {
	const changes: TreeChange[] = [{ path: "src/a.ts", kind: "updated" }];

	it("asks for full revalidation instead of trusting the sample", () => {
		// The batch hit the watcher's cap, so the listed changes are a sample. Applying
		// them literally would leave everything that did not fit silently stale.
		const result = patch(changes, loaded("src"), true);

		expect(result.revalidateAll).toBe(true);
		expect(result.invalidated).toEqual([]);
	});

	it("still honours deletions it did see", () => {
		// A path known to be gone must not survive because the batch overflowed;
		// dropping it is strictly better than re-reading a missing directory.
		const result = patch([{ path: "src/a", kind: "deleted" }], loaded("src", "src/a"), true);

		expect(result.revalidateAll).toBe(true);
		expect(result.dropped).toEqual(["src/a"]);
	});

	it("does not set revalidateAll for a complete batch", () => {
		const result = patch(changes, loaded("src"));

		expect(result.revalidateAll).toBe(false);
	});
});

describe("computeTreePatch — empty input", () => {
	it("produces no work when nothing changed", () => {
		const result = patch([], loaded("src"));

		expect(result.invalidated).toEqual([]);
		expect(result.dropped).toEqual([]);
		expect(result.revalidateAll).toBe(false);
	});
});
