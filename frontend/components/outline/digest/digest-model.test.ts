import { describe, expect, test } from "bun:test";
import type {
	OutlineDigestDelegatedView,
	OutlineDigestDetailResponse,
	OutlineDigestHead,
	OutlineDigestKnowledgeView,
	OutlineDigestLink,
	OutlineDigestListResponse,
	OutlineDigestSpaceView,
	OutlineDigestTaskView,
} from "@shared/outline-digest";
import {
	commitPath,
	DIGEST_COMPACT_ITEMS,
	DIGEST_TODAY,
	dayEntries,
	dayIn,
	dayNeighbors,
	digestModel,
	isTodayIn,
	itemLinks,
	pickDay,
	reportPath,
	sessionPath,
	undoRefusalOf,
} from "./digest-model";

function link(spaceId: string, blockId: string | null, seq: number): OutlineDigestLink {
	return {
		spaceId,
		spaceKey: `${spaceId}-key`,
		blockId,
		pageId: "page",
		address: blockId ? `${spaceId}-key/${blockId}` : null,
		seq,
		commitId: `c${seq}`,
		narratorId: null,
	};
}

function space(id: string, extra: Partial<OutlineDigestSpaceView> = {}): OutlineDigestSpaceView {
	return {
		id,
		key: `${id}-key`,
		kind: "project",
		label: id,
		from: 0,
		to: 10,
		commits: 10,
		truncated: false,
		deletedFacts: 0,
		ownEdits: 0,
		tasksCreated: 0,
		tasksStarted: 0,
		leaseReturned: 0,
		handedBack: 0,
		reviewComments: 0,
		more: {},
		...extra,
	};
}

function knowledge(spaceId: string, seq: number): OutlineDigestKnowledgeView {
	return {
		link: link(spaceId, `page${seq}`, seq),
		title: `Page ${seq}`,
		deleted: false,
		at: "2026-11-05T01:00:00.000Z",
		created: 1,
		changed: 0,
		blocks: [],
	};
}

function delegated(spaceId: string, seq: number): OutlineDigestDelegatedView {
	return {
		link: link(spaceId, `q${seq}`, seq),
		title: "Which one?",
		deleted: false,
		at: "2026-11-05T01:00:00.000Z",
		kind: "relayed_answer",
		session: { narratorId: null, title: null, hidden: false },
		pendingId: null,
		round: null,
		questions: 1,
		stands: true,
		canUndo: true,
	};
}

function task(spaceId: string, seq: number): OutlineDigestTaskView {
	return {
		link: link(spaceId, `t${seq}`, seq),
		title: `Task ${seq}`,
		deleted: false,
		at: "2026-11-05T01:00:00.000Z",
		event: "done",
		by: { kind: "agent", id: "s1" },
		executor: { kind: "agent", id: "s1" },
		manager: null,
		goal: false,
		forYou: false,
		newlyDoneForYou: false,
	};
}

function head(periodKey: string, extra: Partial<OutlineDigestHead> = {}): OutlineDigestHead {
	return {
		id: `d-${periodKey}`,
		kind: "daily",
		periodKey,
		timeZone: "UTC",
		periodStart: `${periodKey}T00:00:00.000Z`,
		periodEnd: `${periodKey}T23:59:59.999Z`,
		counts: {
			delegated: 0,
			knowledge: 0,
			tasks: 0,
			plans: 0,
			questions: 0,
			other: 0,
			spaces: 0,
			ownEdits: 0,
		},
		itemCount: 0,
		truncated: false,
		createdAt: `${periodKey}T07:00:00.000Z`,
		seenAt: null,
		...extra,
	};
}

function detail(): OutlineDigestDetailResponse {
	return {
		digest: head("2026-11-05"),
		spaces: [
			space("a", { ownEdits: 2, tasksCreated: 1, more: { knowledge: 4 } }),
			space("b", { truncated: true, deletedFacts: 3 }),
		],
		moreSpaces: 2,
		delegated: [delegated("a", 1), delegated("a", 2), delegated("b", 3), delegated("b", 4)],
		knowledge: [
			knowledge("a", 5),
			knowledge("a", 6),
			knowledge("b", 7),
			knowledge("a", 8),
			knowledge("a", 9),
		],
		tasks: [task("b", 10)],
		plans: [],
		questions: [],
		other: [],
		more: { delegated: 0, knowledge: 4, tasks: 0, plans: 0, questions: 0, other: 0 },
		names: { users: {}, sessions: {} },
	};
}

describe("digestModel", () => {
	test("in full: every item, counts with what the server's caps left out", () => {
		const model = digestModel(detail());
		const by = Object.fromEntries(model.sections.map((s) => [s.section, s]));
		expect(by.knowledge?.items).toHaveLength(5);
		expect(by.knowledge?.count).toBe(9);
		expect(by.knowledge?.hidden).toBe(4);
		expect(by.delegated?.count).toBe(4);
		expect(by.plans?.count).toBe(0);
		expect(model.total).toBe(4 + 9 + 1);
		expect(model.moreSpaces).toBe(2);
		expect(model.tallies).toMatchObject({
			commits: 20,
			ownEdits: 2,
			deletedFacts: 3,
			tasksCreated: 1,
		});
		expect(model.tallies.truncated.map((s) => s.id)).toEqual(["b"]);
		expect(model.sections.map((s) => s.section)).toEqual([
			"delegated",
			"knowledge",
			"tasks",
			"plans",
			"questions",
			"other",
		]);
	});

	test("compact: the first few items of each section, every decision", () => {
		const model = digestModel(detail(), { compact: true });
		const by = Object.fromEntries(model.sections.map((s) => [s.section, s]));
		expect(by.knowledge?.items).toHaveLength(DIGEST_COMPACT_ITEMS);
		expect(by.knowledge?.count).toBe(9);
		expect(by.knowledge?.hidden).toBe(9 - DIGEST_COMPACT_ITEMS);
		expect(by.delegated?.items).toHaveLength(4);
		expect(by.delegated?.hidden).toBe(0);
	});

	test("one space: its items, its own past-the-caps counts and tallies, no other spaces", () => {
		const a = digestModel(detail(), { spaceId: "a" });
		const by = Object.fromEntries(a.sections.map((s) => [s.section, s]));
		expect(by.knowledge?.items.map((k) => k.link.spaceId)).toEqual(["a", "a", "a", "a"]);
		expect(by.knowledge?.count).toBe(4 + 4);
		expect(by.delegated?.count).toBe(2);
		expect(by.tasks?.count).toBe(0);
		expect(a.spaces.map((s) => s.id)).toEqual(["a"]);
		expect(a.tallies.truncated).toEqual([]);
		expect(a.moreSpaces).toBe(0);
		const b = digestModel(detail(), { spaceId: "b" });
		expect(b.total).toBe(2 + 1 + 1);
		expect(b.tallies.deletedFacts).toBe(3);
		// A space the report does not have: nothing.
		expect(digestModel(detail(), { spaceId: "zz" }).total).toBe(0);
	});
});

describe("itemLinks", () => {
	test("the block now (in the view a section needs), the commit, the session", () => {
		const l = { ...link("a", "t1", 12), narratorId: "s1" };
		expect(itemLinks(l, { view: "all" })).toEqual({
			block: { kind: "block", spaceId: "a", blockId: "t1", view: "all" },
			commit: { space: "a-key", seq: 12 },
			session: "s1",
		});
		expect(itemLinks(l).block).toEqual({ kind: "block", spaceId: "a", blockId: "t1" });
	});

	test("a block deleted since opens as of the item's commit; no block, no block link", () => {
		expect(itemLinks(link("a", "t1", 12), { deleted: true }).block).toEqual({
			kind: "block",
			spaceId: "a",
			blockId: "t1",
			view: "all",
			asOf: 12,
		});
		expect(itemLinks(link("a", null, 3)).block).toBeNull();
	});
});

describe("app paths", () => {
	test("the reports page, a session, the page as of a commit (as tool cards link it)", () => {
		expect(reportPath()).toBe("/outline/digest");
		expect(reportPath({ d: "2026-11-05", space: "s1" })).toBe(
			"/outline/digest?d=2026-11-05&space=s1",
		);
		expect(reportPath({ d: DIGEST_TODAY, space: null })).toBe("/outline/digest?d=today");
		expect(sessionPath("n/1")).toBe("/narrators/n%2F1");
		expect(commitPath({ space: "imp", seq: 8 })).toBe("/outline/ref?space=imp&commit=8");
	});
});

describe("browsing by day", () => {
	const page = (
		days: string[],
		nextCursor: string | null,
		preview: OutlineDigestHead | null = null,
	): OutlineDigestListResponse => ({ digests: days.map((d) => head(d)), preview, nextCursor });

	test("today so far first, then the days, newest first, across pages", () => {
		const pages = [
			page(["2026-11-05", "2026-11-04"], "2026-11-04", head("2026-11-06", { kind: "today" })),
			page(["2026-11-03"], null, head("2026-11-06", { kind: "today" })),
		];
		expect(dayEntries(pages).map((e) => e.key)).toEqual([
			DIGEST_TODAY,
			"2026-11-05",
			"2026-11-04",
			"2026-11-03",
		]);
		expect(dayEntries(undefined)).toEqual([]);
	});

	test("the address's day, the latest day by default, or a later page to look in", () => {
		const entries = dayEntries([
			page(["2026-11-05", "2026-11-04"], "2026-11-04", head("2026-11-06", { kind: "today" })),
		]);
		const loaded = (more: boolean) => ({ more, loaded: true });
		expect(pickDay(entries, undefined, loaded(true)).entry?.key).toBe("2026-11-05");
		expect(pickDay(entries, DIGEST_TODAY, loaded(true)).entry?.key).toBe(DIGEST_TODAY);
		// Today's date, before today's report exists: the preview.
		expect(pickDay(entries, "2026-11-06", loaded(true)).entry?.key).toBe(DIGEST_TODAY);
		expect(pickDay(entries, "2026-11-01", loaded(true))).toEqual({
			entry: null,
			missing: false,
			searching: true,
			noPreview: false,
		});
		expect(pickDay(entries, "2026-11-01", loaded(false))).toEqual({
			entry: null,
			missing: true,
			searching: false,
			noPreview: false,
		});
		// No daily report yet: today so far.
		const onlyToday = dayEntries([page([], null, head("2026-11-06", { kind: "today" }))]);
		expect(pickDay(onlyToday, undefined, loaded(false)).entry?.key).toBe(DIGEST_TODAY);
		expect(pickDay([], undefined, loaded(false)).entry).toBeNull();
		// Today so far asked for by address, and none made: said so, not "missing".
		const noPreview = dayEntries([page(["2026-11-05"], null)]);
		expect(pickDay(noPreview, DIGEST_TODAY, loaded(false))).toEqual({
			entry: null,
			missing: false,
			searching: false,
			noPreview: true,
		});
	});

	test("nothing is missing (nor picked) before the list has loaded", () => {
		expect(pickDay([], "2026-11-05", { more: false, loaded: false })).toEqual({
			entry: null,
			missing: false,
			searching: false,
			noPreview: false,
		});
		expect(pickDay([], DIGEST_TODAY, { more: false, loaded: false }).noPreview).toBe(false);
	});

	test("today in the report's zone", () => {
		const now = new Date("2026-11-06T02:00:00.000Z");
		expect(isTodayIn("2026-11-06", "UTC", now)).toBe(true);
		// Still the 5th in New York; already the 6th in Shanghai.
		expect(isTodayIn("2026-11-05", "America/New_York", now)).toBe(true);
		expect(isTodayIn("2026-11-06", "America/New_York", now)).toBe(false);
		expect(isTodayIn("2026-11-06", "Asia/Shanghai", now)).toBe(true);
		// The calendar day, from the date's parts, in the zone; an unknown zone reads UTC.
		expect(dayIn(new Date("2026-01-01T03:00:00.000Z"), "America/Los_Angeles")).toBe("2025-12-31");
		expect(dayIn(new Date("2026-03-09T23:30:00.000Z"), "Asia/Tokyo")).toBe("2026-03-10");
		expect(dayIn(new Date("2026-03-09T23:30:00.000Z"), "No/Such_Zone")).toBe("2026-03-09");
	});

	test("neighbors: earlier and later among those loaded, or on the next page", () => {
		const entries = dayEntries([page(["2026-11-05", "2026-11-04"], "2026-11-04")]);
		expect(dayNeighbors(entries, "2026-11-05", true)).toEqual({
			newer: null,
			older: "2026-11-04",
			olderOnNextPage: false,
		});
		expect(dayNeighbors(entries, "2026-11-04", true)).toEqual({
			newer: "2026-11-05",
			older: null,
			olderOnNextPage: true,
		});
		expect(dayNeighbors(entries, "2026-11-04", false).olderOnNextPage).toBe(false);
	});
});

describe("undoRefusalOf", () => {
	test("the server's status and code, as what the reader is told", () => {
		const error = (status: number, code?: string) => ({ status, data: code ? { code } : {} });
		expect(undoRefusalOf(error(409, "OUTLINE_DIGEST_UNDO_GONE"))).toBe("gone");
		expect(undoRefusalOf(error(403, "OUTLINE_DIGEST_UNDO_READ_ONLY"))).toBe("readOnly");
		expect(undoRefusalOf(error(403, "OUTLINE_DIGEST_UNDO_NOT_YOURS"))).toBe("notYours");
		expect(undoRefusalOf(error(403))).toBe("notYours");
		expect(undoRefusalOf(error(404))).toBe("missing");
		expect(undoRefusalOf(error(500))).toBe("failed");
		expect(undoRefusalOf(new Error("network"))).toBe("failed");
	});
});
