import { describe, expect, test } from "bun:test";
import { buildNarratorCleanupPlan, type NarratorCleanupRecord } from "../database-cleanup-utils";

function narrator(
	overrides: Partial<NarratorCleanupRecord> & Pick<NarratorCleanupRecord, "id">,
): NarratorCleanupRecord {
	return {
		id: overrides.id,
		parentNarratorId: overrides.parentNarratorId ?? null,
		chapterId: overrides.chapterId ?? null,
		type: overrides.type ?? "primary",
		title: overrides.title ?? overrides.id,
		status: overrides.status ?? "idle",
		messageCount: overrides.messageCount ?? 0,
		createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
		updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
		lastMessageAt: overrides.lastMessageAt ?? "2024-01-01T00:00:00.000Z",
		isBackground: overrides.isBackground ?? false,
		backgroundStatus: overrides.backgroundStatus ?? null,
	};
}

describe("buildNarratorCleanupPlan", () => {
	test("archived cleanup selects only the topmost safe root", () => {
		const plan = buildNarratorCleanupPlan(
			"archivedSessions",
			[
				narrator({ id: "root", status: "archived", title: "root" }),
				narrator({
					id: "child-subagent",
					parentNarratorId: "root",
					type: "subagent",
					status: "archived",
				}),
				narrator({
					id: "child-fork",
					parentNarratorId: "root",
					status: "archived",
				}),
			],
			{},
		);

		expect(plan.safeRoots).toHaveLength(1);
		expect(plan.safeRoots[0]?.rootNarratorId).toBe("root");
		expect(plan.safeRoots[0]?.deletedNarratorIds).toEqual(["root", "child-subagent", "child-fork"]);
		expect(plan.safeRoots[0]?.descendantNarratorCount).toBe(2);
		expect(plan.blockedRoots).toHaveLength(0);
	});

	test("archived cleanup blocks roots with non-archived descendants", () => {
		const plan = buildNarratorCleanupPlan(
			"archivedSessions",
			[
				narrator({ id: "root", status: "archived", title: "root" }),
				narrator({ id: "child", parentNarratorId: "root", status: "idle", title: "child" }),
			],
			{},
		);

		expect(plan.safeRoots).toHaveLength(0);
		expect(plan.blockedRoots).toHaveLength(1);
		expect(plan.blockedRoots[0]?.narratorId).toBe("root");
		expect(plan.blockedRoots[0]?.reasonCode).toBe("nonArchived");
		expect(plan.blockedRoots[0]?.blockingNarratorId).toBe("child");
	});

	test("stale cleanup blocks recent activity inside the subtree", () => {
		const plan = buildNarratorCleanupPlan(
			"staleSessions",
			[
				narrator({ id: "root", status: "idle", lastMessageAt: "2024-01-01T00:00:00.000Z" }),
				narrator({
					id: "recent-child",
					parentNarratorId: "root",
					status: "idle",
					lastMessageAt: "2024-06-20T00:00:00.000Z",
				}),
			],
			{ staleCutoffIso: "2024-06-01T00:00:00.000Z" },
		);

		expect(plan.safeRoots).toHaveLength(0);
		expect(plan.blockedRoots).toHaveLength(2);
		expect(plan.blockedRoots[0]?.reasonCode).toBe("recentActivity");
		expect(plan.blockedRoots[0]?.blockingNarratorId).toBe("recent-child");
		expect(plan.blockedRoots[1]?.blockingNarratorId).toBe("recent-child");
	});

	test("stale cleanup allows a stale descendant root when parent is too recent", () => {
		const plan = buildNarratorCleanupPlan(
			"staleSessions",
			[
				narrator({ id: "recent-root", status: "idle", lastMessageAt: "2024-06-20T00:00:00.000Z" }),
				narrator({
					id: "stale-child",
					parentNarratorId: "recent-root",
					status: "idle",
					lastMessageAt: "2024-01-01T00:00:00.000Z",
				}),
			],
			{ staleCutoffIso: "2024-06-01T00:00:00.000Z" },
		);

		expect(plan.safeRoots).toHaveLength(1);
		expect(plan.safeRoots[0]?.rootNarratorId).toBe("stale-child");
		expect(plan.blockedRoots).toHaveLength(1);
		expect(plan.blockedRoots[0]?.narratorId).toBe("recent-root");
		expect(plan.blockedRoots[0]?.reasonCode).toBe("recentActivity");
	});

	test("stale cleanup blocks running terminals anywhere in the subtree", () => {
		const plan = buildNarratorCleanupPlan(
			"staleSessions",
			[
				narrator({ id: "root", status: "idle", lastMessageAt: "2024-01-01T00:00:00.000Z" }),
				narrator({
					id: "child",
					parentNarratorId: "root",
					status: "idle",
					lastMessageAt: "2024-01-01T00:00:00.000Z",
				}),
			],
			{
				staleCutoffIso: "2024-06-01T00:00:00.000Z",
				runningTerminalIds: new Set(["child"]),
			},
		);

		expect(plan.safeRoots).toHaveLength(0);
		expect(plan.blockedRoots).toHaveLength(2);
		expect(plan.blockedRoots[0]?.reasonCode).toBe("runningTerminal");
		expect(plan.blockedRoots[0]?.blockingNarratorId).toBe("child");
		expect(plan.blockedRoots[1]?.blockingNarratorId).toBe("child");
	});
});
