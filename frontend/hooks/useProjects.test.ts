import { describe, expect, test } from "bun:test";
import { clearToken, confirmAuthUser, setToken } from "../lib/api/client";
import {
	getRecentTabsScope,
	recentTabsScopeKey,
	requireRecentTabsScope,
} from "../lib/recent-tabs-owner";
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
	test("invalidates only the initiating RecentTabs account after local delete mutation", () => {
		const calls: unknown[][] = [];
		const queryClient = {
			invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
				calls.push([...queryKey]);
			},
		};
		const storage = new Map<string, string>();
		const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => storage.get(key) ?? null,
				setItem: (key: string, value: string) => storage.set(key, value),
				removeItem: (key: string) => storage.delete(key),
			},
		});
		try {
			confirmAuthUser(setToken("project-test-auth"), "project-test-user");
			const scope = getRecentTabsScope();
			requireRecentTabsScope(scope);
			invalidateProjectDeleteQueries(queryClient, scope);
			confirmAuthUser(setToken("project-replacement-auth"), "project-test-user");
			invalidateProjectDeleteQueries(queryClient, scope);
			expect(calls).toEqual([["projects"], [...recentTabsScopeKey(scope)], ["projects"]]);
		} finally {
			clearToken();
			if (original) Object.defineProperty(globalThis, "localStorage", original);
			else Reflect.deleteProperty(globalThis, "localStorage");
		}
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
