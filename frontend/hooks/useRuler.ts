import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface RulerCommit {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	date: string;
}

export interface RulerSegment {
	fromSha: string;
	toSha: string;
	fromIndex: number;
	toIndex: number;
	activeChapterCount: number;
	totalChapterCount: number;
	activeChapterIds: string[];
	isExpandable: boolean;
}

export interface RulerActiveChapter {
	id: string;
	title: string;
	branch: string;
	role: string;
	startCommitSha: string | null;
	narratorId: string | null;
	narratorStatus: string | null;
}

export interface RulerData {
	commits: RulerCommit[];
	segments: RulerSegment[];
	activeChapters: RulerActiveChapter[];
}

export function useRulerData(projectId: string) {
	return useQuery({
		queryKey: ["ruler", projectId],
		queryFn: () => api.getRulerData(projectId) as Promise<RulerData>,
		enabled: !!projectId,
	});
}

export function useSubRulerData(projectId: string, chapterId: string | null) {
	return useQuery({
		queryKey: ["ruler", projectId, "sub", chapterId],
		queryFn: () => api.getSubRulerData(projectId, chapterId!) as Promise<RulerData>,
		enabled: !!projectId && !!chapterId,
	});
}
