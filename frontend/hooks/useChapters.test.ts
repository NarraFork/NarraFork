import { describe, expect, test } from "bun:test";
import { invalidateChapterGraphQueries, shouldRefreshProjectGraphForEvent } from "./useChapters";

describe("shouldRefreshProjectGraphForEvent", () => {
	test("refreshes the current project graph for chapter abandoned events", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:abandoned",
				projectId: "project-1",
				chapterId: "chapter-1",
			}),
		).toBe(true);
	});

	test("ignores lifecycle events from other projects", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:abandoned",
				projectId: "project-2",
				chapterId: "chapter-2",
			}),
		).toBe(false);
	});

	test("accepts legacy lifecycle events without a project id", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:abandoned",
				chapterId: "chapter-1",
			}),
		).toBe(true);
	});

	test("refreshes dependency lifecycle events without project id", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "dependency:created",
				edgeId: "edge-1",
				sourceId: "chapter-1",
				targetId: "chapter-2",
			}),
		).toBe(true);
	});

	test("refreshes dependency lifecycle events with matching project id", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "dependency:removed",
				projectId: "project-1",
				edgeId: "edge-1",
			}),
		).toBe(true);
	});

	test("refreshes review lifecycle events for the current project", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "review:created",
				projectId: "project-1",
				reviewChapterId: "review-1",
				sourceChapterId: "chapter-1",
			}),
		).toBe(true);
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "review:concluded",
				projectId: "project-1",
				reviewChapterId: "review-1",
				sourceChapterId: "chapter-1",
			}),
		).toBe(true);
	});

	test("refreshes dormant and wake lifecycle events for the current project", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:dormant",
				projectId: "project-1",
				chapterId: "chapter-1",
			}),
		).toBe(true);
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:woken",
				projectId: "project-1",
				chapterId: "chapter-1",
			}),
		).toBe(true);
	});

	test("ignores unrelated WS events", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "user:recent_tabs_snapshot",
				projectId: "project-1",
			}),
		).toBe(false);
	});
});

describe("invalidateChapterGraphQueries", () => {
	test("invalidates chapter, graph, ruler, and edge queries for chapter create success", () => {
		const calls: unknown[][] = [];
		invalidateChapterGraphQueries(
			{
				// biome-ignore lint/suspicious/noExplicitAny: minimal QueryClient test double
				invalidateQueries: ({ queryKey }: any) => {
					calls.push(queryKey);
				},
			},
			"project-1",
		);

		expect(calls).toEqual([
			["chapters", { projectId: "project-1" }],
			["narraFlow", "project-1"],
			["ruler", "project-1"],
			["rulerSegment", "project-1"],
			["chapterEdges", "project-1"],
		]);
	});

	test("does not crash or invalidate when project id is absent", () => {
		const calls: unknown[][] = [];
		invalidateChapterGraphQueries(
			{
				// biome-ignore lint/suspicious/noExplicitAny: minimal QueryClient test double
				invalidateQueries: ({ queryKey }: any) => {
					calls.push(queryKey);
				},
			},
			undefined,
		);

		expect(calls).toEqual([]);
	});
});
