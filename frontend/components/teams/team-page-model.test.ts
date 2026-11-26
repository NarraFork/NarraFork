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
	TEAM_FAST_FORWARD_BLOCKERS,
	TEAM_LEVEL_EVENT_KINDS,
	TEAM_MERGE_DISABLED_REASONS,
	TEAM_OVERLAP_EVENT_KINDS,
	TEAM_PERSON_DECISION_EVENT_KINDS,
	TEAM_PR_MERGE_BLOCKERS,
	TEAM_PR_MERGE_METHODS,
	TEAM_WORK_EVENT_KINDS,
	type TeamBoardItem,
	type TeamPageSummary,
	type TeamPendingApproval,
	type TeamWorkMergeSummary,
	type TeamWorkPullRequest,
} from "@shared/project-teams";
import {
	ATTENTION_SHOWN,
	attentionEntries,
	attentionView,
	audienceNotes,
	boardSignature,
	cappedCount,
	chunkIds,
	conflictReasonFiles,
	coordinatorLine,
	diffLineKind,
	eventLabelKey,
	eventNote,
	findingsNeedToggle,
	isCoordinator,
	itemMarks,
	itemOfApproval,
	liveActivity,
	liveWorkerStatus,
	MERGE_CONFLICT_REASON_FILES,
	mergeControl,
	mergeControl as mergeControlOf,
	mergeErrorKey,
	mergeRequestCode,
	nextPollDelay,
	nudgeDelay,
	onlookerSeesWaiting,
	pauseNotice,
	pauseOrder,
	pullRequestControl,
	queuedLine,
	returnErrorKey,
	returnReason,
	rowLine,
	SUMMARY_POLL_MAX_MS,
	SUMMARY_POLL_MIN_MS,
	safeHref,
	showsStat,
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
			key: "waitingTools.runCommand",
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
			key: "waitingTools.runCommand",
			detail: "pnpm test",
			tone: "amber",
		});
		// What the call asks for, in words (R2): editing, reading, a web page, or the tool's name.
		for (const [toolName, key] of [
			["Edit", "waitingTools.editFile"],
			["NotebookEdit", "waitingTools.editFile"],
			["Read", "waitingTools.readFile"],
			["WebFetch", "waitingTools.fetchWeb"],
			["mcp__github__create_issue", "waitingTools.useTool"],
		])
			expect(rowLine(row({}, approval({ toolName })), "waiting", "main").key).toBe(key);
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

describe("review fixes", () => {
	test("a row's doing-now follows the summary's running list, else what the board read", () => {
		const worker = { id: "n-1", title: null, status: "working" };
		const board = { toolName: "Read", preview: "old.ts", at: at(1) };
		const fresh = { toolName: "Bash", preview: "pnpm test", at: at(5) };
		const live = summary({ runningAgents: [{ ...worker, activity: fresh }], runningCount: 1 });
		expect(liveActivity(item({ worker, activity: board }), live)).toEqual(fresh);
		// An older server's summary without activity: keep the board's.
		const older = summary({ runningAgents: [worker], runningCount: 1 });
		expect(liveActivity(item({ worker, activity: board }), older)).toEqual(board);
		expect(liveActivity(item({ worker: null, activity: null }), live)).toBeNull();
	});

	test("onlookers: a waiting worker with nothing known waits on a person; a question is no tool", () => {
		const waiting = { item: item({ activity: null }), approval: null, waiting: true };
		expect(rowLine(waiting, "waiting", "main")).toMatchObject({
			key: "waitingPerson",
			detail: null,
		});
		const asking = {
			item: item({ activity: { toolName: "AskUserQuestion", preview: "Ship?", at: at(1) } }),
			approval: null,
			waiting: true,
		};
		expect(rowLine(asking, "waiting", "main")).toMatchObject({
			key: "waitingAnswer",
			detail: "Ship?",
		});
	});

	test("the header never undercounts: N+ when more calls wait than listed", () => {
		const s = summary({
			columnCounts: { queued: 0, in_progress: 2, review: 0, done: 0, cancelled: 0 },
		});
		expect(
			statusSentence({ summary: s, member: true, waiting: 50, waitingItems: 1, waitingMore: true })
				.parts,
		).toContainEqual({ key: "waitingYouMore", count: 50 });
	});

	test("marks: the exclusive lock; a finished item still holding its worktree", () => {
		expect(itemMarks(item())).toEqual([]);
		expect(itemMarks(item({ exclusiveKey: "paths" }))).toEqual(["exclusive"]);
		expect(itemMarks(item({ state: "merged" }))).toEqual(["worktree"]);
		expect(itemMarks(item({ state: "cancelled", hasWorktree: false }))).toEqual([]);
		// A live item's worktree is expected, not a mark.
		expect(itemMarks(item({ state: "in_progress", hasWorktree: true }))).toEqual([]);
	});

	test("sizes: nothing changed shows nothing; requests of 50", () => {
		expect(showsStat({ added: 0, removed: 0, files: 0 })).toBe(false);
		expect(showsStat({ added: 0, removed: 0, files: 1 })).toBe(true);
		expect(showsStat({ added: 3, removed: 0 })).toBe(true);
		expect(showsStat(null)).toBe(false);
		const ids = Array.from({ length: 120 }, (_, index) => `id${String(index).padStart(3, "0")}`);
		const chunks = chunkIds([...ids, "id000"], 50);
		expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 20]);
		expect(chunks.flat()).toEqual(ids);
	});

	test("a return's refusals have their own words; the coordinator signs as such", () => {
		expect(returnErrorKey({ data: { code: "TEAM_WORK_ITEM_NOT_RETURNABLE" } })).toBe(
			"teams.page.drawer.errors.TEAM_WORK_ITEM_NOT_RETURNABLE",
		);
		expect(returnErrorKey({ data: { code: "TEAM_ARCHIVED" } })).toBe(
			"teams.page.drawer.errors.TEAM_ARCHIVED",
		);
		expect(returnErrorKey({ data: { code: "TEAM_HAS_LIVE_WORK" } })).toBeNull();
		expect(returnErrorKey(new Error("x"))).toBeNull();
		expect(isCoordinator({ actorKind: "agent", actorId: "lead" }, "lead")).toBe(true);
		expect(isCoordinator({ actorKind: "agent", actorId: "w" }, "lead")).toBe(false);
		expect(isCoordinator({ actorKind: "person", actorId: "lead" }, "lead")).toBe(false);
	});
});

describe("dependencies (D)", () => {
	const dep = (id: string, state: TeamBoardItem["state"]) => ({ id, title: `Item ${id}`, state });

	test("a queued row says what it waits for: one or two by title, more by count", () => {
		expect(queuedLine(undefined)).toEqual({
			key: "queued",
			values: {},
			detail: null,
			tone: "hollow",
		});
		expect(queuedLine([dep("a", "merged")]).key).toBe("queued");
		expect(queuedLine([dep("a", "ready"), dep("b", "merged")])).toEqual({
			key: "queuedWaitingOne",
			values: { first: "Item a" },
			detail: null,
			tone: "hollow",
		});
		expect(queuedLine([dep("a", "in_progress"), dep("b", "queued")]).values).toEqual({
			first: "Item a",
			second: "Item b",
		});
		expect(
			queuedLine([dep("a", "queued"), dep("b", "queued"), dep("c", "in_review")]),
		).toMatchObject({ key: "queuedWaitingMany", values: { count: 3 } });
		// A cancelled dependency never merges: said first, whatever else waits.
		expect(queuedLine([dep("a", "queued"), dep("b", "cancelled")])).toMatchObject({
			key: "queuedBlockedCancelled",
			values: { title: "Item b" },
		});
		// rowLine uses it for queued items only.
		const row = {
			item: item({ state: "queued", worker: null, dependsOn: [dep("a", "queued")] }),
			approval: null,
		};
		expect(rowLine(row, null, "main").key).toBe("queuedWaitingOne");
		const started = { item: item({ dependsOn: [dep("a", "merged")] }), approval: null };
		expect(rowLine(started, "working", "main").key.startsWith("queued")).toBe(false);
	});

	test("dependency events have headlines and notes", () => {
		expect(eventLabelKey("work.dependencies_changed")).toBe("work_dependencies_changed");
		expect(eventLabelKey("work.unblocked")).toBe("work_unblocked");
		expect(
			eventNote({ kind: "work.dependencies_changed", detail: { dependsOn: ["a", "b"] } }),
		).toEqual({ key: "dependencies", values: { count: 2 } });
		expect(eventNote({ kind: "work.dependencies_changed", detail: { dependsOn: [] } })).toEqual({
			key: "dependenciesCleared",
			values: {},
		});
		expect(eventNote({ kind: "work.dependencies_changed", detail: {} })).toBeNull();
		expect(eventNote({ kind: "work.unblocked", detail: { mergedItem: "a" } })).toEqual({
			key: "unblocked",
			values: {},
		});
	});
});

describe("review findings", () => {
	test("a short text never gets 展开; many lines or a long text does", () => {
		expect(findingsNeedToggle("缺少跨日边界用例。")).toBe(false);
		expect(findingsNeedToggle("a\nb\nc")).toBe(false);
		expect(findingsNeedToggle("a\nb\nc\nd")).toBe(true);
		expect(findingsNeedToggle("x".repeat(141))).toBe(true);
	});
});

describe("the coordinator's line", () => {
	const base = {
		teamId: "lead",
		coordinatorStatus: "working",
		runningAgents: [] as { id: string; title: string | null; status: string }[],
		runningCount: 0,
	};
	const agent = (id: string) => ({ id, title: null, status: "working" });
	test("the other running sessions; a lower bound when the list was cut", () => {
		expect(
			coordinatorLine({
				...base,
				runningAgents: [agent("lead"), agent("w1"), agent("w2")],
				runningCount: 3,
			}),
		).toEqual({ kind: "running", count: 2, more: false });
		// One listed, more beyond it: at least two.
		expect(coordinatorLine({ ...base, runningAgents: [agent("w1")], runningCount: 2 })).toEqual({
			kind: "running",
			count: 2,
			more: true,
		});
		// The full list (the coordinator and 19 others) and one past it: 20+.
		const full = [agent("lead"), ...Array.from({ length: 19 }, (_, i) => agent(`w${i}`))];
		expect(coordinatorLine({ ...base, runningAgents: full, runningCount: 21 })).toEqual({
			kind: "running",
			count: 20,
			more: true,
		});
	});
	test("a list cut down to the coordinator: 1+, never 0+", () => {
		expect(coordinatorLine({ ...base, runningAgents: [agent("lead")], runningCount: 2 })).toEqual({
			kind: "running",
			count: 1,
			more: true,
		});
	});
	test("nothing else running: the coordinator's own state", () => {
		expect(coordinatorLine({ ...base, runningAgents: [agent("lead")], runningCount: 1 })).toEqual({
			kind: "status",
			status: "working",
		});
		expect(coordinatorLine({ ...base, coordinatorStatus: "waiting" })).toEqual({
			kind: "status",
			status: "waiting",
		});
		expect(coordinatorLine({ ...base, coordinatorStatus: "archived" }).kind).toBe("status");
		expect(coordinatorLine({ ...base, coordinatorStatus: "something" })).toEqual({
			kind: "status",
			status: "idle",
		});
	});
});

describe("merge (M)", () => {
	const summary = {
		mode: "local" as const,
		phase: null,
		job: null,
		outcome: null,
		canMerge: true,
		disabledReason: null,
	};

	test("the control: merge, a running job, prepare again, disabled with its reason", () => {
		expect(mergeControl(undefined)).toBeNull();
		expect(mergeControl(summary)).toEqual({
			label: "merge",
			busy: false,
			enabled: true,
			disabledKey: null,
			panel: null,
		});
		expect(mergeControl({ ...summary, phase: "updating", job: "merge", canMerge: false })).toEqual({
			label: "merging",
			busy: true,
			enabled: false,
			disabledKey: null,
			panel: null,
		});
		expect(mergeControl({ ...summary, phase: "fast_forwarding", job: "fast_forward" })?.label).toBe(
			"fastForwarding",
		);
		expect(mergeControl({ ...summary, outcome: "prepared" })).toMatchObject({
			label: "prepareAgain",
			panel: "prepared",
		});
		expect(
			mergeControl({
				...summary,
				canMerge: false,
				disabledReason: "gh_logged_out",
				mode: "github",
			}),
		).toMatchObject({
			label: "openPr",
			enabled: false,
			disabledKey: "teams.page.merge.disabled.gh_logged_out",
		});
		expect(mergeControl({ ...summary, outcome: "conflict" })?.panel).toBe("conflict");
	});

	test("every disabled reason, blocker and known error code has words in both locales", () => {
		for (const locale of ["en", "zh-CN"]) {
			const merge = JSON.parse(
				readFileSync(new URL(`../../locales/${locale}/projects.json`, import.meta.url), "utf8"),
			).teams.page.merge;
			for (const reason of TEAM_MERGE_DISABLED_REASONS)
				expect({ locale, reason, text: typeof merge.disabled[reason] }).toEqual({
					locale,
					reason,
					text: "string",
				});
			for (const blocker of TEAM_FAST_FORWARD_BLOCKERS)
				expect({ locale, blocker, text: typeof merge.blocker[blocker] }).toEqual({
					locale,
					blocker,
					text: "string",
				});
			for (const code of Object.keys(merge.errors))
				expect(mergeErrorKey(code)).toBe(`teams.page.merge.errors.${code}`);
		}
		expect(mergeErrorKey("SOMETHING_ELSE")).toBeNull();
		expect(mergeErrorKey(null)).toBeNull();
		expect(mergeRequestCode({ data: { code: "TEAM_WORK_ITEM_MERGING" } })).toBe(
			"TEAM_WORK_ITEM_MERGING",
		);
		expect(mergeRequestCode(new Error("x"))).toBeNull();
	});

	test("a conflict's prefilled 退回 names at most 20 files and says when there are more", () => {
		expect(conflictReasonFiles(["a.ts", "b.ts"], false)).toEqual({
			files: "- a.ts\n- b.ts",
			more: false,
		});
		const many = Array.from({ length: 30 }, (_, index) => `f${index}.ts`);
		const cut = conflictReasonFiles(many, false);
		expect(cut.files.split("\n")).toHaveLength(MERGE_CONFLICT_REASON_FILES);
		expect(cut.more).toBe(true);
		expect(conflictReasonFiles(["a.ts"], true).more).toBe(true);
		expect(conflictReasonFiles(undefined, undefined)).toEqual({ files: "", more: false });
	});

	test("the activity words merge requests, failures, prepared merges and how an item merged", () => {
		const note = (kind: string, detail: Record<string, unknown>) => eventNote({ kind, detail });
		expect(note("work.merge_requested", { job: "merge" })).toEqual({
			key: "mergeRequested",
			values: {},
		});
		expect(note("work.merge_requested", { job: "fast_forward" })?.key).toBe("mergeFastForward");
		expect(note("work.merge_failed", { code: "conflict", conflicts: ["a", "b"] })).toEqual({
			key: "mergeConflict",
			values: { count: 2 },
		});
		expect(note("work.merge_failed", { code: "conflict", conflicts: ["a"], more: true })?.key).toBe(
			"mergeConflictMore",
		);
		expect(note("work.merge_failed", { code: "X", message: "base moved" })).toEqual({
			key: "text",
			values: { text: "base moved" },
		});
		expect(note("work.merge_prepared", { checkedOutAt: "/repo" })).toEqual({
			key: "mergePrepared",
			values: { path: "/repo" },
		});
		expect(note("work.merged", { detectedBy: "local_merge" })?.key).toBe("mergedLocal");
		expect(note("work.merged", { detectedBy: "local_merge", fastForwarded: "checkout" })?.key).toBe(
			"mergedFastForward",
		);
		expect(note("work.merged", { detectedBy: "ancestry" })?.key).toBe("mergedAncestry");
		for (const locale of ["en", "zh-CN"]) {
			const notes = JSON.parse(
				readFileSync(new URL(`../../locales/${locale}/projects.json`, import.meta.url), "utf8"),
			).teams.eventNote as Record<string, string>;
			for (const key of [
				"mergeRequested",
				"mergeFastForward",
				"mergeConflict_other",
				"mergeConflictMore",
				"mergePrepared",
				"mergedLocal",
				"mergedFastForward",
				"mergedAncestry",
			])
				expect({ locale, key, text: typeof notes[key] }).toEqual({ locale, key, text: "string" });
		}
	});
});

describe("pull requests (G)", () => {
	const pr = (over: Partial<TeamWorkPullRequest> = {}): TeamWorkPullRequest => ({
		number: 7,
		url: "https://github.com/acme/app/pull/7",
		state: "OPEN",
		isDraft: false,
		headMatches: true,
		mergeState: "CLEAN",
		review: null,
		checks: null,
		queued: false,
		checkedAt: "2026-11-25T00:00:00.000Z",
		refreshing: false,
		error: null,
		methods: ["squash", "merge"],
		canMergePr: true,
		mergeBlocker: null,
		...over,
	});
	const github = (over: Partial<TeamWorkMergeSummary> = {}): TeamWorkMergeSummary => ({
		mode: "github",
		phase: null,
		job: null,
		outcome: null,
		canMerge: true,
		disabledReason: null,
		pr: null,
		...over,
	});

	test("the main button: 发起 PR, 更新 PR after a re-ready, 重新发起 PR when closed, hidden while the PR is current", () => {
		expect(mergeControlOf(github())).toMatchObject({ label: "openPr", enabled: true });
		expect(mergeControlOf(github({ pr: pr({ headMatches: false }) }))?.label).toBe("updatePr");
		expect(mergeControlOf(github({ pr: pr({ state: "CLOSED" }) }))?.label).toBe("reopenPr");
		expect(mergeControlOf(github({ pr: pr() }))).toBeNull();
		// Not read yet, but recorded at this head: 查看 PR takes its place too.
		expect(mergeControlOf(github({ pr: pr({ state: null }) }))).toBeNull();
		for (const reason of [
			"checking",
			"gh_missing",
			"gh_logged_out",
			"gh_no_permission",
			"gh_repo_archived",
			"gh_unavailable",
			"worker_running",
		] as const)
			expect(mergeControlOf(github({ canMerge: false, disabledReason: reason }))).toMatchObject({
				label: "openPr",
				enabled: false,
				disabledKey: `teams.page.merge.disabled.${reason}`,
			});
		expect(mergeControlOf(github({ phase: "pushing", job: "pull_request" }))?.label).toBe(
			"pushing",
		);
		expect(mergeControlOf(github({ phase: "opening", job: "pull_request" }))?.label).toBe(
			"opening",
		);
		expect(mergeControlOf(github({ phase: "queued", job: "pull_request" }))?.label).toBe("pushing");
		expect(mergeControlOf(github({ phase: "merging", job: "pr_merge" }))).toMatchObject({
			label: "mergingPr",
			busy: true,
		});
		expect(mergeControlOf(github({ phase: "checking", job: "merge" }))?.label).toBe("pushing");
	});

	test("查看 PR #N with CI, review, conflict / behind / blocked / draft and queue labels", () => {
		const labels = (over: Partial<TeamWorkPullRequest>) =>
			pullRequestControl(github({ pr: pr(over) }))?.labels.map((label) => [label.kind, label.key]);
		const checks = (state: "passing" | "failing" | "pending" | "none") => ({
			state,
			pass: 3,
			fail: 2,
			pending: 1,
			skipping: 0,
			total: 6,
			failures: [{ name: "CI / test", link: "https://ci.example/1" }],
		});
		expect(labels({ checks: checks("passing") })).toEqual([["checks", "checksPassing"]]);
		expect(labels({ checks: checks("failing") })).toEqual([["checks", "checksFailing"]]);
		expect(
			pullRequestControl(github({ pr: pr({ checks: checks("failing") }) }))?.labels[0]?.values,
		).toEqual({ count: 2 });
		expect(
			pullRequestControl(github({ pr: pr({ checks: checks("pending") }) }))?.labels[0]?.values,
		).toEqual({ count: 1 });
		expect(labels({ checks: checks("none") })).toEqual([["checks", "checksNone"]]);
		expect(labels({ review: "REVIEW_REQUIRED" })).toEqual([["review", "reviewRequired"]]);
		expect(labels({ review: "APPROVED" })).toEqual([["review", "reviewApproved"]]);
		expect(labels({ review: "CHANGES_REQUESTED" })).toEqual([["review", "reviewChanges"]]);
		expect(labels({ mergeState: "DIRTY" })).toEqual([["state", "dirty"]]);
		expect(labels({ mergeState: "BEHIND" })).toEqual([["state", "behind"]]);
		expect(labels({ mergeState: "BLOCKED" })).toEqual([["state", "blocked"]]);
		expect(labels({ isDraft: true, mergeState: "DRAFT" })).toEqual([["state", "draft"]]);
		expect(labels({ queued: true })).toEqual([["queue", "queued"]]);
		expect(labels({ headMatches: false })).toEqual([["state", "stale"]]);
		expect(labels({ state: "CLOSED" })).toEqual([["state", "closed"]]);
		expect(labels({ state: null })).toEqual([["read", "checking"]]);
		expect(labels({ refreshing: true })).toEqual([["read", "checking"]]);
		const view = pullRequestControl(github({ pr: pr({ checks: checks("failing") }) }));
		expect(view).toMatchObject({
			number: 7,
			url: "https://github.com/acme/app/pull/7",
			showMerge: true,
			mergeEnabled: true,
			mergeDisabledKey: null,
			methods: ["squash", "merge"],
			failures: [{ name: "CI / test", link: "https://ci.example/1" }],
		});
		expect(pullRequestControl(github())).toBeNull();
		expect(pullRequestControl({ ...github({ pr: pr() }), mode: "local" })).toBeNull();
	});

	test("合并 PR: enabled only when GitHub says it can merge; otherwise the reason", () => {
		for (const blocker of TEAM_PR_MERGE_BLOCKERS) {
			const view = pullRequestControl(
				github({ pr: pr({ canMergePr: false, mergeBlocker: blocker }) }),
			);
			expect({ blocker, enabled: view?.mergeEnabled, key: view?.mergeDisabledKey }).toEqual({
				blocker,
				enabled: false,
				key: `teams.page.merge.prBlocker.${blocker}`,
			});
		}
		// A reason of the whole action (the worker running) comes first.
		expect(
			pullRequestControl(
				github({
					canMerge: false,
					disabledReason: "worker_running",
					pr: pr({ canMergePr: false, mergeBlocker: null }),
				}),
			)?.mergeDisabledKey,
		).toBe("teams.page.merge.disabled.worker_running");
		// Busy merging: shown, not pressable again.
		expect(
			pullRequestControl(github({ phase: "merging", job: "pr_merge", pr: pr() })),
		).toMatchObject({ busy: true, mergeEnabled: false });
		// Not shown for a stale head (更新 PR first) or a closed one.
		expect(pullRequestControl(github({ pr: pr({ headMatches: false }) }))?.showMerge).toBe(false);
		expect(pullRequestControl(github({ pr: pr({ state: "CLOSED" }) }))?.showMerge).toBe(false);
	});

	test("links are http(s) only", () => {
		expect(safeHref("https://github.com/acme/app/pull/7")).toBe(
			"https://github.com/acme/app/pull/7",
		);
		expect(safeHref("javascript:alert(1)")).toBeNull();
		expect(safeHref("data:text/html,x")).toBeNull();
		expect(safeHref(null)).toBeNull();
	});

	test("the activity words the pull request's events", () => {
		const note = (kind: string, detail: Record<string, unknown>) => eventNote({ kind, detail });
		expect(note("work.merge_requested", { job: "pull_request" })?.key).toBe("prRequested");
		expect(note("work.merge_requested", { job: "pr_merge", method: "squash" })).toEqual({
			key: "prMergeRequested",
			values: { method: "squash" },
		});
		expect(note("work.pr_pushed", { branch: "team/x" })).toEqual({
			key: "branch",
			values: { branch: "team/x" },
		});
		for (const kind of ["work.pr_opened", "work.pr_closed", "work.pr_queued"])
			expect(note(kind, { pr: 7 })).toEqual({ key: "prNumber", values: { pr: 7 } });
		expect(note("work.pr_checks", { checks: "failing", failed: 2 })).toEqual({
			key: "prChecksFailing",
			values: { count: 2 },
		});
		expect(note("work.pr_checks", { checks: "passing" })?.key).toBe("prChecksPassing");
		expect(note("work.pr_checks", { review: "CHANGES_REQUESTED" })?.key).toBe("prChangesRequested");
		expect(note("work.pr_checks", { review: "APPROVED" })?.key).toBe("prApproved");
		expect(note("work.merged", { detectedBy: "pull_request", pr: 7 })).toEqual({
			key: "mergedPullRequest",
			values: { pr: 7 },
		});
		for (const kind of [
			"work.pr_pushed",
			"work.pr_opened",
			"work.pr_checks",
			"work.pr_closed",
			"work.pr_queued",
		])
			expect(eventLabelKey(kind)).toBe(kind.replace(".", "_"));
	});

	test("every pull request word exists in both locales", () => {
		for (const locale of ["en", "zh-CN"]) {
			const teams = JSON.parse(
				readFileSync(new URL(`../../locales/${locale}/projects.json`, import.meta.url), "utf8"),
			).teams;
			const merge = teams.page.merge;
			for (const blocker of TEAM_PR_MERGE_BLOCKERS)
				expect({ locale, blocker, text: typeof merge.prBlocker[blocker] }).toEqual({
					locale,
					blocker,
					text: "string",
				});
			for (const method of TEAM_PR_MERGE_METHODS)
				expect({ locale, method, text: typeof merge.method[method] }).toEqual({
					locale,
					method,
					text: "string",
				});
			for (const key of [
				"checking",
				"closed",
				"merged",
				"stale",
				"checksPassing",
				"checksFailing_other",
				"checksPending_other",
				"checksNone",
				"reviewApproved",
				"reviewChanges",
				"reviewRequired",
				"draft",
				"dirty",
				"behind",
				"blocked",
				"queued",
				"failuresTitle",
				"readFailed",
			])
				expect({ locale, key, text: typeof merge.pr[key] }).toEqual({
					locale,
					key,
					text: "string",
				});
			for (const key of [
				"openPr",
				"updatePr",
				"reopenPr",
				"pushing",
				"opening",
				"mergingPr",
				"viewPr",
				"mergePr",
				"methodMenu",
				"methodDefault",
				"barNotePr",
				"pushRejectedReason",
			])
				expect({ locale, key, text: typeof merge[key] }).toEqual({ locale, key, text: "string" });
			for (const key of [
				"prRequested",
				"prMergeRequested",
				"prNumber",
				"prChecksFailing_other",
				"prChecksPassing",
				"prChangesRequested",
				"prApproved",
				"mergedPullRequest",
			])
				expect({ locale, key, text: typeof teams.eventNote[key] }).toEqual({
					locale,
					key,
					text: "string",
				});
			// The promise of a coming PR flow is gone everywhere.
			expect(JSON.stringify(teams)).not.toMatch(/coming soon|即将提供/);
		}
	});
});
