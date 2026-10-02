import { expect, test } from "bun:test";
import {
	GIT_COMMIT_PREVIEW_PATCH_MAX_BYTES,
	GIT_COMMIT_PREVIEW_UNSUPPORTED,
} from "@shared/git-commit-preview";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import {
	GIT_WORKSPACE_MAX_BYTES,
	GIT_WORKSPACE_TIMEOUT_MS,
	type GitWorkspaceRequest,
	type GitWorkspaceResult,
} from "../lib/agent/execution/git-workspace-rpc";
import {
	createRemoteGitService,
	parseRemoteGitStatus,
	supportsRemoteGitWorkspace,
} from "./remote-git-service";

function backendFixture(supportsGitCommitPreview = true) {
	const calls: Array<{ request: GitWorkspaceRequest; signal?: AbortSignal }> = [];
	let response: GitWorkspaceResult = { stdout: "" };
	let failure: Error | undefined;
	const backend = {
		kind: "remote",
		deviceId: "device-a",
		supportsGitWorkspace: true,
		supportsGitCommitPreview,
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

const PREVIEW_SHA = "a".repeat(40);
const PREVIEW_PARENT = "b".repeat(40);
function previewOutputs(overrides: Record<string, string> = {}) {
	return {
		found: "1",
		// Ten fields: the full object name is distinct from the display abbreviation.
		meta: [
			PREVIEW_SHA,
			"aaaaaaa",
			PREVIEW_PARENT,
			"Author",
			"author@test",
			"2026-09-25T10:00:00Z",
			"Committer",
			"committer@test",
			"2026-09-25T11:00:00Z",
			"subject\n\nmultiline body\n",
		].join("\0"),
		nameStatus: "M\0src/file.txt\0R100\0old name.txt\0new name.txt\0",
		numstat: "2\t1\tsrc/file.txt\0" + "0\t0\t\0old name.txt\0new name.txt\0",
		...overrides,
	};
}

test("remote commit preview uses read RPCs with pinned roots, cancellation and bounded outputs", async () => {
	const f = backendFixture();
	const controller = new AbortController();
	let writes = 0;
	const git = createRemoteGitService(f.backend, controller.signal, async () => {
		writes++;
	});
	const cwd = "C:\\Work\\History";
	f.respond({ outputs: previewOutputs() });
	const detail = await git.getCommitDetail(cwd, PREVIEW_SHA);
	expect(detail).toMatchObject({
		sha: PREVIEW_SHA,
		shortSha: "aaaaaaa",
		parents: [PREVIEW_PARENT],
		comparedTo: PREVIEW_PARENT,
		authorName: "Author",
		authorEmail: "author@test",
		authoredAt: "2026-09-25T10:00:00Z",
		committerName: "Committer",
		committerEmail: "committer@test",
		committedAt: "2026-09-25T11:00:00Z",
		message: "subject\n\nmultiline body",
		messageTruncated: false,
		filesTruncated: false,
	});
	expect(detail.files).toEqual([
		{ path: "src/file.txt", status: "modified", linesAdded: 2, linesRemoved: 1, binary: false },
		{
			path: "new name.txt",
			oldPath: "old name.txt",
			status: "renamed",
			linesAdded: 0,
			linesRemoved: 0,
			binary: false,
		},
	]);
	expect(f.calls[0]?.request).toEqual({
		cwd,
		expectedRoot: cwd,
		operation: "commitDetail",
		commit: PREVIEW_SHA,
		timeoutMs: GIT_WORKSPACE_TIMEOUT_MS,
		maxBytes: GIT_WORKSPACE_MAX_BYTES,
	});
	const patch =
		"diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n";
	f.respond({ stdout: patch, truncated: true });
	expect(await git.getCommitPatch(cwd, PREVIEW_SHA, "new name.txt", "old name.txt")).toEqual({
		diff: patch,
		truncated: true,
	});
	expect(f.calls[1]?.request).toEqual({
		cwd,
		expectedRoot: cwd,
		operation: "commitDiff",
		commit: PREVIEW_SHA,
		path: "new name.txt",
		oldPath: "old name.txt",
		timeoutMs: GIT_WORKSPACE_TIMEOUT_MS,
		maxBytes: GIT_COMMIT_PREVIEW_PATCH_MAX_BYTES,
	});
	expect(f.calls.every((call) => call.signal === controller.signal)).toBe(true);
	expect(writes).toBe(0);
	controller.abort();
	expect(f.calls.every((call) => call.signal?.aborted)).toBe(true);
});

test("remote double-section patches require exact complete scoped typechange evidence", async () => {
	const f = backendFixture();
	const git = createRemoteGitService(f.backend);
	const diff = "diff --git a/file b/file\nfirst\ndiff --git a/file b/file\nsecond\n";
	for (const evidence of [
		undefined,
		"M\0file\0",
		"T\0other\0",
		"T\0file\0M\0extra\0",
		"T\0file\0R100\0partial\0",
		"T\0file",
	]) {
		f.respond({
			stdout: diff,
			outputs: evidence === undefined ? {} : { typechangeNameStatus: evidence },
		});
		await expect(git.getCommitPatch("/repo", PREVIEW_SHA, "file")).rejects.toThrow();
	}
	f.respond({ stdout: diff, outputs: { typechangeNameStatus: "T\0file\0" } });
	expect((await git.getCommitPatch("/repo", PREVIEW_SHA, "file")).diff).toBe(diff);
	await expect(git.getCommitPatch("/repo", PREVIEW_SHA, "file", "forged")).rejects.toThrow();
	f.respond({
		stdout: `${diff}diff --git a/extra b/extra\n`,
		outputs: { typechangeNameStatus: "T\0file\0" },
	});
	await expect(git.getCommitPatch("/repo", PREVIEW_SHA, "file")).rejects.toThrow("single file");
});

test("remote commit preview preserves independent metadata and list truncation boundaries", async () => {
	const f = backendFixture();
	const git = createRemoteGitService(f.backend);
	for (const key of ["meta", "nameStatus", "numstat"] as const) {
		const outputs = previewOutputs({ [`${key}Truncated`]: "1" });
		if (key === "nameStatus") outputs.nameStatus += "A\0incomplete";
		if (key === "numstat")
			outputs.numstat = "2\t1\tsrc/file.txt\0" + "0\t0\t\0old name.txt\0partial";
		f.respond({ outputs, truncated: true });
		const detail = await git.getCommitDetail("/repo", PREVIEW_SHA);
		expect(detail.messageTruncated).toBe(key === "meta");
		expect(detail.filesTruncated).toBe(key === "nameStatus");
		expect(detail.files.map((file) => file.path)).toEqual(["src/file.txt", "new name.txt"]);
		expect(detail.files[0]?.linesAdded).toBe(2);
		expect(detail.files[1]?.linesAdded).toBe(key === "numstat" ? null : 0);
	}
	f.respond({ outputs: previewOutputs({ meta: "partial\0metadata", metaTruncated: "1" }) });
	await expect(git.getCommitDetail("/repo", PREVIEW_SHA)).rejects.toThrow("incomplete");
	f.respond({
		outputs: previewOutputs({ meta: previewOutputs().meta.replace(PREVIEW_SHA, "aaaaaaa") }),
	});
	await expect(git.getCommitDetail("/repo", PREVIEW_SHA)).rejects.toThrow("identity");
});

test("remote commit preview preserves unsupported and membership errors without fallback or replay", async () => {
	const old = backendFixture(false);
	const oldGit = createRemoteGitService(old.backend);
	for (const read of [
		() => oldGit.getCommitDetail("/same/path", PREVIEW_SHA),
		() => oldGit.getCommitPatch("/same/path", PREVIEW_SHA, "file.txt"),
	])
		await expect(read()).rejects.toMatchObject({
			statusCode: 409,
			code: GIT_COMMIT_PREVIEW_UNSUPPORTED,
		});
	expect(old.calls).toHaveLength(0);
	// Lack of the additive preview feature must not disable ordinary workspace RPCs.
	await oldGit.probe("/same/path");
	expect(old.calls).toHaveLength(1);

	const f = backendFixture();
	const git = createRemoteGitService(f.backend);
	f.respond({ outputs: { found: "0" } });
	await expect(git.getCommitDetail("/repo", PREVIEW_SHA)).rejects.toMatchObject({
		statusCode: 404,
		code: "GIT_COMMIT_NOT_FOUND",
	});
	await expect(git.getCommitPatch("/repo", PREVIEW_SHA, "file.txt")).rejects.toMatchObject({
		statusCode: 404,
		code: "GIT_COMMIT_NOT_FOUND",
	});
	for (const [fileStatus, statusCode] of [
		["not_found", 404],
		["too_large", 413],
		["invalid", 400],
	] as const) {
		f.respond({
			outputs: { found: "1", fileStatus },
			stdout: "diff --git a/file.txt b/file.txt\n",
		});
		await expect(git.getCommitPatch("/repo", PREVIEW_SHA, "file.txt")).rejects.toMatchObject({
			statusCode,
		});
	}
	expect(f.calls).toHaveLength(5);
});

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

test("remote getLog parses parents from %P and tolerates old 5-field executor lines", async () => {
	const f = backendFixture();
	const git = createRemoteGitService(f.backend);
	const mergeSha = "a".repeat(40);
	const left = "b".repeat(40);
	const right = "c".repeat(40);
	const rootSha = "d".repeat(40);
	// New executor: 6 fields, %P last. Old executor: 5 fields, no parents segment.
	// Use \x00 (not \0): \0 followed by a digit would be parsed as an octal escape.
	const sep = "\x00";
	f.respond({
		stdout: [
			`${mergeSha}${sep}abc${sep}M${sep}Test${sep}2020-01-05T00:00:00Z${sep}${left} ${right}`,
			`${rootSha}${sep}def${sep}seed${sep}Test${sep}2020-01-01T00:00:00Z${sep}`,
			`${rootSha}${sep}def${sep}seed${sep}Test${sep}2020-01-01T00:00:00Z`,
		].join("\n"),
	});
	const log = await git.getLog("/repo");
	expect(log).toHaveLength(3);
	expect(log[0]).toMatchObject({
		sha: mergeSha,
		shortSha: "abc",
		message: "M",
		parents: [left, right],
	});
	expect(log[1]?.parents).toEqual([]);
	// Missing 6th field (old executor) still yields an empty parents array, not undefined.
	expect(log[2]?.parents).toEqual([]);
	for (const entry of log) {
		expect(Array.isArray(entry.parents)).toBe(true);
	}
	f.respond({ stdout: "" });
	expect(await git.getLog("/repo")).toEqual([]);
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
