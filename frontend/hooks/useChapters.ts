import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const CHAPTER_QUERY_GC_TIME_MS = 60_000;

/**
 * Server events that invalidate the project graph.
 *
 * The list is what a *different* client's action must do to this one's view. Anything
 * the local user did is already handled by that mutation's own `onSuccess`; these
 * exist because the story network is shared state.
 *
 * `chapter:forked` and `chapter:split` are here because they add nodes — a fork is the
 * single most common way the graph changes, and it used to redraw only on the 60 s
 * fallback poll for everyone but the client that made it.
 *
 * `chapter:commits_updated` is deliberately NOT here, even though the commit count it
 * carries is rendered on the node. It is the one event in this family that fires on
 * agent activity rather than user action — the worktree watcher emits it whenever HEAD
 * moved — and it has no `projectId`, which `shouldRefreshProjectGraphForEvent` reads as
 * "may concern me". Every client with a graph open would therefore refetch
 * `GET /:id/graph` (which spawns git per active chapter) on every commit made anywhere
 * in the deployment. A stale commit count until the next poll is the cheaper wrong
 * answer.
 *
 * `chapter:updated` is deliberately absent: the server has no such event, and the only
 * field `chapterService.update` touches that affects the graph — `role` — emits
 * `chapter:role_changed` instead. Everything else it writes (title, color, panel
 * geometry) is refreshed by the mutation's own `onSuccess`, so a coarse "updated"
 * event would put two mechanisms in charge of one job and refetch the graph on every
 * panel resize.
 */
export const CHAPTER_GRAPH_REFRESH_EVENTS = [
	"chapter:created",
	"chapter:forked",
	"chapter:split",
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
