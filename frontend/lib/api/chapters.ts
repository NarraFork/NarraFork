import { request } from "./client";
import type { ApiEntity } from "./types";

export interface ChapterSplitResult {
	prefixChapter: ApiEntity;
	continuationChapter: ApiEntity;
	newForkChapter: ApiEntity;
	commitSha: string;
	warnings?: string[];
	fallbacks?: Array<Record<string, unknown>>;
}

export const chaptersApi = {
	listChapters: (projectId: string, status?: string) =>
		request<ApiEntity[]>(`/chapters?projectId=${projectId}${status ? `&status=${status}` : ""}`),
	getChapter: (id: string) => request<ApiEntity>(`/chapters/${id}`),
	createChapter: (data: Record<string, unknown>) =>
		request<ApiEntity>("/chapters", { method: "POST", body: JSON.stringify(data) }),
	updateChapter: (id: string, data: Record<string, unknown>) =>
		request<ApiEntity>(`/chapters/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteChapter: (id: string) => request<ApiEntity>(`/chapters/${id}`, { method: "DELETE" }),

	// Chapter operations (fork/merge/cleanup)
	forkChapter: (
		id: string,
		data: {
			title?: string;
			description?: string;
			inheritMode?: string;
			/** Fork point by SDK message uuid (assistant messages only). */
			forkAtMessageUuid?: string;
			/** Fork point by local narrator message id (any role) — preferred for UI forks. */
			forkAtMessageId?: string;
			/** Explicit commit SHA to fork from (ruler mode). Overrides the fork point. */
			startCommitSha?: string;
			/** Explicit parent chapter ID (ruler mode). Defaults to root chapter. */
			parentChapterId?: string;
			role?: string;
			anchorCommitSha?: string;
			axisOffset?: number;
			crossOffset?: number;
		},
	) =>
		request<ApiEntity>(`/chapters/${id}/fork`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	checkMergeConflicts: (id: string, targetChapterId: string) =>
		request<ApiEntity>(`/chapters/${id}/merge-check?targetChapterId=${targetChapterId}`),
	mergeChapter: (
		id: string,
		data: {
			targetChapterId: string;
			strategy?: string;
			message?: string;
			/**
			 * Which space the merge happens in. Omitted means the server decides, which
			 * prefers `snapshot`: the workspaces are merged as they stand and the user's
			 * git history is untouched. `commit` asks for a real merge commit and brings
			 * back the clean-worktree requirement (MERGE_DIRTY_SOURCE/TARGET).
			 */
			mode?: "snapshot" | "commit";
		},
	) =>
		request<ApiEntity>(`/chapters/${id}/merge`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	cleanupChapters: (data: { chapterIds: string[]; force?: boolean; deleteBranch?: boolean }) =>
		request<ApiEntity>("/chapters/cleanup", { method: "POST", body: JSON.stringify(data) }),
	batchMerge: (data: {
		baseChapterId: string;
		sourceChapterIds: string[];
		title?: string;
		strategy?: string;
		targetChapterId?: string;
	}) =>
		request<ApiEntity>("/chapters/batch-merge", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	dormantChapter: (id: string) => request<ApiEntity>(`/chapters/${id}/dormant`, { method: "POST" }),
	wakeChapter: (id: string) => request<ApiEntity>(`/chapters/${id}/wake`, { method: "POST" }),
	unmergeChapter: (id: string) => request<ApiEntity>(`/chapters/${id}/unmerge`, { method: "POST" }),

	// Chapter commits
	getChapterCommits: (id: string, params?: { limit?: number; since?: string }) => {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set("limit", String(params.limit));
		if (params?.since) searchParams.set("since", params.since);
		const qs = searchParams.toString();
		return request<
			Array<{
				id: string;
				sha: string;
				message: string;
				authorName: string | null;
				authorEmail: string | null;
				authoredAt: string;
				source: "manual" | "auto" | "merge" | "cherry_pick" | "initial";
				narratorId: string | null;
				narratorMessageId: string | null;
				filesChanged: number | null;
				linesAdded: number | null;
				linesRemoved: number | null;
			}>
		>(`/chapters/${id}/commits${qs ? `?${qs}` : ""}`);
	},
	getChapterCommit: (chapterId: string, sha: string) =>
		request<{
			id: string;
			sha: string;
			message: string;
			fullMessage: string | null;
			authorName: string | null;
			authorEmail: string | null;
			authoredAt: string;
			source: "manual" | "auto" | "merge" | "cherry_pick" | "initial";
			narratorId: string | null;
			narratorMessageId: string | null;
			filesChanged: number | null;
			linesAdded: number | null;
			linesRemoved: number | null;
			files: Array<{
				path: string;
				oldPath?: string;
				status: string;
				linesAdded: number;
				linesRemoved: number;
				diff?: string;
			}>;
			diffInlined: boolean;
		}>(`/chapters/${chapterId}/commits/${sha}`),
	getCommitFileDiff: (chapterId: string, sha: string, filePath: string) =>
		request<{ diff: string; truncated: boolean }>(
			`/chapters/${chapterId}/commits/${sha}/files/${filePath}`,
		),

	// Chapter git status
	getChapterGitStatus: (id: string) =>
		request<{
			commitsAhead: number;
			baseBranch: string;
			linesAdded: number;
			linesRemoved: number;
		}>(`/chapters/${id}/git-status`),

	// Chapter split
	splitChapter: (
		id: string,
		data: {
			commitSha: string;
			newFork: { title: string; description?: string; inheritMode?: string };
		},
	) =>
		request<ChapterSplitResult>(`/chapters/${id}/split`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// Batch fork
	batchForkChapter: (
		id: string,
		data: {
			forks: Array<{
				title: string;
				description?: string;
				inheritMode?: string;
				role?: string;
			}>;
		},
	) =>
		request<{ created: ApiEntity[]; failed: Array<{ input: unknown; error: string }> }>(
			`/chapters/${id}/batch-fork`,
			{ method: "POST", body: JSON.stringify(data) },
		),

	// Cherry-pick
	cherryPickChapter: (id: string, data: { sourceChapterId: string; commitShas: string[] }) =>
		request<ApiEntity>(`/chapters/${id}/cherry-pick`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// Dependency status
	getDependencyStatus: (id: string) =>
		request<
			Array<{
				edgeId: string;
				sourceChapterId: string;
				hasUpdates: boolean;
				newCommitCount: number;
			}>
		>(`/chapters/${id}/dependency-status`),

	// Sync upstream
	syncUpstream: (id: string, data: { edgeId: string; strategy: "rebase" | "merge" }) =>
		request<ApiEntity>(`/chapters/${id}/sync-upstream`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// Chapter edges
	listChapterEdges: (params: { projectId?: string; chapterId?: string; type?: string }) => {
		const searchParams = new URLSearchParams();
		if (params.projectId) searchParams.set("projectId", params.projectId);
		if (params.chapterId) searchParams.set("chapterId", params.chapterId);
		if (params.type) searchParams.set("type", params.type);
		return request<ApiEntity[]>(`/chapter-edges?${searchParams}`);
	},
	createChapterEdge: (data: {
		sourceId: string;
		targetId: string;
		type: string;
		metadata?: Record<string, unknown>;
	}) => request<ApiEntity>("/chapter-edges", { method: "POST", body: JSON.stringify(data) }),
	deleteChapterEdge: (id: string) =>
		request<{ ok: boolean }>(`/chapter-edges/${id}`, { method: "DELETE" }),

	// Exploration groups
	listExplorationGroups: (projectId: string) =>
		request<ApiEntity[]>(`/exploration-groups?projectId=${projectId}`),
	getExplorationGroup: (id: string) => request<ApiEntity>(`/exploration-groups/${id}`),
	createExplorationGroup: (data: {
		projectId: string;
		title: string;
		description?: string;
		baseChapterId: string;
		branches: Array<{ title: string; description?: string; inheritMode?: string }>;
	}) =>
		request<ApiEntity>("/exploration-groups", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateExplorationGroup: (id: string, data: { title?: string; description?: string }) =>
		request<ApiEntity>(`/exploration-groups/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	decideExplorationGroup: (id: string, chapterId: string) =>
		request<ApiEntity>(`/exploration-groups/${id}/decide`, {
			method: "POST",
			body: JSON.stringify({ chapterId }),
		}),
	abandonExplorationGroup: (id: string) =>
		request<ApiEntity>(`/exploration-groups/${id}/abandon`, { method: "POST" }),

	// Reviews
	createReview: (
		chapterId: string,
		data: {
			title?: string;
			locale?: string;
			anchorCommitSha?: string;
			axisOffset?: number;
			crossOffset?: number;
		},
	) =>
		request<ApiEntity>(`/chapters/${chapterId}/review`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	convertReviewToSubagent: (reviewId: string) =>
		request<ApiEntity>(`/reviews/${reviewId}/convert-to-subagent`, { method: "POST" }),
	promoteReview: (reviewId: string) =>
		request<ApiEntity>(`/reviews/${reviewId}/promote`, { method: "POST" }),
	dismissReview: (reviewId: string) =>
		request<ApiEntity>(`/reviews/${reviewId}/dismiss`, { method: "POST" }),
	getReviewConclusionForSource: (sourceChapterId: string) =>
		request<{
			conclusion: {
				id: string;
				verdict: "approve" | "request_changes" | "comment_only";
				findingsJson: Array<{
					severity: string;
					file?: string;
					line?: number;
					message: string;
				}> | null;
				createdAt: string;
			} | null;
		}>(`/reviews/by-source/${sourceChapterId}/conclusion`),

	// Containers
	getContainerSetup: (refresh?: boolean) =>
		request<{
			podman: { ok: boolean; version?: string };
			podmanCompose: { ok: boolean; version?: string };
			composeProvider: { ok: boolean; provider?: string };
			passt: { ok: boolean; version?: string };
			rootlessNetwork: { ok: boolean; backend?: string };
			allReady: boolean;
			supported?: boolean;
			fallback?: boolean;
			reason?: string;
			error?: string;
			message?: string;
			code?: string;
		}>(`/chapters/container-setup${refresh ? "?refresh=true" : ""}`),
	getPodmanStatus: () =>
		request<{
			installed: boolean;
			version?: string;
			platform: string;
			supported: boolean;
			fallback?: boolean;
			reason?: string;
			error?: string;
			message?: string;
			code?: string;
		}>("/chapters/podman/status"),
	installPodman: () =>
		request<{ ok: boolean; installed?: boolean; version?: string; code?: string; error?: string }>(
			"/chapters/podman/install",
			{ method: "POST" },
		),
	getComposeInfo: (chapterId: string) =>
		request<{
			services: Array<{
				name: string;
				ports: Array<{ host: number; container: number }>;
				environment: Record<string, string>;
				image?: string;
			}>;
		}>(`/chapters/${chapterId}/compose-info`),
	getContainers: (chapterId: string) => request<ApiEntity[]>(`/chapters/${chapterId}/containers`),
	startContainers: (chapterId: string) =>
		request<ApiEntity>(`/chapters/${chapterId}/containers/start`, { method: "POST" }),
	stopContainers: (chapterId: string) =>
		request<ApiEntity>(`/chapters/${chapterId}/containers/stop`, { method: "POST" }),
	pauseContainers: (chapterId: string) =>
		request<ApiEntity>(`/chapters/${chapterId}/containers/pause`, { method: "POST" }),
	unpauseContainers: (chapterId: string) =>
		request<ApiEntity>(`/chapters/${chapterId}/containers/unpause`, { method: "POST" }),
	getContainerLogs: (chapterId: string, opts?: { tail?: number; service?: string }) => {
		const params = new URLSearchParams();
		if (opts?.tail) params.set("tail", String(opts.tail));
		if (opts?.service) params.set("service", opts.service);
		const qs = params.toString();
		return request<{ logs: string }>(`/chapters/${chapterId}/containers/logs${qs ? `?${qs}` : ""}`);
	},
	removeContainers: (chapterId: string, opts?: { deleteVolumes?: boolean }) =>
		request<ApiEntity>(`/chapters/${chapterId}/containers/remove`, {
			method: "POST",
			body: JSON.stringify(opts ?? {}),
		}),
};
