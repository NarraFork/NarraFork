/**
 * Work item branch names: ASCII words of the title (or of the coordinator's branch hint) plus a
 * hash of the item id, so every name passes the app's ASCII branch validator, the worktree
 * service's ref check and `git check-ref-format`, and two items never share a branch.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { gitBranchName, teamBaseBranchSchema } from "@shared/project-team-draft";
import { worktreeDirectoryName } from "../../narrator-worktree-service";
import { workBranchSlug, workItemBranchName } from "../work-items";

const HASH = /-[a-f0-9]{8}$/;

function gitAccepts(branch: string): boolean {
	return spawnSync("git", ["check-ref-format", "--branch", branch]).status === 0;
}

describe("work item branch names", () => {
	test("an English title keeps its words", () => {
		expect(workItemBranchName("item-1", "Add the export button")).toMatch(
			/^team\/add-the-export-button-[a-f0-9]{8}$/,
		);
	});

	test("a mixed title keeps its ASCII words; accents and full-width letters fold", () => {
		expect(workItemBranchName("item-2", "迁移会话缓存到 Redis")).toMatch(
			/^team\/redis-[a-f0-9]{8}$/,
		);
		expect(workBranchSlug("Résumé 导出")).toBe("resume");
		expect(workBranchSlug("修复 ＡＰＩ 限流")).toBe("api");
	});

	test("a title without ASCII words takes the hint, or falls back to work", () => {
		expect(workItemBranchName("item-3", "补充登录页单元测试", "login page unit tests")).toMatch(
			/^team\/login-page-unit-tests-[a-f0-9]{8}$/,
		);
		expect(workItemBranchName("item-3", "补充登录页单元测试")).toMatch(/^team\/work-[a-f0-9]{8}$/);
		// A hint with no ASCII words of its own is ignored, not turned into an empty slug.
		expect(workItemBranchName("item-3", "Fix login", "登录")).toMatch(/^team\/fix-login-/);
		expect(workItemBranchName("item-3", "补充测试", "   ")).toMatch(/^team\/work-/);
	});

	test("the coordinator's hint wins over the title's words", () => {
		expect(workItemBranchName("item-4", "迁移会话缓存到 Redis", "session cache to redis")).toMatch(
			/^team\/session-cache-to-redis-[a-f0-9]{8}$/,
		);
	});

	test("the slug is bounded and never ends with a separator", () => {
		const slug = workBranchSlug(`${"word ".repeat(30)}end`);
		expect(slug.length).toBeLessThanOrEqual(40);
		expect(slug).not.toMatch(/^-|-$/);
	});

	test("same titles on different items get different branches", () => {
		const a = workItemBranchName("item-a", "补充登录页单元测试");
		const b = workItemBranchName("item-b", "补充登录页单元测试");
		expect(a).not.toBe(b);
		expect(a).toMatch(HASH);
	});

	test("every name passes the app's branch validators and git", () => {
		const cases: Array<[string, string?]> = [
			["Add the export button"],
			["补充登录页单元测试"],
			["补充登录页单元测试", "login page unit tests"],
			["迁移会话缓存到 Redis"],
			["--force; rm -rf / .lock"],
			["..//.. @{1} ~^:?*[\\ end."],
			["Ünïcödé ÉÈ façade"],
			["", "..lock"],
			["🙂🙂🙂"],
		];
		for (const [title, hint] of cases) {
			const branch = workItemBranchName("item-x", title, hint);
			expect({ branch, ascii: gitBranchName.safeParse(branch).success }).toEqual({
				branch,
				ascii: true,
			});
			expect({ branch, base: teamBaseBranchSchema.safeParse(branch).success }).toEqual({
				branch,
				base: true,
			});
			expect({ branch, git: gitAccepts(branch) }).toEqual({ branch, git: true });
			expect(worktreeDirectoryName(branch)).toMatch(/^[a-z0-9_-]+$/);
		}
	});
});
