import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractToolPaths,
	isInsideWorktree,
	resolvePermissionDecision,
} from "../../../server/services/narrator-session";

const TRUNCATE_DIR = join(tmpdir(), "narrafork-tool-output");

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
		expect(resolvePermissionDecision("TodoWrite", {}, "default", CWD)).toBe("allow");
		expect(resolvePermissionDecision("TodoWrite", {}, "dontAsk", CWD)).toBe("allow");
		expect(resolvePermissionDecision("TodoWrite", {}, "acceptEdits", CWD)).toBe("allow");
	});

	test("TodoRead is allowed in default mode (no external paths)", () => {
		expect(resolvePermissionDecision("TodoRead", {}, "default", CWD)).toBe("allow");
	});

	test("EnterPlanMode is always allowed", () => {
		expect(resolvePermissionDecision("EnterPlanMode", {}, "default", CWD)).toBe("allow");
	});

	test("ExitPlanMode always requires user approval", () => {
		expect(resolvePermissionDecision("ExitPlanMode", {}, "dontAsk", CWD)).toBe("ask");
		expect(resolvePermissionDecision("ExitPlanMode", {}, "default", CWD)).toBe("ask");
		expect(resolvePermissionDecision("ExitPlanMode", {}, "bypassPermissions", CWD)).toBe("ask");
	});

	// --- bypassPermissions mode ---

	test("bypassPermissions allows everything", () => {
		expect(
			resolvePermissionDecision("Bash", { command: "rm -rf /" }, "bypassPermissions", CWD),
		).toBe("allow");
		expect(
			resolvePermissionDecision("Read", { file_path: "/etc/shadow" }, "bypassPermissions", CWD),
		).toBe("allow");
	});

	// --- dontAsk mode ---

	test("dontAsk denies everything (except always-allow)", () => {
		expect(resolvePermissionDecision("Read", { file_path: "src/a.ts" }, "dontAsk", CWD)).toBe(
			"deny",
		);
		expect(resolvePermissionDecision("Bash", { command: "ls" }, "dontAsk", CWD)).toBe("deny");
		expect(resolvePermissionDecision("Edit", { file_path: "f.ts" }, "dontAsk", CWD)).toBe("deny");
	});

	// --- default mode: internal paths ---

	test("default mode: Read inside worktree → allow", () => {
		expect(resolvePermissionDecision("Read", { file_path: "src/index.ts" }, "default", CWD)).toBe(
			"allow",
		);
	});

	test("default mode: Write inside worktree → allow", () => {
		expect(
			resolvePermissionDecision("Write", { file_path: "out.txt", content: "x" }, "default", CWD),
		).toBe("allow");
	});

	test("default mode: Edit inside worktree → allow", () => {
		expect(
			resolvePermissionDecision(
				"Edit",
				{ file_path: "src/a.ts", old_string: "a", new_string: "b" },
				"default",
				CWD,
			),
		).toBe("allow");
	});

	test("default mode: Glob without path → allow (uses cwd)", () => {
		expect(resolvePermissionDecision("Glob", { pattern: "*.ts" }, "default", CWD)).toBe("allow");
	});

	test("default mode: Grep without path → allow (uses cwd)", () => {
		expect(resolvePermissionDecision("Grep", { pattern: "foo" }, "default", CWD)).toBe("allow");
	});

	test("default mode: Bash always asks", () => {
		expect(resolvePermissionDecision("Bash", { command: "echo hi" }, "default", CWD)).toBe("ask");
	});

	// --- default mode: external paths ---

	test("default mode: Read outside worktree → ask", () => {
		expect(resolvePermissionDecision("Read", { file_path: "/etc/passwd" }, "default", CWD)).toBe(
			"ask",
		);
	});

	test("default mode: Write outside worktree → ask", () => {
		expect(
			resolvePermissionDecision(
				"Write",
				{ file_path: "/tmp/evil.sh", content: "bad" },
				"default",
				CWD,
			),
		).toBe("ask");
	});

	test("default mode: Edit outside worktree → ask", () => {
		expect(
			resolvePermissionDecision(
				"Edit",
				{ file_path: "/etc/hosts", old_string: "a", new_string: "b" },
				"default",
				CWD,
			),
		).toBe("ask");
	});

	test("default mode: path traversal escape → ask", () => {
		expect(
			resolvePermissionDecision("Read", { file_path: "../../etc/passwd" }, "default", CWD),
		).toBe("ask");
	});

	test("default mode: Glob with external path → ask", () => {
		expect(
			resolvePermissionDecision("Glob", { pattern: "*.ts", path: "/other" }, "default", CWD),
		).toBe("ask");
	});

	test("default mode: Grep with external path → ask", () => {
		expect(
			resolvePermissionDecision(
				"Grep",
				{ pattern: "secret", path: "/home/user/other" },
				"default",
				CWD,
			),
		).toBe("ask");
	});

	// --- acceptEdits mode: internal paths ---

	test("acceptEdits mode: Edit inside worktree → allow", () => {
		expect(
			resolvePermissionDecision(
				"Edit",
				{ file_path: "src/a.ts", old_string: "a", new_string: "b" },
				"acceptEdits",
				CWD,
			),
		).toBe("allow");
	});

	test("acceptEdits mode: Read inside worktree → allow", () => {
		expect(resolvePermissionDecision("Read", { file_path: "lib/b.ts" }, "acceptEdits", CWD)).toBe(
			"allow",
		);
	});

	test("acceptEdits mode: Glob without path → allow", () => {
		expect(resolvePermissionDecision("Glob", { pattern: "**/*.ts" }, "acceptEdits", CWD)).toBe(
			"allow",
		);
	});

	test("acceptEdits mode: Bash always asks", () => {
		expect(resolvePermissionDecision("Bash", { command: "ls" }, "acceptEdits", CWD)).toBe("ask");
	});

	test("acceptEdits mode: non-listed tool asks", () => {
		expect(
			resolvePermissionDecision("WebFetch", { url: "https://example.com" }, "acceptEdits", CWD),
		).toBe("ask");
	});

	// --- acceptEdits mode: external paths ---

	test("acceptEdits mode: Edit outside worktree → ask", () => {
		expect(
			resolvePermissionDecision(
				"Edit",
				{ file_path: "/etc/hosts", old_string: "a", new_string: "b" },
				"acceptEdits",
				CWD,
			),
		).toBe("ask");
	});

	test("acceptEdits mode: Read outside worktree → ask", () => {
		expect(
			resolvePermissionDecision("Read", { file_path: "/etc/passwd" }, "acceptEdits", CWD),
		).toBe("ask");
	});

	test("acceptEdits mode: Grep with external path → ask", () => {
		expect(
			resolvePermissionDecision("Grep", { pattern: "x", path: "/var/log" }, "acceptEdits", CWD),
		).toBe("ask");
	});

	// --- Edge cases ---

	test("default mode: tool with no path params (WebFetch) → allow", () => {
		// No path to check → not external → auto-allow in default mode
		expect(
			resolvePermissionDecision("WebFetch", { url: "https://example.com" }, "default", CWD),
		).toBe("allow");
	});

	test("unknown permission mode falls through to ask", () => {
		expect(
			resolvePermissionDecision("Read", { file_path: "a.ts" }, "unknownMode" as string, CWD),
		).toBe("ask");
	});

	test("prefix-matching trap: project-v2 path is external", () => {
		expect(
			resolvePermissionDecision(
				"Read",
				{ file_path: "/home/user/project-v2/secret.ts" },
				"default",
				CWD,
			),
		).toBe("ask");
	});

	// --- Truncated output directory: read-only auto-allow ---

	test("default mode: Read in truncate output dir → allow", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(resolvePermissionDecision("Read", { file_path: filePath }, "default", CWD)).toBe(
			"allow",
		);
	});

	test("default mode: Grep in truncate output dir → allow", () => {
		expect(
			resolvePermissionDecision("Grep", { pattern: "error", path: TRUNCATE_DIR }, "default", CWD),
		).toBe("allow");
	});

	test("default mode: Glob in truncate output dir → allow", () => {
		expect(
			resolvePermissionDecision("Glob", { pattern: "tool_*", path: TRUNCATE_DIR }, "default", CWD),
		).toBe("allow");
	});

	test("acceptEdits mode: Read in truncate output dir → allow", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(resolvePermissionDecision("Read", { file_path: filePath }, "acceptEdits", CWD)).toBe(
			"allow",
		);
	});

	test("default mode: Write to truncate output dir → ask (not read-only)", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(
			resolvePermissionDecision("Write", { file_path: filePath, content: "x" }, "default", CWD),
		).toBe("ask");
	});

	test("default mode: Edit in truncate output dir → ask (not read-only)", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(
			resolvePermissionDecision(
				"Edit",
				{ file_path: filePath, old_string: "a", new_string: "b" },
				"default",
				CWD,
			),
		).toBe("ask");
	});

	test("dontAsk mode: Read in truncate output dir → deny (dontAsk overrides)", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(resolvePermissionDecision("Read", { file_path: filePath }, "dontAsk", CWD)).toBe("deny");
	});

	test("bypassPermissions mode: Read in truncate output dir → allow", () => {
		const filePath = join(TRUNCATE_DIR, "tool_1234_abcd1234");
		expect(
			resolvePermissionDecision("Read", { file_path: filePath }, "bypassPermissions", CWD),
		).toBe("allow");
	});
});
