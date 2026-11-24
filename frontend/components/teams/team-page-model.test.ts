/**
 * The team page's pure rules (P4): the board mapping from the six work item states to the five
 * columns, the state icons, card marks, activity wording, the poll backoff and the pause order.
 */
import { describe, expect, test } from "bun:test";
import { OUTLINE_STATUS_KEYS } from "@shared/outline-status";
import {
	TEAM_BOARD_COLUMN_STATES,
	TEAM_WORK_ITEM_STATES,
	type TeamBoardItem,
	type TeamPageSummary,
} from "@shared/project-teams";
import {
	audienceNotes,
	BOARD_COLUMN_STATUS_ICON,
	boardColumnOf,
	boardSignature,
	cappedCount,
	cardMarks,
	cardNeedsStateChip,
	eventLabelKey,
	eventNote,
	liveWorkerStatus,
	nextPollDelay,
	nudgeDelay,
	pauseNotice,
	pauseOrder,
	recentDecisionKey,
	recentDecisionTextKey,
	SUMMARY_POLL_MAX_MS,
	SUMMARY_POLL_MIN_MS,
	summarySignature,
	TEAM_BOARD_COLUMNS,
	TEAM_CONVERSATION_MIN_WIDTH,
	teamWorkspaceLayout,
	WORK_ITEM_STATUS_ICON,
} from "./team-page-model";

const item = (patch: Partial<TeamBoardItem> = {}): TeamBoardItem => ({
	id: "w1",
	title: "Work",
	kind: "change",
	state: "in_progress",
	branch: "team/work-1",
	baseRef: "main",
	headSha: null,
	worker: null,
	reviewRounds: 0,
	lastReview: null,
	hasWorktree: true,
	exclusiveKey: null,
	createdAt: "2026-11-18T00:00:00.000Z",
	updatedAt: "2026-11-18T00:00:00.000Z",
	...patch,
});

const summary = (patch: Partial<TeamPageSummary> = {}): TeamPageSummary => ({
	teamId: "lead",
	access: "write",
	coordinatorStatus: "working",
	runningAgents: [],
	runningCount: 0,
	pendingApprovalCount: 0,
	columnCounts: { queued: 0, in_progress: 0, review: 0, done: 0, cancelled: 0 },
	lastEventId: "e1",
	lastEventAt: "2026-11-18T00:00:00.000Z",
	...patch,
});

describe("board mapping", () => {
	test("five columns: queued; in progress; in review + ready; merged; cancelled", () => {
		expect([...TEAM_BOARD_COLUMNS]).toEqual([
			"queued",
			"in_progress",
			"review",
			"done",
			"cancelled",
		]);
		expect(TEAM_WORK_ITEM_STATES.map((state) => [state, boardColumnOf(state)])).toEqual([
			["queued", "queued"],
			["in_progress", "in_progress"],
			["in_review", "review"],
			["ready", "review"],
			["merged", "done"],
			["cancelled", "cancelled"],
		]);
		// Every state is in exactly one column.
		const listed = TEAM_BOARD_COLUMNS.flatMap((column) => TEAM_BOARD_COLUMN_STATES[column]);
		expect([...listed].sort()).toEqual([...TEAM_WORK_ITEM_STATES].sort());
	});

	test("every state and column is drawn with an outline state badge, distinct per state", () => {
		for (const state of TEAM_WORK_ITEM_STATES)
			expect(OUTLINE_STATUS_KEYS).toContain(WORK_ITEM_STATUS_ICON[state]);
		for (const column of TEAM_BOARD_COLUMNS)
			expect(OUTLINE_STATUS_KEYS).toContain(BOARD_COLUMN_STATUS_ICON[column]);
		expect(new Set(Object.values(WORK_ITEM_STATUS_ICON)).size).toBe(TEAM_WORK_ITEM_STATES.length);
	});

	test("a ready item in the review column says its state in words; the icon is no check", () => {
		expect(WORK_ITEM_STATUS_ICON.ready).toBe("delegated");
		expect(cardNeedsStateChip({ state: "ready" })).toBe(true);
		expect(cardNeedsStateChip({ state: "in_review" })).toBe(false);
		for (const state of ["queued", "in_progress", "merged", "cancelled"] as const)
			expect(cardNeedsStateChip({ state })).toBe(false);
	});

	test("layout follows the frame's width with room for the conversation", () => {
		expect(teamWorkspaceLayout(360)).toBe("tabs");
		// 1280 px window, 480 px app sidebar: 800 px frame.
		expect(teamWorkspaceLayout(800)).toBe("tabs");
		expect(teamWorkspaceLayout(TEAM_CONVERSATION_MIN_WIDTH + 380)).toBe("split");
		// 1280 px window, 250 px sidebar.
		expect(teamWorkspaceLayout(1030)).toBe("split");
		expect(teamWorkspaceLayout(232 + TEAM_CONVERSATION_MIN_WIDTH + 380)).toBe("columns");
		expect(TEAM_CONVERSATION_MIN_WIDTH).toBeGreaterThanOrEqual(480);
	});

	test("card marks: exclusive lock; a finished item still holding its worktree", () => {
		expect(cardMarks(item())).toEqual([]);
		expect(cardMarks(item({ exclusiveKey: "migrations" }))).toEqual(["exclusive"]);
		expect(cardMarks(item({ state: "merged" }))).toEqual(["cleanable"]);
		expect(cardMarks(item({ state: "cancelled", hasWorktree: false }))).toEqual([]);
		expect(cardMarks(item({ state: "merged", exclusiveKey: "x" }))).toEqual([
			"exclusive",
			"cleanable",
		]);
	});

	test("capped counts", () => {
		expect(cappedCount(3, 50)).toBe("3");
		expect(cappedCount(50, 50)).toBe("50");
		expect(cappedCount(51, 50)).toBe("50+");
	});
});

describe("activity wording", () => {
	test("known kinds have their own label; overruns share one; others fall back", () => {
		expect(eventLabelKey("work.review")).toBe("work_review");
		expect(eventLabelKey("team.decision")).toBe("team_decision");
		expect(eventLabelKey("coordinator.overrun.readLines")).toBe("overrun");
		expect(eventLabelKey("x.future")).toBe("other");
	});

	test("notes from the details", () => {
		expect(eventNote({ kind: "team.decision", detail: { summary: " Ship it " } })).toEqual({
			key: "text",
			values: { text: "Ship it" },
		});
		expect(
			eventNote({ kind: "work.review", detail: { round: 2, verdict: "blocker", findings: 3 } }),
		).toEqual({ key: "reviewBlocker", values: { round: 2, findings: 3 } });
		expect(eventNote({ kind: "work.review", detail: { round: 1, verdict: "clear" } })).toEqual({
			key: "reviewClear",
			values: { round: 1, findings: 0 },
		});
		expect(eventNote({ kind: "work.cancelled", detail: { reason: "no_changes" } })?.key).toBe(
			"cancelledNoChanges",
		);
		expect(
			eventNote({ kind: "work.sync", detail: { outcome: "handed_off", delivered: false } }),
		).toMatchObject({ key: "syncNotDelivered" });
		expect(eventNote({ kind: "team.checkin", detail: { minutes: 50 } })).toEqual({
			key: "checkin",
			values: { minutes: 50 },
		});
		expect(
			eventNote({
				kind: "coordinator.overrun.editLines",
				detail: { tool: "Edit", size: 84, limit: 30 },
			}),
		).toEqual({ key: "overrun", values: { tool: "Edit", size: 84, limit: 30 } });
		expect(eventNote({ kind: "work.ready", detail: null })).toBeNull();
		const long = eventNote({ kind: "team.decision", detail: { summary: "x".repeat(2000) } });
		expect(String(long?.values.text).length).toBe(600);
	});
});

describe("live updates", () => {
	test("poll backoff: 4 s after a change, doubling to 60 s while nothing changes", () => {
		expect(nextPollDelay(SUMMARY_POLL_MAX_MS, true)).toBe(SUMMARY_POLL_MIN_MS);
		let delay = SUMMARY_POLL_MIN_MS;
		const seen: number[] = [];
		for (let i = 0; i < 6; i++) {
			delay = nextPollDelay(delay, false);
			seen.push(delay);
		}
		expect(seen).toEqual([8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
	});

	test("the board refetches on work item changes only", () => {
		const base = summary({
			runningAgents: [{ id: "w", title: "w", status: "working" }],
			runningCount: 1,
		});
		expect(boardSignature(base)).toBe(boardSignature({ ...base, pendingApprovalCount: 4 }));
		expect(summarySignature(base)).not.toBe(summarySignature({ ...base, pendingApprovalCount: 4 }));
		expect(boardSignature(base)).not.toBe(boardSignature({ ...base, lastEventId: "e2" }));
		expect(boardSignature(base)).not.toBe(
			boardSignature({ ...base, columnCounts: { ...base.columnCounts, queued: 1 } }),
		);
		// A worker's status flip does not refetch the board (cards take it from the summary)...
		const flipped = { ...base, runningAgents: [{ id: "w", title: "w", status: "waiting" }] };
		expect(boardSignature(base)).toBe(boardSignature(flipped));
		// ...but it is a change for the top bar.
		expect(summarySignature(base)).not.toBe(summarySignature(flipped));
		expect(boardSignature(undefined)).toBe("");
	});

	test("pause all stops the coordinator first, and says paused only when all stopped", () => {
		expect(pauseOrder("lead", [{ id: "w1" }, { id: "lead" }, { id: "w2" }])).toEqual([
			"lead",
			"w1",
			"w2",
		]);
		expect(pauseOrder("lead", [])).toEqual([]);
		expect(pauseNotice({ stopped: 3, alreadyIdle: 0, failed: 0, more: false })).toEqual({
			color: "green",
			key: "paused",
		});
		expect(pauseNotice({ stopped: 2, alreadyIdle: 1, failed: 0, more: false }).key).toBe(
			"pausedSomeIdle",
		);
		expect(pauseNotice({ stopped: 2, alreadyIdle: 0, failed: 1, more: false }).key).toBe(
			"pausePartial",
		);
		expect(pauseNotice({ stopped: 500, alreadyIdle: 0, failed: 0, more: true }).key).toBe(
			"pauseMore",
		);
		// Every session had already stopped: not "paused".
		expect(pauseNotice({ stopped: 0, alreadyIdle: 2, failed: 0, more: false }).key).toBe(
			"pauseNothing",
		);
	});

	test("socket nudges: 400 ms after the last frame, at most 2 s after the first", () => {
		expect(nudgeDelay(0)).toBe(400);
		expect(nudgeDelay(1_000)).toBe(400);
		expect(nudgeDelay(1_800)).toBe(200);
		expect(nudgeDelay(5_000)).toBe(0);
	});

	test("cards keep their worker's status from the summary", () => {
		const worker = { id: "w", status: "working" };
		expect(liveWorkerStatus(worker, undefined)).toBe("working");
		const listed = summary({
			runningAgents: [{ id: "w", title: null, status: "waiting" }],
			runningCount: 1,
		});
		expect(liveWorkerStatus(worker, listed)).toBe("waiting");
		// Not running any more (the summary lists every running session): idle.
		expect(liveWorkerStatus(worker, summary())).toBe("idle");
		// A capped list cannot tell: keep what the card read.
		const capped = summary({
			runningAgents: Array.from({ length: 20 }, (_, index) => ({
				id: `x${index}`,
				title: null,
				status: "working",
			})),
			runningCount: 21,
		});
		expect(liveWorkerStatus(worker, capped)).toBe("working");
		expect(liveWorkerStatus({ id: "w", status: "archived" }, summary())).toBe("archived");
	});
});

describe("people (M1)", () => {
	test("a decision's line and its activity note", () => {
		expect(recentDecisionKey("approval.allowed")).toBe("allowed");
		expect(recentDecisionKey("approval.denied")).toBe("denied");
		expect(recentDecisionKey("question.answered")).toBe("answered");
		expect(recentDecisionKey("question.dismissed")).toBe("dismissed");
		expect(recentDecisionKey("question.ignored")).toBe("ignored");
		expect(recentDecisionKey("question.supplemented")).toBe("supplemented");
		expect(recentDecisionKey("question.deferred")).toBe("deferred");
		expect(recentDecisionKey("question.answered_by_ai")).toBe("answeredByAi");
		expect(recentDecisionTextKey("approval.allowed", "plan")).toBe("allowedPlan");
		expect(recentDecisionTextKey("approval.denied", "plan")).toBe("deniedPlan");
		expect(recentDecisionTextKey("approval.denied", "tool")).toBe("denied");
		expect(
			eventNote({
				kind: "approval.allowed",
				detail: { tool: "ExitPlanMode", approvalKind: "plan", agentTitle: "W", depth: 1 },
			}),
		).toEqual({ key: "decisionPlan", values: { agent: "W" } });
		for (const kind of [
			"approval.allowed",
			"approval.denied",
			"question.answered",
			"question.dismissed",
			"question.ignored",
			"question.supplemented",
			"question.deferred",
			"question.answered_by_ai",
		])
			expect(eventLabelKey(kind)).toBe(kind.replace(".", "_"));
		expect(
			eventNote({
				kind: "approval.allowed",
				detail: { tool: "Bash", agentTitle: "Parser worker", depth: 1 },
			}),
		).toEqual({ key: "decision", values: { tool: "Bash", agent: "Parser worker" } });
		expect(eventNote({ kind: "approval.denied", detail: { tool: "Edit", depth: 0 } })).toEqual({
			key: "decisionCoordinator",
			values: { tool: "Edit" },
		});
		expect(eventNote({ kind: "question.answered", detail: { tool: "AskUserQuestion" } })).toEqual({
			key: "decisionAgent",
			values: { tool: "AskUserQuestion" },
		});
	});

	test("broad audiences named in the members list", () => {
		expect(audienceNotes("project", "project")).toEqual(["projectWrite", "projectRead"]);
		expect(audienceNotes("project", "owner")).toEqual(["projectRead"]);
		expect(audienceNotes("public", "public")).toEqual(["publicWrite", "publicRead"]);
		expect(audienceNotes("private", "owner")).toEqual([]);
	});
});
