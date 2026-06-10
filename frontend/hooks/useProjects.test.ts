import { describe, expect, test } from "bun:test";
import {
	invalidateProjectCreateQueries,
	invalidateProjectDeleteQueries,
	recentTabsSnapshotRemovedProject,
} from "./useProjects";

describe("project create frontend refresh helpers", () => {
	test("invalidates project list after local create mutation or clone stream success", () => {
		const calls: unknown[][] = [];
		invalidateProjectCreateQueries({
			invalidateQueries: ({ queryKey }) => {
				calls.push([...queryKey]);
			},
		});

		expect(calls).toEqual([["projects"]]);
	});
});

describe("project delete frontend refresh helpers", () => {
	test("invalidates project list and recent tabs after local delete mutation", () => {
		const calls: unknown[][] = [];
		invalidateProjectDeleteQueries({
			invalidateQueries: ({ queryKey }) => {
				calls.push([...queryKey]);
			},
		});

		expect(calls).toEqual([["projects"], ["user-preferences", "recent-tabs"]]);
	});

	test("refreshes project list when a recent-tabs snapshot removes a project tab", () => {
		expect(
			recentTabsSnapshotRemovedProject(
				[
					{ type: "project", id: "p1" },
					{ type: "chapter", id: "c1" },
				],
				[{ type: "chapter", id: "c1" }],
			),
		).toBe(true);
	});

	test("ignores snapshots that keep all project tabs or remove only non-project tabs", () => {
		expect(
			recentTabsSnapshotRemovedProject(
				[
					{ type: "project", id: "p1" },
					{ type: "chapter", id: "c1" },
				],
				[{ type: "project", id: "p1" }],
			),
		).toBe(false);
		expect(recentTabsSnapshotRemovedProject([{ type: "chapter", id: "c1" }], [])).toBe(false);
	});

	test("treats an empty snapshot as a removed project when a project tab existed", () => {
		expect(recentTabsSnapshotRemovedProject([{ type: "project", id: "p1" }], [])).toBe(true);
	});
});
