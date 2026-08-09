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
		const { byStartSha, unanchored } = resolveChapterAnchors([], onBackbone("c1"));
		expect(byStartSha.size).toBe(0);
		expect(unanchored).toEqual([]);
	});
});
