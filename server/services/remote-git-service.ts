import {
	GIT_COMMIT_PREVIEW_PATCH_MAX_BYTES,
	GIT_COMMIT_PREVIEW_UNSUPPORTED,
	type GitCommitDetail,
	type GitCommitPatch,
} from "@shared/git-commit-preview";
import type { GitLineStats } from "@shared/git-line-stats";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import {
	GIT_WORKSPACE_AI_DIFF_BYTES,
	GIT_WORKSPACE_MAX_BYTES,
	GIT_WORKSPACE_TIMEOUT_MS,
	GIT_WORKSPACE_WRITE_TIMEOUT_MS,
	type GitWorkspaceOperation,
	type GitWorkspaceRequest,
	type GitWorkspaceResult,
} from "../lib/agent/execution/git-workspace-rpc";
import { AppError, GitError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { parseGitBranches } from "./git-branch-listing";
import {
	assertSingleFilePatch,
	buildCommitDetail,
	commitNotFound,
	parseCommitMeta,
} from "./git-commit-preview-parse";
import { invalidateGitLineStats } from "./git-line-stats-cache";
import type { GitCommitIdentity, GitStatusFile, GitStatusSummary } from "./git-service";
import { coordinateGitStatusQuery, invalidateGitStatusQuery } from "./git-status-query";

const WRITES = new Set<GitWorkspaceOperation>([
	"stage",
	"unstage",
	"commit",
	"discard",
	"stashPush",
	"stashPop",
	"stashDrop",
	"reset",
	"checkout",
	"push",
	"fetch",
]);

export function supportsRemoteGitWorkspace(backend: ExecutionBackend): boolean {
	return (
		backend.kind === "remote" && backend.supportsGitWorkspace === true && !!backend.gitWorkspace
	);
}

type LineStats = { added: number; removed: number };
function numstat(raw: string): Map<string, LineStats> {
	const result = new Map<string, LineStats>();
	const records = raw.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		const first = record.indexOf("\t");
		const second = record.indexOf("\t", first + 1);
		if (first < 0 || second < 0) continue;
		let path = record.slice(second + 1);
		if (!path) {
			i++;
			path = records[++i] ?? "";
		}
		if (!path) continue;
		result.set(path, {
			added: Number.parseInt(record.slice(0, first), 10) || 0,
			removed: Number.parseInt(record.slice(first + 1, second), 10) || 0,
		});
	}
	return result;
}

/** Same status contract as local Git. NUL delimiters preserve tabs/newlines/renames. */
export function parseRemoteGitStatus(
	result: GitWorkspaceResult,
): GitStatusSummary & { truncated: boolean } {
	const outputs = result.outputs ?? {};
	let truncated = result.truncated === true || result.totalFilesExact === false;
	// Only legacy executors send statistics. Missing statistics are unknown, not zero.
	const hasLineStats = ["stagedNumstat", "unstagedNumstat", "untrackedNumstat"].some(
		(key) => typeof outputs[key] === "string",
	);
	const stagedStats = numstat(outputs.stagedNumstat ?? "");
	const unstagedStats = numstat(outputs.unstagedNumstat ?? "");
	for (const [path, stats] of numstat(outputs.untrackedNumstat ?? ""))
		unstagedStats.set(path, stats);
	const rawStatus = outputs.status ?? "";
	const records = rawStatus.split("\0");
	// Do not treat a legacy executor's incomplete final path as a complete entry.
	if (records.pop()) truncated = true;
	const files: GitStatusFile[] = [];
	let staged = 0,
		unstaged = 0,
		untracked = 0,
		totalFiles = 0;
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		if (record.length < 4) continue;
		if (totalFiles >= 10_000) {
			truncated = true;
			break;
		}
		const status = record.slice(0, 2);
		const path = record.slice(3);
		const renamed = /[RC]/.test(status);
		const oldPath = renamed ? records[++i] : undefined;
		// A capped porcelain stream can end after the first half of a rename.
		// Exclude that incomplete logical entry; `truncated` still makes every
		// reported count a lower bound and prevents a false clean status.
		if (renamed && !oldPath) {
			truncated = true;
			continue;
		}
		if (status === "??") untracked++;
		else {
			if (status[0] !== " " && status[0] !== "?") staged++;
			if (status[1] !== " " && status[1] !== "?") unstaged++;
		}
		totalFiles++;
		if (files.length >= 200) continue;
		const s = stagedStats.get(path) ?? { added: 0, removed: 0 };
		const u = unstagedStats.get(path) ?? { added: 0, removed: 0 };
		files.push({
			status,
			path,
			...(oldPath ? { oldPath } : {}),
			...(hasLineStats
				? {
						linesAdded: s.added + u.added,
						linesRemoved: s.removed + u.removed,
						stagedLinesAdded: s.added,
						stagedLinesRemoved: s.removed,
						unstagedLinesAdded: u.added,
						unstagedLinesRemoved: u.removed,
					}
				: {}),
		});
	}
	let linesAdded = 0,
		linesRemoved = 0;
	for (const stats of [...stagedStats.values(), ...unstagedStats.values()]) {
		linesAdded += stats.added;
		linesRemoved += stats.removed;
	}
	return {
		// A zero-record truncated prefix is unknown, never proof of a clean tree.
		hasChanges: totalFiles > 0 || truncated,
		staged,
		unstaged,
		untracked,
		files,
		totalFiles,
		totalFilesExact: !truncated,
		headSha: (outputs.head ?? "").trim(),
		branch: (outputs.branch ?? "").trim(),
		...(hasLineStats ? { linesAdded, linesRemoved } : {}),
		// Both the upstream byte budget and this adapter's file cap make the list incomplete.
		truncated: truncated || totalFiles > files.length,
	};
}

/** Shared by reads, writes and workspace-event invalidation; never a host-path key. */
export function getRemoteGitStatusQueryKey(
	backend: Pick<ExecutionBackend, "deviceId" | "runtimeGeneration">,
	cwd: string,
	expectedRoot = cwd,
): string {
	return JSON.stringify(["remote", backend.deviceId, backend.runtimeGeneration, cwd, expectedRoot]);
}

/**
 * Caller must authorize narrator + project + device + canonical root on EVERY
 * request before constructing this adapter. Status results share a bounded cache,
 * never authorization decisions; there is no local fallback or retry.
 * The backend is pinned to its authenticated transport generation; the executor
 * independently verifies expectedRoot and its operator-owned path policy.
 */
export function createRemoteGitService(
	backend: ExecutionBackend,
	options?: AbortSignal | { signal?: AbortSignal },
	beforeWrite?: () => Promise<void>,
) {
	const signal = options instanceof AbortSignal ? options : options?.signal;
	const statusKey = (cwd: string) => getRemoteGitStatusQueryKey(backend, cwd);
	async function request(
		cwd: string,
		operation: GitWorkspaceOperation,
		args: Partial<GitWorkspaceRequest> = {},
		overrideSignal = signal,
	): Promise<GitWorkspaceResult> {
		if (!supportsRemoteGitWorkspace(backend) || !backend.gitWorkspace) {
			throw new GitError("Remote executor lacks git.workspace.v1; upgrade the device executor");
		}
		const write = WRITES.has(operation);
		// Keep authorization errors intact and run the live policy check directly
		// before dispatch (not once at adapter construction or workspace probing).
		if (write) await beforeWrite?.();
		try {
			return await backend.gitWorkspace(
				{
					cwd,
					expectedRoot: operation === "probe" ? undefined : cwd,
					operation,
					timeoutMs: write ? GIT_WORKSPACE_WRITE_TIMEOUT_MS : GIT_WORKSPACE_TIMEOUT_MS,
					maxBytes: GIT_WORKSPACE_MAX_BYTES,
					...args,
				},
				overrideSignal,
			);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (write)
				throw new GitError(
					`${detail}. Remote Git write result may be uncertain; refresh status/history before retrying.`,
				);
			throw error;
		} finally {
			// Even an uncertain write must not let the next read reuse pre-write work.
			if (write) {
				const queryKey = statusKey(cwd);
				invalidateGitStatusQuery(queryKey);
				invalidateGitLineStats(queryKey);
				eventBus.emit({ type: "git:workspace_invalidated", queryKey });
			}
		}
	}
	async function mutate(
		cwd: string,
		operation: GitWorkspaceOperation,
		args: Partial<GitWorkspaceRequest> = {},
	) {
		await request(cwd, operation, args);
	}
	return {
		probe: (
			cwd: string,
			probeSignal?: AbortSignal,
			limits: Pick<GitWorkspaceRequest, "maxBytes" | "timeoutMs"> = {},
		) => request(cwd, "probe", limits, probeSignal ?? signal),
		async getStatusSummary(cwd: string, options: { ttlMs?: number } = {}) {
			return coordinateGitStatusQuery(
				statusKey(cwd),
				async (sharedSignal) =>
					parseRemoteGitStatus(await request(cwd, "status", {}, sharedSignal)),
				{ signal, ttlMs: options.ttlMs },
			);
		},
		async getLineStats(cwd: string): Promise<GitLineStats> {
			if (backend.supportsGitLineStats !== true) {
				throw new AppError(
					"Remote executor lacks git.workspace.line-stats.v1; upgrade the device executor",
					501,
					"GIT_LINE_STATS_UNSUPPORTED",
				);
			}
			const result = await request(cwd, "lineStats");
			if (!result.lineStats) throw new GitError("Remote Git line statistics are missing");
			return result.lineStats;
		},
		async getFileDiff(cwd: string, path: string, staged = false, maxBytes = 200_000) {
			const result = await request(cwd, "diff", { files: [path], staged, maxBytes });
			return { diff: result.stdout ?? "", truncated: result.truncated ?? false };
		},
		async getFullDiff(cwd: string, maxBytes = GIT_WORKSPACE_AI_DIFF_BYTES) {
			const result = await request(cwd, "fullDiff", { maxBytes });
			return `${result.stdout ?? ""}${result.truncated ? "\n[diff truncated]" : ""}`;
		},
		stageFiles: (cwd: string, files: string[]) => mutate(cwd, "stage", { files }),
		stageAll: (cwd: string) => mutate(cwd, "stage", { all: true }),
		unstageFiles: (cwd: string, files: string[]) => mutate(cwd, "unstage", { files }),
		unstageAll: (cwd: string) => mutate(cwd, "unstage", { all: true }),
		async commit(cwd: string, message: string, identity?: GitCommitIdentity) {
			const result = await request(cwd, "commit", { message, identity: identity ?? undefined });
			return (result.stdout ?? "").trim();
		},
		discardFiles: (cwd: string, files: string[]) => mutate(cwd, "discard", { files }),
		discardAll: (cwd: string) => mutate(cwd, "discard", { all: true }),
		async getLog(cwd: string, opts: { limit?: number; skip?: number; branch?: string } = {}) {
			const result = await request(cwd, "log", opts);
			if (result.truncated)
				throw new GitError("Remote Git history exceeds output limit; reduce the page size");
			return (result.stdout ?? "")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [sha = "", shortSha = "", message = "", author = "", date = "", parentsRaw] =
						line.split("\0");
					return {
						sha,
						shortSha,
						message,
						author,
						date,
						// 旧 executor 无 %P 时第 6 段不存在，解析为 []（字段存在但空）。
						parents: (parentsRaw ?? "").trim().split(/\s+/).filter(Boolean),
					};
				});
		},
		stash: (cwd: string, message?: string, identity?: GitCommitIdentity) =>
			mutate(cwd, "stashPush", { message, identity: identity ?? undefined }),
		async stashList(cwd: string) {
			const result = await request(cwd, "stashList");
			if (result.truncated) throw new GitError("Remote stash list exceeds output limit");
			return (result.stdout ?? "")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [ref = "", message = "", date = ""] = line.split("\0");
					return { index: Number.parseInt(ref.replace("stash@{", ""), 10), message, date };
				});
		},
		async stashPop(cwd: string) {
			return { hasConflicts: (await request(cwd, "stashPop")).hasConflicts ?? false };
		},
		stashDrop: (cwd: string, index: number) => mutate(cwd, "stashDrop", { index }),
		resetSoft: (cwd: string, target: string) => mutate(cwd, "reset", { mode: "soft", target }),
		resetHard: (cwd: string, target: string) => mutate(cwd, "reset", { mode: "hard", target }),
		/** The executor returns the raw listings; parsing is shared with the local backend. */
		async getBranches(cwd: string) {
			requireBranches();
			const result = await request(cwd, "branches");
			return parseGitBranches({ ...result.outputs, truncated: result.truncated === true });
		},
		async checkoutBranch(
			cwd: string,
			input: { branch: string; create?: boolean; startPoint?: string },
		) {
			requireBranchSwitch();
			await mutate(cwd, "checkout", {
				branch: input.branch,
				...(input.create ? { create: true } : {}),
				...(input.startPoint ? { startPoint: input.startPoint } : {}),
			});
		},
		async push(cwd: string, input: { remote?: string; setUpstream?: boolean } = {}) {
			requireRemoteSync();
			await mutate(cwd, "push", {
				...(input.remote ? { remote: input.remote } : {}),
				...(input.setUpstream ? { setUpstream: true } : {}),
			});
		},
		async fetch(cwd: string, input: { remote?: string; prune?: boolean } = {}) {
			requireRemoteSync();
			await mutate(cwd, "fetch", {
				...(input.remote ? { remote: input.remote } : {}),
				...(input.prune ? { prune: true } : {}),
			});
		},
		/**
		 * The executor returns the three raw listings; parsing is shared with the local
		 * backend so both answer identically. `outputs.<key>Truncated` = "1" marks a
		 * listing cut by its own budget.
		 */
		async getCommitDetail(cwd: string, sha: string): Promise<GitCommitDetail> {
			requireCommitPreview();
			const result = await request(cwd, "commitDetail", { commit: sha });
			const outputs = result.outputs ?? {};
			if (outputs.found === "0") throw commitNotFound(sha);
			const cut = (key: string) => outputs[`${key}Truncated`] === "1";
			return buildCommitDetail(parseCommitMeta(outputs.meta ?? "", cut("meta")), {
				numstat: outputs.numstat ?? "",
				numstatTruncated: cut("numstat"),
				nameStatus: outputs.nameStatus ?? "",
				nameStatusTruncated: cut("nameStatus"),
			});
		},
		async getCommitPatch(
			cwd: string,
			sha: string,
			file: string,
			oldPath?: string,
		): Promise<GitCommitPatch> {
			requireCommitPreview();
			const result = await request(cwd, "commitDiff", {
				commit: sha,
				path: file,
				...(oldPath ? { oldPath } : {}),
				maxBytes: GIT_COMMIT_PREVIEW_PATCH_MAX_BYTES,
			});
			if (result.outputs?.found === "0") throw commitNotFound(sha);
			switch (result.outputs?.fileStatus) {
				case "not_found":
					throw new AppError("File is not part of this commit", 404, "GIT_COMMIT_FILE_NOT_FOUND");
				case "too_large":
					throw new AppError(
						"Commit path exceeds the preview budget",
						413,
						"GIT_COMMIT_PREVIEW_TOO_LARGE",
					);
				case "invalid":
					throw new ValidationError("Commit preview path must name a single changed file");
			}
			const diff = result.stdout ?? "";
			// Only the executor's complete, scoped T record authorizes a second section.
			// Do not infer it from patch headers, a caller flag, or an unscoped list.
			const scoped = result.outputs?.typechangeNameStatus;
			if (scoped !== undefined && (scoped !== `T\0${file}\0` || oldPath))
				throw new ValidationError("Invalid scoped commit typechange record");
			assertSingleFilePatch(
				diff,
				file,
				scoped === undefined ? undefined : { status: "typechange", path: file },
			);
			return { diff, truncated: result.truncated ?? false };
		},
	};
	function requireCommitPreview() {
		// No local fallback: the repository lives on the device.
		if (backend.supportsGitCommitPreview !== true)
			throw new AppError(
				"The device executor is too old to preview commits; upgrade it",
				409,
				GIT_COMMIT_PREVIEW_UNSUPPORTED,
			);
	}
	// The three branch capabilities are separate because they shipped separately: a
	// device may list branches without being able to switch or sync. Each gates only
	// its own operations and none of them falls back to local execution.
	function requireBranches() {
		if (backend.supportsGitBranches !== true)
			throw new AppError(
				"The device executor is too old to list branches; upgrade it to manage branches here",
				409,
				"GIT_BRANCHES_UNSUPPORTED",
			);
	}
	function requireBranchSwitch() {
		if (backend.supportsGitBranchSwitch !== true)
			throw new AppError(
				"The device executor is too old to switch branches; upgrade it to manage branches here",
				409,
				"GIT_BRANCH_SWITCH_UNSUPPORTED",
			);
	}
	function requireRemoteSync() {
		if (backend.supportsGitRemoteSync !== true)
			throw new AppError(
				"The device executor is too old to push or fetch; upgrade it to sync with the remote",
				409,
				"GIT_REMOTE_SYNC_UNSUPPORTED",
			);
	}
}

export type RemoteGitService = ReturnType<typeof createRemoteGitService>;
