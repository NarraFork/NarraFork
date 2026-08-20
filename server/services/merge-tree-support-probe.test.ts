/**
 * The capability probe must keep its exact argv shape.
 *
 * `supportsMergeTree()` decides whether every merge preview, scoped revert and
 * dirty-op reapply is available at all, and a false negative is cached for the
 * process lifetime — the user sees "requires git >= 2.38" on a modern git and no
 * amount of retrying clears it.
 *
 * The failure mode being locked out: git only prints usage-and-exit for `-h` when
 * `-h` is the *sole* argument, which is also what lets the command run outside a
 * repository. Any probe carrying a second flag (`--write-tree -h`) makes git demand
 * a repository first, so it dies with "fatal: not a git repository" whenever the
 * server was started from a non-repo directory — which is the normal case for a
 * launched binary, and never the case in development.
 *
 * So the invariant under test is the argv, not the process's working directory.
 * `supportsMergeTree` pins `cwd: tmpdir()` itself, which is exactly why an earlier
 * pair of `process.chdir()` cases could not fail: both walked the same code path
 * with the same spawn cwd, and neither would have noticed the flag coming back.
 */
import { describe, expect, test } from "bun:test";
import {
	MERGE_TREE_PROBE_ARGV,
	resetMergeTreeSupportCacheForTests,
	supportsMergeTree,
} from "./worktree-tree-snapshot";

describe("merge-tree probe argv", () => {
	test("is exactly `git merge-tree -h`, with no second flag", () => {
		// The whole bug was an extra `--write-tree`. Asserting the array literally is
		// what makes re-adding one a test failure rather than a silent capability loss.
		expect([...MERGE_TREE_PROBE_ARGV]).toEqual(["git", "merge-tree", "-h"]);
	});

	test("passes `-h` as the sole argument to the subcommand", () => {
		// Restates the git-side condition (`argc == 2`) in terms the array must satisfy,
		// so a reordering that keeps the same three tokens still has to be deliberate.
		const [binary, subcommand, ...rest] = MERGE_TREE_PROBE_ARGV;
		expect(binary).toBe("git");
		expect(subcommand).toBe("merge-tree");
		expect(rest).toEqual(["-h"]);
	});
});

describe("supportsMergeTree", () => {
	test("detects support without depending on the process working directory", async () => {
		// The probe spawns with `cwd: tmpdir()`, a directory that is deliberately not a
		// git repository — that is the condition the argv shape has to survive. Bun's
		// test runner requires git >= 2.38 era tooling anyway; if this ever runs on an
		// older git the assertion is the correct failure, not a flake.
		try {
			resetMergeTreeSupportCacheForTests();
			expect(await supportsMergeTree()).toBe(true);
		} finally {
			resetMergeTreeSupportCacheForTests();
		}
	});
});
