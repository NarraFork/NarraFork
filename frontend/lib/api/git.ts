import type { GitWorkspace } from "@shared/git-workspace";
import { request } from "./client";
import type { ApiEntity } from "./types";

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

/** Strings remain the legacy chapter adapter; new callers carry a resolved workspace. */
export type GitTarget =
	| string
	| {
			narratorId: string;
			workspaceKey: string;
			repositoryKey?: string | null;
			canWrite: boolean;
			rootPath?: string | null;
			chapterId?: string | null;
	  };

export function gitTargetKey(target: GitTarget | null | undefined): string | undefined {
	return typeof target === "string" ? target : target?.workspaceKey;
}

export function gitCanWrite(target: GitTarget): boolean {
	return typeof target === "string" || target.canWrite;
}

export function gitBasePath(target: GitTarget): string {
	return typeof target === "string"
		? `/chapters/${encodeURIComponent(target)}/git`
		: `/narrators/${encodeURIComponent(target.narratorId)}/git`;
}

/** Pin reads too, so a late response cannot cache the new root under an old identity. */
function gitReadPath(target: GitTarget, suffix: string): string {
	const path = `${gitBasePath(target)}${suffix}`;
	return typeof target === "string"
		? path
		: `${path}${suffix.includes("?") ? "&" : "?"}workspaceKey=${encodeURIComponent(target.workspaceKey)}`;
}

function writeBody(target: GitTarget, body: object = {}): string {
	if (typeof target !== "string" && (!target.workspaceKey || !target.canWrite)) {
		throw new Error("Git workspace is read-only or unavailable");
	}
	return JSON.stringify(
		typeof target === "string" ? body : { ...body, workspaceKey: target.workspaceKey },
	);
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
	getGitWorkspace: (narratorId: string, signal?: AbortSignal) =>
		gitRequest<GitWorkspace>(`/narrators/${encodeURIComponent(narratorId)}/git/workspace`, {
			signal,
		}),
	getGitStatus: (target: GitTarget, signal?: AbortSignal) =>
		gitRequest<ApiEntity>(gitReadPath(target, "/status"), { signal }),
	getGitModifications: (
		target: GitTarget,
		opts?: {
			scope?: "uncommitted";
			limit?: number;
			cursor?: { changedAt: string; rowId: string };
			projection?: "byFile" | "all";
		},
		signal?: AbortSignal,
	) => {
		const params = new URLSearchParams();
		if (opts?.scope) params.set("scope", opts.scope);
		if (opts?.limit) params.set("limit", String(opts.limit));
		if (opts?.projection) params.set("projection", opts.projection);
		if (opts?.cursor) {
			params.set("cursorAt", opts.cursor.changedAt);
			params.set("cursorRowId", opts.cursor.rowId);
		}
		const qs = params.toString();
		return gitRequest<ApiEntity>(gitReadPath(target, `/modifications${qs ? `?${qs}` : ""}`), {
			signal,
		});
	},
	gitStage: (target: GitTarget, body: { files?: string[]; all?: boolean }) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/stage`, {
			method: "POST",
			body: writeBody(target, body),
		}),
	gitUnstage: (target: GitTarget, body: { files?: string[]; all?: boolean }) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/unstage`, {
			method: "POST",
			body: writeBody(target, body),
		}),
	gitCommit: (target: GitTarget, message: string) =>
		gitRequest<ApiEntity>(`${gitBasePath(target)}/commit`, {
			method: "POST",
			body: writeBody(target, { message }),
		}),
	gitDiscard: (target: GitTarget, body: { files?: string[]; all?: boolean }) =>
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
};
