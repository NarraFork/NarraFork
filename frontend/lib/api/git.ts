import { request } from "./client";
import type { ApiEntity } from "./types";

export const gitApi = {
	getGitStatus: (chapterId: string) => request<ApiEntity>(`/chapters/${chapterId}/git/status`),
	getGitAttributions: (chapterId: string, file?: string) =>
		request<ApiEntity[]>(
			`/chapters/${chapterId}/git/attributions${file ? `?file=${encodeURIComponent(file)}` : ""}`,
		),
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
