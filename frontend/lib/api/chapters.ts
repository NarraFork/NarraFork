import type { ForkWorktreeSource } from "@shared/chapter-fork";
import { request } from "./client";
import type { ApiEntity } from "./types";

export interface ForkChapterRequest {
	title?: string;
	description?: string;
	inheritMode?: "fresh" | "compressed" | "full";
	worktreeSource?: ForkWorktreeSource;
	/** Fork point by SDK message uuid (assistant messages only). */
	forkAtMessageUuid?: string;
	/** Fork point by local narrator message id (any role) — preferred for UI forks. */
	forkAtMessageId?: string;
	/** Explicit commit SHA to fork from. Only valid with commit worktree source. */
	startCommitSha?: string;
	/** Explicit parent chapter ID (ruler mode). Defaults to root chapter. */
	parentChapterId?: string;
	role?: string;
	anchorCommitSha?: string;
	axisOffset?: number;
	crossOffset?: number;
}

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
	forkChapter: (id: string, data: ForkChapterRequest) =>
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

	// Chapter commits: the `getChapterCommits` / `getChapterCommit` / `getCommitFileDiff`
	// clients lived here and served `CommitList` + `CommitDetailModal`, both of which had
	// lost their last importer and have been deleted. The routes they named still exist
	// (`GET /chapters/:id/commits`, `/commits/:sha`, `/commits/:sha/files/*`); the live
	// commit UI is `GitCommitsTab`, which reads git directly via `useGitLog`. Re-add a
	// client here when something needs the persisted `chapter_commits` rows again.

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

	// Batch fork: not implemented.
	//
	// `batchForkChapter` used to live here, targeting `POST /chapters/:id/batch-fork`.
	// No route was ever mounted and nothing called it. Removed for the same reason as
	// the exploration-group clients below: a typed client for a route that answers 404
	// reads as a working feature to anyone writing UI against it.
	//
	// The `batchFork` string in NarratorPanel is unrelated — it forks a narrator from
	// several selected messages, and goes through `forkChapter`.

	// `cherryPickChapter` is gone for the same reason: `POST /chapters/:id/cherry-pick`
	// does not exist. Cherry-pick as a *merge strategy* does work and goes through
	// `mergeChapter` with `strategy: "cherry-pick"`.

	// Dependency edges: removed. `getDependencyStatus` and `syncUpstream` named
	// `/chapters/:id/dependency-status` and `/chapters/:id/sync-upstream`, neither of which
	// was ever routed, and both had zero callers. The `dependency` edge type they belonged
	// to is gone too — see `server/services/chapter-edge-service.ts`.
	//
	// `createChapterEdge`/`deleteChapterEdge` are gone with it: fork, merge and review edges
	// are all created by the operation that owns them, so `/api/chapter-edges` is read-only.
	// `listChapterEdges` went as well — the graph gets its edges from `GET /projects/:id/graph`
	// and nothing else queried it.

	// Exploration groups: not implemented.
	//
	// Six client functions used to live here, targeting `/api/exploration-groups/*`.
	// No route was ever mounted, and nothing in the app called them — no hook, no
	// component, not even a translation lookup. They have been removed rather than
	// left in place, because a typed client for a route that answers 404 reads as a
	// working feature to anyone writing UI against it.
	//
	// What remains on the server is deliberate and harmless: the `exploration_groups`
	// table, its validators, its project-database sync, and the `exploration:*` event
	// types. Reviving the feature means adding a service plus routes, then a client
	// again — see the notes in DESIGN.md.

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
