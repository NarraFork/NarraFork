/**
 * P3 check-ins and the team brief in subagent prompts.
 *
 * A check-in is one wake-up: scheduling another replaces it, it fires once, and a restart re-arms
 * the pending one from its event. The brief follows every team subagent's own prompt (both
 * levels), byte-identical while the brief is unchanged, and never reaches other sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db, sqlite } from "../../../db";
import { teamWorkEvents } from "../../../db/schema";
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
	updateBrief,
} from "../work-items";

const LEAD = "p3c-lead";
const PROJECT = "p3c-project";
const NOW = "2026-11-17T00:00:00.000Z";
const agent = { kind: "agent" as const, id: LEAD };

let now: number;
let timers: Array<{ at: number; fn: () => void; cancelled: boolean }>;
let wakes: Array<{ teamId: string; minutes: number; note: string | null }>;
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
			wakes.push({ teamId: input.teamId, minutes: input.minutes, note: input.note });
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
		});
		expect(first.replaced).toBe(false);
		const second = scheduleCheckin({
			coordinatorId: LEAD,
			minutes: 30,
			note: "review of item A",
			locale: "en",
			actor: agent,
		});
		expect(second.replaced).toBe(true);
		expect(pendingCheckinCount(LEAD)).toBe(1);
		advance(29 * 60_000);
		expect(wakes).toEqual([]);
		advance(60_000);
		await Promise.resolve();
		expect(wakes).toEqual([{ teamId: LEAD, minutes: 30, note: "review of item A" }]);
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
			.orderBy(asc(teamWorkEvents.createdAt))
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

	test("bounded minutes; a restart re-arms the pending one", async () => {
		for (const minutes of [0, 1441, 2.5])
			expect(() =>
				scheduleCheckin({ coordinatorId: LEAD, minutes, locale: "en", actor: agent }),
			).toThrow("minutes must be");
		scheduleCheckin({ coordinatorId: LEAD, minutes: 10, locale: "en", actor: agent });
		resetCheckinsForTests(); // the process restarted: timers gone
		expect(pendingCheckinCount()).toBe(0);
		expect(rearmCheckins()).toBe(1);
		advance(10 * 60_000);
		await Promise.resolve();
		expect(wakes).toEqual([{ teamId: LEAD, minutes: 10, note: null }]);
		expect(() =>
			scheduleCheckin({ coordinatorId: "p3c-other", minutes: 5, locale: "en", actor: agent }),
		).toThrow("Only a team coordinator");
	});
});

describe("team brief in subagent prompts", () => {
	test("appended to every team subagent's prompt, deterministically; nobody else gets it", () => {
		updateBrief({ coordinatorId: LEAD, text: "Never edit drizzle/ by hand.", actor: agent });
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
