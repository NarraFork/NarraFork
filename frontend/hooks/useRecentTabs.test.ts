import { afterAll, describe, expect, mock, test } from "bun:test";
import type { RecentTabsDelta as RecentTabsDeltaFrame } from "@shared/recent-tabs";
import { QueryClient } from "@tanstack/react-query";
import {
	buildRecentTabUpsert,
	buildSubagentRecentTab,
	bumpRecentTabRuntimeVersions,
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
	refreshRecentTabsLoadedWindow,
} = await import("./useRecentTabs");
const { api } = await import("../lib/api");

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
		expect(applyRecentTabsDelta(qc, delta)).toEqual([]);
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
		).toEqual(["projects", "work"]);
		expect(
			qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("projects"))?.pages[0]
				.revision,
		).toBe(3);
		expect(
			qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))?.pages[0].revision,
		).toBe(3);
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
		).toEqual([]);

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
