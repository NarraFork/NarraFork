import type { GitBranches } from "@shared/git-branches";
import type { GitCommitDetail, GitCommitPatch } from "@shared/git-commit-preview";
import type { GitLineStats } from "@shared/git-line-stats";
import type {
	GitStagingAction,
	GitStagingActionResult,
	GitStagingDiff,
	GitStagingFilesPage,
	GitStagingSummary,
} from "@shared/git-staging-lists";
import type {
	GitStatusFilterChar,
	GitStatusPageQuery,
	GitStatusPageResult,
	GitStatusPageScopeProof,
	GitStatusPageStatsQuery,
	GitStatusPageStatsResponse,
} from "@shared/git-status-page";
import type { GitWorkspace } from "@shared/git-workspace";
import type {
	WorktreeCreateRequest,
	WorktreeCreateResult,
	WorktreeListQuery,
	WorktreeListResult,
	WorktreePrepareRequest,
	WorktreePrepareResult,
	WorktreeReconcileRequest,
	WorktreeRemovalPlan,
	WorktreeRemovalPlanRequest,
	WorktreeRemovalRequest,
	WorktreeRemovalResult,
} from "@shared/narrator-worktrees";
import { request } from "./client";
import type { ApiEntity } from "./types";

export type { GitBranchEntry, GitBranches } from "@shared/git-branches";
export type { GitWorkspace } from "@shared/git-workspace";

/** A single `git log` row. `parents` comes from git `%P` (full parent SHAs; root = []). */
export interface GitLogEntry {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	date: string;
	/** git %P：父提交完整 SHA 数组；根提交为 []。旧远程可能缺失。 */
	parents?: string[];
}

/** Existing explicit-file mutation ceiling; all:true uses its separate Git semantics. */
export const GIT_FILE_ACTION_MAX_FILES = 1000;

/** A narrator's resolved Git workspace. */
export type GitTarget = {
	narratorId: string;
	workspaceKey: string;
	repositoryKey?: string | null;
	canWrite: boolean;
	rootPath?: string | null;
};

export function gitTargetKey(target: GitTarget | null | undefined): string | undefined {
	return target?.workspaceKey;
}

export function gitCanWrite(target: GitTarget): boolean {
	return target.canWrite;
}

export function gitBasePath(target: GitTarget): string {
	return `/narrators/${encodeURIComponent(target.narratorId)}/git`;
}

/** Pin reads too, so a late response cannot cache the new root under an old identity. */
function gitReadPath(target: GitTarget, suffix: string): string {
	const path = `${gitBasePath(target)}${suffix}`;
	return `${path}${suffix.includes("?") ? "&" : "?"}workspaceKey=${encodeURIComponent(target.workspaceKey)}`;
}

function writeBody(target: GitTarget, body: object = {}): string {
	if (!target.workspaceKey || !target.canWrite) {
		throw new Error("Git workspace is read-only or unavailable");
	}
	return JSON.stringify({ ...body, workspaceKey: target.workspaceKey });
}

/** HTTP ceiling includes workspace probing plus the server's bounded Git/AI operation. */
export const GIT_HTTP_TIMEOUT_MS = 180_000;
function gitRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
	const timeout = AbortSignal.timeout(GIT_HTTP_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	return request<T>(path, { ...options, signal });
}

// Reads are cancellable by React Query; writes are never retried automatically.
export const gitApi = {
	listNarratorWorktrees: (
		id: string,
		workspaceKey: string,
		signal?: AbortSignal,
		query: WorktreeListQuery = {},
	) => {
		const params = new URLSearchParams({ workspaceKey });
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined) params.set(key, String(value));
		}
		return gitRequest<WorktreeListResult>(
			`/narrators/${encodeURIComponent(id)}/git/worktrees?${params}`,
			{ signal },
		);
	},
	prepareNarratorWorktree: (id: string, input: WorktreePrepareRequest) =>
		gitRequest<WorktreePrepareResult>(
			`/narrators/${encodeURIComponent(id)}/git/worktrees/prepare`,
			{ method: "POST", body: JSON.stringify(input) },
		),
	createNarratorWorktree: (id: string, input: WorktreeCreateRequest) =>
		gitRequest<WorktreeCreateResult>(`/narrators/${encodeURIComponent(id)}/git/worktrees`, {
			method: "POST",
			body: JSON.stringify(input),
		}),
	/** Read-only receipt verification: POST is a bounded query, not another creation. */
	reconcileNarratorWorktree: (id: string, input: WorktreeReconcileRequest) =>
		gitRequest<WorktreeCreateResult>(
			`/narrators/${encodeURIComponent(id)}/git/worktrees/reconcile`,
			{ method: "POST", body: JSON.stringify(input) },
		),
	/** Read-only removal preflight; safe to re-run whenever the dialog needs fresh facts. */
	planNarratorWorktreeRemoval: (id: string, input: WorktreeRemovalPlanRequest) =>
		gitRequest<WorktreeRemovalPlan>(
			`/narrators/${encodeURIComponent(id)}/git/worktrees/removal/plan`,
			{ method: "POST", body: JSON.stringify(input) },
		),
	/** Explicit destructive command. Retrying a completed removal reports `already_absent`. */
	removeNarratorWorktree: (id: string, input: WorktreeRemovalRequest) =>
		gitRequest<WorktreeRemovalResult>(
			`/narrators/${encodeURIComponent(id)}/git/worktrees/removal`,
			{ method: "POST", body: JSON.stringify(input) },
		),
	getGitWorkspace: (narratorId: string, signal?: AbortSignal) =>
		gitRequest<GitWorkspace>(`/narrators/${encodeURIComponent(narratorId)}/git/workspace`, {
			signal,
		}),
	getGitStagingLists: (target: GitTarget, signal?: AbortSignal) =>
		gitRequest<GitStagingSummary>(gitReadPath(target, "/staging-lists"), { signal }),
	gitStagingAction: (target: GitTarget, action: GitStagingAction) =>
		gitRequest<GitStagingActionResult>(`${gitBasePath(target)}/staging-lists/action`, {
			method: "POST",
			body: writeBody(target, action),
		}),
	getGitStagingFiles: (
		target: GitTarget,
		listId: string,
		query: { cursor?: string; limit?: number; filter?: GitStatusFilterChar[] } = {},
		signal?: AbortSignal,
	) => {
		const params = new URLSearchParams();
		if (query.cursor !== undefined) params.set("cursor", query.cursor);
		if (query.limit !== undefined) params.set("limit", String(query.limit));
		if (query.filter?.length) params.set("filter", query.filter.join(","));
		return gitRequest<GitStagingFilesPage>(
			gitReadPath(target, `/staging-lists/${encodeURIComponent(listId)}/files?${params}`),
			{ signal },
		);
	},
	getGitStagingDiff: (
		target: GitTarget,
		listId: string,
		query: { path: string; oldPath?: string },
		signal?: AbortSignal,
	) => {
		const params = new URLSearchParams({ path: query.path });
		if (query.oldPath !== undefined) params.set("oldPath", query.oldPath);
		return gitRequest<GitStagingDiff>(
			gitReadPath(target, `/staging-lists/${encodeURIComponent(listId)}/diff?${params}`),
			{ signal },
		);
	},
	getGitStatus: (target: GitTarget, signal?: AbortSignal, fresh = false) =>
		gitRequest<ApiEntity>(gitReadPath(target, fresh ? "/status?fresh=1" : "/status"), { signal }),
	/** Full branch listing: local, remote-tracking, upstream tracking and worktrees. */
	getGitBranches: (target: GitTarget, signal?: AbortSignal) =>
		gitRequest<GitBranches>(gitReadPath(target, "/branches"), { signal }),
	getGitStatusPage: (target: GitTarget, query: GitStatusPageQuery = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (query.cursor !== undefined) params.set("cursor", query.cursor);
		if (query.limit !== undefined) params.set("limit", String(query.limit));
		if (query.filter?.length) params.set("filter", query.filter.join(","));
		return gitRequest<GitStatusPageResult>(gitReadPath(target, `/status-files?${params}`), {
			signal,
		});
	},
	getGitStatusPageStats: (
		target: GitTarget,
		query: GitStatusPageStatsQuery,
		signal?: AbortSignal,
	) => {
		const params = new URLSearchParams({
			snapshotId: query.snapshotId,
			rows: JSON.stringify(query.rows),
		});
		if (query.filter?.length) params.set("filter", query.filter.join(","));
		return gitRequest<GitStatusPageStatsResponse>(
			gitReadPath(target, `/status-page-stats?${params}`),
			{ signal },
		);
	},
	getGitLineStats: (target: GitTarget, signal?: AbortSignal, fresh = false) =>
		gitRequest<GitLineStats>(gitReadPath(target, fresh ? "/line-stats?fresh=1" : "/line-stats"), {
			signal,
		}),
	getGitModifications: (
		target: GitTarget,
		opts?: {
			scope?: "uncommitted";
			limit?: number;
			cursor?: { changedAt: string; rowId: string };
			projection?: "byFile" | "all";
			/** Git-root-relative; the server accepts it only with uncommitted + byFile. */
			filePath?: string;
		},
		signal?: AbortSignal,
	) => {
		const params = new URLSearchParams();
		if (opts?.scope) params.set("scope", opts.scope);
		if (opts?.limit) params.set("limit", String(opts.limit));
		if (opts?.projection) params.set("projection", opts.projection);
		if (opts?.filePath !== undefined) params.set("filePath", opts.filePath);
		if (opts?.cursor) {
			params.set("cursorAt", opts.cursor.changedAt);
			params.set("cursorRowId", opts.cursor.rowId);
		}
		const qs = params.toString();
		return gitRequest<ApiEntity>(gitReadPath(target, `/modifications${qs ? `?${qs}` : ""}`), {
			signal,
		});
	},
	gitStage: (
		target: GitTarget,
		body: { files?: string[]; all?: boolean; snapshotScope?: GitStatusPageScopeProof },
	) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/stage`, {
			method: "POST",
			body: writeBody(target, body),
		}),
	gitUnstage: (
		target: GitTarget,
		body: { files?: string[]; all?: boolean; snapshotScope?: GitStatusPageScopeProof },
	) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/unstage`, {
			method: "POST",
			body: writeBody(target, body),
		}),
	gitCommit: (target: GitTarget, message: string) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/commit`, {
			method: "POST",
			body: writeBody(target, { message }),
		}),
	gitDiscard: (
		target: GitTarget,
		body: { files?: string[]; all?: boolean; snapshotScope?: GitStatusPageScopeProof },
	) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/discard`, {
			method: "POST",
			body: writeBody(target, body),
		}),
	getGitDiff: (target: GitTarget, file: string, staged = false, signal?: AbortSignal) =>
		gitRequest<ApiEntity>(
			gitReadPath(target, `/diff?file=${encodeURIComponent(file)}&staged=${staged}`),
			{ signal },
		),
	getGitStashList: (target: GitTarget, signal?: AbortSignal) =>
		gitRequest<ApiEntity[]>(gitReadPath(target, "/stash/list"), { signal }),
	gitStash: (target: GitTarget, body: { action: string; message?: string; index?: number }) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/stash`, {
			method: "POST",
			body: writeBody(target, body),
		}),
	getGitLog: (target: GitTarget, limit = 50, skip = 0, signal?: AbortSignal) =>
		gitRequest<GitLogEntry[]>(gitReadPath(target, `/log?limit=${limit}&skip=${skip}`), { signal }),
	getGitCommitDetail: (target: GitTarget, sha: string, signal?: AbortSignal) =>
		gitRequest<GitCommitDetail>(gitReadPath(target, `/commits/${encodeURIComponent(sha)}`), {
			signal,
		}),
	getGitCommitDiff: (
		target: GitTarget,
		sha: string,
		file: string,
		oldPath?: string,
		signal?: AbortSignal,
	) => {
		const params = new URLSearchParams({ file });
		if (oldPath) params.set("oldPath", oldPath);
		return gitRequest<GitCommitPatch>(
			gitReadPath(target, `/commits/${encodeURIComponent(sha)}/diff?${params}`),
			{ signal },
		);
	},
	gitReset: (target: GitTarget, commit: string, mode: "soft" | "hard") =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/reset`, {
			method: "POST",
			body: writeBody(target, { target: commit, mode }),
		}),
	gitAiCommitMessage: (target: GitTarget) =>
		gitRequest<{ message: string }>(`${gitBasePath(target)}/ai-commit-message`, {
			method: "POST",
			body: writeBody(target),
		}),
	/** Switch, create (`create` + `startPoint`), or track a remote branch by name. */
	gitCheckoutBranch: (
		target: GitTarget,
		body: { branch: string; create?: boolean; startPoint?: string },
	) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/checkout`, {
			method: "POST",
			body: writeBody(target, body),
		}),
	/** Never force-pushes: a rejected non-fast-forward comes back as git's own text. */
	gitPushBranch: (target: GitTarget, body: { remote?: string; setUpstream?: boolean } = {}) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/push`, {
			method: "POST",
			body: writeBody(target, body),
		}),
	gitFetchRemote: (target: GitTarget, body: { remote?: string; prune?: boolean } = {}) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/fetch`, {
			method: "POST",
			body: writeBody(target, body),
		}),
};
