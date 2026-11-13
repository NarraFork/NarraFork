/**
 * The reports' pure parts (汇报, outline P2 PR 11): how a block's state before and after a window
 * classifies (tasks, plans, questions, the three decisions made in a person's name), what one
 * person is shown of a space, how parts become one report within its limits, and days in time
 * zones. No database.
 */
import { describe, expect, test } from "bun:test";
import type { OutlineDigestKnowledgeStored, OutlineDigestTaskStored } from "@shared/outline-digest";
import {
	assembleDigest,
	delegateConfirmationPerson,
	isPlanReviewApproval,
	newlyDoneForReader,
	OUTLINE_DIGEST_LIMITS,
	type OutlineDigestLimits,
	type OutlinePersonContribution,
	type OutlineSpaceSummary,
	planEvent,
	questionEvent,
	relayedAnswerPerson,
	selectForPerson,
	taskTransition,
} from "../digest";
import {
	addDays,
	canonicalTimeZone,
	dayWindow,
	digestTimeMinutes,
	latestDueDay,
	localDayOf,
} from "../digest-time";
import type { OutlineAskJson, OutlineTaskJson } from "../model";
import { keyLayers } from "../store/digest-keys";
import type { OutlinePendingHead } from "../store/port";

const task = (
	status: OutlineTaskJson["status"],
	extra: Partial<OutlineTaskJson> = {},
): OutlineTaskJson => ({
	status,
	assignee: null,
	...extra,
});

describe("tasks: the state before the window against after it", () => {
	test.each([
		// [before, after, created, event, created, started]
		[null, task("todo"), true, null, true, false],
		[null, task("doing"), true, null, true, true],
		[null, task("done"), true, "done", true, false],
		[task("todo"), task("done"), false, "done", false, false],
		[task("doing"), task("done"), false, "done", false, false],
		[task("todo"), task("cancelled"), false, "cancelled", false, false],
		[task("done"), task("todo"), false, "reopened", false, false],
		[task("cancelled"), task("doing"), false, "reopened", false, false],
		[task("todo"), task("doing"), false, null, false, true],
		// Done and reopened the same day: as before, nothing.
		[task("todo"), task("todo"), false, null, false, false],
		[task("done"), task("done"), false, null, false, false],
		// A lease run out (in progress, then back to do): nothing; counted apart.
		[task("doing"), task("todo"), false, null, false, false],
	] as const)("%j → %j", (before, after, created, event, isNew, started) => {
		const t = taskTransition(before, after, created);
		expect([t.event, t.created, t.started]).toEqual([event, isNew, started]);
	});

	test("handed to someone: the new assignee, only when it changed", () => {
		expect(
			taskTransition(task("todo"), task("todo", { assignee: "human:bob" }), false).assignedTo,
		).toBe("human:bob");
		expect(
			taskTransition(
				task("todo", { assignee: "human:bob" }),
				task("done", { assignee: "human:bob" }),
				false,
			).assignedTo,
		).toBeNull();
		expect(taskTransition(null, task("todo", { assignee: "agent:x" }), true).assignedTo).toBe(
			"agent:x",
		);
		expect(taskTransition(task("todo"), null, false)).toEqual({
			event: null,
			created: false,
			started: false,
			assignedTo: null,
		});
	});

	test("newly done for the reader: their task, finished by an agent", () => {
		const base: OutlineDigestTaskStored = {
			space: "s",
			commitId: "c",
			seq: 1,
			at: "t",
			event: "done",
			blockId: "b",
			pageId: "p",
			by: { kind: "agent", id: "n" },
			executor: null,
			manager: { kind: "human", id: "u" },
			goal: true,
			forYou: true,
		};
		expect(newlyDoneForReader(base, "u")).toBe(true);
		expect(newlyDoneForReader(base, "v")).toBe(false);
		expect(newlyDoneForReader({ ...base, by: { kind: "human", id: "u" } }, "u")).toBe(false);
		expect(
			newlyDoneForReader(
				{
					...base,
					by: { kind: "system", id: "outline-report" },
					executor: { kind: "agent", id: "n" },
				},
				"u",
			),
		).toBe(true);
		expect(newlyDoneForReader({ ...base, event: "cancelled" }, "u")).toBe(false);
		expect(newlyDoneForReader({ ...base, manager: { kind: "agent", id: "u" } }, "u")).toBe(false);
	});
});

describe("plans: each decision against the root just before it", () => {
	const plan = (
		state: "planning" | "approved",
		round: number,
		extra: Partial<OutlineTaskJson> = {},
	) =>
		task("todo", {
			plan: {
				state,
				by: "s",
				round,
				baseSeq: 0,
				...(state === "approved" ? { approvedBy: { kind: "system", id: "plan-review" } } : {}),
			},
			...extra,
		});
	test.each([
		[null, plan("planning", 0), "planning"],
		[task("todo"), plan("planning", 0), "planning"],
		[plan("approved", 1), plan("planning", 1), "planning"],
		[plan("planning", 0), plan("planning", 1), "returned"],
		[plan("planning", 1), plan("planning", 1), null],
		[plan("planning", 0), plan("approved", 1), "approved_draft"],
		[
			plan("planning", 0),
			plan("approved", 1, {
				lock: { by: { kind: "human", id: "u" }, delegate: null, versionSeq: 3 },
			}),
			"approved_locked",
		],
		[plan("approved", 1), plan("approved", 1), null],
		[plan("planning", 0), task("todo"), null],
	] as const)("%j → %j", (before, after, event) => {
		expect(planEvent(before, after)).toBe(event);
	});

	test("the plan review's approval is the system's, on a person's behalf", () => {
		expect(isPlanReviewApproval(plan("approved", 1))).toBe(true);
		expect(
			isPlanReviewApproval(
				task("todo", {
					plan: {
						state: "approved",
						by: "s",
						round: 1,
						baseSeq: 0,
						approvedBy: { kind: "human", id: "u" },
					},
				}),
			),
		).toBe(false);
		expect(
			isPlanReviewApproval(
				task("todo", {
					plan: {
						state: "approved",
						by: "s",
						round: 1,
						baseSeq: 0,
						approvedBy: { kind: "system", id: "outline-plan" },
					},
				}),
			),
		).toBe(false);
		expect(isPlanReviewApproval(plan("planning", 0))).toBe(false);
	});
});

describe("questions and the decisions made in a person's name", () => {
	const q: OutlineAskJson = {
		to: { kind: "human", id: "u" },
		recommend: { option: 1 },
		options: ["a", "b"],
	};
	const answered = (
		extra: Partial<NonNullable<OutlineAskJson["answer"]>> = {},
	): OutlineAskJson => ({
		...q,
		answer: { option: 1, by: { kind: "human", id: "u" }, at: "t1", ...extra },
	});
	test("asked, answered, withdrawn; a revert reopening it is none of them", () => {
		expect(questionEvent(null, q)).toBe("asked");
		expect(questionEvent(q, answered())).toBe("answered");
		expect(questionEvent(answered(), answered({ option: 2, at: "t2" }))).toBe("answered");
		expect(questionEvent(answered(), answered())).toBeNull();
		expect(questionEvent(q, { ...q, withdrawn: { by: { kind: "agent", id: "n" }, at: "t" } })).toBe(
			"withdrawn",
		);
		expect(questionEvent(answered(), q)).toBeNull();
		expect(questionEvent(q, null)).toBeNull();
	});

	test("a relayed answer is its person's; one they gave themselves is not delegated", () => {
		expect(relayedAnswerPerson(answered({ relayed: { narratorId: "n", messageId: null } }))).toBe(
			"u",
		);
		expect(relayedAnswerPerson(answered())).toBeNull();
		expect(relayedAnswerPerson(null)).toBeNull();
	});

	test("a confirmation is the locker's when an agent made it", () => {
		const head = {
			status: "confirmed",
			decidedByJson: { kind: "agent", id: "d" },
			deciderUserId: "u",
		} as OutlinePendingHead;
		expect(delegateConfirmationPerson(head)).toBe("u");
		expect(
			delegateConfirmationPerson({ ...head, decidedByJson: { kind: "human", id: "u" } }),
		).toBeNull();
		expect(delegateConfirmationPerson({ ...head, status: "rejected" })).toBeNull();
		expect(delegateConfirmationPerson({ ...head, deciderUserId: null })).toBeNull();
	});
});

function summary(over: Partial<OutlineSpaceSummary> = {}): OutlineSpaceSummary {
	return {
		spaceId: "s1",
		kind: "project",
		from: 3,
		to: 9,
		commits: 6,
		truncated: false,
		actors: new Set(),
		knowledge: [],
		deletedFacts: 0,
		tasks: [],
		tasksCreated: 0,
		tasksStarted: 0,
		leaseReturned: 0,
		handedBack: 0,
		plans: [],
		reviewComments: 0,
		questions: [],
		delegated: [],
		other: [],
		...over,
	};
}

describe("what one person is shown of a space", () => {
	test("facts they alone wrote are counted; pages group the rest, three topmost blocks each", () => {
		const fact = (id: string, parentId: string | null, writers: string[], seq: number) => ({
			blockId: id,
			pageId: "p",
			parentId,
			created: true,
			seq,
			commitId: `c${seq}`,
			at: `t${seq}`,
			writers,
		});
		const part = selectForPerson(
			summary({
				knowledge: [
					fact("own", "p", ["human:u"], 4),
					fact("a", "p", ["agent:n"], 5),
					fact("a1", "a", ["agent:n"], 6),
					fact("b", "p", ["human:u", "agent:n"], 7),
					fact("c", "p", ["human:v"], 8),
					fact("d", "p", ["agent:n"], 9),
				],
			}),
			{ userId: "u", username: "uu" },
		);
		expect(part.space.ownEdits).toBe(1);
		expect(part.knowledge).toHaveLength(1);
		const page = part.knowledge[0] as OutlineDigestKnowledgeStored;
		expect([page.created, page.changed, page.seq]).toEqual([5, 0, 9]);
		// `a1` sits under `a`: not topmost.
		expect(page.blocks.map((b) => b.id)).toEqual(["a", "b", "c"]);
	});

	test("tasks handed to someone else are not theirs; their own come first; others' decisions go", () => {
		const t = (
			event: OutlineDigestTaskStored["event"],
			assignee: string | null,
			manager: string | null,
			seq: number,
		) => ({
			space: "s1",
			commitId: `c${seq}`,
			seq,
			at: `t${seq}`,
			event,
			blockId: `b${seq}`,
			pageId: "p",
			by: { kind: "agent" as const, id: "n" },
			executor: null,
			manager: manager ? { kind: "human" as const, id: manager } : null,
			goal: false,
			assignee,
		});
		const part = selectForPerson(
			summary({
				tasks: [
					t("done", null, "v", 4),
					t("assigned", "human:vv", null, 5),
					t("assigned", "human:uu", null, 6),
					t("done", null, "u", 7),
				],
				questions: [
					{
						space: "s1",
						commitId: "c1",
						seq: 1,
						at: "t1",
						event: "asked",
						blockId: "q1",
						pageId: "p",
						to: "v",
						by: null,
						adopted: false,
						relayed: false,
					},
					{
						space: "s1",
						commitId: "c2",
						seq: 2,
						at: "t2",
						event: "asked",
						blockId: "q2",
						pageId: "p",
						to: "u",
						by: null,
						adopted: false,
						relayed: false,
					},
				],
				delegated: [
					{
						kind: "relayed_answer",
						person: "v",
						space: "s1",
						commitId: "x",
						seq: 1,
						at: "t",
						blockId: "q",
						pageId: "p",
						narratorId: "n",
					},
					{
						kind: "confirmation",
						person: "u",
						space: "s1",
						commitId: "y",
						seq: 2,
						at: "t",
						blockId: "r",
						pageId: "p",
						narratorId: "n",
						pendingId: "pp",
					},
				],
			}),
			{ userId: "u", username: "uu" },
		);
		expect(part.tasks.map((x) => [x.seq, x.event, x.forYou])).toEqual([
			[6, "assigned", true],
			[7, "done", true],
			[4, "done", false],
		]);
		expect(part.questions.map((x) => [x.blockId, x.toYou])).toEqual([
			["q2", true],
			["q1", false],
		]);
		expect(part.delegated.map((d) => d.kind)).toEqual(["confirmation"]);
		expect("person" in (part.delegated[0] as object)).toBe(false);
	});

	test("a section past its cap keeps the first items and counts the rest", () => {
		const limits = { ...OUTLINE_DIGEST_LIMITS, itemsPerSection: 2 };
		const other = Array.from({ length: 5 }, (_, i) => ({
			space: "s1",
			commitId: `c${i}`,
			seq: i,
			at: `t${i}`,
			event: "revert" as const,
			actor: { kind: "human" as const, id: "v" },
			blocks: 1,
		}));
		const part = selectForPerson(summary({ other }), { userId: "u", username: "uu" }, limits);
		expect(part.other.map((o) => o.seq)).toEqual([0, 1]);
		expect(part.more.other).toBe(3);
	});
});

function part(
	spaceId: string,
	items: number,
	extra: Partial<OutlinePersonContribution["space"]> = {},
): OutlinePersonContribution {
	const other = Array.from({ length: items }, (_, i) => ({
		space: spaceId,
		commitId: `${spaceId}-c${i}`,
		seq: i + 1,
		at: `2026-11-05T0${i % 10}:00:00.000Z`,
		event: "revert" as const,
		actor: { kind: "human" as const, id: "v" },
		blocks: 1,
	}));
	return {
		space: {
			id: spaceId,
			kind: "project",
			from: 0,
			to: items,
			commits: items,
			truncated: false,
			deletedFacts: 0,
			ownEdits: 0,
			tasksCreated: 0,
			tasksStarted: 0,
			leaseReturned: 0,
			reviewComments: 0,
			...extra,
		},
		delegated: [],
		knowledge: [],
		tasks: [],
		plans: [],
		questions: [],
		other,
		more: { delegated: 0, knowledge: 0, tasks: 0, plans: 0, questions: 0, other: 0 },
	};
}

describe("one report within its limits", () => {
	test("empty spaces are not spaces with changes; counts and item count", () => {
		const done = assembleDigest([part("a", 2), part("b", 0), part("c", 0, { ownEdits: 3 })]);
		expect(done.items.spaces.map((s) => s.id)).toEqual(["c", "a"]);
		expect(done.counts).toEqual({
			delegated: 0,
			knowledge: 0,
			tasks: 0,
			plans: 0,
			questions: 0,
			other: 2,
			spaces: 2,
			ownEdits: 3,
		});
		expect(done.itemCount).toBe(2);
		expect(done.truncated).toBe(false);
	});

	test("at most so many spaces (the busiest), so many per section and in all, so many bytes", () => {
		const limits = {
			...OUTLINE_DIGEST_LIMITS,
			spacesPerDigest: 2,
			itemsPerSection: 4,
			itemsPerDigest: 3,
		};
		const done = assembleDigest([part("a", 1), part("b", 3), part("c", 2)], limits);
		expect(done.items.spaces.map((s) => s.id)).toEqual(["b", "c"]);
		expect(done.items.moreSpaces).toBe(1);
		expect(done.items.other).toHaveLength(3);
		// Five items in the shown spaces: three listed, two counted against their own spaces.
		expect(done.counts.other).toBe(5);
		expect(done.items.spaces.reduce((n, s) => n + (s.more?.other ?? 0), 0)).toBe(2);
		expect(done.items.more.other).toBe(2);
		expect(done.counts.spaces).toBe(3);
		expect(done.truncated).toBe(true);

		const tiny = assembleDigest([part("a", 40)], { ...OUTLINE_DIGEST_LIMITS, itemsBytes: 2048 });
		expect(Buffer.byteLength(JSON.stringify(tiny.items))).toBeLessThanOrEqual(2048);
		expect(tiny.items.other.length).toBeLessThan(40);
		expect(tiny.counts.other).toBe(40);
		expect(tiny.items.spaces[0]?.more?.other).toBe(40 - tiny.items.other.length);
	});

	test("the byte limit holds exactly, counts of the items cut and of spaces left out included", () => {
		// Every cut adds a `more` count to a space, which the estimate of what was cut does not
		// include; spaces the job left out early (`dropped`) are counted before the measuring. The
		// report is measured again before it is taken, and nothing changes it afterwards.
		const compositions = [
			Array.from({ length: 30 }, (_, i) => part(`space-${String(i).padStart(2, "0")}`, 1)),
			[part("s".repeat(21), 40)],
		];
		let checked = 0;
		for (const parts of compositions) {
			for (const dropped of [0, 9, 10, 150]) {
				const assemble = (limits: Partial<OutlineDigestLimits>) =>
					assembleDigest(parts, { ...OUTLINE_DIGEST_LIMITS, ...limits }, { dropped });
				const whole = Buffer.byteLength(JSON.stringify(assemble({}).items));
				// Every item cut: the spaces and their counts alone (the least any limit can get to).
				const bare = Buffer.byteLength(JSON.stringify(assemble({ itemsPerDigest: 0 }).items));
				expect(bare).toBeLessThan(whole);
				for (let limit = bare; limit < whole; limit++) {
					const done = assemble({ itemsBytes: limit });
					expect(Buffer.byteLength(JSON.stringify(done.items))).toBeLessThanOrEqual(limit);
					expect(done.counts.other).toBe(parts.reduce((n, p) => n + p.other.length, 0));
					expect(done.counts.spaces).toBe(parts.length + dropped);
					expect(done.items.moreSpaces).toBe(dropped);
					expect(done.truncated).toBe(true);
					checked++;
				}
			}
		}
		expect(checked).toBeGreaterThan(1000);
	});

	test("a part's own overflow is carried into the report and its space", () => {
		const p = part("a", 1);
		p.more.tasks = 7;
		const done = assembleDigest([p]);
		expect(done.counts.tasks).toBe(7);
		expect(done.items.spaces[0]?.more).toEqual({ tasks: 7 });
		expect(done.truncated).toBe(true);
	});
});

describe("days in a person's time zone", () => {
	const iso = (n: number) => new Date(n).toISOString();
	test.each([
		["2026-11-05", "Asia/Shanghai", "2026-11-04T16:00:00.000Z", "2026-11-05T16:00:00.000Z"],
		["2026-03-08", "America/New_York", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
		["2026-11-01", "America/New_York", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
		["2026-03-29", "Europe/London", "2026-03-29T00:00:00.000Z", "2026-03-29T23:00:00.000Z"],
		// Santiago skips midnight (00:00 → 01:00): the day starts at the jump.
		["2026-09-06", "America/Santiago", "2026-09-06T04:00:00.000Z", "2026-09-07T03:00:00.000Z"],
		["2026-12-31", "UTC", "2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
	])("%s in %s", (key, zone, start, end) => {
		const w = dayWindow(key, zone);
		expect([iso(w.start), iso(w.end)]).toEqual([start, end]);
		expect(localDayOf(w.start, zone)).toBe(key);
		expect(localDayOf(w.end - 1, zone)).toBe(key);
		// Consecutive days meet.
		expect(dayWindow(addDays(key, 1), zone).start).toBe(w.end);
	});

	test("the latest day due: yesterday once the report time passed, else the day before", () => {
		const at = (s: string) => Date.parse(s);
		expect(latestDueDay(at("2026-11-05T22:59:00.000Z"), "Asia/Shanghai", null)).toBe("2026-11-04");
		expect(latestDueDay(at("2026-11-05T23:00:00.000Z"), "Asia/Shanghai", null)).toBe("2026-11-05");
		expect(latestDueDay(at("2026-11-06T06:44:00.000Z"), "UTC", "06:45")).toBe("2026-11-04");
		expect(latestDueDay(at("2026-11-06T06:45:00.000Z"), "UTC", "06:45")).toBe("2026-11-05");
	});

	test("zone names and times", () => {
		expect(canonicalTimeZone("asia/shanghai")).toBe("Asia/Shanghai");
		expect(canonicalTimeZone("Mars/Olympus")).toBeNull();
		expect(canonicalTimeZone("")).toBeNull();
		expect(digestTimeMinutes("06:45")).toBe(405);
		expect(digestTimeMinutes(null)).toBe(420);
		expect(digestTimeMinutes("25:00")).toBe(420);
		expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
		expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
	});
});

describe("as-of keys", () => {
	test("layers never repeat a block; duplicates go", () => {
		expect(
			keyLayers([
				{ blockId: "a", seq: 1 },
				{ blockId: "a", seq: 2 },
				{ blockId: "b", seq: 1 },
				{ blockId: "a", seq: 1 },
			]),
		).toEqual([
			[
				{ blockId: "a", seq: 1 },
				{ blockId: "b", seq: 1 },
			],
			[{ blockId: "a", seq: 2 }],
		]);
	});
});
