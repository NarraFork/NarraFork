import { describe, expect, test } from "bun:test";
import type {
	CommunicationCandidate,
	CommunicationCandidates,
} from "@shared/narrator-communication";
import type { PersistedRecentTab } from "@shared/recent-tabs";
import {
	localNarratorMentionCandidates,
	type MentionSearchState,
	mergeNarratorMentionCandidates,
	NarratorMentionSearch,
} from "./narrator-mention-candidates";

const candidate = (
	id: string,
	extra: Partial<CommunicationCandidate> = {},
): CommunicationCandidate => ({
	id,
	title: id,
	status: "idle",
	lastActivityAt: null,
	isRecent: false,
	canConnect: true,
	...extra,
});
const result = (id: string): CommunicationCandidates => ({
	items: [candidate(id)],
	hasMore: false,
});
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("mention candidate local model", () => {
	test("includes collapsed-folder members, excludes projects/tools/self, uses activity rather than sidebar ordering", () => {
		const tabs: PersistedRecentTab[] = [
			{ id: "self", type: "narrator", title: "Self", lastVisitedAt: 100 },
			{ id: "folder", type: "folder", title: "Folder", lastVisitedAt: 999 },
			{ id: "project", type: "project", title: "Project", lastVisitedAt: 999 },
			{ id: "old", type: "narrator", title: "Old", lastVisitedAt: 1, pinned: true },
			{
				id: "child-tab",
				narratorId: "child",
				type: "subagent",
				folderId: "folder",
				title: "Child",
				lastVisitedAt: 2,
			},
		];
		const local = localNarratorMentionCandidates(tabs, "self");
		expect(mergeNarratorMentionCandidates(local, [], "").map((item) => item.id)).toEqual([
			"child",
			"old",
		]);
	});
	test("a pinned team references its coordinator and keeps a local session rename", () => {
		const team: PersistedRecentTab = {
			type: "team",
			id: "coordinator",
			projectId: "project",
			title: "Old team name",
			lastVisitedAt: 5,
		};
		const session: PersistedRecentTab = {
			type: "narrator",
			id: "coordinator",
			title: "New coordinator name",
			lastVisitedAt: 1,
		};
		expect(localNarratorMentionCandidates([team], undefined)).toMatchObject([
			{ id: "coordinator", title: "Old team name", isRecent: true },
		]);
		expect(localNarratorMentionCandidates([team], "coordinator")).toEqual([]);
		for (const tabs of [
			[team, session],
			[session, team],
		]) {
			expect(localNarratorMentionCandidates(tabs, undefined)).toMatchObject([
				{
					id: "coordinator",
					title: "New coordinator name",
					lastActivityAt: new Date(5).toISOString(),
				},
			]);
		}
	});

	test("server recent membership wins even for unloaded tabs and dedupes by stable id", () => {
		const local = [candidate("local", { isRecent: true, lastActivityAt: "2026-01-01" })];
		const remote = [
			candidate("local", { title: "Renamed", lastActivityAt: "2026-01-02" }),
			candidate("unloaded", { isRecent: true, lastActivityAt: "2026-01-03" }),
			candidate("more", { lastActivityAt: "2026-11-01" }),
		];
		expect(
			mergeNarratorMentionCandidates(local, remote, "").map((item) => [item.id, item.isRecent]),
		).toEqual([
			["unloaded", true],
			["local", true],
			["more", false],
		]);
		// The server page has already matched the current title. Enrichment can retain
		// a locally edited label without accidentally hiding that authorized hit.
		expect(mergeNarratorMentionCandidates(local, remote.slice(0, 1), "renamed")).toMatchObject([
			{ id: "local", title: "local" },
		]);
		expect(mergeNarratorMentionCandidates(local, [], "local")[0]?.title).toBe("local");
	});
});

describe("mention search ownership", () => {
	test("leads immediately, aborts on changed query before trailing window, rejects stale responses", async () => {
		const calls: {
			query: string;
			signal: AbortSignal;
			resolve: (value: CommunicationCandidates) => void;
		}[] = [];
		const states: MentionSearchState[] = [];
		const search = new NarratorMentionSearch(
			(_source, query, { signal }) =>
				new Promise((resolve) => calls.push({ query, signal, resolve })),
			(value) => states.push(value),
		);
		search.update("user", "source", "a");
		expect(calls.map((call) => call.query)).toEqual(["a"]);
		search.update("user", "source", "ab");
		expect(calls[0].signal.aborted).toBe(true);
		calls[0].resolve(result("stale"));
		await tick();
		expect(states.at(-1)?.items).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 275));
		expect(calls.map((call) => call.query)).toEqual(["a", "ab"]);
		calls[1].resolve(result("current"));
		await tick();
		expect(states.at(-1)?.items[0].id).toBe("current");
		search.cancel();
	});
	test("account/source/close invalidate requests and short-lived caches", async () => {
		let requests = 0;
		const states: MentionSearchState[] = [];
		const search = new NarratorMentionSearch(
			async () => result(`result-${++requests}`),
			(value) => states.push(value),
		);
		search.update("u1", "s1", "q");
		await tick();
		await tick();
		search.update("u1", "s1", "q");
		expect(requests).toBe(1);
		search.update("u2", "s1", "q");
		await tick();
		expect(requests).toBe(2);
		search.update("u2", "s2", "q");
		await tick();
		expect(requests).toBe(3);
		search.update("u2", "s2", null);
		expect(states.at(-1)?.items).toEqual([]);
		expect(states.at(-1)?.loading).toBe(false);
		search.cancel();
	});
	test("failure keeps independently filtered local candidates and reports error", async () => {
		const states: MentionSearchState[] = [];
		const search = new NarratorMentionSearch(
			async () => {
				throw new Error("offline");
			},
			(value) => states.push(value),
		);
		search.update("u", "s", "local");
		await tick();
		await tick();
		expect(states.at(-1)?.error).toBe(true);
		expect(
			mergeNarratorMentionCandidates(
				[candidate("local", { isRecent: true })],
				states.at(-1)?.items ?? [],
				"local",
			),
		).toHaveLength(1);
		search.cancel();
	});
});
