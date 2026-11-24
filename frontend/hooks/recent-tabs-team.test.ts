/**
 * Project and team tabs on the client: they live in the sidebar's one list (`work`), lead to
 * their pages, show their own titles, and join the live window under their own key.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { navRowHref } from "../components/nav/recent-tab-keyboard-nav";
import { loadedSidebarPin, resolvePagePin } from "../components/nav/recent-tab-page-pin";
import { isTabActive } from "../components/nav/recent-tabs-logic";
import { recentTabWindowHref } from "../components/window/panel-window";
import { api } from "../lib/api";
import {
	accessChangeNeedsRuntimeRefresh,
	projectAccessChangeNeedsRuntimeRefresh,
	type RecentTab,
	recentTabHref,
	recentTabLiveNarratorId,
	selectProjectRuntimeTabs,
	selectRecentTabsLiveWindow,
} from "./recent-tabs-utils";
import {
	applyRecentTabsDelta,
	clearLoadedTabs,
	type RecentTabsInfiniteData,
	recentTabSection,
	recentTabsOperationSections,
	recentTabsSectionQueryKey,
	setRecentTabPinnedFromPage,
} from "./useRecentTabs";

const team: RecentTab = {
	type: "team",
	id: "coord",
	projectId: "proj",
	title: "Docs crew",
	lastVisitedAt: 1,
};
const project: RecentTab = { type: "project", id: "proj", title: "Repo", lastVisitedAt: 1 };
const session: RecentTab = {
	type: "narrator",
	id: "coord",
	title: "Coordinator",
	lastVisitedAt: 1,
};

afterEach(() => mock.restore());

describe("sections", () => {
	test("project and team tabs are in the sidebar's list, like sessions", () => {
		expect(recentTabSection(project)).toBe("work");
		expect(recentTabSection(team)).toBe("work");
		expect(recentTabSection(session)).toBe("work");
		expect(
			recentTabsOperationSections([
				{ type: "remove", key: "project:proj" },
				{ type: "remove", key: "team:coord" },
			]),
		).toEqual(["work"]);
	});

	test("a delta's project and team upserts land in the loaded work window", () => {
		const qc = new QueryClient();
		qc.setQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"), {
			pages: [{ items: [session], revision: 1, hasMore: false, nextCursor: undefined }],
			pageParams: [undefined],
		});
		applyRecentTabsDelta(qc, {
			baseRevision: 1,
			revision: 2,
			operations: [
				{
					type: "upsert",
					key: "team:coord",
					tab: { ...team, pinned: true },
					beforeKey: "project:proj",
					afterKey: null,
				},
				{
					type: "upsert",
					key: "project:proj",
					tab: { ...project, pinned: true },
					beforeKey: "narrator:coord",
					afterKey: "team:coord",
				},
			],
		});
		const items = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
			?.pages[0]?.items;
		expect(items?.map((tab) => `${tab.type}:${tab.id}`)).toEqual([
			"team:coord",
			"project:proj",
			"narrator:coord",
		]);
	});

	test("clearing inactive sessions keeps project and team tabs", () => {
		const idle: RecentTab = { type: "narrator", id: "idle", title: "x", lastVisitedAt: 1 };
		expect(clearLoadedTabs([team, project, idle], "inactive_narrators")).toEqual([team, project]);
	});
});

describe("links and labels", () => {
	test("each tab leads to its page; a team page needs its project", () => {
		expect(recentTabHref(team)).toBe("/projects/proj/teams/coord");
		expect(recentTabHref(project)).toBe("/projects/proj");
		expect(recentTabHref(session)).toBe("/narrators/coord");
		expect(recentTabHref({ type: "team", id: "coord" })).toBeNull();
		expect(recentTabHref({ type: "folder", id: "f" })).toBeNull();
	});

	test("the team tab is active on its team page, not on the coordinator's session page", () => {
		expect(isTabActive(team, "/projects/proj/teams/coord")).toBe(true);
		expect(isTabActive(team, "/narrators/coord")).toBe(false);
		expect(isTabActive(session, "/projects/proj/teams/coord")).toBe(false);
		expect(isTabActive(project, "/projects/proj")).toBe(true);
	});

	test("open in a window and keyboard Enter reach the team page", () => {
		expect(recentTabWindowHref(team)).toEndWith("/projects/proj/teams/coord");
		expect(recentTabWindowHref({ type: "team", id: "coord" })).toBeNull();
		const { document } = parseHTML(
			'<div data-recent-tab-list><div data-tab-sort-id="team:coord" data-tab-href="/projects/proj/teams/coord"></div></div>',
		);
		const list = document.querySelector("[data-recent-tab-list]");
		expect(navRowHref(list, "team:coord")).toBe("/projects/proj/teams/coord");
		expect(navRowHref(list, "project:proj")).toBe("/projects/proj");
		expect(navRowHref(list, "team:missing")).toBeNull();
	});
});

describe("live window", () => {
	test("a team tab follows its coordinator and sits beside the coordinator's own tab", () => {
		expect(recentTabLiveNarratorId(team)).toBe("coord");
		expect(recentTabLiveNarratorId(project)).toBeNull();
		const live = selectRecentTabsLiveWindow([session, team, project], "/");
		expect(live.map((tab) => `${tab.type}:${tab.id}`)).toEqual(["narrator:coord", "team:coord"]);
	});

	test("project tabs get runtime details apart from the live window, bounded", () => {
		const projects = Array.from({ length: 25 }, (_, i): RecentTab => ({
			type: "project",
			id: `p${i}`,
			title: `P${i}`,
			lastVisitedAt: 1,
			pinned: i === 24,
		}));
		const picked = selectProjectRuntimeTabs([session, ...projects], "/projects/p23");
		// The current page's project, then pinned ones, then the rest, at most 20.
		expect(picked.map((tab) => tab.id).slice(0, 3)).toEqual(["p23", "p24", "p0"]);
		expect(picked).toHaveLength(20);
		expect(picked.every((tab) => tab.type === "project")).toBe(true);
		expect(selectProjectRuntimeTabs([session, team], "/")).toEqual([]);
	});

	test("access changes re-read a team tab's runtime", () => {
		expect(accessChangeNeedsRuntimeRefresh([team], "coord")).toBe(true);
		expect(accessChangeNeedsRuntimeRefresh([team], "other")).toBe(false);
		expect(projectAccessChangeNeedsRuntimeRefresh([team])).toBe(true);
	});
});

describe("pin from the page", () => {
	test("a loaded row answers for that exact entity; an unloaded one is unknown", () => {
		expect(loadedSidebarPin([{ ...team, pinned: true }], "team", "coord")).toBe(true);
		expect(loadedSidebarPin([team], "team", "coord")).toBe(false);
		// The coordinator's session tab is not the team tab.
		expect(loadedSidebarPin([{ ...session, pinned: true }], "team", "coord")).toBeUndefined();
		expect(loadedSidebarPin(undefined, "project", "proj")).toBeUndefined();
	});

	test("the loaded row wins; otherwise the server's read; otherwise unknown", () => {
		expect(resolvePagePin(false, { present: true, pinned: true })).toEqual({
			pinned: false,
			known: true,
		});
		expect(resolvePagePin(undefined, { present: true, pinned: true })).toEqual({
			pinned: true,
			known: true,
		});
		expect(resolvePagePin(undefined, { present: false, pinned: false })).toEqual({
			pinned: false,
			known: true,
		});
		expect(resolvePagePin(undefined, undefined)).toEqual({ pinned: false, known: false });
	});

	test("a pin the server refuses rejects, so the page can say so", async () => {
		const refused = Object.assign(new Error("refused"), { status: 409 });
		spyOn(api, "upsertRecentTab").mockRejectedValue(refused);
		await expect(
			setRecentTabPinnedFromPage({ type: "team", id: "coord", title: "Docs crew" }, true),
		).rejects.toBe(refused);
	});

	test("pinning is one upsert carrying `pin`; unpinning is the ordinary unpin", async () => {
		const result = { changed: false, baseRevision: 0, revision: 0, operations: [] };
		const upsert = spyOn(api, "upsertRecentTab").mockResolvedValue(result);
		const pin = spyOn(api, "pinRecentTab").mockResolvedValue(result);
		await setRecentTabPinnedFromPage({ type: "team", id: "coord", title: "Docs crew" }, true);
		expect(upsert).toHaveBeenCalledTimes(1);
		expect(upsert.mock.calls[0]?.[0]).toMatchObject({
			type: "team",
			id: "coord",
			title: "Docs crew",
			pin: true,
		});
		await setRecentTabPinnedFromPage({ type: "project", id: "proj", title: "Repo" }, false);
		expect(pin).toHaveBeenCalledWith("project:proj", false);
	});
});
