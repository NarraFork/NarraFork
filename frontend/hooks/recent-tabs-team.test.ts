/**
 * Project and team tabs on the client: they live in the sidebar's one list (`work`), lead to
 * their pages, show their own titles, and join the live window under their own key.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { navRowHref } from "../components/nav/recent-tab-keyboard-nav";
import { isPinnedInSidebar } from "../components/nav/recent-tab-page-pin";
import { isTabActive } from "../components/nav/recent-tabs-logic";
import { recentTabWindowHref } from "../components/window/panel-window";
import { api } from "../lib/api";
import {
	accessChangeNeedsRuntimeRefresh,
	projectAccessChangeNeedsRuntimeRefresh,
	type RecentTab,
	recentTabHref,
	recentTabLiveNarratorId,
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
			pages: [{ items: [session], revision: 1, hasMore: false, nextCursor: null }],
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

	test("access changes re-read a team tab's runtime", () => {
		expect(accessChangeNeedsRuntimeRefresh([team], "coord")).toBe(true);
		expect(accessChangeNeedsRuntimeRefresh([team], "other")).toBe(false);
		expect(projectAccessChangeNeedsRuntimeRefresh([team])).toBe(true);
	});
});

describe("pin from the page", () => {
	test("pinned means a pinned tab of that exact entity", () => {
		expect(isPinnedInSidebar([{ ...team, pinned: true }], "team", "coord")).toBe(true);
		expect(isPinnedInSidebar([team], "team", "coord")).toBe(false);
		expect(isPinnedInSidebar([{ ...session, pinned: true }], "team", "coord")).toBe(false);
		expect(isPinnedInSidebar(undefined, "project", "proj")).toBe(false);
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
