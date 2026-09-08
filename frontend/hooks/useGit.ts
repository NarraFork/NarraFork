import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CurrentDiffView } from "../../server/services/git-current-diff-view";
import type {
	FileChangeActorKind,
	FileChangeAttributionGrade,
	FileChangeProjectionCompleteness,
} from "../../shared/file-change-protocol";
import { api } from "../lib/api";

export type {
	CurrentDiffFile,
	CurrentDiffTarget,
	CurrentDiffView,
} from "../../server/services/git-current-diff-view";

// Types
export interface GitStatusSummary {
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

export interface GitLogEntry {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	date: string;
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

export interface FileModificationGroup {
	filePath: string;
	changeCount: number;
	lastChangedAt: string;
	/** Actor and action of the same latest observed event, never guessed from group flags. */
	lastActor: AttributionActor;
	lastAction: AttributionAction;
	/** Known subjects and anonymous buckets seen in the returned row window. */
	actors: AttributionActor[];
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

// Queries

const GIT_QUERY_GC_TIME_MS = 60_000;

/**
 * Prefix of the attribution query key.
 *
 * Deliberately two segments while the query itself is keyed with a third (`"uncommitted"`):
 * invalidations mean "every scope for this chapter", so adding a scope later cannot leave a
 * stale badge behind.
 */
function gitAttributionKey(chapterId: string): unknown[] {
	return ["gitModifications", chapterId];
}

/**
 * Invalidate everything that describes the working tree.
 *
 * Status and attribution are one fact split across two queries: a commit moves each file's
 * per-path attribution boundary, and stage/discard changes which files are in the diff at
 * all. Refreshing only status left the badges showing contributors filtered by the previous
 * boundary until the 30s poll caught up.
 */
export function invalidateWorkspaceQueries(
	qc: ReturnType<typeof useQueryClient>,
	chapterId: string,
): void {
	qc.invalidateQueries({ queryKey: ["gitStatus", chapterId] });
	qc.invalidateQueries({ queryKey: gitAttributionKey(chapterId) });
}

export function useGitStatus(chapterId: string | undefined | null) {
	return useQuery<GitStatusSummary>({
		queryKey: ["gitStatus", chapterId],
		queryFn: () => api.getGitStatus(chapterId as string),
		enabled: !!chapterId,
		refetchInterval: 30_000,
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
}

/**
 * Recent historical observations for paths in the current diff. The per-file last-commit
 * timestamp is only a filter hint: without a verified baseline epoch/fingerprint it
 * cannot establish which actor's changes still survive in HEAD/index/worktree.
 */
export function useGitModifications(chapterId: string | undefined | null) {
	return useQuery<WorkspaceModificationView>({
		queryKey: ["gitModifications", chapterId, "uncommitted"],
		queryFn: () =>
			api.getGitModifications(chapterId as string, {
				scope: "uncommitted",
				// The badge reads `byFile` only. The event-by-event `timeline` is the larger half
				// of this response and nothing renders it, so it is not asked for.
				projection: "byFile",
			}) as Promise<WorkspaceModificationView>,
		enabled: !!chapterId,
		refetchInterval: 30_000,
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
}

export function useGitLog(chapterId: string | undefined | null, limit = 50, skip = 0) {
	return useQuery<GitLogEntry[]>({
		queryKey: ["gitLog", chapterId, limit, skip],
		queryFn: () => api.getGitLog(chapterId as string, limit, skip),
		enabled: !!chapterId,
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
}

export function useGitStashList(chapterId: string | undefined | null) {
	return useQuery<GitStashEntry[]>({
		queryKey: ["gitStashList", chapterId],
		queryFn: () => api.getGitStashList(chapterId as string),
		enabled: !!chapterId,
		gcTime: GIT_QUERY_GC_TIME_MS,
	});
}

export function useGitDiff(
	chapterId: string | undefined | null,
	file: string | null,
	staged = false,
) {
	return useQuery({
		queryKey: ["gitDiff", chapterId, file, staged],
		queryFn: () => api.getGitDiff(chapterId as string, file as string, staged),
		enabled: !!chapterId && !!file,
		gcTime: 30_000,
	});
}

// Mutations

export function useGitStage(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { files?: string[]; all?: boolean }) => api.gitStage(chapterId, body),
		onSuccess: () => {
			invalidateWorkspaceQueries(qc, chapterId);
		},
	});
}

export function useGitUnstage(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { files?: string[]; all?: boolean }) => api.gitUnstage(chapterId, body),
		onSuccess: () => {
			invalidateWorkspaceQueries(qc, chapterId);
		},
	});
}

export function useGitCommit(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (message: string) => api.gitCommit(chapterId, message),
		onSuccess: () => {
			invalidateWorkspaceQueries(qc, chapterId);
			qc.invalidateQueries({ queryKey: ["gitLog", chapterId] });
			qc.invalidateQueries({ queryKey: ["gitStashList", chapterId] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});
}

export function useGitDiscard(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { files?: string[]; all?: boolean }) => api.gitDiscard(chapterId, body),
		onSuccess: () => {
			invalidateWorkspaceQueries(qc, chapterId);
		},
	});
}

export function useGitStash(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { action: string; message?: string; index?: number }) =>
			api.gitStash(chapterId, body),
		onSuccess: () => {
			invalidateWorkspaceQueries(qc, chapterId);
			qc.invalidateQueries({ queryKey: ["gitStashList", chapterId] });
		},
	});
}

export function useGitReset(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (params: { target: string; mode: "soft" | "hard" }) =>
			api.gitReset(chapterId, params.target, params.mode),
		onSuccess: () => {
			invalidateWorkspaceQueries(qc, chapterId);
			qc.invalidateQueries({ queryKey: ["gitLog", chapterId] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});
}

export function useGitAiCommitMessage(chapterId: string) {
	return useMutation({
		mutationFn: () => api.gitAiCommitMessage(chapterId),
	});
}
