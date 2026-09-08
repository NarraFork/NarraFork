import { request } from "./client";
import type { ApiEntity } from "./types";

export const gitApi = {
	getGitStatus: (chapterId: string) => request<ApiEntity>(`/chapters/${chapterId}/git/status`),
	getGitModifications: (
		chapterId: string,
		opts?: {
			scope?: "uncommitted";
			limit?: number;
			/** nextCursor from the historical (unscoped) response; never a current baseline. */
			cursor?: { changedAt: string; rowId: string };
			/**
			 * `"byFile"` drops the per-event timeline from the response; no caller renders it.
			 * `"all"` keeps it, and is what the server assumes when the parameter is absent.
			 *
			 * These are the server's spellings (`gitModificationsQuerySchema`), not a
			 * client-side vocabulary: the value is forwarded verbatim as a query parameter, so
			 * a name the enum does not list is rejected as a 400 rather than degrading.
			 */
			projection?: "byFile" | "all";
		},
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
		return request<ApiEntity>(`/chapters/${chapterId}/git/modifications${qs ? `?${qs}` : ""}`);
	},
	gitStage: (chapterId: string, body: { files?: string[]; all?: boolean }) =>
		request<ApiEntity>(`/chapters/${chapterId}/git/stage`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	gitUnstage: (chapterId: string, body: { files?: string[]; all?: boolean }) =>
		request<ApiEntity>(`/chapters/${chapterId}/git/unstage`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	gitCommit: (chapterId: string, message: string) =>
		request<ApiEntity>(`/chapters/${chapterId}/git/commit`, {
			method: "POST",
			body: JSON.stringify({ message }),
		}),
	gitDiscard: (chapterId: string, body: { files?: string[]; all?: boolean }) =>
		request<ApiEntity>(`/chapters/${chapterId}/git/discard`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	getGitDiff: (chapterId: string, file: string, staged = false) =>
		request<ApiEntity>(
			`/chapters/${chapterId}/git/diff?file=${encodeURIComponent(file)}&staged=${staged}`,
		),
	getGitStashList: (chapterId: string) =>
		request<ApiEntity[]>(`/chapters/${chapterId}/git/stash/list`),
	gitStash: (chapterId: string, body: { action: string; message?: string; index?: number }) =>
		request<ApiEntity>(`/chapters/${chapterId}/git/stash`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	getGitLog: (chapterId: string, limit = 50, skip = 0) =>
		request<ApiEntity[]>(`/chapters/${chapterId}/git/log?limit=${limit}&skip=${skip}`),
	gitReset: (chapterId: string, target: string, mode: "soft" | "hard") =>
		request<ApiEntity>(`/chapters/${chapterId}/git/reset`, {
			method: "POST",
			body: JSON.stringify({ target, mode }),
		}),
	gitAiCommitMessage: (chapterId: string) =>
		request<{ message: string }>(`/chapters/${chapterId}/git/ai-commit-message`, {
			method: "POST",
		}),
};
