import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashAnalysis } from "../../../server/lib/agent/bash-analyze";
import {
	extractToolPaths,
	isInsideWorktree,
	resolvePermissionDecision,
} from "../../../server/services/narrator-session";

const TRUNCATE_DIR = join(tmpdir(), "narrafork-tool-output");

function makeBashAnalysis(partial: Partial<BashAnalysis> = {}): BashAnalysis {
	return {
		commands: [],
		filePaths: [],
		allWhitelisted: true,
		nonWhitelisted: [],
		dangerousPatterns: [],
		hasEnvInjection: false,
		isCatastrophic: false,
		gitBranchViolations: [],
		gitBranchWarnings: [],
		hasWriteOperation: false,
		...partial,
	};
}

// ============================================================
// isInsideWorktree
// ============================================================

describe("isInsideWorktree", () => {
	const CWD = "/home/user/project";

	test("relative path inside worktree", () => {
		expect(isInsideWorktree(CWD, "src/index.ts")).toBe(true);
	});

	test("absolute path inside worktree", () => {
		expect(isInsideWorktree(CWD, "/home/user/project/src/index.ts")).toBe(true);
	});

	test("nested subdirectory", () => {
		expect(isInsideWorktree(CWD, "a/b/c/d.txt")).toBe(true);
	});

	test("exact cwd path returns true", () => {
		expect(isInsideWorktree(CWD, "/home/user/project")).toBe(true);
	});

	test("dot path (current dir) returns true", () => {
		expect(isInsideWorktree(CWD, ".")).toBe(true);
	});

	test("windows-style path comparison is case-insensitive", () => {
		expect(isInsideWorktree("C:/Users/Ray/Repo", "c:/users/ray/repo/src/index.ts")).toBe(true);
		expect(isInsideWorktree("C:/Users/Ray/Repo", "C:/Users/Ray/Repo-2/file.txt")).toBe(false);
	});

	test("absolute path outside worktree", () => {
		expect(isInsideWorktree(CWD, "/etc/passwd")).toBe(false);
	});

	test("absolute path to home dir", () => {
		expect(isInsideWorktree(CWD, "/home/user")).toBe(false);
	});

	test("path traversal with ..", () => {
		expect(isInsideWorktree(CWD, "../other-project/secret.txt")).toBe(false);
	});

	test("deep path traversal escaping worktree", () => {
		expect(isInsideWorktree(CWD, "src/../../../../../../etc/passwd")).toBe(false);
	});

	test("path traversal that re-enters worktree stays inside", () => {
		// /home/user/project/src/../lib → /home/user/project/lib
		expect(isInsideWorktree(CWD, "src/../lib/util.ts")).toBe(true);
	});

	test("sibling directory is outside", () => {
		expect(isInsideWorktree(CWD, "/home/user/other-project/file.txt")).toBe(false);
	});

	test("prefix-matching trap: project-v2 is not inside project", () => {
		// /home/user/project-v2 should NOT match /home/user/project
		expect(isInsideWorktree(CWD, "/home/user/project-v2/file.txt")).toBe(false);
	});

	test("root path is outside", () => {
		expect(isInsideWorktree(CWD, "/")).toBe(false);
	});

	test("cwd with trailing slash", () => {
		expect(isInsideWorktree("/home/user/project/", "src/file.ts")).toBe(true);
		expect(isInsideWorktree("/home/user/project/", "../secret")).toBe(false);
	});
});

// ============================================================
// extractToolPaths
// ============================================================

describe("extractToolPaths", () => {
	test("Read extracts file_path", () => {
		expect(extractToolPaths("Read", { file_path: "/tmp/a.txt" })).toEqual(["/tmp/a.txt"]);
	});

	test("Write extracts file_path", () => {
		expect(extractToolPaths("Write", { file_path: "out.txt", content: "hi" })).toEqual(["out.txt"]);
	});

	test("Edit extracts file_path", () => {
		expect(
			extractToolPaths("Edit", { file_path: "f.ts", old_string: "a", new_string: "b" }),
		).toEqual(["f.ts"]);
	});

	test("NotebookEdit extracts file_path", () => {
		expect(extractToolPaths("NotebookEdit", { file_path: "nb.ipynb" })).toEqual(["nb.ipynb"]);
	});

	test("MultiEdit extracts file_path", () => {
		expect(extractToolPaths("MultiEdit", { file_path: "m.ts" })).toEqual(["m.ts"]);
	});

	test("Glob extracts path when present", () => {
		expect(extractToolPaths("Glob", { pattern: "*.ts", path: "/other" })).toEqual(["/other"]);
	});

	test("Glob returns empty when path absent", () => {
		expect(extractToolPaths("Glob", { pattern: "*.ts" })).toEqual([]);
	});

	test("Grep extracts path when present", () => {
		expect(extractToolPaths("Grep", { pattern: "foo", path: "/search" })).toEqual(["/search"]);
	});

	test("Grep returns empty when path absent", () => {
		expect(extractToolPaths("Grep", { pattern: "foo" })).toEqual([]);
	});

	test("Bash returns empty (no path param)", () => {
		expect(extractToolPaths("Bash", { command: "ls" })).toEqual([]);
	});

	test("unknown tool returns empty", () => {
		expect(extractToolPaths("SomeFutureTool", { file_path: "/x" })).toEqual([]);
	});

	test("non-string file_path returns empty", () => {
		expect(extractToolPaths("Read", { file_path: 123 })).toEqual([]);
		expect(extractToolPaths("Read", {})).toEqual([]);
	});

	test("non-string path returns empty for Glob/Grep", () => {
		expect(extractToolPaths("Glob", { pattern: "*", path: null })).toEqual([]);
		expect(extractToolPaths("Grep", { pattern: "x", path: undefined })).toEqual([]);
	});
});

// ============================================================
// resolvePermissionDecision
// ============================================================

describe("resolvePermissionDecision", () => {
	const CWD = "/home/user/project";

	// --- Always-allow tools ---

	test("TodoWrite is always allowed regardless of mode", () => {
		expect(
			resolvePermissionDecision({
				toolName: "TodoWrite",
				input: {},
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("allow");
		expect(
			resolvePermissionDecision({
				toolName: "TodoWrite",
				input: {},
				permMode: "dontAsk",
				cwd: CWD,
			}),
		).toBe("allow");
		expect(
			resolvePermissionDecision({
				toolName: "TodoWrite",
				input: {},
				permMode: "acceptEdits",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("EnterPlanMode is always allowed", () => {
		expect(
			resolvePermissionDecision({
				toolName: "EnterPlanMode",
				input: {},
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("ExitPlanMode always requires user approval", () => {
		expect(
			resolvePermissionDecision({
				toolName: "ExitPlanMode",
				input: {},
				permMode: "dontAsk",
				cwd: CWD,
			}),
		).toBe("ask");
		expect(
			resolvePermissionDecision({
				toolName: "ExitPlanMode",
				input: {},
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
		expect(
			resolvePermissionDecision({
				toolName: "ExitPlanMode",
				input: {},
				permMode: "bypassPermissions",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	// --- bypassPermissions mode ---

	test("bypassPermissions allows everything", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Bash",
				input: { command: "rm -rf /" },
				permMode: "bypassPermissions",
				cwd: CWD,
			}),
		).toBe("allow");
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: "/etc/shadow" },
				permMode: "bypassPermissions",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	// --- dontAsk mode ---

	test("dontAsk denies everything (except always-allow)", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: "src/a.ts" },
				permMode: "dontAsk",
				cwd: CWD,
			}),
		).toBe("deny");
		expect(
			resolvePermissionDecision({
				toolName: "Bash",
				input: { command: "ls" },
				permMode: "dontAsk",
				cwd: CWD,
			}),
		).toBe("deny");
		expect(
			resolvePermissionDecision({
				toolName: "Edit",
				input: { file_path: "f.ts" },
				permMode: "dontAsk",
				cwd: CWD,
			}),
		).toBe("deny");
	});

	// --- default mode: internal paths ---

	test("default mode: Read inside worktree → allow", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: "src/index.ts" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("default mode: Write inside worktree → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Write",
				input: { file_path: "out.txt", content: "x" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("default mode: Edit inside worktree → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Edit",
				input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("default mode: Glob without path → allow (uses cwd)", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Glob",
				input: { pattern: "*.ts" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("default mode: Grep without path → allow (uses cwd)", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Grep",
				input: { pattern: "foo" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("default mode: Bash always asks", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Bash",
				input: { command: "echo hi" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("default mode: Bash in readWrite whitelisted workdir → allow", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Bash",
				input: { command: "touch out.txt", workdir: "/mnt/shared" },
				permMode: "default",
				cwd: CWD,
				bashAnalysis: makeBashAnalysis({ hasWriteOperation: true, filePaths: [] }),
				whitelistDirs: [{ path: "/mnt/shared", accessLevel: "readWrite", enabled: true }],
			}),
		).toBe("allow");
	});

	test("default mode: Task with full-whitelisted workdir → allow", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Task",
				input: { subagent_type: "general", workdir: "/mnt/shared" },
				permMode: "default",
				cwd: CWD,
				whitelistDirs: [{ path: "/mnt/shared", accessLevel: "full", enabled: true }],
			}),
		).toBe("allow");
	});

	test("default mode: Task with readWrite-whitelisted workdir still asks for general subagent", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Task",
				input: { subagent_type: "general", workdir: "/mnt/shared" },
				permMode: "default",
				cwd: CWD,
				whitelistDirs: [{ path: "/mnt/shared", accessLevel: "readWrite", enabled: true }],
			}),
		).toBe("ask");
	});

	// --- default mode: external paths ---

	test("default mode: Read outside worktree → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: "/etc/passwd" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("default mode: Write outside worktree → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Write",
				input: { file_path: "/tmp/evil.sh", content: "bad" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("default mode: Edit outside worktree → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Edit",
				input: { file_path: "/etc/hosts", old_string: "a", new_string: "b" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("default mode: Write in readWrite whitelisted external dir → allow", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Write",
				input: { file_path: "/mnt/shared/out.txt", content: "x" },
				permMode: "default",
				cwd: CWD,
				whitelistDirs: [{ path: "/mnt/shared", accessLevel: "readWrite", enabled: true }],
			}),
		).toBe("allow");
	});

	test("default mode: path traversal escape → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: "../../etc/passwd" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("default mode: Glob with external path → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Glob",
				input: { pattern: "*.ts", path: "/other" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("default mode: Grep with external path → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Grep",
				input: { pattern: "secret", path: "/home/user/other" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	// --- acceptEdits mode: internal paths ---

	test("acceptEdits mode: Edit inside worktree → allow", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Edit",
				input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
				permMode: "acceptEdits",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("acceptEdits mode: Read inside worktree → allow", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: "lib/b.ts" },
				permMode: "acceptEdits",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("acceptEdits mode: Glob without path → allow", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Glob",
				input: { pattern: "**/*.ts" },
				permMode: "acceptEdits",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("acceptEdits mode: Bash always asks", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Bash",
				input: { command: "ls" },
				permMode: "acceptEdits",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("acceptEdits mode: non-listed tool asks", () => {
		expect(
			resolvePermissionDecision({
				toolName: "WebFetch",
				input: { url: "https://example.com" },
				permMode: "acceptEdits",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	// --- acceptEdits mode: external paths ---

	test("acceptEdits mode: Edit outside worktree → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Edit",
				input: { file_path: "/etc/hosts", old_string: "a", new_string: "b" },
				permMode: "acceptEdits",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("acceptEdits mode: Read outside worktree → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: "/etc/passwd" },
				permMode: "acceptEdits",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("acceptEdits mode: Grep with external path → ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Grep",
				input: { pattern: "x", path: "/var/log" },
				permMode: "acceptEdits",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	// --- Edge cases ---

	test("default mode: tool with no path params (WebFetch) → ask", () => {
		// No path to check → not external → but default mode asks for non-readonly tools
		expect(
			resolvePermissionDecision({
				toolName: "WebFetch",
				input: { url: "https://example.com" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("unknown permission mode falls through to ask", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: "a.ts" },
				permMode: "unknownMode" as string,
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("prefix-matching trap: project-v2 path is external", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: "/home/user/project-v2/secret.ts" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	// --- Truncated output directory: read-only auto-allow ---

	test("default mode: Read in truncate output dir → allow", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: filePath },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("default mode: Grep in truncate output dir → allow", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Grep",
				input: { pattern: "error", path: TRUNCATE_DIR },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("default mode: Glob in truncate output dir → allow", () => {
		expect(
			resolvePermissionDecision({
				toolName: "Glob",
				input: { pattern: "tool_*", path: TRUNCATE_DIR },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("acceptEdits mode: Read in truncate output dir → allow", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: filePath },
				permMode: "acceptEdits",
				cwd: CWD,
			}),
		).toBe("allow");
	});

	test("default mode: Write to truncate output dir → ask (not read-only)", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(
			resolvePermissionDecision({
				toolName: "Write",
				input: { file_path: filePath, content: "x" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("default mode: Edit in truncate output dir → ask (not read-only)", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(
			resolvePermissionDecision({
				toolName: "Edit",
				input: { file_path: filePath, old_string: "a", new_string: "b" },
				permMode: "default",
				cwd: CWD,
			}),
		).toBe("ask");
	});

	test("dontAsk mode: Read in truncate output dir → deny (dontAsk overrides)", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: filePath },
				permMode: "dontAsk",
				cwd: CWD,
			}),
		).toBe("deny");
	});

	test("bypassPermissions mode: Read in truncate output dir → allow", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(
			resolvePermissionDecision({
				toolName: "Read",
				input: { file_path: filePath },
				permMode: "bypassPermissions",
				cwd: CWD,
			}),
		).toBe("allow");
	});
});
