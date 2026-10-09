import { afterAll, describe, expect, mock, test } from "bun:test";
import type { RecentTabsDelta as RecentTabsDeltaFrame } from "@shared/recent-tabs";
import { QueryClient } from "@tanstack/react-query";
import {
	buildRecentTabUpsert,
	buildSubagentRecentTab,
	bumpRecentTabRuntimeVersions,
	isRecentTabBackgroundActive,
	mergeRecentTabPatch,
	mergeRecentTabRuntime,
	pruneRecentTabsRuntimeVersions,
	type RecentTab,
	reconcileRecentTabsRuntimePatches,
	selectRecentTabsLiveWindow,
	shouldAddSubagentRecentTab,
	shouldApplyRecentTabsRuntimeResponse,
	snapshotRecentTabRuntimeVersions,
} from "./recent-tabs-utils";
import type { RecentTabsInfiniteData } from "./useRecentTabs";

// Bun's mock.module is process-wide and mock.restore() does NOT undo it, so the
// stub stays namespace-compatible with the production module (a `default`-only
// stub makes any LATER file importing a named i18n export die with
// "Export named 'getNamespacesForPath' not found"), and afterAll restores the
// real module for the rest of the process.
const realI18nModule = { ...(await import("../lib/i18n")) };
const testI18n = {
	language: "en",
	resolvedLanguage: "en",
	t: (key: string) => key,
	changeLanguage: async () => testI18n,
};
const testI18nModule = () => ({
	supportedLanguages: ["en", "zh-CN"],
	namespaces: ["common", "narrator"],
	normalizeLanguage: (language: string | null | undefined) => language ?? "en",
	getNamespacesForPath: () => ["common"],
	getInitialNamespaces: () => ["common"],
	ensureI18nNamespaces: async () => {},
	changeAppLanguage: async () => testI18n,
	initI18n: async () => testI18n,
	default: testI18n,
});
mock.module("../lib/i18n", testI18nModule);
mock.module("@frontend/lib/i18n", testI18nModule);

afterAll(() => {
	mock.module("../lib/i18n", () => realI18nModule);
	mock.module("@frontend/lib/i18n", () => realI18nModule);
	mock.restore();
});

const {
	addRecentTabsBatch,
	applyRecentTabsDelta,
	applyRecentTabsRuntimePatches,
	clearLoadedTabs,
	collectRecentTabsDeltaFrame,
	recentTabsDataRevision,
	recentTabsSectionQueryKey,
	recordRecentTabVisit,
	refreshRecentTabsLoadedWindow,
} = await import("./useRecentTabs");
const { api } = await import("../lib/api");
const { queryClient: globalQC } = await import("../lib/query-client");

describe("isRecentTabBackgroundActive", () => {
	const tab = (activeBackgroundTaskCount?: number): RecentTab =>
		({ type: "narrator", id: "n1", activeBackgroundTaskCount }) as RecentTab;

	test("services do not paint idle or unread tabs blue, mixed work still does", () => {
		const service: RecentTab = {
			...tab(2),
			status: "idle",
			substatus: ["unread"],
			activeBackgroundWorkCount: 0,
			activeBackgroundServiceCount: 2,
		};
		expect(isRecentTabBackgroundActive(service, true)).toBeFalse();
		expect(isRecentTabBackgroundActive(service, false)).toBeFalse();
		expect(
			isRecentTabBackgroundActive({ ...service, activeBackgroundWorkCount: 1 }, true),
		).toBeTrue();
	});

	test("classification survives persisted merges and stale HTTP responses", () => {
		const service: RecentTab = {
			...tab(2),
			activeBackgroundWorkCount: 0,
			activeBackgroundServiceCount: 2,
		};
		expect(mergeRecentTabRuntime(tab(), service)).toMatchObject(service);
		const versions = new Map<string, Map<string, number>>();
		const before = snapshotRecentTabRuntimeVersions(versions, ["n1"]);
		bumpRecentTabRuntimeVersions(versions, "n1", [
			"activeBackgroundWorkCount",
			"activeBackgroundServiceCount",
		]);
		const patches = reconcileRecentTabsRuntimePatches(
			[
				{
					key: "narrator:n1",
					patch: {
						activeBackgroundWorkCount: 9,
						activeBackgroundServiceCount: 0,
						activeTerminalCount: 3,
					},
				},
			],
			new Map([["narrator:n1", "n1"]]),
			before,
			versions,
		);
		expect(patches).toEqual([{ key: "narrator:n1", patch: { activeTerminalCount: 3 } }]);
	});

	test("hollow tab with running background tasks renders half-filled", () => {
		expect(isRecentTabBackgroundActive(tab(2), false)).toBeTrue();
		expect(isRecentTabBackgroundActive(tab(1), false)).toBeTrue();
	});

	test("filled foreground states keep their solid appearance except idle unread", () => {
		expect(isRecentTabBackgroundActive(tab(2), true)).toBeFalse();
		for (const status of ["working", "waiting", "archived"]) {
			expect(
				isRecentTabBackgroundActive({ ...tab(2), status, substatus: ["unread"] }, true),
			).toBeFalse();
		}
		for (const tag of ["error", "planning", "taken_over", "queued"]) {
			expect(
				isRecentTabBackgroundActive(
					{ ...tab(2), status: "idle", substatus: ["unread", tag] },
					true,
				),
			).toBeFalse();
		}
	});

	test("idle unread with background work splits unread green and working blue", () => {
		expect(isRecentTabBackgroundActive({ ...tab(1), substatus: ["unread"] }, true)).toBeTrue();
		for (const substatus of [["unread"], ["unread", "reasoning"]]) {
			const unread = { ...tab(1), status: "idle", substatus };
			expect(isRecentTabBackgroundActive(unread, true)).toBeTrue();
			expect(
				isRecentTabBackgroundActive({ ...unread, activeBackgroundTaskCount: 0 }, true),
			).toBeFalse();
		}
	});

	test("working to idle preserves background occupancy until an explicit zero arrives", () => {
		const working = { ...tab(2), status: "working", substatus: [] };
		const idle = mergeRecentTabPatch(working, { status: "idle", substatus: [] });
		expect(idle.activeBackgroundTaskCount).toBe(2);
		expect(isRecentTabBackgroundActive(idle, false)).toBeTrue();
		const persisted = mergeRecentTabRuntime(
			{ type: "narrator", id: "n1", title: "tab", status: "idle", lastVisitedAt: 1 },
			idle,
		);
		expect(isRecentTabBackgroundActive(persisted, false)).toBeTrue();
		const finished = mergeRecentTabPatch(persisted, { activeBackgroundTaskCount: 0 });
		expect(isRecentTabBackgroundActive(finished, false)).toBeFalse();
	});

	test("no background work means the ordinary hollow icon", () => {
		expect(isRecentTabBackgroundActive(tab(0), false)).toBeFalse();
		expect(isRecentTabBackgroundActive(tab(undefined), false)).toBeFalse();
	});
});

describe("shouldAddSubagentRecentTab", () => {
	test("waits until preferences finish loading", () => {
		expect(
			shouldAddSubagentRecentTab({
				isLoading: true,
				addSubagentToRecentTabs: true,
			}),
		).toBeFalse();
		expect(
			shouldAddSubagentRecentTab({
				isLoading: true,
				addSubagentToRecentTabs: undefined,
			}),
		).toBeFalse();
	});

	test("defaults to enabled after preferences load", () => {
		expect(
			shouldAddSubagentRecentTab({
				isLoading: false,
				addSubagentToRecentTabs: undefined,
			}),
		).toBeTrue();
	});

	test("respects explicit enabled and disabled preferences", () => {
		expect(
			shouldAddSubagentRecentTab({
				isLoading: false,
				addSubagentToRecentTabs: true,
			}),
		).toBeTrue();
		expect(
			shouldAddSubagentRecentTab({
				isLoading: false,
				addSubagentToRecentTabs: false,
			}),
		).toBeFalse();
	});
});

describe("recent tab payload builders", () => {
	test("defaults ordinary visits to a real upsert", () => {
		const payload = buildRecentTabUpsert({
			type: "narrator",
			id: "narrator-1",
			title: "Opened narrator",
			lastVisitedAt: 100,
		});

		expect(payload).toMatchObject({
			type: "narrator",
			id: "narrator-1",
			title: "Opened narrator",
			lastVisitedAt: 100,
			updateOnly: false,
		});
	});

	test("normalizes nullable text fields", () => {
		const payload = buildRecentTabUpsert({
			type: "narrator",
			id: "narrator-null-cwd",
			title: "Narrator without cwd",
			subtitle: null as unknown as string,
		});

		expect(payload.subtitle).toBeUndefined();
	});

	test("builds standalone subagent navigation metadata", () => {
		const payload = buildRecentTabUpsert(
			buildSubagentRecentTab({
				id: "subagent-1",
				parentNarratorId: "parent-1",
				title: "Child task",
				cwd: "/workspace/project",
				status: "working",
				isScheduled: true,
			}),
		);

		expect(payload).toMatchObject({
			type: "subagent",
			id: "subagent-1",
			parentNarratorId: "parent-1",
			title: "Child task",
			subtitle: "/workspace/project",
			status: "working",
			isScheduled: true,
			updateOnly: false,
		});
	});

	test("preserves explicit updateOnly for workspace membership updates", () => {
		const payload = buildRecentTabUpsert({
			type: "chapter",
			id: "chapter-1",
			narratorId: "narrator-1",
			workspaceId: "workspace-1",
			title: "Chapter",
			updateOnly: true,
		});

		expect(payload.updateOnly).toBeTrue();
	});

	test("submits workspace header and child bindings in one batch", async () => {
		const original = api.upsertRecentTabsBatch;
		const calls: Parameters<typeof api.upsertRecentTabsBatch>[0][] = [];
		api.upsertRecentTabsBatch = async (tabs) => {
			calls.push(tabs);
			return { changed: false, baseRevision: 1, revision: 1, operations: [] };
		};
		try {
			await addRecentTabsBatch([
				{ type: "workspace", id: "w1", title: "Workspace" },
				{
					type: "narrator",
					id: "n1",
					title: "",
					workspaceId: "w1",
					updateOnly: true,
				},
			]);
		} finally {
			api.upsertRecentTabsBatch = original;
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]).toHaveLength(2);
		expect(calls[0][1]).toMatchObject({ workspaceId: "w1", updateOnly: true });
	});
});

describe("recordRecentTabVisit", () => {
	/**
	 * Drive one visit and report how many upsert requests it produced. The tab is seeded
	 * into the global cache first, because the dedupe deliberately does not skip a tab
	 * that is no longer in a loaded window.
	 */
	async function visitCalls(
		visits: Array<Parameters<typeof recordRecentTabVisit>[0]>,
		options: { seedLoaded?: boolean } = {},
	): Promise<Array<Parameters<typeof api.upsertRecentTab>[0]>> {
		const original = api.upsertRecentTab;
		const calls: Array<Parameters<typeof api.upsertRecentTab>[0]> = [];
		api.upsertRecentTab = async (tab) => {
			calls.push(tab);
			if (options.seedLoaded !== false) {
				globalQC.setQueryData(
					recentTabsSectionQueryKey(tab.type === "project" ? "projects" : "work"),
					pageData([{ ...tab, lastVisitedAt: tab.lastVisitedAt }], 1),
				);
			}
			return { changed: false, baseRevision: 1, revision: 1, operations: [] };
		};
		try {
			for (const visit of visits) await recordRecentTabVisit(visit);
		} finally {
			api.upsertRecentTab = original;
		}
		return calls;
	}

	test("writes once when only status and lastVisitedAt differ between re-renders", async () => {
		// A narrator page re-runs its visit effect on every status/substatus WS patch.
		const calls = await visitCalls([
			{ type: "narrator", id: "dedupe-status", title: "Task", status: "idle" },
			{ type: "narrator", id: "dedupe-status", title: "Task", status: "working" },
			{
				type: "narrator",
				id: "dedupe-status",
				title: "Task",
				status: "waiting",
				lastVisitedAt: Date.now() + 1_000,
			},
		]);
		expect(calls).toHaveLength(1);
	});

	test("writes again when a persisted field actually changes", async () => {
		const calls = await visitCalls([
			{ type: "narrator", id: "dedupe-title", title: "Untitled" },
			{ type: "narrator", id: "dedupe-title", title: "Untitled" },
			{ type: "narrator", id: "dedupe-title", title: "Renamed by the model" },
		]);
		expect(calls.map((call) => call.title)).toEqual(["Untitled", "Renamed by the model"]);
	});

	test("re-creates a tab that is no longer in any loaded window", async () => {
		// Removing the tab from the sidebar and navigating back must write again, which
		// the signature alone cannot distinguish from a redundant re-render.
		const calls = await visitCalls(
			[
				{ type: "narrator", id: "dedupe-removed", title: "Task" },
				{ type: "narrator", id: "dedupe-removed", title: "Task" },
			],
			{ seedLoaded: false },
		);
		expect(calls).toHaveLength(2);
	});

	test("retries after a failed write instead of remembering it as persisted", async () => {
		const original = api.upsertRecentTab;
		let attempts = 0;
		api.upsertRecentTab = async (tab) => {
			attempts++;
			if (attempts === 1) throw new Error("network down");
			globalQC.setQueryData(
				recentTabsSectionQueryKey("work"),
				pageData([{ ...tab, lastVisitedAt: tab.lastVisitedAt }], 1),
			);
			return { changed: false, baseRevision: 1, revision: 1, operations: [] };
		};
		try {
			await recordRecentTabVisit({ type: "narrator", id: "dedupe-retry", title: "Task" });
			await recordRecentTabVisit({ type: "narrator", id: "dedupe-retry", title: "Task" });
		} finally {
			api.upsertRecentTab = original;
		}
		expect(attempts).toBe(2);
	});
});

function pageData(
	items: RecentTabsInfiniteData["pages"][number]["items"],
	revision: number,
	hasMore = false,
): RecentTabsInfiniteData {
	return {
		pages: [{ items, revision, hasMore, ...(hasMore ? { nextCursor: "cursor" } : {}) }],
		pageParams: [undefined],
	};
}

describe("recent tabs delta reducer", () => {
	test("applies one revision to loaded pages and ignores duplicate delivery", () => {
		const qc = new QueryClient();
		qc.setQueryData(
			recentTabsSectionQueryKey("projects"),
			pageData([{ type: "project", id: "project-1", title: "Project", lastVisitedAt: 1 }], 1),
		);
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData([{ type: "narrator", id: "narrator-1", title: "Old", lastVisitedAt: 1 }], 1),
		);

		const delta = {
			baseRevision: 1,
			revision: 2,
			operations: [
				{
					type: "upsert" as const,
					key: "narrator:narrator-2",
					tab: {
						type: "narrator" as const,
						id: "narrator-2",
						title: "New",
						lastVisitedAt: 2,
					},
					beforeKey: "narrator:narrator-1",
					afterKey: null,
				},
			],
		};
		expect(applyRecentTabsDelta(qc, delta)).toEqual({ gaps: [], backfill: [] });
		expect(
			qc
				.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
				?.pages[0].items.map((tab) => tab.id),
		).toEqual(["narrator-2", "narrator-1"]);
		expect(
			qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("projects"))?.pages[0]
				.revision,
		).toBe(2);

		applyRecentTabsDelta(qc, {
			...delta,
			operations: [{ type: "remove", key: "narrator:narrator-2" }],
		});
		expect(
			qc
				.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
				?.pages[0].items.map((tab) => tab.id),
		).toEqual(["narrator-2", "narrator-1"]);
	});

	test("keeps a boundary tab in place when its next neighbor is outside the loaded window", () => {
		const qc = new QueryClient();
		const loaded: RecentTab[] = Array.from({ length: 50 }, (_, index) => ({
			type: "narrator",
			id: `n${index}`,
			title: `N${index}`,
			lastVisitedAt: index,
		}));
		qc.setQueryData(recentTabsSectionQueryKey("work"), pageData(loaded, 1, true));

		applyRecentTabsDelta(qc, {
			baseRevision: 1,
			revision: 2,
			operations: [
				{
					type: "upsert",
					key: "narrator:n49",
					tab: { ...loaded[49], title: "Renamed" },
					beforeKey: "narrator:n50",
					afterKey: "narrator:n48",
				},
			],
		});

		const items = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
			?.pages[0].items;
		expect(items?.map((tab) => tab.id)).toEqual(loaded.map((tab) => tab.id));
		expect(items?.[49]?.title).toBe("Renamed");
	});

	test("uses the loaded predecessor when the next neighbor belongs to the other section", () => {
		const qc = new QueryClient();
		const loaded: RecentTab[] = ["first", "second", "third"].map((id) => ({
			type: "narrator",
			id,
			title: id,
			lastVisitedAt: 1,
		}));
		qc.setQueryData(recentTabsSectionQueryKey("work"), pageData(loaded, 1));
		qc.setQueryData(
			recentTabsSectionQueryKey("projects"),
			pageData([{ type: "project", id: "p1", title: "Project", lastVisitedAt: 1 }], 1),
		);

		applyRecentTabsDelta(qc, {
			baseRevision: 1,
			revision: 2,
			operations: [
				{
					type: "upsert",
					key: "narrator:second",
					tab: { ...loaded[1], title: "Renamed" },
					beforeKey: "project:p1",
					afterKey: "narrator:first",
				},
			],
		});

		expect(
			qc
				.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
				?.pages[0].items.map((tab) => tab.id),
		).toEqual(["first", "second", "third"]);
	});

	test("does not pull an unloaded tab to the top when both neighbors are unloaded", () => {
		const qc = new QueryClient();
		const loaded: RecentTab[] = ["first", "second"].map((id) => ({
			type: "narrator",
			id,
			title: id,
			lastVisitedAt: 1,
		}));
		qc.setQueryData(recentTabsSectionQueryKey("work"), pageData(loaded, 1, true));

		applyRecentTabsDelta(qc, {
			baseRevision: 1,
			revision: 2,
			operations: [
				{
					type: "upsert",
					key: "narrator:unloaded",
					tab: { type: "narrator", id: "unloaded", title: "Renamed", lastVisitedAt: 1 },
					beforeKey: "narrator:unloaded-next",
					afterKey: "narrator:unloaded-previous",
				},
			],
		});

		expect(
			qc
				.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
				?.pages[0].items.map((tab) => tab.id),
		).toEqual(["first", "second"]);
	});

	test("replays predecessor-based moves without undoing an already positioned block", () => {
		const qc = new QueryClient();
		const loaded: RecentTab[] = ["a", "b", "c", "d"].map((id) => ({
			type: "narrator",
			id,
			title: id,
			lastVisitedAt: 1,
		}));
		qc.setQueryData(recentTabsSectionQueryKey("work"), pageData(loaded, 1));

		applyRecentTabsDelta(qc, {
			baseRevision: 1,
			revision: 2,
			operations: [
				{ type: "move", key: "narrator:c", beforeKey: "narrator:d", afterKey: null },
				{ type: "move", key: "narrator:d", beforeKey: "narrator:a", afterKey: "narrator:c" },
			],
		});

		expect(
			qc
				.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
				?.pages[0].items.map((tab) => tab.id),
		).toEqual(["c", "d", "a", "b"]);
	});

	test("does not move a workspace back to the top using its own child as an anchor", () => {
		const qc = new QueryClient();
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData(
				[
					{ type: "workspace", id: "w2", title: "W2", lastVisitedAt: 1 },
					{ type: "narrator", id: "c2", title: "C2", workspaceId: "w2", lastVisitedAt: 1 },
					{ type: "workspace", id: "w1", title: "W1", lastVisitedAt: 1 },
					{ type: "narrator", id: "c1", title: "C1", workspaceId: "w1", lastVisitedAt: 1 },
				],
				1,
			),
		);

		applyRecentTabsDelta(qc, {
			baseRevision: 1,
			revision: 2,
			operations: [
				{ type: "move", key: "workspace:w1", beforeKey: "narrator:c1", afterKey: null },
				{
					type: "move",
					key: "workspace:w2",
					beforeKey: "narrator:c2",
					afterKey: "narrator:c1",
				},
			],
		});

		expect(
			qc
				.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
				?.pages[0].items.map((tab) => tab.id),
		).toEqual(["w1", "c1", "w2", "c2"]);
	});

	test("backfills a tab moved into the window when the delta has no tab payload", () => {
		const qc = new QueryClient();
		const loaded: RecentTab[] = [
			{ type: "narrator", id: "first", title: "First", lastVisitedAt: 1 },
		];
		qc.setQueryData(recentTabsSectionQueryKey("work"), pageData(loaded, 1, true));

		expect(
			applyRecentTabsDelta(qc, {
				baseRevision: 1,
				revision: 2,
				operations: [
					{ type: "move", key: "narrator:unloaded", beforeKey: "narrator:first", afterKey: null },
				],
			}),
		).toEqual({ gaps: [], backfill: ["work"] });
		expect(
			qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))?.pages[0].items,
		).toEqual(loaded);
	});

	test("backfills after a loaded tab moves outside the visible prefix", () => {
		const qc = new QueryClient();
		const loaded: RecentTab[] = ["first", "second"].map((id) => ({
			type: "narrator",
			id,
			title: id,
			lastVisitedAt: 1,
		}));
		qc.setQueryData(recentTabsSectionQueryKey("work"), pageData(loaded, 1, true));

		expect(
			applyRecentTabsDelta(qc, {
				baseRevision: 1,
				revision: 2,
				operations: [
					{
						type: "move",
						key: "narrator:second",
						beforeKey: "narrator:unloaded-next",
						afterKey: "narrator:unloaded-previous",
					},
				],
			}),
		).toEqual({ gaps: [], backfill: ["work"] });
		expect(
			qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))?.pages[0].items,
		).toEqual([loaded[0]]);
	});

	test("keeps optimistic inserts bounded to the loaded page window", () => {
		const qc = new QueryClient();
		const loaded = Array.from({ length: 50 }, (_, index) => ({
			type: "narrator" as const,
			id: `n${index}`,
			title: `N${index}`,
			lastVisitedAt: index,
		}));
		qc.setQueryData(recentTabsSectionQueryKey("work"), pageData(loaded, 1, true));

		applyRecentTabsDelta(qc, {
			baseRevision: 1,
			revision: 2,
			operations: [
				{
					type: "upsert",
					key: "narrator:new",
					tab: { type: "narrator", id: "new", title: "New", lastVisitedAt: 51 },
					beforeKey: "narrator:n0",
					afterKey: null,
				},
			],
		});
		const items = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
			?.pages[0].items;
		expect(items).toHaveLength(50);
		expect(items?.[0]?.id).toBe("new");
		expect(items?.some((tab) => tab.id === "n49")).toBeFalse();
	});

	test("rejects an infinite window whose pages have mixed revisions", () => {
		const data: RecentTabsInfiniteData = {
			pages: [
				{
					items: [{ type: "narrator", id: "n1", title: "N1", lastVisitedAt: 1 }],
					revision: 3,
					hasMore: true,
					nextCursor: "cursor",
				},
				{
					items: [{ type: "narrator", id: "n2", title: "N2", lastVisitedAt: 2 }],
					revision: 4,
					hasMore: false,
				},
			],
			pageParams: [undefined, "cursor"],
		};
		expect(recentTabsDataRevision(data)).toBeUndefined();
	});

	test("keeps runtime fields when a revisit upserts the same tab", () => {
		const qc = new QueryClient();
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData(
				[
					{
						type: "chapter",
						id: "c1",
						narratorId: "n1",
						title: "Chapter",
						lastVisitedAt: 1,
						status: "working",
						substatus: ["planning"],
						activeTerminalCount: 2,
						viewers: [{ userId: "u1", username: "u1", avatarColor: null, avatarImageId: null }],
						viewerCount: 1,
						containerStatus: "running",
						hasDraft: true,
					} as RecentTab,
				],
				1,
			),
		);

		applyRecentTabsDelta(qc, {
			baseRevision: 1,
			revision: 2,
			operations: [
				{
					type: "upsert",
					key: "chapter:c1",
					// A delta only carries persisted columns.
					tab: {
						type: "chapter",
						id: "c1",
						narratorId: "n1",
						title: "Chapter",
						lastVisitedAt: 99,
					},
					beforeKey: null,
					afterKey: null,
				},
			],
		});

		const tab = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))?.pages[0]
			.items[0] as RecentTab | undefined;
		expect(tab?.lastVisitedAt).toBe(99);
		expect(tab?.status).toBe("working");
		expect(tab?.substatus).toEqual(["planning"]);
		expect(tab?.activeTerminalCount).toBe(2);
		expect(tab?.viewerCount).toBe(1);
		expect(tab?.containerStatus).toBe("running");
		expect(tab?.hasDraft).toBeTrue();
	});

	test("does not advance any loaded section when baseRevision has a gap", () => {
		const qc = new QueryClient();
		qc.setQueryData(
			recentTabsSectionQueryKey("projects"),
			pageData([{ type: "project", id: "p1", title: "P1", lastVisitedAt: 1 }], 3),
		);
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData([{ type: "narrator", id: "n1", title: "N1", lastVisitedAt: 1 }], 3),
		);

		expect(
			applyRecentTabsDelta(qc, {
				baseRevision: 4,
				revision: 5,
				operations: [{ type: "remove", key: "narrator:n1" }],
			}),
		).toEqual({ gaps: ["projects", "work"], backfill: [] });
		expect(
			qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("projects"))?.pages[0]
				.revision,
		).toBe(3);
		expect(
			qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))?.pages[0].revision,
		).toBe(3);
	});

	test("a gap does not invalidate the section queries on top of the caller's reset", () => {
		const qc = new QueryClient();
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData([{ type: "narrator", id: "n1", title: "N1", lastVisitedAt: 1 }], 3),
		);
		const invalidated: unknown[] = [];
		const originalInvalidate = qc.invalidateQueries.bind(qc);
		qc.invalidateQueries = ((filters?: unknown) => {
			invalidated.push(filters);
			return Promise.resolve();
		}) as typeof qc.invalidateQueries;
		try {
			applyRecentTabsDelta(qc, {
				baseRevision: 4,
				revision: 5,
				operations: [{ type: "remove", key: "narrator:n1" }],
			});
		} finally {
			qc.invalidateQueries = originalInvalidate;
		}
		expect(invalidated).toEqual([]);
	});

	test("an applied revision needs no page fetch, but a shrunk full window does", () => {
		const qc = new QueryClient();
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData(
				[
					{ type: "narrator", id: "n1", title: "N1", lastVisitedAt: 2 },
					{ type: "narrator", id: "n2", title: "N2", lastVisitedAt: 1 },
				],
				1,
			),
		);

		// A visit upsert reorders/updates in place: nothing left the window.
		expect(
			applyRecentTabsDelta(qc, {
				baseRevision: 1,
				revision: 2,
				operations: [
					{
						type: "upsert",
						key: "narrator:n2",
						tab: { type: "narrator", id: "n2", title: "N2", lastVisitedAt: 9 },
						beforeKey: "narrator:n1",
						afterKey: null,
					},
				],
			}),
		).toEqual({ gaps: [], backfill: [] });

		// A removal from a window with no further server rows still needs no fetch.
		expect(
			applyRecentTabsDelta(qc, {
				baseRevision: 2,
				revision: 3,
				operations: [{ type: "remove", key: "narrator:n2" }],
			}),
		).toEqual({ gaps: [], backfill: [] });

		// The same removal when the server has more rows leaves an empty slot.
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData(
				[
					{ type: "narrator", id: "n1", title: "N1", lastVisitedAt: 2 },
					{ type: "narrator", id: "n2", title: "N2", lastVisitedAt: 1 },
				],
				3,
				true,
			),
		);
		expect(
			applyRecentTabsDelta(qc, {
				baseRevision: 3,
				revision: 4,
				operations: [{ type: "remove", key: "narrator:n2" }],
			}),
		).toEqual({ gaps: [], backfill: ["work"] });
	});

	test("keeps runtime-enriched fields when a visit upserts only persisted columns", () => {
		const qc = new QueryClient();
		const enriched: RecentTab = {
			type: "narrator",
			id: "n1",
			title: "Old title",
			lastVisitedAt: 1,
			status: "working",
			substatus: ["unread"],
			activeTerminalCount: 2,
			viewers: [
				{ userId: "u1", username: "alice", avatarColor: "indigo", avatarImageId: null },
				{ userId: "u2", username: "bob", avatarColor: null, avatarImageId: null },
			],
			viewerCount: 2,
			containerStatus: "running",
			hasDraft: true,
		};
		qc.setQueryData(recentTabsSectionQueryKey("work"), pageData([enriched], 1));

		// Mirrors addRecentTab() on navigation: the server delta carries persisted columns only.
		expect(
			applyRecentTabsDelta(qc, {
				baseRevision: 1,
				revision: 2,
				operations: [
					{
						type: "upsert",
						key: "narrator:n1",
						tab: {
							type: "narrator",
							id: "n1",
							title: "New title",
							lastVisitedAt: 99,
							status: "working",
						},
						beforeKey: null,
						afterKey: null,
					},
				],
			}),
		).toEqual({ gaps: [], backfill: [] });

		const tab = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))?.pages[0]
			.items[0] as RecentTab | undefined;
		expect(tab).toMatchObject({
			title: "New title",
			lastVisitedAt: 99,
			activeTerminalCount: 2,
			viewerCount: 2,
			containerStatus: "running",
			hasDraft: true,
			substatus: ["unread"],
		});
		expect(tab?.viewers?.map((viewer) => viewer.userId)).toEqual(["u1", "u2"]);
	});

	test("does not invent runtime fields for a newly inserted tab", () => {
		const qc = new QueryClient();
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData([{ type: "narrator", id: "n1", title: "N1", lastVisitedAt: 1 }], 1),
		);

		applyRecentTabsDelta(qc, {
			baseRevision: 1,
			revision: 2,
			operations: [
				{
					type: "upsert",
					key: "narrator:n2",
					tab: { type: "narrator", id: "n2", title: "N2", lastVisitedAt: 2 },
					beforeKey: "narrator:n1",
					afterKey: null,
				},
			],
		});

		const inserted = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
			?.pages[0].items[0] as RecentTab | undefined;
		expect(inserted?.id).toBe("n2");
		expect(inserted?.activeTerminalCount).toBeUndefined();
		expect(inserted?.hasDraft).toBeUndefined();
	});
});

describe("recent tabs delta batching", () => {
	test("waits for every frame and preserves batch order", () => {
		const state = new Map();
		const frames: RecentTabsDeltaFrame[] = [
			{
				type: "user:recent_tabs_delta",
				baseRevision: 8,
				revision: 9,
				batchIndex: 1,
				batchCount: 2,
				operations: [{ type: "remove", key: "narrator:second" }],
			},
			{
				type: "user:recent_tabs_delta",
				baseRevision: 8,
				revision: 9,
				batchIndex: 0,
				batchCount: 2,
				operations: [{ type: "remove", key: "narrator:first" }],
			},
		];

		expect(collectRecentTabsDeltaFrame(state, frames[0])).toEqual({ status: "pending" });
		expect(collectRecentTabsDeltaFrame(state, frames[1])).toEqual({
			status: "complete",
			delta: {
				baseRevision: 8,
				revision: 9,
				operations: [
					{ type: "remove", key: "narrator:first" },
					{ type: "remove", key: "narrator:second" },
				],
			},
		});
	});

	test("reports a gap when a later revision overtakes an incomplete frame", () => {
		const state = new Map();
		collectRecentTabsDeltaFrame(state, {
			type: "user:recent_tabs_delta",
			baseRevision: 8,
			revision: 9,
			batchIndex: 0,
			batchCount: 2,
			operations: [{ type: "remove", key: "narrator:first" }],
		});
		expect(
			collectRecentTabsDeltaFrame(state, {
				type: "user:recent_tabs_delta",
				baseRevision: 9,
				revision: 10,
				batchIndex: 0,
				batchCount: 1,
				operations: [{ type: "remove", key: "narrator:later" }],
			}),
		).toEqual({ status: "gap" });
		expect(state.size).toBe(0);
	});
});

describe("recent tabs loaded-window refresh", () => {
	test("preserves loaded page counts and retries a mixed-revision cursor window", async () => {
		const qc = new QueryClient();
		const makeExisting = (section: "projects" | "work", pageCount: number) =>
			({
				pages: Array.from({ length: pageCount }, (_, pageIndex) => ({
					items: Array.from({ length: 50 }, (_, itemIndex) => ({
						type: section === "projects" ? ("project" as const) : ("narrator" as const),
						id: `${section}-old-${pageIndex}-${itemIndex}`,
						title: "Old",
						lastVisitedAt: itemIndex,
					})),
					revision: 1,
					hasMore: pageIndex < pageCount - 1,
					...(pageIndex < pageCount - 1 ? { nextCursor: `${section}:${pageIndex + 1}` } : {}),
				})),
				pageParams: Array.from({ length: pageCount }, (_, index) =>
					index === 0 ? undefined : `${section}:${index}`,
				),
			}) satisfies RecentTabsInfiniteData;
		qc.setQueryData(recentTabsSectionQueryKey("projects"), makeExisting("projects", 4));
		qc.setQueryData(recentTabsSectionQueryKey("work"), makeExisting("work", 2));

		const original = api.getRecentTabsPage;
		let injectedMixedRevision = false;
		api.getRecentTabsPage = async (section, params = {}) => {
			const pageIndex = params.cursor ? Number(params.cursor.split(":").at(-1)) : 0;
			const pageCount = section === "projects" ? 4 : 2;
			let revision = 2;
			if (section === "projects" && pageIndex === 1 && !injectedMixedRevision) {
				injectedMixedRevision = true;
				revision = 3;
			}
			return {
				items: Array.from({ length: 50 }, (_, itemIndex) => ({
					type: section === "projects" ? ("project" as const) : ("narrator" as const),
					id: `${section}-new-${pageIndex}-${itemIndex}`,
					title: "New",
					lastVisitedAt: itemIndex,
				})),
				revision,
				hasMore: pageIndex < pageCount - 1,
				...(pageIndex < pageCount - 1 ? { nextCursor: `${section}:${pageIndex + 1}` } : {}),
			};
		};
		try {
			await refreshRecentTabsLoadedWindow(qc, { reset: true });
		} finally {
			api.getRecentTabsPage = original;
		}

		const projects = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("projects"));
		const work = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"));
		expect(projects?.pages).toHaveLength(4);
		expect(projects?.pages.flatMap((page) => page.items)).toHaveLength(200);
		expect(work?.pages).toHaveLength(2);
		expect(projects?.pages.every((page) => page.revision === 2)).toBeTrue();
		expect(work?.pages.every((page) => page.revision === 2)).toBeTrue();
	});

	test("does not let an older refresh overwrite a newer minimum revision", async () => {
		const qc = new QueryClient();
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData([{ type: "narrator", id: "old", title: "Old", lastVisitedAt: 1 }], 1),
		);
		const original = api.getRecentTabsPage;
		const pending: Array<{
			resolve: (page: Awaited<ReturnType<typeof api.getRecentTabsPage>>) => void;
		}> = [];
		api.getRecentTabsPage = () =>
			new Promise((resolve) => {
				pending.push({ resolve });
			});
		try {
			const older = refreshRecentTabsLoadedWindow(qc, { minimumRevision: 2 });
			while (pending.length < 1) await Promise.resolve();
			const newer = refreshRecentTabsLoadedWindow(qc, { minimumRevision: 3 });
			while (pending.length < 2) await Promise.resolve();
			pending[1].resolve({
				items: [{ type: "narrator", id: "new", title: "New", lastVisitedAt: 3 }],
				revision: 3,
				hasMore: false,
			});
			await newer;
			pending[0].resolve({
				items: [{ type: "narrator", id: "older", title: "Older", lastVisitedAt: 2 }],
				revision: 2,
				hasMore: false,
			});
			await older;
		} finally {
			api.getRecentTabsPage = original;
		}
		expect(
			qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))?.pages[0].revision,
		).toBe(3);
	});

	test("keeps runtime fields a WS event wrote while the pages were in flight", async () => {
		const qc = new QueryClient();
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData(
				[
					{
						type: "narrator",
						id: "n1",
						title: "N1",
						lastVisitedAt: 1,
						status: "idle",
					} as RecentTab,
				],
				1,
			),
		);
		const original = api.getRecentTabsPage;
		let resolvePage:
			| ((page: Awaited<ReturnType<typeof api.getRecentTabsPage>>) => void)
			| undefined;
		api.getRecentTabsPage = () =>
			new Promise((resolve) => {
				resolvePage = resolve;
			});
		try {
			const refresh = refreshRecentTabsLoadedWindow(qc, { minimumRevision: 2 });
			while (!resolvePage) await Promise.resolve();
			// A narrator started working while the page request was open.
			applyRecentTabsRuntimePatches(qc, [
				{ key: "narrator:n1", patch: { status: "working", substatus: ["reasoning"] } },
			]);
			resolvePage({
				items: [{ type: "narrator", id: "n1", title: "N1", lastVisitedAt: 1, status: "idle" }],
				revision: 2,
				hasMore: false,
			});
			await refresh;
		} finally {
			api.getRecentTabsPage = original;
		}

		const tab = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))?.pages[0]
			.items[0] as RecentTab | undefined;
		expect(tab?.status).toBe("working");
		expect(tab?.substatus).toEqual(["reasoning"]);
	});
});

describe("recent tabs runtime races", () => {
	test("prunes versions outside the live window but retains in-flight snapshots", () => {
		const versions = new Map([
			["live", new Map([["status", 1]])],
			["in-flight", new Map([["status", 2]])],
			["stale", new Map([["status", 3]])],
		]);

		pruneRecentTabsRuntimeVersions(versions, new Set(["live"]), [new Set(["in-flight"])]);
		expect([...versions.keys()]).toEqual(["live", "in-flight"]);

		pruneRecentTabsRuntimeVersions(versions, new Set(["live"]), []);
		expect([...versions.keys()]).toEqual(["live"]);
	});

	test("rejects an older runtime request generation", () => {
		expect(shouldApplyRecentTabsRuntimeResponse(4, 5)).toBeFalse();
		expect(shouldApplyRecentTabsRuntimeResponse(5, 5)).toBeTrue();
	});

	test("bumps only the fields a WS event actually delivered", () => {
		const versions = new Map();
		bumpRecentTabRuntimeVersions(versions, "n1", ["status", "substatus"]);
		bumpRecentTabRuntimeVersions(versions, "n1", ["status"]);

		expect(versions.get("n1")).toEqual(
			new Map([
				["status", 2],
				["substatus", 1],
			]),
		);
	});

	test("snapshots per-narrator field counters independently of later bumps", () => {
		const versions = new Map();
		bumpRecentTabRuntimeVersions(versions, "n1", ["status"]);
		const snapshot = snapshotRecentTabRuntimeVersions(versions, ["n1", "n2"]);
		bumpRecentTabRuntimeVersions(versions, "n1", ["status"]);

		expect(snapshot.get("n1")).toEqual(new Map([["status", 1]]));
		expect(snapshot.get("n2")).toEqual(new Map());
		expect(versions.get("n1")).toEqual(new Map([["status", 2]]));
	});

	test("a stale runtime zero cannot erase background occupancy delivered over WS", () => {
		const versions = new Map();
		const snapshot = snapshotRecentTabRuntimeVersions(versions, ["n1"]);
		bumpRecentTabRuntimeVersions(versions, "n1", ["activeBackgroundTaskCount"]);
		const patches = reconcileRecentTabsRuntimePatches(
			[{ key: "narrator:n1", patch: { status: "idle", activeBackgroundTaskCount: 0 } }],
			new Map([["narrator:n1", "n1"]]),
			snapshot,
			versions,
		);
		expect(patches).toEqual([{ key: "narrator:n1", patch: { status: "idle" } }]);
		const idle = mergeRecentTabPatch(
			{
				type: "narrator",
				id: "n1",
				title: "tab",
				status: "working",
				activeBackgroundTaskCount: 1,
				lastVisitedAt: 1,
			},
			patches[0]?.patch ?? {},
		);
		expect(isRecentTabBackgroundActive(idle, false)).toBeTrue();
	});

	test("drops only a stale terminal count after a newer WS update", () => {
		const patches = reconcileRecentTabsRuntimePatches(
			[
				{
					key: "narrator:n1",
					patch: { status: "working", activeTerminalCount: 0, hasDraft: true },
				},
			],
			new Map([["narrator:n1", "n1"]]),
			new Map([["n1", new Map([["activeTerminalCount", 2]])]]),
			new Map([["n1", new Map([["activeTerminalCount", 3]])]]),
		);

		expect(patches).toEqual([{ key: "narrator:n1", patch: { status: "working", hasDraft: true } }]);
	});

	test("keeps a status delivered by WS while still refreshing untouched fields", () => {
		const patches = reconcileRecentTabsRuntimePatches(
			[
				{
					key: "narrator:n1",
					patch: { status: "idle", substatus: null, activeTerminalCount: 2 },
				},
			],
			new Map([["narrator:n1", "n1"]]),
			new Map([["n1", new Map()]]),
			new Map([
				[
					"n1",
					new Map([
						["status", 1],
						["substatus", 1],
					]),
				],
			]),
		);

		expect(patches).toEqual([{ key: "narrator:n1", patch: { activeTerminalCount: 2 } }]);
	});

	test("filters a patch emptied by dropping its stale terminal count", () => {
		const patches = reconcileRecentTabsRuntimePatches(
			[
				{ key: "narrator:n1", patch: { activeTerminalCount: 1 } },
				{ key: "narrator:n2", patch: { hasDraft: false } },
			],
			new Map([
				["narrator:n1", "n1"],
				["narrator:n2", "n2"],
			]),
			new Map([["n1", new Map([["activeTerminalCount", 2]])]]),
			new Map([["n1", new Map([["activeTerminalCount", 3]])]]),
		);

		expect(patches).toEqual([{ key: "narrator:n2", patch: { hasDraft: false } }]);
	});

	test("keeps an explicit zero when no newer terminal-count WS update arrived", () => {
		const patches = reconcileRecentTabsRuntimePatches(
			[{ key: "chapter:c1", patch: { activeTerminalCount: 0 } }],
			new Map([["chapter:c1", "n1"]]),
			new Map([["n1", new Map([["activeTerminalCount", 7]])]]),
			new Map([["n1", new Map([["activeTerminalCount", 7]])]]),
		);

		expect(patches).toEqual([{ key: "chapter:c1", patch: { activeTerminalCount: 0 } }]);
	});
});

describe("recent tab identity preservation", () => {
	test("returns the previous tab when a runtime patch changes nothing", () => {
		const viewers = [{ userId: "u1", username: "u1", avatarColor: null, avatarImageId: null }];
		const tab: RecentTab = {
			type: "narrator",
			id: "n1",
			title: "N1",
			lastVisitedAt: 1,
			status: "idle",
			substatus: ["unread"],
			activeTerminalCount: 1,
			viewers,
			viewerCount: 1,
			containerStatus: null,
			hasDraft: false,
		};

		// Runtime polls hand back freshly allocated arrays with identical contents.
		const patched = mergeRecentTabPatch(tab, {
			status: "idle",
			substatus: ["unread"],
			activeTerminalCount: 1,
			viewers: [{ userId: "u1", username: "u1", avatarColor: null, avatarImageId: null }],
			viewerCount: 1,
			containerStatus: null,
			hasDraft: false,
		});

		expect(patched).toBe(tab);
		expect(mergeRecentTabPatch(tab, { activeTerminalCount: 3 })).not.toBe(tab);
		expect(mergeRecentTabPatch(tab, { activeTerminalCount: 3 }).activeTerminalCount).toBe(3);
	});

	test("keeps identity when an upsert carries no persisted change", () => {
		const previous: RecentTab = {
			type: "narrator",
			id: "n1",
			title: "N1",
			lastVisitedAt: 5,
			status: "working",
			activeTerminalCount: 2,
		};

		expect(
			mergeRecentTabRuntime(
				{ type: "narrator", id: "n1", title: "N1", lastVisitedAt: 5 },
				previous,
			),
		).toBe(previous);
	});

	test("a no-op runtime tick leaves both cache entries byte-identical", () => {
		// The per-tab merge already preserves identity; this asserts the cache WRITE does
		// too. Allocating a new window object here re-renders every consumer of the
		// recent-tabs cache (app shell, sidebar lists, graph) on each status tick.
		const qc = new QueryClient();
		const tab: RecentTab = {
			type: "narrator",
			id: "n1",
			title: "N1",
			lastVisitedAt: 1,
			status: "working",
			substatus: ["reasoning"],
			activeTerminalCount: 1,
		};
		qc.setQueryData(recentTabsSectionQueryKey("work"), pageData([tab], 1));
		applyRecentTabsRuntimePatches(qc, [
			{ key: "narrator:n1", patch: { status: "working", substatus: ["reasoning"] } },
		]);
		const windowBefore = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"));
		const flatBefore = qc.getQueryData<RecentTab[]>(["user-preferences", "recent-tabs"]);

		applyRecentTabsRuntimePatches(qc, [
			// Same values, freshly allocated array — exactly what a runtime poll returns.
			{ key: "narrator:n1", patch: { status: "working", substatus: ["reasoning"] } },
		]);

		expect(qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))).toBe(
			windowBefore,
		);
		expect(qc.getQueryData<RecentTab[]>(["user-preferences", "recent-tabs"])).toBe(flatBefore);

		// A real change must still produce new objects, or the rows would never update.
		applyRecentTabsRuntimePatches(qc, [
			{ key: "narrator:n1", patch: { status: "idle", substatus: [] } },
		]);
		expect(qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))).not.toBe(
			windowBefore,
		);
		expect(qc.getQueryData<RecentTab[]>(["user-preferences", "recent-tabs"])).not.toBe(flatBefore);
	});

	test("an applied delta that changes nothing observable keeps the window object", () => {
		const qc = new QueryClient();
		qc.setQueryData(
			recentTabsSectionQueryKey("work"),
			pageData([{ type: "narrator", id: "n1", title: "N1", lastVisitedAt: 1 }], 1),
		);
		const windowBefore = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"));

		// A revision bump IS observable (it gates cursor validity), so this must allocate.
		applyRecentTabsDelta(qc, {
			baseRevision: 1,
			revision: 2,
			operations: [{ type: "remove", key: "narrator:absent" }],
		});
		expect(qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))).not.toBe(
			windowBefore,
		);
	});
});

describe("recent tabs live window", () => {
	test("prioritizes current, pinned, attention, draft, then loaded order", () => {
		const tabs: RecentTab[] = Array.from({ length: 150 }, (_, index) => ({
			type: "narrator" as const,
			id: `n${index}`,
			title: `Narrator ${index}`,
			lastVisitedAt: index,
		}));
		tabs[120].pinned = true;
		tabs[110].status = "working";
		tabs[105].hasDraft = true;

		expect(selectRecentTabsLiveWindow(tabs, "/narrators/n149", 5).map((tab) => tab.id)).toEqual([
			"n149",
			"n120",
			"n110",
			"n105",
			"n0",
		]);
	});
});

describe("recent tabs optimistic clear", () => {
	const tab = (overrides: Partial<RecentTab> & Pick<RecentTab, "id">): RecentTab => ({
		type: "narrator",
		title: `Tab ${overrides.id}`,
		lastVisitedAt: 0,
		...overrides,
	});

	test("keeps pinned tabs in every scope", () => {
		const tabs: RecentTab[] = [
			tab({ id: "p-pinned", type: "project", pinned: true }),
			tab({ id: "p-plain", type: "project" }),
			tab({ id: "n-pinned", pinned: true }),
			tab({ id: "n-idle" }),
		];

		expect(clearLoadedTabs(tabs, "all").map((item) => item.id)).toEqual(["p-pinned", "n-pinned"]);
		expect(clearLoadedTabs(tabs, "projects").map((item) => item.id)).toEqual([
			"p-pinned",
			"n-pinned",
			"n-idle",
		]);
		expect(clearLoadedTabs(tabs, "inactive_narrators").map((item) => item.id)).toEqual([
			"p-pinned",
			"p-plain",
			"n-pinned",
		]);
	});

	test("keeps a pinned workspace group together", () => {
		const tabs: RecentTab[] = [
			tab({ id: "ws-1", type: "workspace", pinned: true }),
			tab({ id: "child-1", workspaceId: "ws-1" }),
			tab({ id: "n-idle" }),
		];

		for (const scope of ["all", "inactive_narrators"] as const) {
			expect(clearLoadedTabs(tabs, scope).map((item) => item.id)).toEqual(["ws-1", "child-1"]);
		}
	});
});
