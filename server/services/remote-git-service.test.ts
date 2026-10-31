import { afterEach, expect, spyOn, test } from "bun:test";
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
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { GitAuthError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { getGitLineStatsCached } from "./git-line-stats-cache";
import {
	getGitWorkspaceLineStats,
	getGitWorkspaceStatus,
	invalidateGitWorkspace,
	validateGitWorkspaceCache,
} from "./git-management-service";
import { clearStatusCache } from "./git-status-cache";
import type { GitWorkspaceTarget } from "./git-workspace";
import {
	createRemoteGitService,
	getRemoteGitStatusQueryKey,
	parseRemoteGitStatus,
	supportsRemoteGitWorkspace,
} from "./remote-git-service";

afterEach(clearStatusCache);

function backendFixture(supportsGitCommitPreview = true) {
	const calls: Array<{ request: GitWorkspaceRequest; signal?: AbortSignal }> = [];
	let response: GitWorkspaceResult = { stdout: "" };
	let failure: Error | undefined;
	const backend = {
		kind: "remote",
		deviceId: "device-a",
		supportsGitWorkspace: true,
		supportsGitLineStats: true,
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

test("workspace helpers share results, preserve fresh overrides and renew only clean cached data", async () => {
	const f = backendFixture();
	const backend = { ...f.backend, paths: targetPathSemantics("posix") } as ExecutionBackend;
	const target = {
		backend,
		workspace: { deviceId: backend.deviceId, cwd: "/helpers", rootPath: "/helpers" },
	} as GitWorkspaceTarget;
	f.respond({
		outputs: { status: "?? a\0" },
		lineStats: { files: [], linesAdded: 1, linesRemoved: 0, complete: true },
	});
	let now = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const events: string[] = [];
	const listener = (event: { queryKey: string }) => {
		events.push(event.queryKey);
	};
	eventBus.on("git:workspace_invalidated", listener);
	try {
		validateGitWorkspaceCache(target);
		expect(f.calls).toHaveLength(0);
		await getGitWorkspaceStatus(target);
		validateGitWorkspaceCache(target);
		expect(f.calls.map(({ request }) => request.operation)).toEqual(["status"]);
		await getGitWorkspaceLineStats(target);
		now = 2999;
		validateGitWorkspaceCache(target);
		now = 5000;
		await getGitWorkspaceStatus(target);
		await getGitWorkspaceLineStats(target);
		expect(f.calls).toHaveLength(2);
		await getGitWorkspaceStatus(target, undefined, 0);
		await getGitWorkspaceLineStats(target, undefined, 0);
		expect(f.calls).toHaveLength(4);
		invalidateGitWorkspace(target);
		validateGitWorkspaceCache(target);
		await getGitWorkspaceStatus(target);
		await getGitWorkspaceLineStats(target);
		expect(f.calls).toHaveLength(6);
		expect(events).toEqual([getRemoteGitStatusQueryKey(backend, "/helpers")]);
		await createRemoteGitService(backend).stageAll("/helpers");
		expect(events).toHaveLength(2);
		await getGitWorkspaceStatus(target);
		await getGitWorkspaceLineStats(target);
		expect(f.calls).toHaveLength(9);
	} finally {
		clock.mockRestore();
		eventBus.off("git:workspace_invalidated", listener);
	}
});

test("remote line stats is an independent raw read with unknown fields preserved", async () => {
	const f = backendFixture();
	const controller = new AbortController();
	const partial = {
		files: [{ path: "large.txt", stagedLinesAdded: 1, stagedLinesRemoved: 0, complete: false }],
		linesAdded: 1,
		linesRemoved: 0,
		complete: false,
	};
	f.respond({ lineStats: partial });
	const git = createRemoteGitService(f.backend, controller.signal);
	expect(await git.getLineStats("C:\\Repo")).toEqual(partial);
	expect(f.calls[0]).toEqual({
		request: {
			cwd: "C:\\Repo",
			expectedRoot: "C:\\Repo",
			operation: "lineStats",
			timeoutMs: GIT_WORKSPACE_TIMEOUT_MS,
			maxBytes: GIT_WORKSPACE_MAX_BYTES,
		},
		signal: controller.signal,
	});
	// No settled cache or status coalescer is hidden inside the raw adapter.
	await git.getLineStats("C:\\Repo");
	expect(f.calls).toHaveLength(2);
	f.respond({});
	await expect(git.getLineStats("/repo")).rejects.toThrow("statistics are missing");
	f.fail(new Error("cancelled"));
	await expect(git.getLineStats("/repo")).rejects.toThrow("cancelled");
});

test("remote line stats unsupported requires upgrade without legacy status fallback", async () => {
	const f = backendFixture();
	const backend = { ...f.backend, supportsGitLineStats: false } as ExecutionBackend;
	await expect(createRemoteGitService(backend).getLineStats("/repo")).rejects.toMatchObject({
		code: "GIT_LINE_STATS_UNSUPPORTED",
		statusCode: 501,
	});
	expect(f.calls).toHaveLength(0);
});

for (const writeFails of [false, true]) {
	test(`remote writes invalidate settled line statistics even when uncertain=${writeFails}`, async () => {
		const f = backendFixture();
		const cwd = `/stats-write-invalidates-${writeFails}`;
		const key = getRemoteGitStatusQueryKey(f.backend, cwd);
		const stats = { files: [], linesAdded: 1, linesRemoved: 0, complete: false };
		let reads = 0;
		const read = () =>
			getGitLineStatsCached(key, async () => {
				reads++;
				return stats;
			});
		await read();
		await read();
		expect(reads).toBe(1);
		if (writeFails) f.fail(new Error("connection lost"));
		const git = createRemoteGitService(f.backend);
		if (writeFails) await expect(git.stageAll(cwd)).rejects.toThrow("uncertain");
		else await git.stageAll(cwd);
		await read();
		expect(reads).toBe(2);
	});
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
		totalFilesExact: false,
	});
	expect(emptyPrefix.linesAdded).toBeUndefined();
	expect(emptyPrefix.linesRemoved).toBeUndefined();

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
		const summary = await git.getStatusSummary("/repo", { ttlMs: 0 });
		expect(summary.truncated).toBe(true);
		expect(summary.hasChanges).toBe(true);
		expect(summary.totalFiles).toBe(summary.files.length);
		expect(summary.files).toHaveLength(status.startsWith("??") ? 1 : 0);
	}
	f.respond({ outputs: { status: "" }, truncated: false });
	expect(await git.getStatusSummary("/repo", { ttlMs: 0 })).toMatchObject({
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

test("lightweight remote status omits unknown line counts and keeps exact count beyond display cap", () => {
	const summary = parseRemoteGitStatus({
		outputs: { status: `${"?? file\0".repeat(201)}R  new\0old\0`, head: "sha", branch: "main" },
		totalFilesExact: true,
	});
	expect(summary).toMatchObject({ totalFiles: 202, totalFilesExact: true, truncated: true });
	expect(summary.linesAdded).toBeUndefined();
	expect(summary.linesRemoved).toBeUndefined();
	for (const file of summary.files) {
		expect(Object.keys(file).some((key) => /lines/i.test(key))).toBe(false);
	}
	const legacyOversized = parseRemoteGitStatus({ outputs: { status: "?? file\0".repeat(10_001) } });
	expect(legacyOversized).toMatchObject({
		totalFiles: 10_000,
		totalFilesExact: false,
		truncated: true,
	});
	const partial = parseRemoteGitStatus({ outputs: { status: "?? complete\0?? incomplete" } });
	expect(partial).toMatchObject({ totalFiles: 1, totalFilesExact: false, truncated: true });
});

test("remote status merges authorized readers but cancellation belongs to each caller", async () => {
	const pending = Promise.withResolvers<GitWorkspaceResult>();
	const started = Promise.withResolvers<void>();
	const signals: AbortSignal[] = [];
	let calls = 0;
	const backend = {
		...backendFixture().backend,
		runtimeGeneration: 1,
		async gitWorkspace(_request: GitWorkspaceRequest, signal: AbortSignal) {
			calls++;
			signals.push(signal);
			started.resolve();
			return pending.promise;
		},
	} as ExecutionBackend;
	const first = new AbortController();
	const second = new AbortController();
	const a = createRemoteGitService(backend, first.signal).getStatusSummary("/coalesced");
	const b = createRemoteGitService(backend, second.signal).getStatusSummary("/coalesced");
	await started.promise;
	expect(calls).toBe(1);
	expect(signals[0]).not.toBe(first.signal);
	first.abort(new Error("first reader left"));
	await expect(a).rejects.toThrow("first reader left");
	expect(signals[0]?.aborted).toBe(false);
	pending.resolve({ outputs: { status: "?? file\0" } });
	expect((await b).totalFiles).toBe(1);
	await createRemoteGitService(backend).getStatusSummary("/coalesced");
	expect(calls).toBe(1); // A different authorized adapter shares the settled result.
	await createRemoteGitService(backend).getStatusSummary("/coalesced", { ttlMs: 0 });
	expect(calls).toBe(2);
});

test("remote status separates device, generation and cwd; last reader abort reaches RPC", async () => {
	let calls = 0;
	const started = Promise.withResolvers<void>();
	const signals: AbortSignal[] = [];
	const backend = {
		...backendFixture().backend,
		runtimeGeneration: 1,
		gitWorkspace(_request: GitWorkspaceRequest, signal: AbortSignal) {
			calls++;
			signals.push(signal);
			if (calls === 4) started.resolve();
			return new Promise<GitWorkspaceResult>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		},
	} as ExecutionBackend;
	const controller = new AbortController();
	const requests = [
		createRemoteGitService(backend, controller.signal).getStatusSummary("/separate"),
		createRemoteGitService(
			{ ...backend, deviceId: "other-device" },
			controller.signal,
		).getStatusSummary("/separate"),
		createRemoteGitService(
			{ ...backend, runtimeGeneration: 2 },
			controller.signal,
		).getStatusSummary("/separate"),
		createRemoteGitService(backend, controller.signal).getStatusSummary("/different-root"),
	];
	const settled = Promise.allSettled(requests);
	await started.promise;
	controller.abort();
	expect((await settled).every((result) => result.status === "rejected")).toBe(true);
	expect(signals.every((signal) => signal.aborted)).toBe(true);
	expect(calls).toBe(4);
});

test("workspace events invalidate an in-flight remote read before the next refresh", async () => {
	const pending = Promise.withResolvers<GitWorkspaceResult>();
	const started = Promise.withResolvers<void>();
	let statusCalls = 0;
	const backend = {
		...backendFixture().backend,
		runtimeGeneration: 3,
		paths: targetPathSemantics("posix"),
		async gitWorkspace() {
			statusCalls++;
			if (statusCalls === 1) {
				started.resolve();
				return pending.promise;
			}
			return { outputs: { status: " M latest\0" } };
		},
	} as ExecutionBackend;
	const target = {
		backend,
		workspace: { deviceId: backend.deviceId, cwd: "/event-root", rootPath: "/event-root" },
	} as GitWorkspaceTarget;
	const git = createRemoteGitService(backend);
	const old = git.getStatusSummary("/event-root");
	await started.promise;
	invalidateGitWorkspace(target);
	const refreshed = git.getStatusSummary("/event-root");
	expect(statusCalls).toBe(1);
	pending.resolve({ outputs: { status: "?? obsolete\0" } });
	expect((await old).files[0]?.path).toBe("obsolete");
	expect((await refreshed).files[0]?.path).toBe("latest");
	expect(statusCalls).toBe(2);
});

for (const writeFails of [false, true]) {
	test(`remote writes invalidate in-flight status even when uncertain=${writeFails}`, async () => {
		const pending = Promise.withResolvers<GitWorkspaceResult>();
		const started = Promise.withResolvers<void>();
		let statusCalls = 0;
		const backend = {
			...backendFixture().backend,
			async gitWorkspace(request: GitWorkspaceRequest) {
				if (request.operation !== "status") {
					if (writeFails) throw new Error("connection lost");
					return {};
				}
				statusCalls++;
				if (statusCalls === 1) {
					started.resolve();
					return pending.promise;
				}
				return { outputs: { status: "A  fresh\0" } };
			},
		} as ExecutionBackend;
		const git = createRemoteGitService(backend);
		const old = git.getStatusSummary("/write-invalidates");
		await started.promise;
		if (writeFails) await expect(git.stageAll("/write-invalidates")).rejects.toThrow("uncertain");
		else await git.stageAll("/write-invalidates");
		const fresh = git.getStatusSummary("/write-invalidates");
		expect(statusCalls).toBe(1);
		pending.resolve({ outputs: { status: "?? stale\0" } });
		expect((await old).files[0]?.path).toBe("stale");
		expect((await fresh).files[0]?.path).toBe("fresh");
		expect(statusCalls).toBe(2);
	});
}

test("branch sync failures stay git errors, including auth, without the uncertain-write suffix", async () => {
	const auth = backendFixture();
	Object.assign(auth.backend, { supportsGitRemoteSync: true });
	auth.fail(new Error("fatal: Authentication failed for 'https://example.test/r.git/'"));
	await expect(createRemoteGitService(auth.backend).push("/repo")).rejects.toBeInstanceOf(
		GitAuthError,
	);

	const rejected = backendFixture();
	Object.assign(rejected.backend, { supportsGitRemoteSync: true });
	rejected.fail(new Error("! [rejected] main -> main (non-fast-forward)"));
	const rejectedGit = createRemoteGitService(rejected.backend);
	await expect(rejectedGit.push("/repo")).rejects.toThrow("non-fast-forward");
	await expect(rejectedGit.fetch("/repo")).rejects.not.toThrow("uncertain");

	const checkout = backendFixture();
	Object.assign(checkout.backend, { supportsGitBranchSwitch: true });
	checkout.fail(new Error("fatal: 'side' is already used by worktree"));
	const checkoutGit = createRemoteGitService(checkout.backend);
	await expect(checkoutGit.checkoutBranch("/repo", { branch: "side" })).rejects.toThrow(
		"already used",
	);
	await expect(checkoutGit.checkoutBranch("/repo", { branch: "side" })).rejects.not.toThrow(
		"uncertain",
	);
});
