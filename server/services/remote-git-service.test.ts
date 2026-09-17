import { expect, test } from "bun:test";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import type {
	GitWorkspaceRequest,
	GitWorkspaceResult,
} from "../lib/agent/execution/git-workspace-rpc";
import {
	createRemoteGitService,
	parseRemoteGitStatus,
	supportsRemoteGitWorkspace,
} from "./remote-git-service";

function backendFixture() {
	const calls: Array<{ request: GitWorkspaceRequest; signal?: AbortSignal }> = [];
	let response: GitWorkspaceResult = { stdout: "" };
	let failure: Error | undefined;
	const backend = {
		kind: "remote",
		deviceId: "device-a",
		supportsGitWorkspace: true,
		async gitWorkspace(request: GitWorkspaceRequest, signal?: AbortSignal) {
			calls.push({ request, signal });
			if (failure) throw failure;
			return response;
		},
	} as unknown as ExecutionBackend;
	return {
		backend,
		calls,
		respond: (result: GitWorkspaceResult) => {
			response = result;
		},
		fail: (error: Error) => {
			failure = error;
		},
	};
}

test("remote Git operations retain target, cancellation, actor and finite budgets", async () => {
	const f = backendFixture();
	const controller = new AbortController();
	const git = createRemoteGitService(f.backend, { signal: controller.signal });
	const cwd = "C:\\Work\\Case Sensitive";
	const identity = {
		GIT_AUTHOR_NAME: "Actor",
		GIT_AUTHOR_EMAIL: "actor@test",
		GIT_COMMITTER_NAME: "Actor",
		GIT_COMMITTER_EMAIL: "actor@test",
	};
	await git.probe(cwd);
	expect(f.calls.at(-1)?.request.expectedRoot).toBeUndefined();
	await git.stageFiles(cwd, ["name with spaces.txt"]);
	await git.stageAll(cwd);
	await git.unstageFiles(cwd, ["file"]);
	await git.unstageAll(cwd);
	f.respond({ stdout: "sha\n" });
	expect(await git.commit(cwd, "message", identity)).toBe("sha");
	expect(f.calls.at(-1)?.request.identity).toBe(identity);
	await git.discardFiles(cwd, ["file"]);
	await git.discardAll(cwd);
	await git.stash(cwd, "shelf", identity);
	await git.stashDrop(cwd, 2);
	await git.resetSoft(cwd, "HEAD~1");
	await git.resetHard(cwd, "HEAD");
	for (const call of f.calls) {
		expect(call.request.cwd).toBe(cwd);
		expect(call.signal).toBe(controller.signal);
		expect(call.request.timeoutMs).toBeGreaterThan(0);
		expect(call.request.timeoutMs).toBeLessThanOrEqual(120000);
		expect(call.request.maxBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
		if (call.request.operation !== "probe") expect(call.request.expectedRoot).toBe(cwd);
	}
});

test("remote errors never fall back or replay an uncertain write", async () => {
	const f = backendFixture();
	f.fail(new Error("device disconnected"));
	const git = createRemoteGitService(f.backend);
	await expect(git.commit("/same/path", "message")).rejects.toThrow("result may be uncertain");
	expect(f.calls).toHaveLength(1);
	await expect(git.getStatusSummary("/same/path")).rejects.toThrow("device disconnected");
	expect(f.calls).toHaveLength(2);
	const old = { ...f.backend, supportsGitWorkspace: false };
	expect(supportsRemoteGitWorkspace(old)).toBe(false);
	await expect(createRemoteGitService(old).stageAll("/same/path")).rejects.toThrow("upgrade");
	expect(f.calls).toHaveLength(2);
	expect(supportsRemoteGitWorkspace({ ...f.backend, kind: "local" })).toBe(false);
});

test("remote writes reauthorize immediately before RPC and preserve denial", async () => {
	const f = backendFixture();
	let checks = 0;
	const forbidden = new Error("device grant revoked");
	const git = createRemoteGitService(f.backend, undefined, async () => {
		checks++;
		throw forbidden;
	});
	await git.probe("/repo");
	expect(checks).toBe(0);
	await expect(git.stageAll("/repo")).rejects.toBe(forbidden);
	expect(checks).toBe(1);
	expect(f.calls).toHaveLength(1);
});

test("remote patches retain truncation and structured lists reject partial records", async () => {
	const f = backendFixture();
	const git = createRemoteGitService(f.backend);
	f.respond({ stdout: "patch", truncated: true });
	expect(await git.getFileDiff("/repo", "file")).toEqual({ diff: "patch", truncated: true });
	expect(await git.getFullDiff("/repo")).toBe("patch\n[diff truncated]");
	expect(f.calls.at(-1)?.request.maxBytes).toBe(100000);
	await expect(git.getLog("/repo")).rejects.toThrow("output limit");
	await expect(git.stashList("/repo")).rejects.toThrow("output limit");
	f.respond({ hasConflicts: true });
	expect(await git.stashPop("/repo")).toEqual({ hasConflicts: true });
});

test("truncated remote status is incomplete rather than falsely clean", () => {
	const emptyPrefix = parseRemoteGitStatus({ outputs: { status: "" }, truncated: true });
	expect(emptyPrefix).toMatchObject({
		hasChanges: true,
		truncated: true,
		totalFiles: 0,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		linesAdded: 0,
		linesRemoved: 0,
	});

	const partialRename = parseRemoteGitStatus({
		outputs: { status: "R  new-name\0" },
		truncated: true,
	});
	expect(partialRename.hasChanges).toBe(true);
	expect(partialRename.totalFiles).toBe(0);
	expect(partialRename.files).toEqual([]);
});

for (const count of [200, 201]) {
	for (const upstreamTruncated of [false, true]) {
		test(`remote status preserves counts at ${count} files with upstream truncation ${upstreamTruncated}`, async () => {
			const f = backendFixture();
			const paths = Array.from({ length: count }, (_, index) => `file-${index}.txt`);
			f.respond({
				outputs: {
					status: paths.map((path) => `MM ${path}\0`).join(""),
					stagedNumstat: paths.map((path) => `2\t1\t${path}\0`).join(""),
					unstagedNumstat: paths.map((path) => `3\t2\t${path}\0`).join(""),
				},
				truncated: upstreamTruncated,
			});
			const summary = await createRemoteGitService(f.backend).getStatusSummary("/repo");
			expect(summary).toMatchObject({
				hasChanges: true,
				totalFiles: count,
				staged: count,
				unstaged: count,
				untracked: 0,
				linesAdded: count * 5,
				linesRemoved: count * 3,
				truncated: upstreamTruncated || count > 200,
			});
			expect(summary.files).toHaveLength(200);
			expect(summary.files.map((file) => file.path)).toEqual(paths.slice(0, 200));
			expect(f.calls).toHaveLength(1);
			expect(f.calls[0]?.request.operation).toBe("status");
		});
	}
}

test("remote status retains upstream byte-budget truncation below the file cap", async () => {
	const f = backendFixture();
	const git = createRemoteGitService(f.backend);
	for (const status of ["", "?? captured.txt\0", "R  incomplete-rename\0"]) {
		f.respond({ outputs: { status }, truncated: true });
		const summary = await git.getStatusSummary("/repo");
		expect(summary.truncated).toBe(true);
		expect(summary.hasChanges).toBe(true);
		expect(summary.totalFiles).toBe(summary.files.length);
		expect(summary.files).toHaveLength(status.startsWith("??") ? 1 : 0);
	}
	f.respond({ outputs: { status: "" }, truncated: false });
	expect(await git.getStatusSummary("/repo")).toMatchObject({
		hasChanges: false,
		truncated: false,
		totalFiles: 0,
		files: [],
	});
});

test("remote NUL status handles rename, whitespace and separate staged/unstaged totals", () => {
	const result = parseRemoteGitStatus({
		outputs: {
			head: "abc\n",
			branch: "main\n",
			status: "R  new\tname\0old\nname\0MM tracked\0?? new.txt\0",
			stagedNumstat: "2\t1\t\0old\nname\0new\tname\0" + "3\t2\ttracked\0",
			unstagedNumstat: "4\t1\ttracked\0",
			untrackedNumstat: "5\t0\t\0/dev/null\0new.txt\0",
		},
	});
	expect(result).toMatchObject({
		staged: 2,
		unstaged: 1,
		untracked: 1,
		totalFiles: 3,
		headSha: "abc",
		branch: "main",
		linesAdded: 14,
		linesRemoved: 4,
	});
	expect(result.files[0]).toMatchObject({
		path: "new\tname",
		oldPath: "old\nname",
		stagedLinesAdded: 2,
	});
	expect(result.files[2]).toMatchObject({ path: "new.txt", unstagedLinesAdded: 5 });
});
