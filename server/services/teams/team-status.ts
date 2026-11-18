/**
 * Team status for the coordinator (docs/PROJECT_TEAMS-PLAN.md §二.2 and §二.14, P2).
 *
 * The coordinator does not have to remember the team: the system writes one `sys` row
 * (`team_status`) into its history
 *   - at the start of a run, unless the very same text is already in the current context (same
 *     compaction cycle, the row still in the history);
 *   - on the first pass after a compaction or a context clear (the latest compact marker moved);
 *   - at a tool boundary of a long run, at most every {@link TEAM_STATUS_CADENCE_MS}, and only
 *     when the text changed.
 *
 * Never in the system prompt, the tool definitions or a named context part, so the system
 * prompt of two runs is byte-identical whatever the team did. The text is deterministic: the
 * same state gives the same bytes (no relative times, no "now"; the week of the overrun count
 * is named by its first day), at most {@link TEAM_STATUS_MAX_BYTES}.
 *
 * CONTENT, in this order: heading (team name = coordinator title, base branch), the team brief
 * (P1, ≤ 4 KB; written whole once per compaction cycle — again when it changes or the row that
 * carried it left the history — and named in one line in the rows after that), a context note when the last measured use is above the team's suggested share,
 * this week's limit overruns by kind, approvals waiting in the team tree, work items (open ones
 * listed, finished ones counted), the files this team's open items share with other open items
 * and the project's exclusive paths lock (X; only when there is one of them), and the latest
 * decisions recorded on people's behalf. Lists are filled by priority (approvals, work items,
 * overlaps, decisions) into what the budget leaves, and what does not fit is counted.
 *
 * READS, all bounded: the team and coordinator rows by primary key; open work items
 * (`team_id, state` index, 31 rows) and capped state/finished counts (1,001 ids each); this
 * week's overrun kinds (`team_id, created_at` index, 1,001 rows); the latest 200 event kinds
 * and up to 5 decision details by primary key; the live permission registry in memory (at most
 * 1,000 entries looked at) with one `IN` lookup of their narrators; the project's overlap index
 * (`team-overlap.ts`: built from stored paths at most once per pass interval, ≤ 100 items) with
 * one `IN` read of its items and their coordinators. SQLite only, like the session runtime it
 * serves.
 */

import { hotSafe } from "@server/lib/hot-safe";
import {
	COORDINATOR_OVERRUN_EVENT_PREFIX,
	COORDINATOR_OVERRUN_KINDS,
	type CoordinatorOverrunKind,
	effectiveCoordinatorLimits,
	TEAM_DECISION_EVENT_KIND,
	TEAM_STATUS_CADENCE_MS,
	TEAM_STATUS_MAX_BYTES,
	TEAM_WORK_ITEM_FINISHED_STATES,
	TEAM_WORK_ITEM_STATES,
	type TeamSettings,
	type TeamWorkItemState,
} from "@shared/project-teams";
import { and, asc, desc, eq, gte, inArray, like, notInArray } from "drizzle-orm";
import { db } from "../../db";
import {
	narratorMessageRefs,
	narrators,
	projectTeams,
	teamWorkEvents,
	teamWorkItems,
} from "../../db/schema";
import type { Locale } from "../../lib/i18n";
import { logger } from "../../lib/logger";
import {
	getTeamOverlapLabels,
	getTeamStatusLabels,
	type TeamStatusLabels,
} from "../../lib/prompts/team-coordinator-notes";
import { beginCoordinatorRun } from "./coordinator-limits";
import type { TeamOverlapStatus } from "./team-overlap";

export const TEAM_STATUS_SOURCE = "team_status";

export const TEAM_STATUS_LIMITS = {
	openItems: 30,
	countCap: 1000,
	approvalsLooked: 1000,
	approvals: 10,
	recentEvents: 200,
	decisions: 5,
	overlaps: 10,
	titleChars: 80,
	summaryChars: 120,
} as const;

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** One line of plain text, at most `max` characters. */
function oneLine(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Monday 00:00 UTC of the week holding `now`. */
export function teamWeekStart(now: number): Date {
	const date = new Date(now);
	const day = (date.getUTCDay() + 6) % 7;
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
}

const countText = (count: number) =>
	count > TEAM_STATUS_LIMITS.countCap ? `${TEAM_STATUS_LIMITS.countCap}+` : String(count);

// ─────────────────────────────────────────────────────────────────────────────
// Reading the state
// ─────────────────────────────────────────────────────────────────────────────

interface StatusApproval {
	key: string;
	tool: string;
	who: string | null;
	summary: string;
}

interface StatusState {
	name: string;
	baseBranch: string;
	brief: string;
	contextLimit: number;
	openItems: Array<{
		state: TeamWorkItemState;
		title: string;
		branch: string | null;
		worker: string | null;
	}>;
	openCounts: Partial<Record<TeamWorkItemState, number>>;
	openTotal: number;
	finished: number;
	approvals: StatusApproval[];
	weekStart: string;
	overruns: Partial<Record<CoordinatorOverrunKind, number>>;
	overrunTotal: number;
	decisions: Array<{ date: string; summary: string }>;
	/** X: overlaps with other open items and the exclusive lock (null when unavailable). */
	overlap: TeamOverlapStatus | null;
}

const SUMMARY_KEYS = ["command", "file_path", "path", "url", "pattern", "description"] as const;

function approvalSummary(input: Record<string, unknown> | undefined): string {
	for (const key of SUMMARY_KEYS) {
		const value = input?.[key];
		if (typeof value === "string" && value.trim())
			return oneLine(value, TEAM_STATUS_LIMITS.summaryChars);
	}
	return "";
}

/** Live approvals of the coordinator and of narrators whose ACL root it is. */
async function readTeamApprovals(teamId: string): Promise<StatusApproval[]> {
	const { pendingPermissions } = await import("../narrator-session-state");
	const live: Array<{ key: string; narratorId: string; tool: string; summary: string }> = [];
	let looked = 0;
	for (const [key, pending] of pendingPermissions) {
		if (++looked > TEAM_STATUS_LIMITS.approvalsLooked) break;
		if (pending.signal.aborted) continue;
		live.push({
			key,
			narratorId: pending.narratorId,
			tool: pending.toolName,
			summary: approvalSummary(pending.input),
		});
	}
	if (live.length === 0) return [];
	const ids = [...new Set(live.map((entry) => entry.narratorId))];
	const rows = db
		.select({ id: narrators.id, title: narrators.title, root: narrators.aclRootNarratorId })
		.from(narrators)
		.where(inArray(narrators.id, ids))
		.all();
	const inTeam = new Map(
		rows
			.filter((row) => row.id === teamId || row.root === teamId)
			.map((row) => [row.id, row.id === teamId ? null : (row.title ?? "")]),
	);
	return live
		.filter((entry) => inTeam.has(entry.narratorId))
		.map((entry) => {
			const title = inTeam.get(entry.narratorId);
			return {
				key: entry.key,
				tool: entry.tool,
				// null = the coordinator itself; "" = an untitled subagent.
				who: title === null || title === undefined ? null : oneLine(title, 60),
				summary: entry.summary,
			};
		})
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

async function readStatusState(teamId: string, now: number): Promise<StatusState | null> {
	const team = db
		.select({
			projectId: projectTeams.projectId,
			brief: projectTeams.brief,
			baseBranch: projectTeams.baseBranch,
			settings: projectTeams.settingsJson,
		})
		.from(projectTeams)
		.where(eq(projectTeams.narratorId, teamId))
		.get();
	if (!team) return null;
	const coordinator = db
		.select({ title: narrators.title })
		.from(narrators)
		.where(eq(narrators.id, teamId))
		.get();
	const finishedStates = [...TEAM_WORK_ITEM_FINISHED_STATES];

	const openRows = db
		.select({
			state: teamWorkItems.state,
			title: teamWorkItems.title,
			branch: teamWorkItems.branchName,
			worker: teamWorkItems.workerNarratorId,
		})
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.teamId, teamId), notInArray(teamWorkItems.state, finishedStates)))
		.orderBy(asc(teamWorkItems.createdAt), asc(teamWorkItems.id))
		.limit(TEAM_STATUS_LIMITS.openItems)
		.all();
	const openStates = db
		.select({ state: teamWorkItems.state })
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.teamId, teamId), notInArray(teamWorkItems.state, finishedStates)))
		.limit(TEAM_STATUS_LIMITS.countCap + 1)
		.all();
	const finished = db
		.select({ id: teamWorkItems.id })
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.teamId, teamId), inArray(teamWorkItems.state, finishedStates)))
		.limit(TEAM_STATUS_LIMITS.countCap + 1)
		.all().length;
	const openCounts: Partial<Record<TeamWorkItemState, number>> = {};
	for (const row of openStates) openCounts[row.state] = (openCounts[row.state] ?? 0) + 1;
	const workerIds = [...new Set(openRows.flatMap((row) => (row.worker ? [row.worker] : [])))];
	const workerTitles = new Map(
		workerIds.length
			? db
					.select({ id: narrators.id, title: narrators.title })
					.from(narrators)
					.where(inArray(narrators.id, workerIds))
					.all()
					.map((row) => [row.id, row.title ?? ""])
			: [],
	);

	const week = teamWeekStart(now);
	const overrunRows = db
		.select({ kind: teamWorkEvents.kind })
		.from(teamWorkEvents)
		.where(
			and(
				eq(teamWorkEvents.teamId, teamId),
				gte(teamWorkEvents.createdAt, week.toISOString()),
				like(teamWorkEvents.kind, `${COORDINATOR_OVERRUN_EVENT_PREFIX}%`),
			),
		)
		.limit(TEAM_STATUS_LIMITS.countCap + 1)
		.all();
	const overruns: Partial<Record<CoordinatorOverrunKind, number>> = {};
	for (const row of overrunRows) {
		const kind = row.kind.slice(COORDINATOR_OVERRUN_EVENT_PREFIX.length) as CoordinatorOverrunKind;
		if (COORDINATOR_OVERRUN_KINDS.includes(kind)) overruns[kind] = (overruns[kind] ?? 0) + 1;
	}

	const recent = db
		.select({ id: teamWorkEvents.id, kind: teamWorkEvents.kind })
		.from(teamWorkEvents)
		.where(eq(teamWorkEvents.teamId, teamId))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(TEAM_STATUS_LIMITS.recentEvents)
		.all();
	const decisionIds = recent
		.filter((row) => row.kind === TEAM_DECISION_EVENT_KIND)
		.slice(0, TEAM_STATUS_LIMITS.decisions)
		.map((row) => row.id);
	const decisionRows = decisionIds.length
		? db
				.select({
					id: teamWorkEvents.id,
					createdAt: teamWorkEvents.createdAt,
					detail: teamWorkEvents.detailJson,
				})
				.from(teamWorkEvents)
				.where(inArray(teamWorkEvents.id, decisionIds))
				.all()
		: [];
	const decisions = decisionRows
		.sort(
			(a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
		)
		.flatMap((row) => {
			const summary = row.detail?.summary;
			return typeof summary === "string" && summary.trim()
				? [
						{
							date: row.createdAt.slice(0, 10),
							summary: oneLine(summary, TEAM_STATUS_LIMITS.summaryChars),
						},
					]
				: [];
		});

	return {
		name: oneLine(coordinator?.title ?? "", TEAM_STATUS_LIMITS.titleChars),
		baseBranch: team.baseBranch,
		brief: team.brief.trim(),
		contextLimit: effectiveCoordinatorLimits((team.settings ?? {}) as TeamSettings).contextPercent,
		openItems: openRows.map((row) => ({
			state: row.state,
			title: oneLine(row.title, TEAM_STATUS_LIMITS.titleChars),
			branch: row.branch,
			worker: row.worker ? oneLine(workerTitles.get(row.worker) ?? "", 60) || null : null,
		})),
		openCounts,
		openTotal: openStates.length,
		finished,
		approvals: await readTeamApprovals(teamId),
		weekStart: week.toISOString().slice(0, 10),
		overruns,
		overrunTotal: overrunRows.length,
		decisions,
		overlap: await readOverlapStatus(teamId, team.projectId),
	};
}

async function readOverlapStatus(
	teamId: string,
	projectId: string,
): Promise<TeamOverlapStatus | null> {
	try {
		const { teamOverlapStatus } = await import("./team-overlap");
		return await teamOverlapStatus(teamId, projectId, TEAM_STATUS_LIMITS.overlaps);
	} catch (error) {
		logger.warn("Team status could not read the overlaps", { teamId, error: String(error) });
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering (pure)
// ─────────────────────────────────────────────────────────────────────────────

interface ListSection {
	lines: string[];
	/** All entries, including those not read. */
	total: number;
	more: (count: number) => string;
}

/** Add list lines while they fit, keeping room for the "N more" line. */
function fitList(list: ListSection, budget: number): { lines: string[]; bytes: number } {
	const out: string[] = [];
	let bytes = 0;
	const reserve = utf8Bytes(list.more(list.total)) + 1;
	for (const [index, line] of list.lines.entries()) {
		const need = utf8Bytes(line) + 1;
		const last = index === list.lines.length - 1 && list.total === list.lines.length;
		if (bytes + need + (last ? 0 : reserve) > budget) break;
		out.push(line);
		bytes += need;
	}
	const dropped = list.total - out.length;
	if (dropped > 0 && bytes + reserve <= budget) {
		out.push(list.more(dropped));
		bytes += reserve;
	}
	return { lines: out, bytes };
}

/** Cut text to at most `maxBytes` UTF-8 bytes on a character boundary. */
function cutToBytes(text: string, maxBytes: number): string {
	if (utf8Bytes(text) <= maxBytes) return text;
	// The longest prefix that fits, by binary search over its length.
	let lo = 0;
	let hi = Math.min(text.length, maxBytes);
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (utf8Bytes(text.slice(0, mid)) <= maxBytes) lo = mid;
		else hi = mid - 1;
	}
	// Never end on the first half of a surrogate pair.
	const last = text.charCodeAt(lo - 1);
	if (lo > 0 && last >= 0xd800 && last <= 0xdbff) lo--;
	return text.slice(0, lo);
}

export interface TeamStatusInput {
	contextPercent?: number;
	/**
	 * The brief text the coordinator already has in its current context (written by an earlier
	 * status row of this compaction cycle). The same brief is then named, not repeated.
	 */
	briefShown?: string;
}

/** Whether a status for this state carries the brief text itself. */
export function statusIncludesBrief(state: { brief: string }, briefShown?: string): boolean {
	return briefShown === undefined || briefShown !== state.brief;
}

/** The status text for this state. Pure: the same state and locale give the same bytes. */
export function renderTeamStatus(
	state: StatusState,
	locale: Locale,
	input: TeamStatusInput = {},
): string {
	const t: TeamStatusLabels = getTeamStatusLabels(locale);
	const max = TEAM_STATUS_MAX_BYTES;

	const header = [t.heading(state.name, state.baseBranch)];
	const notes: string[] = [];
	if (input.contextPercent !== undefined && input.contextPercent >= state.contextLimit)
		notes.push(t.context(state.contextLimit));
	const byKind = COORDINATOR_OVERRUN_KINDS.flatMap((kind) =>
		state.overruns[kind] ? [`${t.overrunKind[kind]} ${state.overruns[kind]}`] : [],
	).join(t.separator);
	notes.push(
		state.overrunTotal > 0
			? t.overruns(state.weekStart, countText(state.overrunTotal), byKind)
			: t.noOverruns(state.weekStart),
	);
	const approvalsHead =
		state.approvals.length > 0 ? t.approvals(String(state.approvals.length)) : t.noApprovals;
	const stateCounts = TEAM_WORK_ITEM_STATES.flatMap((itemState) =>
		state.openCounts[itemState]
			? [`${t.state[itemState]} ${countText(state.openCounts[itemState] ?? 0)}`]
			: [],
	);
	if (state.finished > 0) stateCounts.push(t.finished(countText(state.finished)));
	const itemsHead =
		stateCounts.length > 0 ? t.workItems(stateCounts.join(t.separator)) : t.noWorkItems;
	const decisionsHead = state.decisions.length > 0 ? t.decisions : null;
	const o = getTeamOverlapLabels(locale);
	const overlap = state.overlap ?? null;
	const overlapShown =
		overlap !== null &&
		(overlap.total > 0 ||
			overlap.lock !== null ||
			overlap.unlocked.length > 0 ||
			overlap.rewound.length > 0);
	const overlapFixed: string[] = [];
	if (overlap && overlapShown) {
		overlapFixed.push(overlap.total > 0 ? o.heading(countText(overlap.total)) : o.none);
		if (overlap.lock)
			overlapFixed.push(
				overlap.lock.mine
					? o.lockMine(overlap.lock.title ?? "")
					: o.lockOther(overlap.lock.team, overlap.lock.title),
			);
		if (overlap.unlocked.length > 0)
			overlapFixed.push(o.unlocked(overlap.unlocked.join(o.separator)));
		if (overlap.rewound.length > 0) overlapFixed.push(o.rewound(overlap.rewound.join(o.separator)));
	}

	const lists = {
		approvals: {
			lines: state.approvals.map((a) =>
				t.approval(a.tool, a.who === null ? t.coordinatorSelf : a.who || t.unnamedAgent, a.summary),
			),
			total: state.approvals.length,
			more: t.moreApprovals,
		},
		items: {
			lines: state.openItems.map((item) =>
				t.item(t.state[item.state], item.title, item.branch, item.worker),
			),
			total: state.openTotal,
			more: t.moreItems,
		},
		overlaps: {
			lines: (overlapShown && overlap ? overlap.lines : []).map((line) =>
				o.line(
					line.path,
					line.kind === "dir",
					line.mine.map((title) => `"${title}"`).join(o.separator),
					line.others.map((other) => o.other(other.team, other.title)).join(o.separator),
				),
			),
			total: overlapShown && overlap ? overlap.total : 0,
			more: o.more,
		},
		decisions: {
			lines: state.decisions.map((d) => t.decision(d.date, d.summary)),
			total: state.decisions.length,
			more: t.moreDecisions,
		},
	} satisfies Record<string, ListSection>;

	// Fixed parts first: heading, notes and every section's first line; then the brief; then
	// the lists in priority order with what is left. Sections are separated by a blank line.
	const fixed = [
		...header,
		...notes,
		approvalsHead,
		itemsHead,
		...overlapFixed,
		...(decisionsHead ? [decisionsHead] : []),
	];
	const sectionCount = 7;
	let used = utf8Bytes(fixed.join("\n")) + sectionCount * 2;
	let briefLines: string[];
	if (state.brief && !statusIncludesBrief(state, input.briefShown))
		briefLines = [t.briefShown(utf8Bytes(state.brief))];
	else if (state.brief) {
		const full = `${t.briefHeading}\n${state.brief}`;
		const room = max - used - 1;
		if (utf8Bytes(full) <= room) briefLines = [full];
		else {
			const marker = t.briefCut(utf8Bytes(state.brief));
			briefLines = [`${cutToBytes(full, Math.max(0, room - utf8Bytes(marker) - 1))}\n${marker}`];
		}
	} else briefLines = [t.noBrief];
	used += utf8Bytes(briefLines.join("\n")) + 1;
	const fitted: Record<keyof typeof lists, string[]> = {
		approvals: [],
		items: [],
		overlaps: [],
		decisions: [],
	};
	for (const key of ["approvals", "items", "overlaps", "decisions"] as const) {
		const { lines, bytes } = fitList(lists[key], Math.max(0, max - used));
		fitted[key] = lines;
		used += bytes;
	}

	const sections = [
		header,
		briefLines,
		notes,
		[approvalsHead, ...fitted.approvals],
		[itemsHead, ...fitted.items],
		...(overlapShown ? [[...overlapFixed, ...fitted.overlaps]] : []),
		...(decisionsHead ? [[decisionsHead, ...fitted.decisions]] : []),
	];
	const text = sections.map((lines) => lines.join("\n")).join("\n\n");
	// The budget above holds by construction; this is the backstop.
	return cutToBytes(text, max);
}

/** Read the team's state and render its status, or null when the id is no team. */
export async function readTeamStatus(
	teamId: string,
	locale: Locale,
	options: { now?: number; contextPercent?: number; briefShown?: string } = {},
): Promise<{
	text: string;
	/** The same state rendered with the brief itself, to compare with a row that carried it. */
	textWithBrief: string;
	brief: string;
	briefIncluded: boolean;
} | null> {
	const state = await readStatusState(teamId, options.now ?? Date.now());
	if (!state) return null;
	const text = renderTeamStatus(state, locale, options);
	const briefIncluded = statusIncludesBrief(state, options.briefShown);
	return {
		text,
		textWithBrief: briefIncluded
			? text
			: renderTeamStatus(state, locale, { ...options, briefShown: undefined }),
		brief: state.brief,
		briefIncluded,
	};
}

/** Whether the last row already says what this status says. */
function sameAsLast(last: Delivered, status: { text: string; textWithBrief: string }): boolean {
	if (last.text === status.text) return true;
	return last.messageId !== null && last.messageId === last.briefMessageId
		? last.text === status.textWithBrief
		: false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing the row
// ─────────────────────────────────────────────────────────────────────────────

/** What writing needs from the session layer: a seam tests replace. */
export interface TeamStatusDelivery {
	deliver(
		narratorId: string,
		row: {
			content: string;
			source: string;
			schedule: "none" | "onNextTurn";
			locale: Locale;
		},
	): Promise<{ messageId: string | null; turnText: string | null }>;
	/** Whether a delivered row is still in the narrator's history. */
	stillInHistory(narratorId: string, messageId: string): Promise<boolean>;
}

const realDelivery: TeamStatusDelivery = {
	async deliver(narratorId, row) {
		const { deliverInjection } = await import("../narrator-injection");
		const result = await deliverInjection(narratorId, {
			content: row.content,
			body: { kind: "prose", text: row.content },
			source: row.source,
			role: "sys",
			schedule: row.schedule,
			locale: row.locale,
		});
		return { messageId: result.messageId, turnText: result.turnText };
	},
	async stillInHistory(narratorId, messageId) {
		const row = db
			.select({ id: narratorMessageRefs.id })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.messageId, messageId),
					eq(narratorMessageRefs.narratorId, narratorId),
				),
			)
			.limit(1)
			.get();
		return !!row;
	},
};

let deliverySeam: TeamStatusDelivery | null = null;

/** Replace the delivery (tests); null restores the real one. Returns the previous. */
export function setTeamStatusDelivery(next: TeamStatusDelivery | null): TeamStatusDelivery | null {
	const previous = deliverySeam;
	deliverySeam = next;
	return previous;
}

interface Delivered {
	/** The compact marker the row was written after (null: no compaction yet). */
	compactSeq: number | null;
	text: string;
	messageId: string | null;
	/** When the status was last looked at (written or found unchanged). */
	at: number;
	/** The brief text the last row that carried it held, that row, and its compaction cycle. */
	brief: string | null;
	briefMessageId: string | null;
	briefCompactSeq: number | null;
}

/** The brief the coordinator still has in context this cycle, or undefined. */
async function briefInContext(
	narratorId: string,
	last: Delivered | undefined,
	compactSeq: number | null,
	delivery: TeamStatusDelivery,
): Promise<string | undefined> {
	if (!last || last.brief === null || !last.briefMessageId) return undefined;
	if (last.briefCompactSeq !== compactSeq) return undefined;
	return (await delivery.stillInHistory(narratorId, last.briefMessageId)) ? last.brief : undefined;
}

function nextDelivered(
	last: Delivered | undefined,
	status: { text: string; brief: string; briefIncluded: boolean },
	messageId: string | null,
	compactSeq: number | null,
	at: number,
): Delivered {
	return {
		compactSeq,
		text: status.text,
		messageId,
		at,
		...(status.briefIncluded && messageId
			? { brief: status.brief, briefMessageId: messageId, briefCompactSeq: compactSeq }
			: {
					brief: last?.brief ?? null,
					briefMessageId: last?.briefMessageId ?? null,
					briefCompactSeq: last?.briefCompactSeq ?? null,
				}),
	};
}

const delivered = hotSafe<Map<string, Delivered>>(
	"narrafork.teams.statusDelivered",
	() => new Map(),
);

/** Forget what was written (tests, or a narrator gone). */
export function forgetTeamStatus(narratorId?: string): void {
	if (narratorId === undefined) delivered.clear();
	else delivered.delete(narratorId);
}

export interface TeamStatusPassInput {
	narratorId: string;
	locale: Locale;
	/** The latest compact marker's seq as the pass read it. */
	compactSeq: number | null;
	/** The first pass of a run. */
	runStart: boolean;
	contextPercent?: number;
	now?: number;
}

/**
 * At the start of a coordinator's pass, before its history is read: write the status as a plain
 * row (`schedule: none`) when the run starts or a compaction moved the context since the last
 * one. Returns whether a row was written. Never throws.
 */
export async function writeTeamStatusAtPass(input: TeamStatusPassInput): Promise<boolean> {
	const { narratorId, locale, compactSeq, runStart } = input;
	try {
		if (runStart) beginCoordinatorRun(narratorId);
		const last = delivered.get(narratorId);
		if (!runStart && last && last.compactSeq === compactSeq) return false;
		const now = input.now ?? Date.now();
		const delivery = deliverySeam ?? realDelivery;
		const status = await readTeamStatus(narratorId, locale, {
			now,
			contextPercent: input.contextPercent,
			briefShown: await briefInContext(narratorId, last, compactSeq, delivery),
		});
		if (!status) return false;
		const { text } = status;
		if (
			last &&
			last.compactSeq === compactSeq &&
			sameAsLast(last, status) &&
			last.messageId &&
			(await delivery.stillInHistory(narratorId, last.messageId))
		) {
			last.at = now;
			return false;
		}
		const { messageId } = await delivery.deliver(narratorId, {
			content: text,
			source: TEAM_STATUS_SOURCE,
			schedule: "none",
			locale,
		});
		delivered.set(narratorId, nextDelivered(last, status, messageId, compactSeq, now));
		return messageId !== null;
	} catch (error) {
		logger.warn("Could not write a coordinator's team status", {
			narratorId,
			error: String(error),
		});
		return false;
	}
}

/**
 * At a tool boundary of a long run: when {@link TEAM_STATUS_CADENCE_MS} passed since the last
 * look and the text changed, write it for the running loop's next turn (`onNextTurn`). Only
 * narrators that had a status written this process (coordinators) are looked at; for anyone
 * else this is a map lookup. Never throws.
 */
export async function writeTeamStatusAtBoundary(input: {
	narratorId: string;
	locale: Locale;
	contextPercent?: number;
	now?: number;
}): Promise<{ messageId: string | null; turnText: string | null } | null> {
	const last = delivered.get(input.narratorId);
	if (!last) return null;
	const now = input.now ?? Date.now();
	if (now - last.at < TEAM_STATUS_CADENCE_MS) return null;
	try {
		last.at = now;
		const delivery = deliverySeam ?? realDelivery;
		const status = await readTeamStatus(input.narratorId, input.locale, {
			now,
			contextPercent: input.contextPercent,
			briefShown: await briefInContext(input.narratorId, last, last.compactSeq, delivery),
		});
		if (!status || sameAsLast(last, status)) return null;
		const { text } = status;
		const result = await delivery.deliver(input.narratorId, {
			content: text,
			source: TEAM_STATUS_SOURCE,
			schedule: "onNextTurn",
			locale: input.locale,
		});
		delivered.set(
			input.narratorId,
			nextDelivered(last, status, result.messageId, last.compactSeq, now),
		);
		return result;
	} catch (error) {
		logger.warn("Could not write a coordinator's team status at a tool boundary", {
			narratorId: input.narratorId,
			error: String(error),
		});
		return null;
	}
}
