import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionBackend } from "../../execution/backend";
import { resolveBackend } from "../../execution/registry";
import type { ToolContext } from "../../types";
import { bashTool } from "../bash";
import {
	createInvalidWorkdirArgumentResult,
	createMissingWorkingDirectoryResult,
	getMissingWorkingDirectoryRecovery,
	MISSING_WORKING_DIRECTORY_RECOVERY_KIND,
} from "../working-directory-recovery";

describe("missing working directory recovery", () => {
	test("uses backend stat for Windows-style local paths", async () => {
		const windowsCwd = "D:\\GoSLAM Mapping Master Pro\\goslam_go\\goslam_go";
		let executedCwd: string | undefined;
		const backend = {
			kind: "local",
			deviceId: "local",
			statFile: async (path: string) =>
				path === windowsCwd ? { isDirectory: true, isFile: false, size: 0 } : null,
			execCommand: async ({ cwd }: { cwd: string }) => {
				executedCwd = cwd;
				return {
					onData: (callback: (chunk: Uint8Array) => void) =>
						callback(new TextEncoder().encode("ok\\n")),
					exited: Promise.resolve(0),
					isExited: () => true,
					kill: async () => {},
				};
			},
		} as unknown as ExecutionBackend;

		const result = await bashTool.execute({ command: "pwd" }, {
			narratorId: "test-narrator",
			cwd: windowsCwd,
			signal: new AbortController().signal,
			locale: "en",
			requestPermission: async () => ({ behavior: "allow" as const }),
			resolveBackend: () => backend,
		} satisfies ToolContext);

		expect(result.isError).toBeFalsy();
		expect(executedCwd).toBe(windowsCwd);
	});

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

	test("an invalid workdir argument stays non-fatal and carries no recovery payload", () => {
		const result = createInvalidWorkdirArgumentResult({
			missingCwd: "D:\\typo",
			baseCwd: "D:\\project",
			title: "Run command",
		});

		expect(result.isError).toBe(true);
		expect(result.fatal).toBeFalsy();
		expect(getMissingWorkingDirectoryRecovery(result.metadata)).toBeNull();
		expect(result.output).toContain("D:\\typo");
		expect(result.output).toContain("D:\\project");
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
