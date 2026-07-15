import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBackend } from "../../execution/registry";
import type { ToolContext } from "../../types";
import { bashTool } from "../bash";
import {
	createMissingWorkingDirectoryResult,
	getMissingWorkingDirectoryRecovery,
	MISSING_WORKING_DIRECTORY_RECOVERY_KIND,
} from "../working-directory-recovery";

describe("missing working directory recovery", () => {
	test("suggests the active worktree when the narrator cwd is missing", async () => {
		const worktree = mkdtempSync(join(tmpdir(), "nf-recovery-worktree-"));
		try {
			const result = await bashTool.execute({ command: "pwd" }, {
				narratorId: "test-narrator",
				cwd: join(worktree, "missing"),
				worktreePath: worktree,
				projectGitPath: join(worktree, "project-missing"),
				signal: new AbortController().signal,
				locale: "en",
				requestPermission: async () => ({ behavior: "allow" as const }),
				resolveBackend: () => resolveBackend({ requested: "local" }),
			} satisfies ToolContext);
			expect(result.metadata).toMatchObject({
				cwdRecovery: { suggestedCwd: worktree },
			});
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	test("keeps the error fatal and exposes a structured recovery payload", () => {
		const result = createMissingWorkingDirectoryResult({
			missingCwd: "/missing/worktree",
			suggestedCwd: "/available/worktree",
			title: "Run command",
		});

		expect(result).toMatchObject({
			isError: true,
			fatal: true,
			title: "Run command",
			metadata: {
				cwdRecovery: {
					kind: MISSING_WORKING_DIRECTORY_RECOVERY_KIND,
					missingCwd: "/missing/worktree",
					suggestedCwd: "/available/worktree",
				},
			},
		});
		expect(result.output).toContain("Working directory does not exist: /missing/worktree");
	});

	test("accepts only complete matching recovery metadata", () => {
		expect(
			getMissingWorkingDirectoryRecovery({
				cwdRecovery: {
					kind: MISSING_WORKING_DIRECTORY_RECOVERY_KIND,
					missingCwd: "/missing",
					suggestedCwd: "/available",
				},
			}),
		).toEqual({
			kind: MISSING_WORKING_DIRECTORY_RECOVERY_KIND,
			missingCwd: "/missing",
			suggestedCwd: "/available",
		});
		expect(getMissingWorkingDirectoryRecovery({ cwdRecovery: { kind: "other" } })).toBeNull();
	});
});
