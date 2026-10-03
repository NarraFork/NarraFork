import { expect, test } from "bun:test";
import type { WorktreeEntry } from "@shared/narrator-worktrees";
import { filterSortWorktrees, worktreeDirectoryLabel, worktreeLabel } from "./worktree-list-view";

const entry = (name: string, timestamp?: number | null): WorktreeEntry => ({
	path: `/repo/${name}`,
	branch: `refs/heads/${name}`,
	head: null,
	detached: false,
	locked: false,
	prunable: false,
	createdAt: timestamp,
	lastCommitAt: timestamp,
});
const names = (entries: WorktreeEntry[]) => entries.map(worktreeLabel);

test("search matches case-insensitive branch, directory and full path", () => {
	const entries = [entry("Quick-Fixes"), { ...entry("other"), branch: "refs/heads/topic" }];
	for (const query of ["quick", " FIXES ", "/repo/quick"]) {
		expect(names(filterSortWorktrees(entries, query, "name", false))).toEqual(["Quick-Fixes"]);
	}
	expect(names(filterSortWorktrees(entries, "TOPIC", "name", false))).toEqual(["topic"]);
	expect(filterSortWorktrees(entries, "missing", "name", false)).toEqual([]);
});

test("time sorting supports both directions and keeps unknown times last without mutating input", () => {
	const entries = [entry("unknown"), entry("older", 100), entry("newer", 200), entry("null", null)];
	for (const sort of ["createdAt", "lastCommitAt"] as const) {
		expect(names(filterSortWorktrees(entries, "", sort, true))).toEqual([
			"newer",
			"older",
			"null",
			"unknown",
		]);
		expect(names(filterSortWorktrees(entries, "", sort, false))).toEqual([
			"older",
			"newer",
			"null",
			"unknown",
		]);
	}
	expect(names(entries)).toEqual(["unknown", "older", "newer", "null"]);
});

test("name sorting and timestamp ties are stable; detached HEAD uses directory name", () => {
	const entries = [entry("b", 100), entry("a", 100)];
	expect(names(filterSortWorktrees(entries, "", "lastCommitAt", true))).toEqual(["a", "b"]);
	expect(names(filterSortWorktrees(entries, "", "name", true))).toEqual(["b", "a"]);
	expect(worktreeLabel({ ...entry("review"), branch: null, detached: true })).toBe("review");
	expect(worktreeDirectoryLabel("C:\\worktrees\\quick-fixes\\")).toBe("quick-fixes");
});
