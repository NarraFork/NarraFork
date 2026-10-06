import { describe, expect, test } from "bun:test";
import { type AnchorableChapter, resolveChapterAnchors } from "./chapter-anchoring";

const onBackbone = (...shas: string[]) => {
	const set = new Set(shas);
	return (sha: string) => set.has(sha);
};

function chapter(
	id: string,
	startCommitSha: string | null,
	parentChapterId: string | null = null,
): AnchorableChapter {
	return { id, title: id, startCommitSha, parentChapterId };
}

describe("resolveChapterAnchors", () => {
	test("anchors a chapter to its own start commit when that commit is on the ruler", () => {
		const { byStartSha, unanchored } = resolveChapterAnchors(
			[chapter("a", "c1")],
			onBackbone("c1"),
		);
		expect([...byStartSha.keys()]).toEqual(["c1"]);
		expect(byStartSha.get("c1")?.map((ch) => ch.id)).toEqual(["a"]);
		expect(unanchored).toEqual([]);
	});

	test("borrows an ancestor's anchor when the chapter forked off the backbone", () => {
		const { byStartSha, unanchored } = resolveChapterAnchors(
			[chapter("parent", "c1"), chapter("child", "sub-commit", "parent")],
			onBackbone("c1"),
		);
		expect(byStartSha.get("c1")?.map((ch) => ch.id)).toEqual(["parent", "child"]);
		expect(unanchored).toEqual([]);
	});

	test("walks more than one level up the parent chain", () => {
		const { byStartSha, unanchored } = resolveChapterAnchors(
			[chapter("root", "c1"), chapter("mid", "sub-a", "root"), chapter("leaf", "sub-b", "mid")],
			onBackbone("c1"),
		);
		expect(byStartSha.get("c1")?.map((ch) => ch.id)).toEqual(["root", "mid", "leaf"]);
		expect(unanchored).toEqual([]);
	});

	test("reports a chapter with no reachable anchor instead of dropping it", () => {
		// This is the regression: the commit is real but outside the loaded page, so the
		// chapter has no tick. It used to disappear from the view with no explanation.
		const { byStartSha, unanchored } = resolveChapterAnchors(
			[chapter("orphan", "commit-not-loaded")],
			onBackbone("c1"),
		);
		expect(byStartSha.size).toBe(0);
		expect(unanchored.map((ch) => ch.id)).toEqual(["orphan"]);
	});

	test("reports a chapter whose parent is also off the backbone", () => {
		const { unanchored } = resolveChapterAnchors(
			[chapter("p", "old-1"), chapter("c", "old-2", "p")],
			onBackbone("c1"),
		);
		expect(unanchored.map((ch) => ch.id).sort()).toEqual(["c", "p"]);
	});

	test("anchoring the same chapter succeeds once its commit is loaded", () => {
		const chapters = [chapter("orphan", "older-commit")];
		expect(resolveChapterAnchors(chapters, onBackbone("c1")).unanchored).toHaveLength(1);
		expect(resolveChapterAnchors(chapters, onBackbone("c1", "older-commit")).unanchored).toEqual(
			[],
		);
	});

	test("terminates on a parent cycle rather than looping forever", () => {
		const a: AnchorableChapter = { id: "a", title: "a", startCommitSha: "x", parentChapterId: "b" };
		const b: AnchorableChapter = { id: "b", title: "b", startCommitSha: "y", parentChapterId: "a" };
		const { unanchored } = resolveChapterAnchors([a, b], onBackbone("c1"));
		expect(unanchored).toHaveLength(2);
	});

	test("tolerates a dangling parent reference", () => {
		const { unanchored } = resolveChapterAnchors(
			[chapter("child", "sub", "missing-parent")],
			onBackbone("c1"),
		);
		expect(unanchored.map((ch) => ch.id)).toEqual(["child"]);
	});

	test("returns empty results for no chapters", () => {
		const { byStartSha, unanchored, rewrittenAnchors } = resolveChapterAnchors(
			[],
			onBackbone("c1"),
		);
		expect(byStartSha.size).toBe(0);
		expect(unanchored).toEqual([]);
		expect(rewrittenAnchors).toEqual([]);
	});
});

/**
 * The trunk being rewritten under a chapter.
 *
 * A rebase, squash-merge or amend leaves `startCommitSha` naming a commit that still
 * exists but is no longer reachable from the branch. No amount of paging will ever put a
 * tick there, so before this the chapter had no position and was dropped from the view
 * while the UI advised opening it "from the story network view" — which resolves the same
 * sha and fails the same way. The server supplies the fork point instead.
 */
describe("resolveChapterAnchors with a rewritten start commit", () => {
	test("draws the chapter at the fork point and reports the position as approximate", () => {
		const { byStartSha, unanchored, rewrittenAnchors } = resolveChapterAnchors(
			[
				{
					id: "rewritten",
					title: "rewritten",
					startCommitSha: "gone-from-trunk",
					parentChapterId: null,
					anchorFallbackSha: "fork-point",
					startCommitOnBranch: false,
				},
			],
			onBackbone("fork-point"),
		);
		expect(byStartSha.get("fork-point")?.map((ch) => ch.id)).toEqual(["rewritten"]);
		expect(unanchored).toEqual([]);
		expect(rewrittenAnchors.map((ch) => ch.id)).toEqual(["rewritten"]);
	});

	test("does not call it approximate when the fallback is the start commit itself", () => {
		// `startCommitOnBranch: true` means the commit is a genuine ancestor that merely
		// paged in late, so `merge-base` returned it unchanged. The position is exact and
		// claiming otherwise would be noise on a healthy timeline.
		const { byStartSha, rewrittenAnchors } = resolveChapterAnchors(
			[
				{
					id: "late",
					title: "late",
					startCommitSha: "c9",
					parentChapterId: null,
					anchorFallbackSha: "c9",
					startCommitOnBranch: true,
				},
			],
			onBackbone("c9"),
		);
		expect(byStartSha.get("c9")?.map((ch) => ch.id)).toEqual(["late"]);
		expect(rewrittenAnchors).toEqual([]);
	});

	test("prefers an exact anchor over the fallback", () => {
		// The fallback must never move a chapter that can be placed properly: the fork
		// point is older than the real start commit, so using it would silently misreport
		// where the work began.
		const { byStartSha, rewrittenAnchors } = resolveChapterAnchors(
			[
				{
					id: "placeable",
					title: "placeable",
					startCommitSha: "c5",
					parentChapterId: null,
					anchorFallbackSha: "fork-point",
					startCommitOnBranch: false,
				},
			],
			onBackbone("c5", "fork-point"),
		);
		expect(byStartSha.get("c5")?.map((ch) => ch.id)).toEqual(["placeable"]);
		expect(byStartSha.has("fork-point")).toBe(false);
		expect(rewrittenAnchors).toEqual([]);
	});

	test("stays unanchored when even the fallback has no tick", () => {
		// The fork point can itself be outside the loaded window. That is the paging case,
		// which the "load older commits" notice already handles, so it must not be dressed
		// up as a placed chapter.
		const { byStartSha, unanchored, rewrittenAnchors } = resolveChapterAnchors(
			[
				{
					id: "far",
					title: "far",
					startCommitSha: "gone",
					parentChapterId: null,
					anchorFallbackSha: "very-old-fork-point",
					startCommitOnBranch: false,
				},
			],
			onBackbone("c1"),
		);
		expect(byStartSha.size).toBe(0);
		expect(unanchored.map((ch) => ch.id)).toEqual(["far"]);
		expect(rewrittenAnchors).toEqual([]);
	});

	test("groups a rewritten chapter alongside others at the same fork point", () => {
		const { byStartSha, rewrittenAnchors } = resolveChapterAnchors(
			[
				chapter("normal", "fork-point"),
				{
					id: "rewritten",
					title: "rewritten",
					startCommitSha: "gone",
					parentChapterId: null,
					anchorFallbackSha: "fork-point",
					startCommitOnBranch: false,
				},
			],
			onBackbone("fork-point"),
		);
		expect(byStartSha.get("fork-point")?.map((ch) => ch.id)).toEqual(["normal", "rewritten"]);
		expect(rewrittenAnchors.map((ch) => ch.id)).toEqual(["rewritten"]);
	});
});
