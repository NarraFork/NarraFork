import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const CHAPTER_QUERY_GC_TIME_MS = 60_000;

export const CHAPTER_GRAPH_REFRESH_EVENTS = [
	"chapter:created",
	"chapter:updated",
	"chapter:abandoned",
	"chapter:dormant",
	"chapter:woken",
	"chapter:merged",
	"chapter:role_changed",
	"review:created",
	"review:concluded",
	"dependency:created",
	"dependency:removed",
	"merge:completed",
];

const CHAPTER_GRAPH_REFRESH_EVENT_SET = new Set(CHAPTER_GRAPH_REFRESH_EVENTS);

export type QueryInvalidator = {
	invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
};

export function shouldRefreshProjectGraphForEvent(
	projectId: string,
	event: Record<string, unknown>,
): boolean {
	const type = typeof event.type === "string" ? event.type : "";
	if (!projectId || !CHAPTER_GRAPH_REFRESH_EVENT_SET.has(type)) return false;
	const eventProjectId = typeof event.projectId === "string" ? event.projectId : "";
	return eventProjectId === "" || eventProjectId === projectId;
}

export function invalidateChapterGraphQueries(qc: QueryInvalidator, projectId: string | undefined) {
	if (!projectId) return;
	qc.invalidateQueries({ queryKey: ["chapters", { projectId }] });
	qc.invalidateQueries({ queryKey: ["narraFlow", projectId] });
	qc.invalidateQueries({ queryKey: ["ruler", projectId] });
	qc.invalidateQueries({ queryKey: ["rulerSegment", projectId] });
	qc.invalidateQueries({ queryKey: ["chapterEdges", projectId] });
}

export function useChapters(projectId: string, status?: string) {
	const qc = useQueryClient();
	useEffect(() => {
		if (!projectId) return;
		const handle = narratorWSManager.addListener(
			{ types: CHAPTER_GRAPH_REFRESH_EVENTS },
			(event) => {
				if (!shouldRefreshProjectGraphForEvent(projectId, event)) return;
				invalidateChapterGraphQueries(qc, projectId);
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [projectId, qc]);

	return useQuery({
		queryKey: ["chapters", { projectId, status }],
		queryFn: () => api.listChapters(projectId, status),
		enabled: !!projectId,
		gcTime: CHAPTER_QUERY_GC_TIME_MS,
	});
}

export function useChapter(id: string) {
	return useQuery({
		queryKey: ["chapters", id],
		queryFn: () => api.getChapter(id),
		enabled: !!id,
		gcTime: CHAPTER_QUERY_GC_TIME_MS,
	});
}

export function useCreateChapter() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.createChapter,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		onSuccess: (data: any) => {
			invalidateChapterGraphQueries(qc, data.projectId);
		},
	});
}

export function useUpdateChapter() {
	const qc = useQueryClient();
	return useMutation({
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		mutationFn: ({ id, data }: { id: string; data: any }) => api.updateChapter(id, data),
		onSuccess: (_, { id }) => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["chapters", id] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});
}

export function useDeleteChapter() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.deleteChapter,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});
}
