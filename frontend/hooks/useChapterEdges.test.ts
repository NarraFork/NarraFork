import { describe, expect, test } from "bun:test";
import { invalidateChapterEdgeGraphQueries } from "./useChapterEdges";

function createInvalidationRecorder() {
	const calls: unknown[][] = [];
	return {
		calls,
		queryClient: {
			// biome-ignore lint/suspicious/noExplicitAny: minimal QueryClient test double
			invalidateQueries: ({ queryKey }: any) => {
				calls.push(queryKey);
			},
		},
	};
}

describe("invalidateChapterEdgeGraphQueries", () => {
	test("invalidates chapter, graph, ruler, and edge queries from dependency edge project id", () => {
		const { calls, queryClient } = createInvalidationRecorder();

		invalidateChapterEdgeGraphQueries(queryClient, { projectId: "project-1" });

		expect(calls).toEqual([
			["chapters", { projectId: "project-1" }],
			["narraFlow", "project-1"],
			["ruler", "project-1"],
			["rulerSegment", "project-1"],
			["chapterEdges", "project-1"],
		]);
	});

	test("uses mutation fallback project id when delete response has no project id", () => {
		const { calls, queryClient } = createInvalidationRecorder();

		invalidateChapterEdgeGraphQueries(queryClient, undefined, "project-1");

		expect(calls).toEqual([
			["chapters", { projectId: "project-1" }],
			["narraFlow", "project-1"],
			["ruler", "project-1"],
			["rulerSegment", "project-1"],
			["chapterEdges", "project-1"],
		]);
	});

	test("does not crash or invalidate without project id", () => {
		const { calls, queryClient } = createInvalidationRecorder();

		invalidateChapterEdgeGraphQueries(queryClient, undefined);

		expect(calls).toEqual([]);
	});
});
