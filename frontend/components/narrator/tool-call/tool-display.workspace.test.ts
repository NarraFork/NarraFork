import { describe, expect, test } from "bun:test";
import { getCategory, getSummary, traceRowTitle } from "./tool-display";

describe("workspace tool summaries", () => {
	test("all workspace tools select custom detail", () => {
		for (const name of [
			"Worktree",
			"ListWorktrees",
			"CreateWorktree",
			"AttachWorktree",
			"GetWorktreeOperation",
			"SwitchWorkingDirectory",
			"SwitchDevice",
		]) {
			expect(getCategory(name)).toBe("workspace");
			expect(getSummary(name, {})).not.toBe(name);
		}
	});
	test("worktree create names branch, falling back to destination", () => {
		expect(
			getSummary("Worktree", {
				action: "create",
				branch: { name: "fix/new" },
				destinationPath: "/repo/new",
			}),
		).toBe("Create worktree · fix/new");
		expect(getSummary("Worktree", { action: "create", destinationPath: "C:\\repo\\new" })).toBe(
			"Create worktree · new",
		);
		expect(getSummary("Worktree", { action: "list" })).toBe("List worktrees");
	});
	test("explicit worktree tools use flat inputs and localized labels", () => {
		expect(getSummary("ListWorktrees", {})).toBe("List worktrees");
		expect(
			getSummary("CreateWorktree", { branchName: "fix/new", destinationPath: "/repo/new" }),
		).toBe("Create worktree · fix/new");
		expect(getSummary("AttachWorktree", { branchName: "existing" })).toBe(
			"Attach worktree · existing",
		);
		expect(getSummary("GetWorktreeOperation", { operationId: "private-id" })).toBe(
			"Get worktree operation",
		);
		expect(getSummary("AttachWorktree", {}, undefined, { workspaceAttach: "挂载工作树" })).toBe(
			"挂载工作树",
		);
		expect(
			getSummary("GetWorktreeOperation", {}, undefined, { workspaceOperation: "查询工作树操作" }),
		).toBe("查询工作树操作");
	});
	test("directory target and localization survive folded rows", () => {
		const summary = getSummary(
			"SwitchWorkingDirectory",
			{ target: { cwd: "/repo/new" } },
			undefined,
			{ workspaceSwitch: "切换工作目录" },
		);
		expect(summary).toBe("切换工作目录 · /repo/new");
		expect(traceRowTitle("SwitchWorkingDirectory", summary)).toContain("/repo/new");
	});
	test("device target and incomplete fields", () => {
		expect(getSummary("SwitchDevice", { device: "local" })).toBe("Switch device · local");
		expect(getSummary("SwitchWorkingDirectory", null)).toBe("Switch directory");
	});
});
