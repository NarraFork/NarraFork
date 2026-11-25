import { describe, expect, test } from "bun:test";
import type {
	ProjectAttentionEntry,
	ProjectListSummary,
	ProjectSessionRow,
	TeamCard,
} from "@shared/project-overview";
import type { TeamBoardItem, TeamPendingApproval } from "@shared/project-teams";
import { attentionView } from "../teams/team-page-model";
import {
	activityAgo,
	pathTail,
	projectAttentionEntries,
	sessionCountLabel,
	sessionLine,
	sessionSections,
	sessionTone,
	sortProjects,
	teamCardBadge,
	teamCardNumbers,
	teamCardStatus,
	teamOfItem,
} from "./project-page-model";

const approval = (id: string, patch: Partial<TeamPendingApproval> = {}): TeamPendingApproval => ({
	id,
	agent: { id: `agent-${id}`, title: `Agent ${id}`, status: "waiting" },
	depth: 0,
	toolName: "Bash",
	kind: "tool",
	preview: "pnpm test",
	questions: [],
	decisionReason: null,
	createdAt: "2026-11-25T00:00:00.000Z",
	...patch,
});

const item = (id: string): TeamBoardItem => ({
	id,
	title: `Item ${id}`,
	kind: "code",
	state: "ready",
	branch: `team/${id}`,
	baseRef: null,
	headSha: null,
	worker: null,
	reviewRounds: 1,
	lastReview: "clear",
	hasWorktree: true,
	exclusiveKey: null,
	createdAt: "2026-11-25T00:00:00.000Z",
	updatedAt: "2026-11-25T00:00:00.000Z",
});

describe("path tail", () => {
	test("keeps the last two parts after an ellipsis; short paths stay whole", () => {
		expect(pathTail("/home/me/code/acme-app")).toBe("…/code/acme-app");
		expect(pathTail("/srv/app")).toBe("/srv/app");
		expect(pathTail("C:\\Users\\me\\code\\app")).toBe("…\\code\\app");
		expect(pathTail(null)).toBe("");
	});
});

describe("attention", () => {
	const entries: ProjectAttentionEntry[] = [
		{
			kind: "approval",
			approval: approval("call-1"),
			source: { kind: "team", teamId: "team-a", name: "Release" },
		},
		{
			kind: "approval",
			approval: approval("call-2", { kind: "question", toolName: "AskUserQuestion" }),
			source: { kind: "session", narratorId: "s1", title: "Cache study", ownerName: "zhou" },
		},
		{
			kind: "approval",
			approval: approval("call-3", { kind: "plan" }),
			source: { kind: "team", teamId: "team-a", name: "Release" },
		},
		{
			kind: "merge",
			item: item("w1"),
			base: "main",
			source: { kind: "team", teamId: "team-b", name: "Perf" },
		},
	];

	test("each entry becomes the team page's card, keeping its source, kind and order", () => {
		const cards = projectAttentionEntries(entries);
		expect(cards.map((card) => [card.kind, card.id])).toEqual([
			["tool", "approval:call-1"],
			["question", "approval:call-2"],
			["plan", "approval:call-3"],
			["merge", "merge:w1"],
		]);
		expect(cards[1]?.source).toEqual(entries[1]?.source);
		const merge = cards[3];
		expect(merge?.kind === "merge" && merge.base).toBe("main");
	});

	test("a ready item opens the team it belongs to", () => {
		expect(teamOfItem(entries, "w1")).toBe("team-b");
		expect(teamOfItem(entries, "missing")).toBeNull();
	});

	test("more than three cards collapse into 「还有 N 条」", () => {
		const cards = projectAttentionEntries(entries);
		expect(attentionView(cards, false)).toMatchObject({ hidden: 1 });
		expect(attentionView(cards, false).shown).toHaveLength(3);
		expect(attentionView(cards, true)).toMatchObject({ hidden: 0 });
		expect(projectAttentionEntries([])).toEqual([]);
	});
});

describe("sessions", () => {
	const row = (
		id: string,
		status: string,
		patch: Partial<ProjectSessionRow> = {},
	): ProjectSessionRow => ({
		id,
		title: id,
		status,
		group: status === "working" || status === "waiting" ? "running" : "recent",
		updatedAt: "2026-11-25T00:00:00.000Z",
		owner: null,
		activity: null,
		...patch,
	});

	test("进行中 splits running sessions from 「最近 7 天」; a repeated row keeps its first place", () => {
		const rows = [row("a", "waiting"), row("b", "working"), row("c", "idle"), row("a", "idle")];
		expect(sessionSections(rows, "active").map((s) => [s.key, s.rows.map((r) => r.id)])).toEqual([
			["running", ["a", "b"]],
			["recent", ["c"]],
		]);
		expect(sessionSections([row("c", "idle")], "active").map((s) => s.key)).toEqual(["recent"]);
		expect(sessionSections(rows, "all")).toEqual([{ key: "all", rows: rows.slice(0, 3) }]);
		expect(sessionSections([], "mine")).toEqual([]);
	});

	test("a row's dot and line: waiting is amber with what it waits on, working shows its tool", () => {
		expect(sessionTone("waiting")).toBe("amber");
		expect(sessionTone("working")).toBe("blue");
		expect(sessionTone("idle")).toBe("hollow");
		const activity = (toolName: string, preview: string) => ({ toolName, preview, at: "" });
		expect(sessionLine(row("w", "waiting", { activity: activity("Edit", "docs/a.md") }))).toEqual({
			key: "waitingTool",
			values: { tool: "Edit" },
			detail: "docs/a.md",
			tool: false,
			tone: "amber",
		});
		expect(
			sessionLine(row("q", "waiting", { activity: activity("AskUserQuestion", "") }))?.key,
		).toBe("waitingAnswer");
		expect(sessionLine(row("p", "waiting"))?.key).toBe("waitingPerson");
		expect(sessionLine(row("r", "working", { activity: activity("Bash", "pnpm test") }))).toEqual({
			key: "activity",
			values: { tool: "Bash" },
			detail: "pnpm test",
			tool: true,
			tone: "blue",
		});
		expect(sessionLine(row("x", "working"))?.key).toBe("working");
		expect(sessionLine(row("i", "idle"))).toBeNull();
	});

	test("tab counts say 999+ past the cap", () => {
		expect(sessionCountLabel(3, 999)).toBe("3");
		expect(sessionCountLabel(1000, 999)).toBe("999+");
		expect(sessionCountLabel(undefined, 999)).toBe("");
	});
});

describe("team cards", () => {
	const team = (
		patch: Partial<TeamCard> = {},
		card: Partial<NonNullable<TeamCard["card"]>> = {},
	): TeamCard => ({
		id: "t",
		projectId: "p",
		name: "Release",
		baseBranch: "main",
		status: "active",
		coordinatorStatus: "working",
		createdBy: null,
		createdAt: "",
		updatedAt: "",
		access: "write",
		briefBytes: 0,
		...patch,
		card: {
			columnCounts: { queued: 1, in_progress: 2, review: 2, done: 4, cancelled: 1 },
			readyCount: 1,
			runningCount: 3,
			pendingApprovalCount: 2,
			coordinatorStopReason: null,
			coordinatorMessageCount: 5,
			lastEventAt: null,
			...card,
		},
	});

	test("numbers: in progress counts queued, working and in review; ready and done apart", () => {
		expect(teamCardNumbers(team().card)).toEqual({ inProgress: 4, ready: 1, done: 4 });
		expect(teamCardNumbers(undefined)).toEqual({ inProgress: 0, ready: 0, done: 0 });
	});

	test("a member's card waits on calls and items to accept; an onlooker's has no badge", () => {
		expect(teamCardBadge(team())).toBe(3);
		expect(teamCardStatus(team())).toEqual({
			tone: "active",
			parts: [
				{ key: "inProgress", count: 4 },
				{ key: "waitingYou", count: 3 },
			],
		});
		const onlooker = team({ access: "read" }, { pendingApprovalCount: null });
		expect(teamCardBadge(onlooker)).toBe(0);
		expect(teamCardStatus(onlooker)?.parts.at(-1)).toEqual({ key: "waitingMembers", count: 1 });
	});

	test("paused, idle and archived read as on the team page", () => {
		expect(
			teamCardStatus(team({}, { runningCount: 0, coordinatorStopReason: "user_interrupt" })),
		).toEqual({ tone: "paused", parts: [{ key: "paused" }] });
		const idle = team(
			{ coordinatorStatus: "idle" },
			{
				columnCounts: { queued: 0, in_progress: 0, review: 0, done: 6, cancelled: 0 },
				readyCount: 0,
				pendingApprovalCount: 0,
				runningCount: 0,
			},
		);
		expect(teamCardStatus(idle)).toEqual({
			tone: "idle",
			parts: [{ key: "idle" }, { key: "done", count: 6 }],
		});
		expect(teamCardStatus(team({ coordinatorStatus: "archived" }))?.tone).toBe("archived");
		expect(teamCardStatus({ ...team(), card: undefined })).toBeNull();
	});
});

describe("project list order", () => {
	const summary = (projectId: string, waitingCount: number, lastActivityAt: string | null) =>
		[
			projectId,
			{
				projectId,
				runningSessionCount: 0,
				teamCount: 0,
				waitingCount,
				lastActivityAt,
				capped: false,
			} satisfies ProjectListSummary,
		] as const;

	test("waiting first, then the most recent activity, then the list's own order", () => {
		const projects = [
			{ id: "quiet", name: "quiet", updatedAt: "2026-11-20T00:00:00Z" },
			{ id: "busy", name: "busy", updatedAt: "2026-11-01T00:00:00Z" },
			{ id: "waiting-old", name: "waiting-old", updatedAt: "2026-10-01T00:00:00Z" },
			{ id: "no-summary", name: "no-summary", updatedAt: "2026-11-22T00:00:00Z" },
			{ id: "tie", name: "tie", updatedAt: "2026-11-20T00:00:00Z" },
		];
		const summaries = new Map([
			summary("quiet", 0, null),
			summary("busy", 0, "2026-11-24T00:00:00Z"),
			summary("waiting-old", 2, "2026-10-01T00:00:00Z"),
		]);
		expect(sortProjects(projects, summaries).map((p) => p.id)).toEqual([
			"waiting-old",
			"busy",
			"no-summary",
			"quiet",
			"tie",
		]);
	});

	test("the card's activity wording", () => {
		const now = new Date("2026-11-25T12:00:00Z");
		const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
		expect(activityAgo(ago(0), now)).toEqual({ key: "justNow", count: 0 });
		expect(activityAgo(ago(8), now)).toEqual({ key: "minutes", count: 8 });
		expect(activityAgo(ago(90), now)).toEqual({ key: "hours", count: 1 });
		expect(activityAgo(ago(30 * 60), now)).toEqual({ key: "yesterday", count: 1 });
		expect(activityAgo(ago(3 * 24 * 60), now)).toEqual({ key: "days", count: 3 });
		expect(activityAgo(ago(16 * 24 * 60), now).key).toBe("date");
		expect(activityAgo(null, now).key).toBe("never");
	});
});
