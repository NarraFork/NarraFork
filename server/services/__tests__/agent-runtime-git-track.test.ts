import { describe, expect, test } from "bun:test";
import { gitTrackPathForSession } from "../agent-runtime/orchestrator";

describe("gitTrackPathForSession", () => {
	test("chapter narrators track their worktree", () => {
		expect(
			gitTrackPathForSession({
				_worktreePath: "/repo/.worktrees/ch1",
				_chapterId: "ch1",
				_isInGitRepo: true,
				_defaultDeviceId: null,
				cwd: "/repo/.worktrees/ch1",
			}),
		).toBe("/repo/.worktrees/ch1");
	});

	test("standalone narrators track their cwd when it is a local Git repo", () => {
		expect(
			gitTrackPathForSession({
				_chapterId: undefined,
				_isInGitRepo: true,
				_defaultDeviceId: null,
				cwd: "/repo",
			}),
		).toBe("/repo");
	});

	test("standalone narrators outside a Git repo are not tracked", () => {
		expect(
			gitTrackPathForSession({
				_chapterId: undefined,
				_isInGitRepo: false,
				_defaultDeviceId: null,
				cwd: "/tmp",
			}),
		).toBe(null);
	});

	test("standalone narrators on a remote device are not tracked with local git", () => {
		expect(
			gitTrackPathForSession({
				_chapterId: undefined,
				_isInGitRepo: true,
				_defaultDeviceId: "device-a",
				cwd: "/repo",
			}),
		).toBe(null);
	});

	test("an explicit local default device id is tracked", () => {
		expect(
			gitTrackPathForSession({
				_chapterId: undefined,
				_isInGitRepo: true,
				_defaultDeviceId: "local",
				cwd: "/repo",
			}),
		).toBe("/repo");
	});
});
