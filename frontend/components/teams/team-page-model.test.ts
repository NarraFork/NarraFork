/**
 * The team page's pure rules (P4, the redesign R): what waits for a person and how 「等你处理」
 * folds, the work list's groups and their order, the header's status sentence, the starting and
 * wrap-up states, each row's line, read-only gating, activity wording, the poll backoff and the
 * pause order.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	COORDINATOR_OVERRUN_EVENT_PREFIX,
	COORDINATOR_OVERRUN_KINDS,
	TEAM_LEVEL_EVENT_KINDS,
	TEAM_OVERLAP_EVENT_KINDS,
	TEAM_PERSON_DECISION_EVENT_KINDS,
	TEAM_WORK_EVENT_KINDS,
	type TeamBoardItem,
	type TeamPageSummary,
	type TeamPendingApproval,
} from "@shared/project-teams";
import {
	ATTENTION_SHOWN,
	attentionEntries,
	attentionView,
	audienceNotes,
	boardSignature,
	cappedCount,
	diffLineKind,
	eventLabelKey,
	eventNote,
	itemOfApproval,
	liveWorkerStatus,
	nextPollDelay,
	nudgeDelay,
	onlookerSeesWaiting,
	pauseNotice,
	pauseOrder,
	returnReason,
	rowLine,
	SUMMARY_POLL_MAX_MS,
	SUMMARY_POLL_MIN_MS,
	statusSentence,
	summarySignature,
	teamPageMode,
	teamPinTitle,
	teamWorkspaceLayout,
	workGroups,
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

const approval = (patch: Partial<TeamPendingApproval> = {}): TeamPendingApproval => ({
	id: "call-1",
	agent: { id: "n-1", title: "worker one", status: "waiting" },
	depth: 1,
	parentId: "lead",
	toolName: "Bash",
	kind: "tool",
	preview: "pnpm test",
	questions: [],
	decisionReason: null,
	createdAt: "2026-11-18T00:01:00.000Z",
	...patch,
});

const at = (minute: number) => `2026-11-18T00:${String(minute).padStart(2, "0")}:00.000Z`;

describe("等你处理", () => {
	const items = [
		item({ id: "a", worker: { id: "n-1", title: "w", status: "waiting" }, createdAt: at(1) }),
		item({ id: "b", worker: { id: "n-2", title: "w", status: "working" }, createdAt: at(2) }),
		item({ id: "r1", state: "ready", lastReview: "clear", updatedAt: at(9) }),
		item({ id: "r2", state: "ready", lastReview: "clear", updatedAt: at(5) }),
	];

	test("calls first (as asked), then ready items, oldest change first; each tied to its item", () => {
		const calls = [
			approval({ id: "c1" }),
			approval({
				id: "c2",
				kind: "question",
				toolName: "AskUserQuestion",
				agent: { id: "h", title: "helper", status: "waiting" },
				depth: 2,
				parentId: "n-2",
			}),
			approval({
				id: "c3",
				kind: "plan",
				toolName: "ExitPlanMode",
				agent: { id: "lead", title: "Lead", status: "waiting" },
				depth: 0,
				parentId: null,
			}),
		];
		const entries = attentionEntries({ member: true, approvals: calls, items });
		expect(entries.map((entry) => [entry.kind, entry.id, entry.item?.id ?? null])).toEqual([
			["tool", "approval:c1", "a"],
			// A helper's call belongs to its worker's item.
			["question", "approval:c2", "b"],
			// The coordinator's own call has no item.
			["plan", "approval:c3", null],
			["merge", "merge:r2", "r2"],
			["merge", "merge:r1", "r1"],
		]);
	});

	test("onlookers decide nothing: no cards", () => {
		expect(attentionEntries({ member: false, approvals: [approval()], items })).toEqual([]);
	});

	test("more than three fold into 还有 N 条; expanded shows all", () => {
		expect(ATTENTION_SHOWN).toBe(3);
		expect(attentionView([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], hidden: 0 });
		expect(attentionView([1, 2, 3, 4, 5], false)).toEqual({ shown: [1, 2, 3], hidden: 2 });
		expect(attentionView([1, 2, 3, 4, 5], true)).toEqual({ shown: [1, 2, 3, 4, 5], hidden: 0 });
		expect(attentionView([], false)).toEqual({ shown: [], hidden: 0 });
	});

	test("a call matches no item when its session is not a worker", () => {
		expect(
			itemOfApproval(
				approval({ agent: { id: "x", title: null, status: "waiting" }, parentId: "y" }),
				items,
			),
		).toBeNull();
	});
});

describe("the work list", () => {
	test("groups in order: needs you, in progress (then queued), review; finished left out", () => {
		const items = [
			item({ id: "q", state: "queued", createdAt: at(1) }),
			item({ id: "p1", state: "in_progress", createdAt: at(2) }),
			item({
				id: "asked",
				state: "in_progress",
				worker: { id: "n-1", title: null, status: "waiting" },
				createdAt: at(3),
			}),
			item({ id: "rev", state: "in_review", createdAt: at(4) }),
			item({ id: "ready", state: "ready", createdAt: at(0) }),
			item({ id: "p2", state: "in_progress", createdAt: at(5) }),
			item({ id: "m", state: "merged" }),
			item({ id: "c", state: "cancelled" }),
		];
		const groups = workGroups(items, [approval()]);
		const ids = (rows: { item: { id: string } }[]) => rows.map((row) => row.item.id);
		expect(ids(groups.needsYou)).toEqual(["asked", "ready"]);
		expect(groups.needsYou[0]?.approval?.id).toBe("call-1");
		expect(ids(groups.inProgress)).toEqual(["p1", "p2", "q"]);
		expect(ids(groups.review)).toEqual(["rev"]);
	});

	test("read-only gating: an onlooker sees no calls; a waiting worker stands for one", () => {
		const items = [
			item({
				id: "w",
				worker: { id: "n-1", title: null, status: "waiting" },
				activity: { toolName: "Bash", preview: "pnpm add x", at: at(1) },
			}),
			item({ id: "ready", state: "ready" }),
		];
		const live = summary({
			runningAgents: [{ id: "n-1", title: null, status: "waiting" }],
			runningCount: 1,
		});
		const groups = workGroups(items, [], (entry) => onlookerSeesWaiting(entry, live));
		expect(groups.needsYou.map((row) => [row.item.id, row.waiting ?? false])).toEqual([
			["w", true],
			["ready", false],
		]);
		expect(rowLine(groups.needsYou[0] as never, "waiting", "main")).toEqual({
			key: "waitingTool",
			values: { tool: "Bash" },
			detail: "pnpm add x",
			tone: "amber",
		});
		// Stopped meanwhile (no longer running): not waiting.
		expect(onlookerSeesWaiting(items[0] as TeamBoardItem, summary())).toBe(false);
	});

	test("each row says what it is doing now", () => {
		const row = (patch: Partial<TeamBoardItem>, call: TeamPendingApproval | null = null) => ({
			item: item(patch),
			approval: call,
		});
		expect(rowLine(row({}, approval()), "waiting", "main")).toMatchObject({
			key: "waitingTool",
			detail: "pnpm test",
			tone: "amber",
		});
		expect(
			rowLine(row({}, approval({ kind: "question", questions: ["Which?"] })), "waiting", "main"),
		).toMatchObject({ key: "waitingAnswer", detail: "Which?" });
		expect(rowLine(row({ state: "ready", reviewRounds: 2 }), null, "main")).toMatchObject({
			key: "mergeable",
			values: { round: 2 },
			tone: "green",
		});
		expect(rowLine(row({ state: "in_review", reviewRounds: 0 }), null, "main")).toMatchObject({
			key: "reviewing",
			values: { round: 1 },
		});
		expect(
			rowLine(row({ state: "in_review", reviewRounds: 1, lastReview: "clear" }), null, "main").key,
		).toBe("reviewClear");
		expect(rowLine(row({ state: "queued" }), null, "main")).toMatchObject({
			key: "queued",
			tone: "hollow",
		});
		expect(rowLine(row({ state: "merged", baseRef: null }), null, "dev")).toMatchObject({
			key: "merged",
			values: { base: "dev" },
		});
		const running = { id: "n", title: null, status: "working" };
		expect(
			rowLine(
				row({ worker: running, activity: { toolName: "Edit", preview: "a.ts", at: at(1) } }),
				"working",
				"main",
			),
		).toMatchObject({ key: "activity", detail: "a.ts", tone: "blue" });
		// The last tool call of a worker that stopped is not "now".
		expect(
			rowLine(
				row({ worker: running, activity: { toolName: "Edit", preview: "a.ts", at: at(1) } }),
				"idle",
				"main",
			).key,
		).toBe("workerIdle");
		expect(rowLine(row({ lastReview: "blocker", reviewRounds: 2 }), "idle", "main")).toMatchObject({
			key: "fixing",
			values: { round: 2 },
		});
		expect(rowLine(row({}), null, "main").key).toBe("noWorker");
	});
});

describe("status sentence", () => {
	const counts = (patch: Partial<TeamPageSummary["columnCounts"]>) => ({
		queued: 0,
		in_progress: 0,
		review: 0,
		done: 0,
		cancelled: 0,
		...patch,
	});
	test("in progress · waiting on you (members) or on members (onlookers)", () => {
		const s = summary({
			columnCounts: counts({ queued: 1, in_progress: 4, review: 2 }),
			runningCount: 3,
		});
		expect(statusSentence({ summary: s, member: true, waiting: 3, waitingItems: 3 })).toEqual({
			tone: "active",
			parts: [
				{ key: "inProgress", count: 4 },
				{ key: "waitingYou", count: 3 },
			],
		});
		expect(
			statusSentence({ summary: s, member: false, waiting: 1, waitingItems: 1 }).parts,
		).toEqual([
			{ key: "inProgress", count: 6 },
			{ key: "waitingMembers", count: 1 },
		]);
	});
	test("idle, done, no work yet, paused, archived", () => {
		expect(
			statusSentence({
				summary: summary({ columnCounts: counts({}) }),
				member: true,
				waiting: 0,
				waitingItems: 0,
			}),
		).toEqual({ tone: "idle", parts: [{ key: "idle" }, { key: "noWork" }] });
		expect(
			statusSentence({
				summary: summary({ columnCounts: counts({ done: 7, cancelled: 1 }) }),
				member: true,
				waiting: 0,
				waitingItems: 0,
			}).parts,
		).toEqual([{ key: "idle" }, { key: "done", count: 7 }]);
		expect(
			statusSentence({
				summary: summary({
					columnCounts: counts({ in_progress: 2 }),
					runningCount: 0,
					coordinatorStopReason: "user_interrupt",
				}),
				member: true,
				waiting: 0,
				waitingItems: 0,
			}),
		).toEqual({ tone: "paused", parts: [{ key: "paused" }] });
		// Stopped by a person but something still runs: not paused.
		expect(
			statusSentence({
				summary: summary({
					columnCounts: counts({ in_progress: 2 }),
					runningCount: 1,
					coordinatorStopReason: "user_interrupt",
				}),
				member: true,
				waiting: 0,
				waitingItems: 0,
			}).tone,
		).toBe("active");
		expect(
			statusSentence({
				summary: summary({
					coordinatorStatus: "archived",
					columnCounts: counts({ in_progress: 2 }),
				}),
				member: true,
				waiting: 1,
				waitingItems: 1,
			}),
		).toEqual({ tone: "archived", parts: [{ key: "archived" }] });
	});
});

describe("starting and wrap-up", () => {
	const counts = (patch: Partial<TeamPageSummary["columnCounts"]>) => ({
		queued: 0,
		in_progress: 0,
		review: 0,
		done: 0,
		cancelled: 0,
		...patch,
	});
	test("starting: no work and nobody spoke to the coordinator yet", () => {
		expect(teamPageMode(summary({ coordinatorMessageCount: 0 }))).toEqual({
			starting: true,
			emptyWork: true,
			wrapUp: false,
		});
		// Spoken to, still no work: the list explains, the conversation shows.
		expect(teamPageMode(summary({ coordinatorMessageCount: 3 }))).toEqual({
			starting: false,
			emptyWork: true,
			wrapUp: false,
		});
		expect(
			teamPageMode(summary({ coordinatorStatus: "archived", coordinatorMessageCount: 0 })).starting,
		).toBe(false);
		expect(teamPageMode(undefined)).toEqual({ starting: false, emptyWork: false, wrapUp: false });
	});
	test("wrap-up: work happened and nothing is open (not when archived)", () => {
		expect(teamPageMode(summary({ columnCounts: counts({ done: 3, cancelled: 1 }) })).wrapUp).toBe(
			true,
		);
		expect(teamPageMode(summary({ columnCounts: counts({ done: 3, queued: 1 }) })).wrapUp).toBe(
			false,
		);
		expect(
			teamPageMode(summary({ coordinatorStatus: "archived", columnCounts: counts({ done: 3 }) }))
				.wrapUp,
		).toBe(false);
	});
});

describe("drawer and layout rules", () => {
	test("a return needs a reason of at most 2000 characters", () => {
		expect(returnReason("  fix the time zone  ")).toBe("fix the time zone");
		expect(returnReason("   ")).toBeNull();
		expect(returnReason("x".repeat(2001))).toBeNull();
	});
	test("diff lines", () => {
		expect(diffLineKind("@@ -1 +1 @@")).toBe("hunk");
		expect(diffLineKind("+++ b/a.ts")).toBe("meta");
		expect(diffLineKind("+added")).toBe("add");
		expect(diffLineKind("-removed")).toBe("del");
		expect(diffLineKind(" same")).toBe("context");
	});
	test("two columns when the frame has room, tabs otherwise; capped counts", () => {
		expect(teamWorkspaceLayout(390)).toBe("tabs");
		expect(teamWorkspaceLayout(800)).toBe("tabs");
		expect(teamWorkspaceLayout(1190)).toBe("split");
		expect(cappedCount(51, 50)).toBe("50+");
		expect(cappedCount(3, 50)).toBe("3");
	});
});

describe("activity wording", () => {
	test("known kinds have their own label; overruns share one; others fall back", () => {
		expect(eventLabelKey("work.review")).toBe("work_review");
		expect(eventLabelKey("team.decision")).toBe("team_decision");
		expect(eventLabelKey("coordinator.overrun.readLines")).toBe("overrun");
		expect(eventLabelKey("x.future")).toBe("other");
	});

	test("every recorded kind has a headline in both locales, and unknown kinds a generic one", () => {
		const kinds = [
			...TEAM_LEVEL_EVENT_KINDS,
			...TEAM_WORK_EVENT_KINDS,
			...TEAM_OVERLAP_EVENT_KINDS,
			...TEAM_PERSON_DECISION_EVENT_KINDS,
			...COORDINATOR_OVERRUN_KINDS.map((kind) => `${COORDINATOR_OVERRUN_EVENT_PREFIX}${kind}`),
		];
		expect(kinds).toContain("work.merged");
		for (const locale of ["en", "zh-CN"]) {
			const labels = JSON.parse(
				readFileSync(new URL(`../../locales/${locale}/projects.json`, import.meta.url), "utf8"),
			).teams.event as Record<string, string>;
			for (const kind of kinds) {
				const key = eventLabelKey(kind);
				expect({ locale, kind, key: key === "other" ? null : key }).toEqual({
					locale,
					kind,
					key: expect.any(String),
				});
				expect({ locale, kind, label: labels[key] }).toEqual({
					locale,
					kind,
					label: expect.any(String),
				});
				expect(labels[key]).not.toContain(kind);
			}
			// The fallback is readable text with no interpolation of the raw kind.
			expect(labels.other).toBeString();
			expect(labels.other).not.toContain("{{");
		}
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
		expect(eventNote({ kind: "work.returned", detail: { reason: " Use the team zone " } })).toEqual(
			{
				key: "text",
				values: { text: "Use the team zone" },
			},
		);
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
	test("a decision's activity note", () => {
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

describe("pin to sidebar", () => {
	const team = {
		id: "lead",
		name: "Release crew",
		status: "active" as const,
		coordinatorStatus: "idle",
	};
	test("an active team offers its name (or id); an archived or unloaded one offers no pin", () => {
		expect(teamPinTitle(team)).toBe("Release crew");
		expect(teamPinTitle({ ...team, name: "" })).toBe("lead");
		expect(teamPinTitle(undefined)).toBeUndefined();
		expect(teamPinTitle({ ...team, status: "archived" })).toBeUndefined();
		expect(teamPinTitle({ ...team, coordinatorStatus: "archived" })).toBeUndefined();
		// The page's live summary can see the archive before the team detail does.
		expect(teamPinTitle(team, "archived")).toBeUndefined();
		expect(teamPinTitle(team, "working")).toBe("Release crew");
	});
});
