import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

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

export type AttributionAction = "write" | "edit" | "bash" | "external";

/**
 * A contributor resolved by the server.
 *
 * Attribution spans subagents and narrators outside the current chapter, which a
 * chapter-scoped narrator list cannot name, so labels come from the API rather than being
 * looked up client-side — resolving them locally is what made most writers render as
 * "Unknown".
 */
export interface AttributionActor {
	/** Null for a change with no narrator at all (external / terminal edit). */
	narratorId: string | null;
	title: string | null;
	subagentType: string | null;
	parentTitle: string | null;
	/** False when the narrator row no longer exists (deleted session). */
	exists: boolean;
}

/** Per-file rollup of who changed a file within the requested scope. */
export interface FileModificationGroup {
	filePath: string;
	changeCount: number;
	lastChangedAt: string;
	/** Actor of the most recent change — the one the badge names. */
	lastActor: AttributionActor;
	/** Distinct actors, most recent first. */
	actors: AttributionActor[];
	hasExternalChange: boolean;
	/**
	 * True when some change cannot be attributed with confidence (a shell command's
	 * write set is not provably its own).
	 */
	hasImpreciseAttribution: boolean;
	/** True when some change came from a session that has since been deleted. */
	hasDeletedActor: boolean;
}

export interface WorkspaceModificationView {
	workspacePath: string;
	deviceId: string;
	byFile: FileModificationGroup[];
	hasMore: boolean;
	actors: AttributionActor[];
	/**
	 * Records that actually reached the per-file rollup.
	 *
	 * Separates "this file has no attributable session" from "the row window ran out
	 * before reaching this file's changes" — both render as a missing group otherwise,
	 * and only the first is an honest "nobody wrote this".
	 */
	windowCount?: number;
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
 * Who caused the current uncommitted changes.
 *
 * `scope=uncommitted` bounds each file at its own last commit. Without it the view spans
 * the workspace's whole recorded history, which credits a file's current diff to every
 * session that ever touched it — measured on this repository: a median of 7 contributors
 * per file (up to 157) where the real answer was 1.
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
