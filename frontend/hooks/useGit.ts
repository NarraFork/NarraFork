import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { CurrentDiffView } from "../../server/services/git-current-diff-view";
import type {
	FileChangeActorKind,
	FileChangeAttributionGrade,
	FileChangeProjectionCompleteness,
} from "../../shared/file-change-protocol";
import {
	GIT_COMMIT_PREVIEW_UNSUPPORTED,
	type GitCommitDetail,
	type GitCommitPatch,
} from "../../shared/git-commit-preview";
import type { GitWorkspaceSummary } from "../../shared/git-workspace";
import { type ApiError, api } from "../lib/api";
import {
	type GitLogEntry,
	type GitTarget,
	type GitWorkspace,
	gitBasePath,
	gitTargetKey,
} from "../lib/api/git";
import { GitWorkspaceSubscriptions } from "../lib/git-workspace-subscription";
import { type ListenerHandle, narratorWSManager } from "../lib/narrator-ws-manager";
import { observePageLifecycle } from "../lib/page-lifecycle";
import { useNarrator } from "./useNarrator";
import { useWorkspaceContext } from "./useWorkspaceContext";

export type {
	CurrentDiffFile,
	CurrentDiffTarget,
	CurrentDiffView,
} from "../../server/services/git-current-diff-view";
export type { GitLogEntry, GitTarget, GitWorkspace } from "../lib/api/git";

// Types
export interface GitStatusSummary {
	/** The executor reached its output budget; counts may be lower bounds. */
	truncated?: boolean;
	hasChanges: boolean;
	staged: number;
	unstaged: number;
	untracked: number;
	files: Array<{
		/** Two-character porcelain status, e.g. "M ", " M", "MM", "??". */
		status: string;
		path: string;
		linesAdded: number;
		linesRemoved: number;
		stagedLinesAdded: number;
		stagedLinesRemoved: number;
		unstagedLinesAdded: number;
		unstagedLinesRemoved: number;
	}>;
	/** Total changed files (may exceed files.length when capped server-side). */
	totalFiles: number;
	headSha: string;
	branch: string;
	linesAdded: number;
	linesRemoved: number;
}

export interface GitStashEntry {
	index: number;
	message: string;
	date: string;
}

export type AttributionAction = "write" | "edit" | "bash" | "external" | "human";

/** Observed subject, not an owner of the current net diff. */
export interface AttributionActor {
	/** v1 may lose narrator subtype information together with its FK. */
	kind: FileChangeActorKind | "narrator_unknown";
	narratorId: string | null;
	userId: string | null;
	title: string | null;
	subagentType: string | null;
	parentTitle: string | null;
	exists: boolean;
	/** Null means v1 cannot distinguish missing identity from deletion. */
	deleted: boolean | null;
	identityKnown: boolean;
	subjectKey?: string;
}

export interface ModificationEventSummary {
	id: string;
	changedAt: string;
	action: AttributionAction;
	actor: AttributionActor;
	evidence: "legacy" | "v2";
	/** NULL means unmeasured, never zero. */
	linesAdded?: number | null;
	linesRemoved?: number | null;
}

export interface FileModificationGroup {
	filePath: string;
	changeCount: number;
	lastChangedAt: string;
	/** Actor and action of the same latest observed event, never guessed from group flags. */
	lastActor: AttributionActor;
	lastAction: AttributionAction;
	/** Known subjects and anonymous buckets seen in the returned row window. */
	actors: AttributionActor[];
	/** Bounded newest-first history for the status-badge hover card. */
	recentEvents: ModificationEventSummary[];
	/** False requires a complete scan; null means absence is unverified. */
	hasExternalChange: boolean | null;
	hasImpreciseAttribution: boolean | null;
	hasDeletedActor: boolean | null;
	completeness: FileChangeProjectionCompleteness;
	evidence: "legacy" | "v2" | "mixed";
	attributionGrade: FileChangeAttributionGrade;
}

export interface WorkspaceModificationView {
	source?: "history";
	currentDiff?: CurrentDiffView;
	/** Historical page position only; rowId is not a business ID or execution order. */
	nextCursor?: { changedAt: string; rowId: string } | null;
	workspacePath: string;
	deviceId: string;
	byFile: FileModificationGroup[];
	hasMore: boolean;
	actors: AttributionActor[];
	/** Post-filter observed rows, independent of whether the query was truncated. */
	windowCount?: number;
	completeness: FileChangeProjectionCompleteness;
	evidence: "legacy" | "v2" | "mixed";
	baselineStatus: "unverified";
}

// Workspace facts share a cache across narrators, never across devices/worktrees.
const GIT_QUERY_GC_TIME_MS = 60_000;
const GIT_WORKSPACE_RECOVERY_INTERVAL_MS = 30_000;
export const GIT_FACT_QUERIES = [
	"gitStatus",
	"gitModifications",
	"gitDiff",
	"gitLog",
	"gitStashList",
	"gitCommitDetail",
	"gitCommitDiff",
];

/**
 * Live facts invalidated by a WS `git_status` push. Derived from
 * GIT_FACT_QUERIES so a new live fact cannot drift out of the push path;
 * commit previews are immutable and excluded.
 */
export const GIT_LIVE_FACT_QUERIES = GIT_FACT_QUERIES.filter(
	(prefix) => prefix !== "gitCommitDetail" && prefix !== "gitCommitDiff",
);

export function gitWorkspaceTarget(narratorId: string, workspace?: GitWorkspace): GitTarget | null {
	if (workspace?.state !== "ready" || !workspace.capabilities.read || !workspace.workspaceKey)
		return null;
	return {
		narratorId,
		workspaceKey: workspace.workspaceKey,
		repositoryKey: workspace.repositoryKey,
		canWrite: workspace.capabilities.write,
		rootPath: workspace.rootPath,
		chapterId: workspace.chapterId,
	};
}

const gitWorkspaceSubscriptions = new WeakMap<QueryClient, GitWorkspaceSubscriptions>();

/** The panel owns the subscription, not individual status/diff observers. */
export function useGitWorkspaceSubscription(target: GitTarget) {
	const qc = useQueryClient();
	const chapterId = typeof target === "string" ? target : undefined;
	const narratorId = typeof target === "string" ? undefined : target.narratorId;
	const workspaceKey = gitTargetKey(target);
	useEffect(() => {
		let subscriptions = gitWorkspaceSubscriptions.get(qc);
		if (!subscriptions) {
			subscriptions = new GitWorkspaceSubscriptions(qc, narratorWSManager);
			gitWorkspaceSubscriptions.set(qc, subscriptions);
		}
		return subscriptions.subscribe(
			chapterId ?? {
				narratorId: narratorId as string,
				workspaceKey: workspaceKey as string,
				canWrite: false,
			},
		);
	}, [qc, chapterId, narratorId, workspaceKey]);
}

// One permission subscription per QueryClient, shared by all mounted workspace consumers.
const deniedGitSummaries = new WeakMap<QueryClient, Set<string>>();
// Query.reset restores its original initialData snapshot. Mark presentation seeds
// so a reset cannot mistake that old snapshot for a new authoritative response.
const gitSummarySeeds = new WeakSet<GitWorkspace>();
function blockGitSummary(qc: QueryClient, narratorId: string) {
	let denied = deniedGitSummaries.get(qc);
	if (!denied) {
		denied = new Set();
		deniedGitSummaries.set(qc, denied);
	}
	denied.add(narratorId);
	void qc.cancelQueries({ queryKey: ["narrators", narratorId], exact: true });
	qc.setQueryData<Record<string, unknown>>(["narrators", narratorId], (detail) =>
		detail ? { ...detail, gitSummary: null } : detail,
	);
}
const gitAccessSubscriptions = new WeakMap<
	QueryClient,
	{ count: number; handle: ListenerHandle }
>();
function subscribeGitAccess(qc: QueryClient) {
	let entry = gitAccessSubscriptions.get(qc);
	if (!entry) {
		const handle = narratorWSManager.addListener(
			{ narratorIds: "*", types: ["narrator_access_changed"] },
			() => {
				// Cancel in-flight detail reads before clearing presentation-only summaries.
				// A late response must not revive private facts after access changed.
				const details = {
					predicate: (q: { queryKey: readonly unknown[] }) =>
						q.queryKey[0] === "narrators" &&
						q.queryKey.length === 2 &&
						typeof q.queryKey[1] === "string",
				};
				void qc.cancelQueries(details);
				qc.setQueriesData<Record<string, unknown>>(details, (detail) =>
					detail ? { ...detail, gitSummary: null } : detail,
				);
				void qc.invalidateQueries(details);
				qc.resetQueries({ queryKey: ["gitWorkspace"] });
				qc.removeQueries({ predicate: (q) => GIT_FACT_QUERIES.includes(String(q.queryKey[0])) });
			},
		);
		entry = { count: 0, handle };
		gitAccessSubscriptions.set(qc, entry);
	}
	entry.count++;
	return () => {
		if (--entry.count === 0) {
			narratorWSManager.removeListener(entry.handle);
			gitAccessSubscriptions.delete(qc);
		}
	};
}

async function readWorkspace<T>(
	qc: QueryClient,
	target: GitTarget | null | undefined,
	read: () => Promise<T>,
): Promise<T> {
	try {
		return await read();
	} catch (error) {
		const failure = error as ApiError;
		// An older executor missing preview operations is not a workspace change.
		// Re-probing here would unmount/reopen its consumer and repeat the same 409.
		const unsupportedPreview =
			failure?.status === 409 && failure.data?.code === GIT_COMMIT_PREVIEW_UNSUPPORTED;
		if (
			target &&
			typeof target !== "string" &&
			!unsupportedPreview &&
			[401, 403, 409, 503].includes(failure?.status)
		) {
			if ([401, 403].includes(failure.status)) blockGitSummary(qc, target.narratorId);
			void qc.cancelQueries({ queryKey: ["narrators", target.narratorId], exact: true });
			qc.setQueryData<Record<string, unknown>>(["narrators", target.narratorId], (detail) =>
				detail ? { ...detail, gitSummary: null } : detail,
			);
			qc.resetQueries({ queryKey: ["gitWorkspace", target.narratorId] });
		}
		throw error;
	}
}

/** Detail summaries are presentation hints only, never authorization for a Git API. */
export function gitSummaryWorkspace(
	narrator: Record<string, unknown> | undefined,
	contextRevision: number,
): GitWorkspace | undefined {
	const summary = narrator?.gitSummary as GitWorkspaceSummary | null | undefined;
	if (!summary || summary.revision !== contextRevision) return undefined;
	// cwd may be a host path while the executor uses its own defaultCwd, or a
	// symlink resolved by the probe. Directory switches must advance the revision;
	// comparing these differently normalized paths would reject valid summaries.
	if (narrator?.defaultDeviceId && narrator.defaultDeviceId !== summary.workspace.deviceId)
		return undefined;
	return { ...summary.workspace, branch: summary.workspace.branch ?? summary.branch };
}

/** A monotonic revision does not change when execution context first hydrates. */
export function useGitWorkspace(narratorId: string | null | undefined, revision?: unknown) {
	const qc = useQueryClient();
	const {
		data: narrator,
		dataUpdatedAt: narratorUpdatedAt,
		isError: narratorError,
	} = useNarrator(narratorId ?? "");
	const { data: executionContext } = useWorkspaceContext(narratorId ?? "");
	useEffect(() => (narratorId ? subscribeGitAccess(qc) : undefined), [qc, narratorId]);
	const workspaceRevision = Math.max(
		typeof narrator?.workspaceRevision === "number" ? narrator.workspaceRevision : 0,
		executionContext?.revision ?? 0,
	);
	// Directory/device switches advance this revision. Late hydration of optional
	// narrator metadata must not replace an already authorized workspace query.
	const context = revision ?? workspaceRevision;
	const summaryWorkspace = gitSummaryWorkspace(narrator, workspaceRevision);
	const query = useQuery({
		queryKey: ["gitWorkspace", narratorId, context],
		queryFn: ({ signal }) => api.getGitWorkspace(narratorId as string, signal),
		initialData: () => {
			if (!narratorId || deniedGitSummaries.get(qc)?.has(narratorId)) return undefined;
			// resetQueries may call this again: re-read the source rather than capture
			// a summary which an access event has since removed from the detail cache.
			const detail =
				qc.getQueryData<Record<string, unknown>>(["narrators", narratorId]) ?? narrator;
			const seed = gitSummaryWorkspace(detail, workspaceRevision);
			if (seed) gitSummarySeeds.add(seed);
			return seed;
		},
		initialDataUpdatedAt: narratorUpdatedAt || Date.now(),
		// Keep presentation seeds distinguishable from authoritative responses even
		// when a successful probe returns exactly the same small facts object.
		structuralSharing: false,
		// Detail discovery already probes Git. Do not race it with a duplicate cold
		// request; legacy detail responses and failed detail reads can still recover.
		enabled: !!narratorId && (!!narrator || narratorError),
		retry: false,
		staleTime: 5_000,
		// A non-ready workspace has no panel watch yet. Probe only recoverable
		// states until ready; Git facts remain subscription-driven, never polled.
		refetchInterval: (query) => {
			if (query.state.status === "error") {
				const status = (query.state.error as ApiError)?.status;
				return !status || status >= 500 ? GIT_WORKSPACE_RECOVERY_INTERVAL_MS : false;
			}
			return ["not_git", "missing_directory", "git_unavailable", "device_offline"].includes(
				query.state.data?.state ?? "",
			)
				? GIT_WORKSPACE_RECOVERY_INTERVAL_MS
				: false;
		},
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
	const isSummarySeed = !!query.data && gitSummarySeeds.has(query.data);
	// Do not leave private facts visible after an authorization/capability failure.
	useEffect(() => {
		if (narratorId) {
			if (
				(query.isError && [401, 403].includes((query.error as ApiError)?.status)) ||
				query.data?.state === "access_denied"
			)
				blockGitSummary(qc, narratorId);
			else if (!isSummarySeed && query.isSuccess && query.data?.capabilities.read)
				deniedGitSummaries.get(qc)?.delete(narratorId);
		}
		if (!query.isError && query.data?.capabilities.read !== false) return;
		qc.removeQueries({ predicate: (q) => GIT_FACT_QUERIES.includes(String(q.queryKey[0])) });
	}, [
		qc,
		narratorId,
		isSummarySeed,
		query.isError,
		query.error,
		query.isSuccess,
		query.data?.state,
		query.data?.capabilities.read,
	]);
	// Synchronous fallback also works when a pending query already existed before
	// the detail arrived (initialData cannot seed that existing query).
	let data = query.isError
		? undefined
		: query.isPending || isSummarySeed
			? narratorId && deniedGitSummaries.get(qc)?.has(narratorId)
				? undefined
				: summaryWorkspace
			: query.data;
	// Old executors and the authority-only probe may omit branch. Preserve only
	// the label from a same-version summary of this exact device/worktree.
	if (
		data?.state === "ready" &&
		data.capabilities.read &&
		data.branch === undefined &&
		data.workspaceKey &&
		data.workspaceKey === summaryWorkspace?.workspaceKey &&
		data.deviceId === summaryWorkspace.deviceId &&
		data.rootPath === summaryWorkspace.rootPath
	)
		data = { ...data, branch: summaryWorkspace.branch };
	return {
		...query,
		data,
		layoutReady: !narratorId || !!data || query.isError,
	};
}

export function invalidateWorkspaceQueries(
	qc: ReturnType<typeof useQueryClient>,
	target: GitTarget,
): void {
	gitWorkspaceSubscriptions.get(qc)?.retry(target);
	const keys = new Set([gitTargetKey(target)]);
	const workspaces = qc
		.getQueriesData<GitWorkspace>({ queryKey: ["gitWorkspace"] })
		.map(([, workspace]) => workspace);
	const chapterId = typeof target === "string" ? target : target.chapterId;
	const repositoryKey =
		typeof target === "string"
			? workspaces.find((workspace) => workspace?.chapterId === target)?.repositoryKey
			: target.repositoryKey;
	if (chapterId) {
		keys.add(chapterId);
		qc.invalidateQueries({ queryKey: ["chapterGitStatus", chapterId] });
	}
	for (const workspace of workspaces) {
		if (
			workspace?.workspaceKey &&
			((repositoryKey && workspace.repositoryKey === repositoryKey) ||
				(chapterId && workspace.chapterId === chapterId))
		) {
			keys.add(workspace.workspaceKey);
			if (workspace.chapterId) keys.add(workspace.chapterId);
		}
	}
	for (const key of keys) {
		for (const prefix of GIT_FACT_QUERIES) qc.invalidateQueries({ queryKey: [prefix, key] });
	}
	// Re-probe after success AND failure: remote writes may have completed before disconnecting.
	if (typeof target !== "string")
		qc.invalidateQueries({ queryKey: ["gitWorkspace", target.narratorId] });
}

/**
 * A WS `git_status` push marks the badge/fact queries stale so active observers
 * refetch. Unlike {@link invalidateWorkspaceQueries} this never re-probes the
 * workspace itself: pushes arrive up to ~1/s during tool bursts, and a
 * discovery probe per push would be pure waste. Commit previews are immutable,
 * so only the live facts are invalidated.
 */
export function invalidateGitStatusPushQueries(
	qc: ReturnType<typeof useQueryClient>,
	narratorId: string,
	chapterId: string | null,
): void {
	const keys = new Set<string>();
	if (chapterId) keys.add(chapterId);
	for (const [, workspace] of qc.getQueriesData<GitWorkspace>({
		queryKey: ["gitWorkspace", narratorId],
	})) {
		if (workspace?.workspaceKey) keys.add(workspace.workspaceKey);
		if (workspace?.chapterId) keys.add(workspace.chapterId);
	}
	for (const key of keys) {
		for (const prefix of GIT_LIVE_FACT_QUERIES)
			void qc.invalidateQueries({ queryKey: [prefix, key] });
	}
}

export function useGitStatus(target: GitTarget | undefined | null) {
	const qc = useQueryClient();
	return useQuery<GitStatusSummary>({
		queryKey: ["gitStatus", gitTargetKey(target)],
		queryFn: ({ signal }) =>
			readWorkspace(qc, target, () => api.getGitStatus(target as GitTarget, signal)),
		enabled: !!target,
		retry: false,
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
}

/**
 * Minimum interval between two badge refreshes (ms). `focus` and
 * `visibilitychange` co-fire on a single return gesture, and a foreground return
 * usually also triggers the WS reconnect that raises the second signal
 * milliseconds later — without the throttle one user action buys two or three
 * invalidations of the same queries.
 */
const GIT_BADGE_REFRESH_MIN_INTERVAL_MS = 2_000;

/**
 * Foreground/reconnect catch-up for the git status badges (ChapterBar /
 * NarratorGitBar). Mounted ONCE at the app shell, not per bar.
 *
 * The badge queries (`gitStatus`, `chapterGitStatus`) are normally kept fresh by
 * server pushes routed over the narrator WS. Two gaps leave them stale:
 *
 * - **Window focus without a visibility change.** React Query's focus manager
 *   only listens to `visibilitychange`; clicking between two visible windows
 *   (or Alt-Tab on a WM that keeps the window "visible") fires no such event,
 *   so the built-in `refetchOnWindowFocus` never triggers.
 * - **WS reconnect.** Pushes sent while the socket was down are lost, and the
 *   server-side git workspace subscription only exists while the Git PANEL is
 *   open (`useGitWorkspaceSubscription`) — a bar without the panel has no
 *   catch-up of its own, so the badge would keep pre-disconnect numbers
 *   indefinitely.
 *
 * `invalidateQueries` refetches active observers only, so an app showing no
 * badge pays nothing. Deliberately limited to the two badge queries: the open
 * Git panel already gets its facts re-invalidated by the `git_workspace_subscribed`
 * snapshot that follows its resubscribe on reconnect.
 */
export function useGitBadgeRefresh() {
	const qc = useQueryClient();
	useEffect(() => {
		let lastRefreshAt = 0;
		const refresh = () => {
			const now = Date.now();
			if (now - lastRefreshAt < GIT_BADGE_REFRESH_MIN_INTERVAL_MS) return;
			lastRefreshAt = now;
			void qc.invalidateQueries({ queryKey: ["gitStatus"] });
			void qc.invalidateQueries({ queryKey: ["chapterGitStatus"] });
		};
		const unobserve = observePageLifecycle({ onForeground: refresh });
		const offConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (connected && isReconnect) refresh();
		});
		return () => {
			unobserve();
			offConnection();
		};
	}, [qc]);
}

export function useGitModifications(target: GitTarget | undefined | null) {
	const qc = useQueryClient();
	return useQuery<WorkspaceModificationView>({
		queryKey: ["gitModifications", gitTargetKey(target), "uncommitted"],
		queryFn: ({ signal }) =>
			readWorkspace(
				qc,
				target,
				() =>
					api.getGitModifications(
						target as GitTarget,
						{
							scope: "uncommitted",
							projection: "byFile",
						},
						signal,
					) as Promise<WorkspaceModificationView>,
			),
		enabled: !!target,
		retry: false,
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
}

export function useGitLog(
	target: GitTarget | undefined | null,
	limit = 50,
	skip = 0,
	enabled = true,
) {
	const qc = useQueryClient();
	return useQuery<GitLogEntry[]>({
		queryKey: ["gitLog", gitTargetKey(target), limit, skip],
		queryFn: ({ signal }) =>
			readWorkspace(qc, target, () => api.getGitLog(target as GitTarget, limit, skip, signal)),
		enabled: !!target && enabled,
		retry: false,
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
}

export function useGitStashList(target: GitTarget | undefined | null) {
	const qc = useQueryClient();
	return useQuery<GitStashEntry[]>({
		queryKey: ["gitStashList", gitTargetKey(target)],
		queryFn: ({ signal }) =>
			readWorkspace(qc, target, () => api.getGitStashList(target as GitTarget, signal)),
		enabled: !!target,
		retry: false,
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
}

export function useGitDiff(
	target: GitTarget | undefined | null,
	file: string | null,
	staged = false,
) {
	const qc = useQueryClient();
	return useQuery({
		queryKey: ["gitDiff", gitTargetKey(target), file, staged],
		queryFn: ({ signal }) =>
			readWorkspace(qc, target, () =>
				api.getGitDiff(target as GitTarget, file as string, staged, signal),
			),
		enabled: !!target && !!file,
		retry: false,
		gcTime: 30_000,
	});
}

// Commit objects are immutable, but the route granting access is not. Keep the
// workspace prefix for invalidation, and scope previews to their narrator/chapter.
export function useGitCommitDetail(target: GitTarget | undefined | null, sha: string | null) {
	const qc = useQueryClient();
	return useQuery<GitCommitDetail>({
		queryKey: ["gitCommitDetail", gitTargetKey(target), sha, target ? gitBasePath(target) : null],
		queryFn: ({ signal }) =>
			readWorkspace(qc, target, () =>
				api.getGitCommitDetail(target as GitTarget, sha as string, signal),
			),
		enabled: !!target && !!sha,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
}

export function useGitCommitDiff(
	target: GitTarget | undefined | null,
	sha: string | null,
	file: string | null,
	oldPath?: string,
) {
	const qc = useQueryClient();
	return useQuery<GitCommitPatch>({
		queryKey: [
			"gitCommitDiff",
			gitTargetKey(target),
			sha,
			file,
			oldPath ?? null,
			target ? gitBasePath(target) : null,
		],
		queryFn: ({ signal }) =>
			readWorkspace(qc, target, () =>
				api.getGitCommitDiff(target as GitTarget, sha as string, file as string, oldPath, signal),
			),
		enabled: !!target && !!sha && !!file,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
}

function useGitMutation<T, R>(target: GitTarget, run: (value: T) => Promise<R>, graph = false) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: run,
		retry: false,
		onSettled: () => {
			invalidateWorkspaceQueries(qc, target);
			if (graph) qc.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});
}

export function useGitStage(target: GitTarget) {
	return useGitMutation(target, (body: { files?: string[]; all?: boolean }) =>
		api.gitStage(target, body),
	);
}
export function useGitUnstage(target: GitTarget) {
	return useGitMutation(target, (body: { files?: string[]; all?: boolean }) =>
		api.gitUnstage(target, body),
	);
}
export function useGitCommit(target: GitTarget) {
	return useGitMutation(target, (message: string) => api.gitCommit(target, message), true);
}
export function useGitDiscard(target: GitTarget) {
	return useGitMutation(target, (body: { files?: string[]; all?: boolean }) =>
		api.gitDiscard(target, body),
	);
}
export function useGitStash(target: GitTarget) {
	return useGitMutation(target, (body: { action: string; message?: string; index?: number }) =>
		api.gitStash(target, body),
	);
}
export function useGitReset(target: GitTarget) {
	return useGitMutation(
		target,
		(params: { target: string; mode: "soft" | "hard" }) =>
			api.gitReset(target, params.target, params.mode),
		true,
	);
}
export function useGitAiCommitMessage(target: GitTarget) {
	return useGitMutation<void, { message: string }>(target, () => api.gitAiCommitMessage(target));
}
