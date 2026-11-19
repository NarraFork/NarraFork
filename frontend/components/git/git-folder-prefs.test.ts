/**
 * Session-scoped git folder expansion state.
 *
 * The invariants worth pinning are the ones a UI bug would hide: an unknown path
 * must read as COLLAPSED (that is what makes "closed by default" free), corrupt
 * storage must degrade to "nothing expanded" instead of throwing, and the two
 * panel sections must never leak into each other.
 *
 * There are deliberately NO size caps to test. Caps existed when this state was
 * persisted forever in localStorage and could grow across every chapter ever
 * opened; sessionStorage is discarded with the tab, so the document is bounded by
 * one session's browsing and needs no pruning.
 */

import { describe, expect, test } from "bun:test";
import {
	type GitFolderPrefs,
	normalizeExpandedPaths,
	parseFolderPrefs,
	readExpanded,
	toggleExpanded,
	toggleExpandedPath,
} from "./git-folder-prefs";

describe("normalizeExpandedPaths", () => {
	test("adds ancestor intent to historical compact rows without changing the input", () => {
		const paths = ["src/a/deep", "src/a", "src2/b"];
		expect(normalizeExpandedPaths(paths)).toEqual(
			new Set(["src", "src/a", "src/a/deep", "src2", "src2/b"]),
		);
		expect(paths).toEqual(["src/a/deep", "src/a", "src2/b"]);
	});

	test("preserves literal backslashes, whitespace, Unicode and dot names", () => {
		const literal = "中文 空格/line\n\\name/.hidden";
		expect(normalizeExpandedPaths([literal])).toEqual(
			new Set(["中文 空格", "中文 空格/line\n\\name", literal]),
		);
		expect(normalizeExpandedPaths(["src\\a"])).toEqual(new Set(["src\\a"]));
	});

	test("is idempotent for an already normalized set", () => {
		const normalized = normalizeExpandedPaths(["src/a", "src/b"]);
		expect(normalizeExpandedPaths(normalized)).toEqual(normalized);
		expect(normalizeExpandedPaths([])).toEqual(new Set());
	});
});

describe("toggleExpandedPath", () => {
	test("opening a compact row retains every ancestor when its label later splits", () => {
		const opened = toggleExpandedPath([], "src/a/deep");
		expect(opened).toEqual(new Set(["src", "src/a", "src/a/deep"]));
		const closed = toggleExpandedPath(opened, "src/a");
		expect(closed).toEqual(new Set(["src"]));
		expect(toggleExpandedPath(closed, "src/a")).toEqual(new Set(["src", "src/a"]));
	});

	test("closing a parent removes historical descendants and keeps sibling prefixes", () => {
		const paths = ["src/a/deep", "src/a2/deep", "src2/a", "src\\a/deep"];
		expect(toggleExpandedPath(paths, "src/a")).toEqual(
			new Set(["src", "src/a2", "src/a2/deep", "src2", "src2/a", "src\\a", "src\\a/deep"]),
		);
		expect(toggleExpandedPath(paths, "src")).toEqual(
			new Set(["src2", "src2/a", "src\\a", "src\\a/deep"]),
		);
		expect(paths).toEqual(["src/a/deep", "src/a2/deep", "src2/a", "src\\a/deep"]);
	});
});

describe("readExpanded", () => {
	test("an unknown chapter has nothing expanded", () => {
		// This is the whole point of storing the expanded set: default = collapsed.
		expect(readExpanded({}, "ch-1", "staged").size).toBe(0);
	});

	test("keeps staged and unstaged independent", () => {
		const prefs: GitFolderPrefs = {
			"ch-1": { staged: ["src"], unstaged: ["docs"] },
		};
		expect(readExpanded(prefs, "ch-1", "staged")).toEqual(new Set(["src"]));
		expect(readExpanded(prefs, "ch-1", "unstaged")).toEqual(new Set(["docs"]));
	});

	test("reads historical leaf-only records with their real ancestors", () => {
		const prefs: GitFolderPrefs = { "ch-1": { staged: ["src/a"], unstaged: [] } };
		expect(readExpanded(prefs, "ch-1", "staged")).toEqual(new Set(["src", "src/a"]));
		expect(prefs["ch-1"].staged).toEqual(["src/a"]);
	});

	test("does not read one chapter's folders for another", () => {
		const prefs: GitFolderPrefs = { "ch-1": { staged: ["src"], unstaged: [] } };
		expect(readExpanded(prefs, "ch-2", "staged").size).toBe(0);
	});
});

describe("toggleExpanded", () => {
	test("opens an unknown folder and closes it again", () => {
		const opened = toggleExpanded({}, "ch-1", "staged", "src");
		expect(readExpanded(opened, "ch-1", "staged")).toEqual(new Set(["src"]));

		const closed = toggleExpanded(opened, "ch-1", "staged", "src");
		expect(readExpanded(closed, "ch-1", "staged").size).toBe(0);
	});

	test("toggling one section leaves the other alone", () => {
		const prefs = toggleExpanded({}, "ch-1", "staged", "src");
		const next = toggleExpanded(prefs, "ch-1", "unstaged", "src");
		expect(readExpanded(next, "ch-1", "staged")).toEqual(new Set(["src"]));
		expect(readExpanded(next, "ch-1", "unstaged")).toEqual(new Set(["src"]));

		const closedStaged = toggleExpanded(next, "ch-1", "staged", "src");
		expect(readExpanded(closedStaged, "ch-1", "staged").size).toBe(0);
		expect(readExpanded(closedStaged, "ch-1", "unstaged")).toEqual(new Set(["src"]));
	});

	test("does not mutate the input document", () => {
		// The hook feeds the result straight into a store snapshot, so an in-place
		// edit would make the previous snapshot silently wrong.
		const before: GitFolderPrefs = { "ch-1": { staged: [], unstaged: [] } };
		const frozen = JSON.stringify(before);
		toggleExpanded(before, "ch-1", "staged", "src");
		expect(JSON.stringify(before)).toBe(frozen);
	});

	test("persists compact ancestors and subtree collapse through a session refresh", () => {
		const opened = toggleExpanded({}, "ch-1", "staged", "src/a/deep");
		expect(opened["ch-1"].staged).toEqual(["src/a/deep", "src/a", "src"]);
		const refreshed = parseFolderPrefs(JSON.stringify(opened));
		const closed = toggleExpanded(refreshed, "ch-1", "staged", "src/a");
		expect(readExpanded(closed, "ch-1", "staged")).toEqual(new Set(["src"]));
		const reopened = toggleExpanded(
			parseFolderPrefs(JSON.stringify(closed)),
			"ch-1",
			"staged",
			"src/a",
		);
		expect(readExpanded(reopened, "ch-1", "staged")).toEqual(new Set(["src", "src/a"]));
	});

	test("toggling another chapter preserves existing ones", () => {
		const prefs = toggleExpanded({}, "ch-1", "staged", "src");
		const next = toggleExpanded(prefs, "ch-2", "staged", "docs");
		expect(readExpanded(next, "ch-1", "staged")).toEqual(new Set(["src"]));
		expect(readExpanded(next, "ch-2", "staged")).toEqual(new Set(["docs"]));
	});
});

describe("parseFolderPrefs", () => {
	test("round-trips a real document", () => {
		const prefs = toggleExpanded({}, "ch-1", "staged", "src/components");
		const parsed = parseFolderPrefs(JSON.stringify(prefs));
		expect(readExpanded(parsed, "ch-1", "staged")).toEqual(new Set(["src", "src/components"]));
	});

	test.each([
		["missing storage", null],
		["empty string", ""],
		["malformed JSON", "{not json"],
		["a JSON array", "[1,2,3]"],
		["a bare string", '"nope"'],
		["null", "null"],
	])("degrades to nothing expanded for %s", (_label, raw) => {
		// A bad preference must never stop the git panel from rendering.
		expect(parseFolderPrefs(raw)).toEqual({});
	});

	test("drops chapter entries that are not objects", () => {
		const parsed = parseFolderPrefs('{"ch-1":"nope","ch-2":{"staged":["src"]}}');
		expect(parsed["ch-1"]).toBeUndefined();
		expect(readExpanded(parsed, "ch-2", "staged")).toEqual(new Set(["src"]));
	});

	test("replaces non-string-array sections with empty ones", () => {
		const parsed = parseFolderPrefs('{"ch-1":{"staged":[1,"src"],"unstaged":"x"}}');
		expect(parsed["ch-1"]).toEqual({ staged: [], unstaged: [] });
	});

	test("fills in a section that is absent entirely", () => {
		const parsed = parseFolderPrefs('{"ch-1":{"staged":["src"]}}');
		expect(parsed["ch-1"]).toEqual({ staged: ["src"], unstaged: [] });
	});
});
