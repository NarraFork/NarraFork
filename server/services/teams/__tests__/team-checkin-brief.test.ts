/**
 * P3 check-ins and the team brief in subagent prompts.
 *
 * A check-in is one wake-up: scheduling another replaces it, it fires once, and a restart re-arms
 * the pending one from its event. The brief follows every team subagent's own prompt (both
 * levels), byte-identical while the brief is unchanged, and never reaches other sessions.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, sqlite } from "../../../db";
import { teamWorkEvents } from "../../../db/schema";
import { eventBus } from "../../../lib/event-bus";
import { getTeamBriefSection } from "../../../lib/prompts/team-lead";
import { runtimeBasePrompt } from "../../agent-runtime/orchestrator";
import { resolveRuntimePolicy } from "../../agent-runtime/policy";
import { teamBriefForSubagent } from "../team-membership";
import {
	type CheckinClock,
	pendingCheckinCount,
	rearmCheckins,
	resetCheckinsForTests,
	scheduleCheckin,
	setCheckinSeamsForTests,
	startTeamWorkLifecycle,
	updateBrief,
} from "../work-items";

const LEAD = "p3c-lead";
const PROJECT = "p3c-project";
const NOW = "2026-11-17T00:00:00.000Z";
const agent = { kind: "agent" as const, id: LEAD };

let now: number;
let timers: Array<{ at: number; fn: () => void; cancelled: boolean }>;
let wakes: Array<{ teamId: string; minutes: number; note: string | null; userId?: string | null }>;
const clock: CheckinClock = {
	now: () => now,
	after(ms, fn) {
		const timer = { at: now + ms, fn, cancelled: false };
		timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	},
};
function advance(ms: number) {
	now += ms;
	for (const timer of timers.splice(0))
		if (timer.cancelled) continue;
		else if (timer.at <= now) timer.fn();
		else timers.push(timer);
}

beforeEach(() => {
	now = Date.parse("2026-11-17T08:00:00.000Z");
	timers = [];
	wakes = [];
	setCheckinSeamsForTests({
		clock,
		wake: async (input) => {
			wakes.push({
				teamId: input.teamId,
				minutes: input.minutes,
				note: input.note,
				userId: input.userId,
			});
		},
	});
	sqlite.run(
		"INSERT INTO projects (id, name, git_path, created_at, updated_at) VALUES (?, 'p', '/repo', ?, ?)",
		[PROJECT, NOW, NOW],
	);
	sqlite.run(
		`INSERT INTO narrators (id, type, title, traits, created_at, updated_at)
		VALUES (?, 'primary', 'Lead', '["team"]', ?, ?)`,
		[LEAD, NOW, NOW],
	);
	sqlite.run(
		`INSERT INTO project_teams (narrator_id, project_id, base_branch, created_at, updated_at)
		VALUES (?, ?, 'main', ?, ?)`,
		[LEAD, PROJECT, NOW, NOW],
	);
});

afterEach(() => {
	resetCheckinsForTests();
	setCheckinSeamsForTests({ clock: null, wake: null });
	sqlite.run("DELETE FROM team_work_events");
	sqlite.run("DELETE FROM project_teams");
	sqlite.run("DELETE FROM narrators WHERE id LIKE 'p3c-%'");
	sqlite.run("DELETE FROM projects WHERE id = ?", [PROJECT]);
});

describe("check-in", () => {
	test("schedules exactly one wake-up; a second replaces the first", async () => {
		const first = scheduleCheckin({
			coordinatorId: LEAD,
			minutes: 50,
			locale: "en",
			actor: agent,
			userId: "p3c-person",
		});
		expect(first.replaced).toBe(false);
		const second = scheduleCheckin({
			coordinatorId: LEAD,
			minutes: 30,
			note: "review of item A",
			locale: "en",
			actor: agent,
			userId: "p3c-person",
		});
		expect(second.replaced).toBe(true);
		expect(pendingCheckinCount(LEAD)).toBe(1);
		advance(29 * 60_000);
		expect(wakes).toEqual([]);
		advance(60_000);
		await Promise.resolve();
		expect(wakes).toEqual([
			{ teamId: LEAD, minutes: 30, note: "review of item A", userId: "p3c-person" },
		]);
		advance(60 * 60_000);
		await Promise.resolve();
		expect(wakes).toHaveLength(1);
		expect(pendingCheckinCount(LEAD)).toBe(0);
		const log = db
			.select({
				kind: teamWorkEvents.kind,
				actor: teamWorkEvents.actorKind,
				detail: teamWorkEvents.detailJson,
			})
			.from(teamWorkEvents)
			.where(eq(teamWorkEvents.teamId, LEAD))
			.orderBy(sql`rowid`)
			.all();
		expect(log.map((row) => [row.kind, row.actor])).toEqual([
			["team.checkin", "agent"],
			["team.checkin", "agent"],
			["team.checkin", "system"],
		]);
		// Fired: a restart does not wake it again.
		resetCheckinsForTests();
		expect(rearmCheckins()).toBe(0);
	});

	test("after a restart, events written in the same millisecond still say what is pending", async () => {
		const schedule = (minutes: number, note: string) =>
			scheduleCheckin({
				coordinatorId: LEAD,
				minutes,
				note,
				locale: "en",
				actor: agent,
				userId: "p3c-person",
			});
		// Same timestamp everywhere; ids ordered so a timestamp-then-id pick lands on the wrong row.
		const sameInstant = (renameToSmallest: string, name: string) => {
			sqlite.run("UPDATE team_work_events SET created_at = ? WHERE team_id = ?", [NOW, LEAD]);
			sqlite.run("UPDATE team_work_events SET id = ? WHERE id = ?", [name, renameToSmallest]);
		};
		const ids = () =>
			sqlite
				.query<{ id: string }, [string]>(
					"SELECT id FROM team_work_events WHERE team_id = ? ORDER BY rowid",
				)
				.all(LEAD)
				.map((row) => row.id);
		now = Date.parse(NOW);

		// A replaced by B: only B is pending.
		schedule(20, "A");
		schedule(30, "B");
		sameInstant(ids()[1] ?? "", "0-b");
		resetCheckinsForTests();
		expect(rearmCheckins()).toBe(1);
		advance(30 * 60_000);
		await Promise.resolve();
		expect(wakes.map((wake) => wake.note)).toEqual(["B"]);
	});

	test("after a restart, a check-in fired in the same millisecond it was scheduled stays fired", async () => {
		now = Date.parse(NOW);
		scheduleCheckin({
			coordinatorId: LEAD,
			minutes: 5,
			locale: "en",
			actor: agent,
			userId: "p3c-person",
		});
		advance(5 * 60_000);
		await Promise.resolve();
		expect(wakes).toHaveLength(1);
		// The firing row sorts first on (created_at, id), as on a fast machine with the wrong ids.
		sqlite.run("UPDATE team_work_events SET created_at = ? WHERE team_id = ?", [NOW, LEAD]);
		sqlite.run(
			`UPDATE team_work_events SET id = '0-fired' WHERE team_id = ? AND json_extract(detail_json, '$.fired') IS NOT NULL`,
			[LEAD],
		);
		resetCheckinsForTests();
		expect(rearmCheckins()).toBe(0);
	});

	test("bounded minutes; a restart re-arms the pending one", async () => {
		for (const minutes of [0, 4, 1441, 7.5])
			expect(() =>
				scheduleCheckin({
					coordinatorId: LEAD,
					minutes,
					locale: "en",
					actor: agent,
					userId: "p3c-person",
				}),
			).toThrow("minutes must be");
		scheduleCheckin({
			coordinatorId: LEAD,
			minutes: 10,
			locale: "en",
			actor: agent,
			userId: "p3c-person",
		});
		resetCheckinsForTests(); // the process restarted: timers gone
		expect(pendingCheckinCount()).toBe(0);
		expect(rearmCheckins()).toBe(1);
		advance(10 * 60_000);
		await Promise.resolve();
		expect(wakes).toEqual([{ teamId: LEAD, minutes: 10, note: null, userId: "p3c-person" }]);
		expect(() =>
			scheduleCheckin({
				coordinatorId: "p3c-other",
				minutes: 5,
				locale: "en",
				actor: agent,
				userId: "p3c-person",
			}),
		).toThrow("Only a team coordinator");
	});
});

describe("check-in and the coordinator's lifecycle", () => {
	test("archiving cancels it, unarchiving re-arms it, a fire on an archived team wakes nobody", async () => {
		const stop = startTeamWorkLifecycle();
		try {
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
			scheduleCheckin({
				coordinatorId: LEAD,
				minutes: 20,
				locale: "en",
				actor: agent,
				userId: "p3c-person",
			});
			sqlite.run("UPDATE narrators SET status = 'archived' WHERE id = ?", [LEAD]);
			eventBus.emit({ type: "narrator:status_changed", narratorId: LEAD, status: "archived" });
			expect(pendingCheckinCount(LEAD)).toBe(0);
			sqlite.run("UPDATE narrators SET status = 'idle' WHERE id = ?", [LEAD]);
			eventBus.emit({ type: "narrator:status_changed", narratorId: LEAD, status: "idle" });
			expect(pendingCheckinCount(LEAD)).toBe(1);
			// Archived without the event reaching us: the timer checks before it wakes anyone.
			sqlite.run("UPDATE narrators SET status = 'archived' WHERE id = ?", [LEAD]);
			advance(20 * 60_000);
			await Promise.resolve();
			expect(wakes).toEqual([]);
			expect(pendingCheckinCount(LEAD)).toBe(0);
			// Deleted coordinator: cancelled too.
			sqlite.run("UPDATE narrators SET status = 'idle' WHERE id = ?", [LEAD]);
			scheduleCheckin({
				coordinatorId: LEAD,
				minutes: 20,
				locale: "en",
				actor: agent,
				userId: "p3c-person",
			});
			eventBus.emit({ type: "narrator:deleted", narratorId: LEAD, title: null });
			expect(pendingCheckinCount(LEAD)).toBe(0);
			// A second start (a hot reload) replaces the first subscription instead of doubling it.
			const off = spyOn(eventBus, "off");
			const again = startTeamWorkLifecycle();
			expect(off).toHaveBeenCalledTimes(3);
			off.mockRestore();
			again();
		} finally {
			stop();
		}
	});
});

describe("team brief in subagent prompts", () => {
	test("appended to every team subagent's prompt, deterministically; nobody else gets it", () => {
		updateBrief({
			coordinatorId: LEAD,
			text: "Never edit drizzle/ by hand.",
			actor: agent,
		});
		const policy = resolveRuntimePolicy([]);
		const worker = { type: "subagent", aclRootNarratorId: LEAD };
		const helper = { type: "subagent", aclRootNarratorId: LEAD }; // second level: same ACL root
		const brief = teamBriefForSubagent(worker);
		expect(brief).toBe("Never edit drizzle/ by hand.");
		expect(teamBriefForSubagent(helper)).toBe(brief);
		const prompt = runtimeBasePrompt({ systemPrompt: "WORKER" }, "en", policy, brief);
		expect(prompt).toBe(`WORKER\n\n${getTeamBriefSection("en", brief)}`);
		expect(prompt).toContain("Never edit drizzle/ by hand.");
		expect(
			runtimeBasePrompt({ systemPrompt: "WORKER" }, "en", policy, teamBriefForSubagent(worker)),
		).toBe(prompt);
		expect(runtimeBasePrompt({ systemPrompt: "WORKER" }, "zh-CN", policy, brief)).toContain(
			"团队简报",
		);
		// Not a team subagent: no brief.
		expect(teamBriefForSubagent({ type: "subagent", aclRootNarratorId: "p3c-other" })).toBeNull();
		expect(teamBriefForSubagent({ type: "primary", aclRootNarratorId: null })).toBeNull();
		expect(runtimeBasePrompt({ systemPrompt: "OTHER" }, "en", policy, null)).toBe("OTHER");
		// An empty brief adds nothing.
		updateBrief({ coordinatorId: LEAD, text: "  ", actor: agent });
		expect(teamBriefForSubagent(worker)).toBeNull();
	});
});
