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

	test("refreshes merge lifecycle events for the current project", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:merged",
				projectId: "project-1",
				sourceId: "source",
				targetId: "target",
			}),
		).toBe(true);
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:merged",
				projectId: "project-2",
				sourceId: "source",
				targetId: "target",
			}),
		).toBe(false);
	});

	test("refreshes batch merge completion progress for the current project", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "merge:completed",
				projectId: "project-1",
				mergeSessionId: "merge-session-1",
				targetChapterId: "target",
				mergedCount: 2,
			}),
		).toBe(true);
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "merge:completed",
				projectId: "project-2",
				mergeSessionId: "merge-session-2",
				targetChapterId: "target",
				mergedCount: 2,
			}),
		).toBe(false);
	});

	test("refreshes unmerge wake lifecycle events for the current project", () => {
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:woken",
				projectId: "project-1",
				chapterId: "source",
				mergeCommitSha: "merge-sha",
			}),
		).toBe(true);
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:woken",
				projectId: "project-2",
				chapterId: "source",
				mergeCommitSha: "merge-sha",
			}),
		).toBe(false);
	});

	test("refreshes when another client forks or splits a chapter in this project", () => {
		// Adding a node is the most common way the graph changes, and it used to reach only
		// the client that performed it — everyone else waited for the 60 s poll.
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:forked",
				projectId: "project-1",
				chapterId: "chapter-2",
				parentId: "chapter-1",
			}),
		).toBe(true);
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:split",
				projectId: "project-1",
				prefixChapterId: "prefix",
				continuationChapterId: "chapter-1",
				newForkChapterId: "fork",
				commitSha: "abc1234",
			}),
		).toBe(true);
	});

	test("does not refresh for a fork or split in another project", () => {
		// Why both events carry a required `projectId`: a missing one is read as "may
		// concern me", so without it one project's fork would refetch every open graph.
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:forked",
				projectId: "project-2",
				chapterId: "chapter-2",
				parentId: "chapter-1",
			}),
		).toBe(false);
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:split",
				projectId: "project-2",
				prefixChapterId: "prefix",
				continuationChapterId: "chapter-1",
				newForkChapterId: "fork",
				commitSha: "abc1234",
			}),
		).toBe(false);
	});

	test("ignores commit count changes, which fire on agent activity and name no project", () => {
		// `chapter:commits_updated` is broadcast by the worktree watcher whenever HEAD
		// moves and carries no `projectId`, so subscribing would make every open graph
		// refetch a git-spawning endpoint on any commit anywhere in the deployment.
		expect(
			shouldRefreshProjectGraphForEvent("project-1", {
				type: "chapter:commits_updated",
				chapterId: "chapter-1",
				newCount: 3,
			}),
		).toBe(false);
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
