import type {
	OutlineAnswerRequest,
	OutlineAnswerResponse,
	OutlineBacklinksResponse,
	OutlineBlockHistoryResponse,
	OutlineBlockViewResponse,
	OutlineDigestResponse,
	OutlineLockResponse,
	OutlinePageListResponse,
	OutlinePagePendingResponse,
	OutlinePendingDecisionResponse,
	OutlinePendingDetailResponse,
	OutlinePlanDecisionRequest,
	OutlinePlanDecisionResponse,
	OutlinePlanDiffResponse,
	OutlineQuestionGroupResponse,
	OutlineResolveResponse,
	OutlineRevertResponse,
	OutlineSearchResponse,
	OutlineSpaceDetailResponse,
	OutlineSpaceKind,
	OutlineSpaceListResponse,
	OutlineSpaceResolveResponse,
	OutlineTimelineResponse,
	OutlineViewMode,
	OutlineViewStatePutRequest,
	OutlineViewStateResponse,
} from "@shared/outline-api";
import type {
	OutlineDigestDetailResponse,
	OutlineDigestListResponse,
	OutlineDigestNowResponse,
	OutlineDigestUndoResponse,
} from "@shared/outline-digest";
import type {
	NarratorCurrentTaskResponse,
	OutlineBoardAddRequest,
	OutlineBoardAddResponse,
	OutlineBoardFinishedResponse,
	OutlineBoardOpenSessionRequest,
	OutlineBoardOpenSessionResponse,
	OutlineBoardSeenRequest,
	OutlineBoardSeenResponse,
	OutlineBoardTaskUpdateRequest,
	OutlineBoardTaskUpdateResponse,
	OutlineTaskBoardResponse,
} from "@shared/outline-task-board";
import { request } from "./client";

/** `?a=1&b=2` from the defined values, or "" when there are none. */
function query(params: Record<string, string | number | undefined | null>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

const enc = encodeURIComponent;

export const outlineApi = {
	listOutlineSpaces: (params: {
		kind?: OutlineSpaceKind;
		cursor?: string | null;
		limit?: number;
	}) => request<OutlineSpaceListResponse>(`/outline/spaces${query(params)}`),
	ensurePersonalOutlineSpace: () =>
		request<OutlineSpaceResolveResponse>("/outline/spaces/personal", { method: "POST" }),
	resolveProjectOutlineSpace: (projectId: string) =>
		request<OutlineSpaceResolveResponse>(`/outline/projects/${enc(projectId)}/space`, {
			method: "POST",
		}),
	resolveNarratorOutlineSpace: (narratorId: string) =>
		request<OutlineSpaceResolveResponse>(`/outline/narrators/${enc(narratorId)}/space`, {
			method: "POST",
		}),
	getOutlineSpace: (spaceId: string) =>
		request<OutlineSpaceDetailResponse>(`/outline/spaces/${enc(spaceId)}`),
	listOutlinePages: (spaceId: string, params: { cursor?: string | null; limit?: number }) =>
		request<OutlinePageListResponse>(`/outline/spaces/${enc(spaceId)}/pages${query(params)}`),
	getOutlineBlock: (
		spaceId: string,
		blockId: string,
		params: { asOf?: number; view?: OutlineViewMode; blocks?: number },
	) =>
		request<OutlineBlockViewResponse>(
			`/outline/spaces/${enc(spaceId)}/blocks/${enc(blockId)}${query(params)}`,
		),
	getOutlineBlockHistory: (
		spaceId: string,
		blockId: string,
		params: { before?: number | null; limit?: number },
	) =>
		request<OutlineBlockHistoryResponse>(
			`/outline/spaces/${enc(spaceId)}/blocks/${enc(blockId)}/history${query(params)}`,
		),
	getOutlineBacklinks: (spaceId: string, blockId: string) =>
		request<OutlineBacklinksResponse>(
			`/outline/spaces/${enc(spaceId)}/blocks/${enc(blockId)}/backlinks`,
		),
	getOutlinePageCommits: (
		spaceId: string,
		pageId: string,
		params: { before?: number | null; limit?: number },
	) =>
		request<OutlineTimelineResponse>(
			`/outline/spaces/${enc(spaceId)}/pages/${enc(pageId)}/commits${query(params)}`,
		),
	searchOutline: (params: { q: string; spaceId?: string; limit?: number }) =>
		request<OutlineSearchResponse>(`/outline/search${query(params)}`),
	/** Where a reference (`ref`, within `space` when bare) or a commit seq of `space` points. */
	resolveOutline: (params: { ref?: string; space?: string; commit?: number }) =>
		request<OutlineResolveResponse>(`/outline/resolve${query(params)}`),
	/** The caller's folding and mind-map direction of a page (defaults when never written). */
	getOutlineViewState: (pageId: string) =>
		request<OutlineViewStateResponse>(`/outline/view-state/${enc(pageId)}`),
	putOutlineViewState: (pageId: string, body: OutlineViewStatePutRequest) =>
		request<OutlineViewStateResponse>(`/outline/view-state/${enc(pageId)}`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	revertOutlineCommit: (commitId: string) =>
		request<OutlineRevertResponse>(`/outline/commits/${enc(commitId)}/revert`, {
			method: "POST",
		}),
	/** What waits for confirmation on a page, and its locked tasks. */
	getOutlinePagePending: (spaceId: string, pageId: string) =>
		request<OutlinePagePendingResponse>(
			`/outline/spaces/${enc(spaceId)}/pages/${enc(pageId)}/pending`,
		),
	/** A pending change block by block. */
	getOutlinePending: (pendingId: string) =>
		request<OutlinePendingDetailResponse>(`/outline/pending/${enc(pendingId)}`),
	confirmOutlinePending: (pendingId: string) =>
		request<OutlinePendingDecisionResponse>(`/outline/pending/${enc(pendingId)}/confirm`, {
			method: "POST",
		}),
	rejectOutlinePending: (pendingId: string, reason: string | null) =>
		request<OutlinePendingDecisionResponse>(`/outline/pending/${enc(pendingId)}/reject`, {
			method: "POST",
			body: JSON.stringify({ reason }),
		}),
	/** Lock a task's tree, naming the session that may confirm on the caller's behalf. */
	lockOutlineBlock: (spaceId: string, blockId: string, delegate: string | null) =>
		request<OutlineLockResponse>(`/outline/spaces/${enc(spaceId)}/blocks/${enc(blockId)}/lock`, {
			method: "POST",
			body: JSON.stringify({ delegate }),
		}),
	unlockOutlineBlock: (spaceId: string, blockId: string) =>
		request<OutlineLockResponse>(`/outline/spaces/${enc(spaceId)}/blocks/${enc(blockId)}/lock`, {
			method: "DELETE",
		}),
	/**
	 * A plan against the version it is compared with (`from`: a seq, 0 for nothing), without the
	 * plan reviews written since (the server finds them).
	 */
	getOutlinePlanDiff: (spaceId: string, blockId: string, from: number) =>
		request<OutlinePlanDiffResponse>(
			`/outline/spaces/${enc(spaceId)}/plans/${enc(blockId)}/diff?from=${from}`,
		),
	/** The caller's decision on a submitted plan (a waiting ExitPlanMode of an outline session). */
	decideOutlinePlan: (requestId: string, body: OutlinePlanDecisionRequest) =>
		request<OutlinePlanDecisionResponse>(`/narrators/permissions/${enc(requestId)}/plan`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	/** The questions under a block (or a question and its sub-questions). */
	getOutlineQuestions: (blockId: string) =>
		request<OutlineQuestionGroupResponse>(`/outline/blocks/${enc(blockId)}/questions`),
	/** Answer questions put to the caller, of one space, at once. */
	answerOutlineQuestions: (body: OutlineAnswerRequest) =>
		request<OutlineAnswerResponse>("/outline/questions/answer", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	/** What agents confirmed on the caller's behalf and they have not acknowledged. */
	getOutlineDigest: () => request<OutlineDigestResponse>("/outline/digest"),
	markOutlineDigestSeen: (pendingIds: string[]) =>
		request<{ marked: number }>("/outline/digest/seen", {
			method: "POST",
			body: JSON.stringify({ pendingIds }),
		}),
	/** Mark all the caller's unread reports read (P2 PR 11). */
	markOutlineReportsSeen: () =>
		request<{ marked: number }>("/outline/digests/seen", {
			method: "POST",
			body: JSON.stringify({ all: true }),
		}),
	/** The caller's daily reports, latest day first (heads only), and the current preview. */
	listOutlineReports: (params: { before?: string | null; limit?: number }) =>
		request<OutlineDigestListResponse>(`/outline/digests${query(params)}`),
	/** One report as the caller may see it now. */
	getOutlineReport: (id: string) =>
		request<OutlineDigestDetailResponse>(`/outline/digests/${enc(id)}`),
	/** Mark these reports read. */
	markOutlineReportRead: (ids: string[]) =>
		request<{ marked: number }>("/outline/digests/seen", {
			method: "POST",
			body: JSON.stringify({ ids }),
		}),
	/** Ask for "today so far" (made in the background; answers at once). */
	requestOutlineReportNow: () =>
		request<OutlineDigestNowResponse>("/outline/digests/now", { method: "POST" }),
	/** Take back a decision made in the caller's name, by reverting its commit. */
	undoOutlineDecision: (commitId: string) =>
		request<OutlineDigestUndoResponse>("/outline/digests/undo", {
			method: "POST",
			body: JSON.stringify({ commitId }),
		}),
	/** A session's task board (its dock tab). */
	getSessionTaskBoard: (narratorId: string) =>
		request<OutlineTaskBoardResponse>(`/outline/narrators/${enc(narratorId)}/tasks`),
	/** A project's task board, a page of spaces at a time. */
	getProjectTaskBoard: (projectId: string, cursor: string | null) =>
		request<OutlineTaskBoardResponse>(
			`/outline/projects/${enc(projectId)}/tasks${query({ cursor })}`,
		),
	/** A space's next finished tasks. */
	getFinishedTasks: (spaceId: string, cursor: string) =>
		request<OutlineBoardFinishedResponse>(
			`/outline/spaces/${enc(spaceId)}/tasks/finished${query({ cursor })}`,
		),
	/** A person adds a task to a session. */
	addBoardTask: (narratorId: string, body: OutlineBoardAddRequest) =>
		request<OutlineBoardAddResponse>(`/outline/narrators/${enc(narratorId)}/tasks`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	/** A person changes one task on the board. */
	updateBoardTask: (blockId: string, body: OutlineBoardTaskUpdateRequest) =>
		request<OutlineBoardTaskUpdateResponse>(`/outline/tasks/${enc(blockId)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	/** Open a new session for a project task and start it on the task (outline P2 PR 10c-1). */
	openTaskSession: (blockId: string, body: OutlineBoardOpenSessionRequest) =>
		request<OutlineBoardOpenSessionResponse>(`/outline/tasks/${enc(blockId)}/open-session`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	/**
	 * The person saw these tasks marked 「新完成」 on a board (outline P2 PR 9b); `keepalive` when
	 * the page is going away.
	 */
	markBoardTasksSeen: (body: OutlineBoardSeenRequest, options: { keepalive?: boolean } = {}) =>
		request<OutlineBoardSeenResponse>("/outline/tasks/seen", {
			method: "POST",
			body: JSON.stringify(body),
			...(options.keepalive ? { keepalive: true } : {}),
		}),
	/** The status bar's current task, from the session's task source (either backend). */
	getNarratorCurrentTask: (narratorId: string) =>
		request<NarratorCurrentTaskResponse>(`/narrators/${enc(narratorId)}/tasks/current`),
};
