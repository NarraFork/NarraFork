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

// Queries

const GIT_QUERY_GC_TIME_MS = 60_000;

export function useGitStatus(chapterId: string | undefined | null) {
	return useQuery<GitStatusSummary>({
		queryKey: ["gitStatus", chapterId],
		queryFn: () => api.getGitStatus(chapterId as string),
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
			qc.invalidateQueries({ queryKey: ["gitStatus", chapterId] });
		},
	});
}

export function useGitUnstage(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { files?: string[]; all?: boolean }) => api.gitUnstage(chapterId, body),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["gitStatus", chapterId] });
		},
	});
}

export function useGitCommit(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (message: string) => api.gitCommit(chapterId, message),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["gitStatus", chapterId] });
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
			qc.invalidateQueries({ queryKey: ["gitStatus", chapterId] });
		},
	});
}

export function useGitStash(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { action: string; message?: string; index?: number }) =>
			api.gitStash(chapterId, body),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["gitStatus", chapterId] });
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
			qc.invalidateQueries({ queryKey: ["gitStatus", chapterId] });
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
