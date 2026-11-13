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
	OutlineReportAuthorsResponse,
	OutlineResolveResponse,
	OutlineRevertResponse,
	OutlineSearchResponse,
	OutlineSpaceDetailResponse,
	OutlineSpaceKind,
	OutlineSpaceListResponse,
	OutlineSpaceResolveResponse,
	OutlineTimelineResponse,
	OutlineTreeResponse,
	OutlineTreeSpacesResponse,
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
	OutlineSpecImportAdminPage,
	OutlineSpecImportAdminState,
	OutlineSpecImportRevertResult,
	OutlineSpecImportStatus,
	OutlineSpecLossAction,
	OutlineSpecLossDetail,
	OutlineSpecLossFinding,
	OutlineSpecLossPage,
	OutlineSpecLossScanStatus,
	OutlineSpecLossStatus,
} from "@shared/outline-spec-import";
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
	OutlineBoardTransferSessionsResponse,
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

/** Where the swallowed-content findings are read: a session's, or the admin page's (all). */
const specLossBase = (narratorId: string | null) =>
	narratorId
		? `/outline/narrators/${enc(narratorId)}/spec-import/loss`
		: "/admin/outline/spec-import/loss";

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
	/** The connected outline's root: my space, a page of project spaces, the groups' counts. */
	getOutlineTree: (params: { cursor?: string | null }) =>
		request<OutlineTreeResponse>(`/outline/tree${query(params)}`),
	/** A page of a project's sessions, or of a group's spaces, in the connected outline. */
	listOutlineTreeSpaces: (
		group: { kind: "project"; projectId: string } | { kind: "loose" | "orphaned" },
		params: { cursor?: string | null },
	) =>
		request<OutlineTreeSpacesResponse>(
			group.kind === "project"
				? `/outline/tree/projects/${enc(group.projectId)}/sessions${query(params)}`
				: `/outline/tree/${group.kind}${query(params)}`,
		),
	listOutlinePages: (spaceId: string, params: { cursor?: string | null; limit?: number }) =>
		request<OutlinePageListResponse>(`/outline/spaces/${enc(spaceId)}/pages${query(params)}`),
	getOutlineBlock: (
		spaceId: string,
		blockId: string,
		params: { asOf?: number; view?: OutlineViewMode; blocks?: number; bytes?: number },
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
	/** Who wrote the subagent reports with these container ids (the names the caller may see). */
	getOutlineReportAuthors: (spaceId: string, ids: readonly string[]) =>
		request<OutlineReportAuthorsResponse>(
			`/outline/spaces/${enc(spaceId)}/report-authors${query({ ids: ids.join(",") })}`,
		),
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
	/** Whether a session's Dynamic Spec is to be imported into the outline, and how that went. */
	getSpecImportStatus: (narratorId: string) =>
		request<OutlineSpecImportStatus>(`/outline/narrators/${enc(narratorId)}/spec-import`),
	/** Start the import of a session's Dynamic Spec now. */
	startSpecImport: (narratorId: string) =>
		request<OutlineSpecImportStatus>(`/outline/narrators/${enc(narratorId)}/spec-import`, {
			method: "POST",
		}),
	/** The import's admin page (administrators): one state's sessions, a page at a time. */
	getSpecImportAdminPage: (query: {
		state: OutlineSpecImportAdminState;
		cursor?: string | null;
		limit?: number;
	}) => {
		const params = new URLSearchParams({ state: query.state });
		if (query.cursor) params.set("cursor", query.cursor);
		if (query.limit) params.set("limit", String(query.limit));
		return request<OutlineSpecImportAdminPage>(`/admin/outline/spec-import?${params.toString()}`);
	},
	/** An administrator imports a session again (attention and failed attempts cleared). */
	reimportSpecSession: (narratorId: string) =>
		request<OutlineSpecImportStatus>(`/admin/outline/spec-import/${enc(narratorId)}/reimport`, {
			method: "POST",
		}),
	/** An administrator moves a session the import moved back to Dynamic Spec. */
	revertSpecImport: (narratorId: string) =>
		request<OutlineSpecImportRevertResult>(`/admin/outline/spec-import/${enc(narratorId)}/revert`, {
			method: "POST",
		}),
	/**
	 * Content the old Spec panel may have swallowed (outline P2 PR 12c): one status's findings, a
	 * page at a time. Of one session with `narratorId`; of every session without (administrators).
	 */
	getSpecLossPage: (
		narratorId: string | null,
		query: { status: OutlineSpecLossStatus; cursor?: string | null; limit?: number },
	) => {
		const params = new URLSearchParams({ status: query.status });
		if (query.cursor) params.set("cursor", query.cursor);
		if (query.limit) params.set("limit", String(query.limit));
		return request<OutlineSpecLossPage>(`${specLossBase(narratorId)}?${params.toString()}`);
	},
	/** One finding with the lost text. */
	getSpecLossDetail: (narratorId: string | null, findingId: string) =>
		request<OutlineSpecLossDetail>(`${specLossBase(narratorId)}/${enc(findingId)}`),
	/**
	 * A person's decision about one finding: attach to the imported page, dismiss, reopen.
	 * `confirmRule`: with an attach of a finding of the behavior fence, the person confirmed that
	 * the agent will read the content as a rule (the server refuses the attach without it).
	 */
	decideSpecLoss: (
		narratorId: string | null,
		findingId: string,
		action: OutlineSpecLossAction,
		options: { confirmRule?: boolean } = {},
	) =>
		request<OutlineSpecLossFinding>(`${specLossBase(narratorId)}/${enc(findingId)}`, {
			method: "POST",
			body: JSON.stringify({ action, ...(options.confirmRule ? { confirmRule: true } : {}) }),
		}),
	/** An administrator starts a scan pass (answered at once; it runs in the background). */
	startSpecLossScan: () =>
		request<OutlineSpecLossScanStatus>("/admin/outline/spec-import/loss-scan", {
			method: "POST",
		}),
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
	/** The sessions a task may be handed to on the board (「转交给会话…」). */
	getTransferSessions: (blockId: string) =>
		request<OutlineBoardTransferSessionsResponse>(
			`/outline/tasks/${enc(blockId)}/transfer-sessions`,
		),
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
