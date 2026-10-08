import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTestDb } from "../../../../../tests/setup";
import {
	LocalFileChangeRuntime,
	withLocalFileChangeRuntime,
} from "../../../../services/file-change-runtime";
import { createWorkspaceWriteCoordinatorState } from "../../../../services/workspace-write-coordinator";
import type { ExecutionBackend } from "../../execution/backend";
import { localBackend } from "../../execution/local-backend";
import { windowsPathSemantics } from "../../execution/path-semantics";
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
		const workspace = mkdtempSync(join(tmpdir(), "nf-recovery-windows-"));
		const originalCwd = process.cwd();
		// On POSIX a drive-qualified path is a literal filename. A private cwd makes
		// that spelling resolve to a real directory while admission still sees Windows grammar.
		const physicalPath = process.platform === "win32" ? workspace : join(workspace, windowsCwd);
		if (process.platform !== "win32") {
			mkdirSync(physicalPath);
			process.chdir(workspace);
		}
		const { db, sqlite } = getTestDb();
		const runtime = new LocalFileChangeRuntime({
			db,
			privateRoot: join(workspace, "private"),
			coordinatorState: createWorkspaceWriteCoordinatorState(),
			blobStoreOptions: { minimumFreeBytes: 0 },
		});
		const backend = Object.assign(Object.create(localBackend), {
			pathFlavor: "windows",
			paths: windowsPathSemantics,
			// Map only this synthetic drive path to a real, privately owned directory.
			// Admission and object identities stay real; no fail-closed gate is stubbed.
			resolvePathIdentity: async (path: string) => {
				expect(path).toBe(windowsCwd);
				const identity = await localBackend.resolvePathIdentity(physicalPath);
				return {
					...identity,
					lexicalPath: windowsCwd,
					canonicalPath: process.platform === "win32" ? workspace : windowsCwd,
				};
			},
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
		}) as ExecutionBackend;

		try {
			const result = await withLocalFileChangeRuntime(runtime, () =>
				bashTool.execute({ command: "pwd" }, {
					narratorId: "test-narrator",
					cwd: windowsCwd,
					signal: new AbortController().signal,
					locale: "en",
					requestPermission: async () => ({ behavior: "allow" as const }),
					resolveBackend: () => backend,
				} satisfies ToolContext),
			);
			expect(result.output).toContain("ok");
			expect(result.isError).toBeFalsy();
			expect(executedCwd).toBe(windowsCwd);
			const scopes = await db.query.fileChangeScopes.findMany();
			expect(scopes).toHaveLength(1);
			expect(scopes[0]).toMatchObject({
				deviceId: "local",
				pathFlavor: "windows",
				activeMutationCount: 0,
			});
			expect(scopes[0]?.rootIdentityJson).not.toBeNull();
		} finally {
			process.chdir(originalCwd);
			sqlite.close();
			rmSync(workspace, { recursive: true, force: true });
		}
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
