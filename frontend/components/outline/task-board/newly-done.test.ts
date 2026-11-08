/**
 * 「新完成」 seen on a board (outline P2 PR 9b): the cached board reads drop the mark of the tasks
 * the reader saw, at the version they saw, and only theirs, so a board opened again from the cache
 * does not show it.
 */
import { describe, expect, test } from "bun:test";
import type { OutlineBoardTask, OutlineTaskBoardResponse } from "@shared/outline-task-board";
import { withoutNewlyDone } from "./TaskBoard";

const task = (id: string, newlyDone: boolean, versionSeq = 3): OutlineBoardTask => ({
	id,
	spaceId: "s",
	sid: id,
	address: `k/${id}`,
	pageId: "p",
	title: id,
	status: "done",
	waiting: null,
	assignee: null,
	executor: { kind: "none" },
	humanCreated: true,
	lock: null,
	plan: null,
	completion: null,
	versionSeq,
	...(newlyDone ? { newlyDone: true as const } : {}),
});

describe("withoutNewlyDone", () => {
	test("drops the mark of the tasks seen at the version seen, keeps the others", () => {
		const board: OutlineTaskBoardResponse = {
			scope: { kind: "session", narratorId: "n" },
			canAdd: false,
			nextCursor: null,
			me: { userId: "u", name: "u" },
			sections: [
				{
					space: {
						id: "s",
						key: "k",
						kind: "session",
						projectId: null,
						narratorId: "n",
						label: null,
					},
					canWrite: true,
					role: "own",
					open: [],
					openTruncated: false,
					finished: [task("a", true), task("b", true), task("c", false), task("d", true, 5)],
					finishedCursor: null,
				},
			],
		};
		// `d` was seen at version 4; the board read since shows it finished again, at version 5.
		const after = withoutNewlyDone(board, new Set(["a:3", "c:3", "d:4"]));
		expect(after.sections[0]?.finished.map((t) => [t.id, t.newlyDone === true])).toEqual([
			["a", false],
			["b", true],
			["c", false],
			["d", true],
		]);
		expect(after.sections[0]?.finished[0]).not.toHaveProperty("newlyDone");
		// The read it came from is left as it was.
		expect(board.sections[0]?.finished[0]?.newlyDone).toBe(true);
	});
});
