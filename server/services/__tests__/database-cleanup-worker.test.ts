import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
	narrators,
	narratorWorktreeResources,
	projects,
	projectTeams,
	teamWorkItems,
} from "../../db/schema";
import { readDomainTask } from "../../db/worker-read";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
beforeAll(() => fixture.ready);
afterAll(() => fixture.close());

test("cleanup reads every metadata page with current trait and parent semantics off the owner thread", async () => {
	for (let index = 0; index < 260; index++) {
		fixture.db
			.insert(narrators)
			.values({
				id: `cleanup-${index.toString().padStart(3, "0")}`,
				parentNarratorId: index ? "cleanup-000" : null,
				traits: index === 259 ? ["bot"] : [0, 1, 258].includes(index) ? ["team"] : [],
				title: `narrator-${index}`,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-02T00:00:00.000Z",
			})
			.run();
	}
	const timestamps = {
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
	};
	fixture.db
		.insert(projects)
		.values({ id: "cleanup-project", name: "cleanup", ...timestamps })
		.run();
	fixture.db
		.insert(narratorWorktreeResources)
		.values({
			id: "cleanup-worktree",
			deviceId: "local",
			repositoryKey: "cleanup-repository",
			worktreePath: "/cleanup-worktree",
			state: "ready",
			createRequestId: "cleanup-create",
		})
		.run();
	for (const [index, state] of [
		[0, "in_progress"],
		[1, "cancelled"],
		[258, "merged"],
	] as const) {
		const id = `cleanup-${index.toString().padStart(3, "0")}`;
		fixture.db
			.insert(projectTeams)
			.values({ narratorId: id, projectId: "cleanup-project", baseBranch: "main", ...timestamps })
			.run();
		fixture.db
			.insert(teamWorkItems)
			.values({
				id: `item-${id}`,
				teamId: id,
				projectId: "cleanup-project",
				title: id,
				state,
				worktreeResourceId: index === 258 ? "cleanup-worktree" : null,
				...timestamps,
			})
			.run();
	}
	const forbidden = () => {
		throw new Error("Cleanup metadata and team SELECTs must run in the Worker");
	};
	const prepare = spyOn(fixture.sqlite, "prepare").mockImplementation(forbidden);
	const query = spyOn(fixture.sqlite, "query").mockImplementation(forbidden);
	try {
		const context = await readDomainTask(
			fixture.sqlite,
			"databaseCleanupContext",
			{},
			{ executionPolicy: "worker-required" },
		);
		expect(context.narrators).toHaveLength(260);
		expect(context.narrators[1].parentNarratorId).toBe("cleanup-000");
		expect(JSON.parse(String(context.narrators[259].traits))).toEqual(["bot"]);
		expect(context.runningTerminalIds).toEqual([]);
		expect(context.liveTeamIds.toSorted()).toEqual(["cleanup-000", "cleanup-258"]);
		expect(context.narrators.every((row) => !("content_json" in row))).toBe(true);
		expect(prepare).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
		query.mockRestore();
	}
});
