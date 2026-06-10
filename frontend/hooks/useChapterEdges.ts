import { api } from "@frontend/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateChapterGraphQueries, type QueryInvalidator } from "./useChapters";

const CHAPTER_EDGES_QUERY_GC_TIME_MS = 60_000;

type CreateChapterEdgeInput = {
	sourceId: string;
	targetId: string;
	type: string;
	metadata?: Record<string, unknown>;
	projectId?: string;
};

type ChapterEdgeProjectResult = {
	projectId?: string;
};

type DeleteChapterEdgeInput = string | { id: string; projectId?: string };

function deleteChapterEdgeId(input: DeleteChapterEdgeInput) {
	return typeof input === "string" ? input : input.id;
}

function deleteChapterEdgeProjectId(input: DeleteChapterEdgeInput) {
	return typeof input === "string" ? undefined : input.projectId;
}

export function invalidateChapterEdgeGraphQueries(
	queryClient: QueryInvalidator,
	edge: ChapterEdgeProjectResult | undefined,
	fallbackProjectId?: string,
) {
	invalidateChapterGraphQueries(queryClient, edge?.projectId ?? fallbackProjectId);
}

export function useChapterEdges(projectId: string | undefined) {
	return useQuery({
		queryKey: ["chapterEdges", projectId],
		queryFn: () => {
			if (!projectId) throw new Error("projectId is required");
			return api.listChapterEdges({ projectId });
		},
		enabled: !!projectId,
		gcTime: CHAPTER_EDGES_QUERY_GC_TIME_MS,
	});
}

export function useCreateChapterEdge() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (data: CreateChapterEdgeInput) =>
			api.createChapterEdge({
				sourceId: data.sourceId,
				targetId: data.targetId,
				type: data.type,
				metadata: data.metadata,
			}),
		onSuccess: (edge, input) => {
			invalidateChapterEdgeGraphQueries(queryClient, edge, input.projectId);
		},
	});
}

export function useDeleteChapterEdge() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: DeleteChapterEdgeInput) =>
			api.deleteChapterEdge(deleteChapterEdgeId(input)),
		onSuccess: (_, input) => {
			invalidateChapterEdgeGraphQueries(queryClient, undefined, deleteChapterEdgeProjectId(input));
		},
	});
}
