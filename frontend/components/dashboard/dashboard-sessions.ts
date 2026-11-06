import type { HumanAttentionItem } from "@shared/human-attention";
import type { NarratorActivity } from "./dashboard-activity";

/** Fields of a narrator list row the dashboard reads; the list API is loosely typed. */
export interface DashboardNarrator {
	id: string;
	title?: string | null;
	cwd?: string | null;
	status?: string | null;
	substatus?: unknown;
	lastMessageAt?: string | null;
	updatedAt?: string | null;
	activeBackgroundTaskCount?: number | null;
	activeBackgroundWorkCount?: number | null;
}

export interface DashboardDecision {
	count: number;
	/** At least one decision is holding the agent. */
	blocking: boolean;
	summary?: string;
	kind: HumanAttentionItem["kind"];
	source: HumanAttentionItem["source"];
}

export interface DashboardSession {
	narratorId: string;
	title: string;
	cwd: string | null;
	status: string;
	substatus: string[];
	activeBackgroundWorkCount: number;
	time: string | null;
	/** Set when the session waits on the user. */
	decision?: DashboardDecision;
	/** Set when the session stopped on an error. */
	errored?: boolean;
	/** Set when the session finished a turn the user has not read yet. */
	unread?: boolean;
}

export interface DashboardSessionGroups {
	/**
	 * Waiting on the user: open decisions first (blocking before not), then errors,
	 * then finished turns not yet read.
	 */
	attention: DashboardSession[];
	/** Working, reflecting, or idle with background work still running. */
	running: DashboardSession[];
	recent: DashboardSession[];
}

export const RECENT_SESSION_LIMIT = 6;

export function parseSubstatus(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
	if (typeof raw !== "string" || !raw) return [];
	try {
		return parseSubstatus(JSON.parse(raw));
	} catch {
		return [];
	}
}

function timeValue(iso: string | null): number {
	const value = iso ? new Date(iso).getTime() : 0;
	return Number.isFinite(value) ? value : 0;
}

function toSession(n: DashboardNarrator, live: NarratorActivity | undefined): DashboardSession {
	return {
		narratorId: n.id,
		title: live?.title || n.title || n.id.slice(0, 8),
		cwd: n.cwd ?? null,
		status: live?.status ?? n.status ?? "idle",
		substatus: live?.substatus ?? parseSubstatus(n.substatus),
		activeBackgroundWorkCount:
			live?.activeBackgroundWorkCount ??
			n.activeBackgroundWorkCount ??
			n.activeBackgroundTaskCount ??
			0,
		time: n.lastMessageAt ?? n.updatedAt ?? null,
	};
}

/**
 * Split sessions into the dashboard groups. Each session lands in exactly one.
 *
 * "Needs you" is driven by the human-attention feed, not by `status: "waiting"`:
 * a narrator also waits while an automated gate (danger / plan / question
 * reflection) reviews a request, and that is not the user's turn. Such a
 * session stays under Running, showing its reflecting state. A subagent's
 * decision is attributed to its root session, the page that surfaces it.
 *
 * Running also covers an idle narrator whose background work (bash tasks,
 * subagents) is still going — the session is not done, and will wake when the
 * work completes.
 *
 * A finished turn the user has not read (`unread`) also needs the user, the same
 * way the server raises a "done" attention for it. Opening the session clears the
 * tag, which moves it to Recent.
 */
export function buildDashboardSessions(input: {
	attentionItems: readonly HumanAttentionItem[];
	narrators: readonly DashboardNarrator[];
	activity: ReadonlyMap<string, NarratorActivity>;
}): DashboardSessionGroups {
	const known = new Map<string, DashboardNarrator>();
	for (const n of input.narrators) if (!known.has(n.id)) known.set(n.id, n);

	const decisions = new Map<string, { item: HumanAttentionItem; decision: DashboardDecision }>();
	for (const item of input.attentionItems) {
		const ownerId = item.rootNarratorId ?? item.narratorId;
		const entry = decisions.get(ownerId);
		if (!entry) {
			decisions.set(ownerId, {
				item,
				decision: {
					count: 1,
					blocking: item.blocking,
					summary: item.summary || undefined,
					kind: item.kind,
					source: item.source,
				},
			});
			continue;
		}
		entry.decision.count++;
		if (item.blocking && !entry.decision.blocking) {
			entry.decision = {
				...entry.decision,
				blocking: true,
				summary: item.summary || entry.decision.summary,
				kind: item.kind,
				source: item.source,
			};
		}
	}

	const attention: DashboardSession[] = [];
	const running: DashboardSession[] = [];
	const recent: DashboardSession[] = [];

	for (const [ownerId, { item, decision }] of decisions) {
		const narrator = known.get(ownerId);
		const session = narrator
			? toSession(narrator, input.activity.get(ownerId))
			: {
					narratorId: ownerId,
					title: item.narratorTitle || ownerId.slice(0, 8),
					cwd: null,
					status: "waiting",
					substatus: [],
					activeBackgroundWorkCount: 0,
					time: item.createdAt,
				};
		attention.push({ ...session, decision });
	}

	for (const narrator of known.values()) {
		if (decisions.has(narrator.id)) continue;
		const session = toSession(narrator, input.activity.get(narrator.id));
		if (session.status === "archived") continue;
		if (session.status === "working" || session.status === "waiting") running.push(session);
		else if (session.substatus.includes("error")) attention.push({ ...session, errored: true });
		else if (session.activeBackgroundWorkCount > 0) running.push(session);
		else if (session.substatus.includes("unread")) attention.push({ ...session, unread: true });
		else recent.push(session);
	}

	const byTime = (a: DashboardSession, b: DashboardSession) =>
		timeValue(b.time) - timeValue(a.time);
	attention.sort(
		(a, b) =>
			Number(!!b.decision) - Number(!!a.decision) ||
			Number(!!b.decision?.blocking) - Number(!!a.decision?.blocking) ||
			Number(!!b.errored) - Number(!!a.errored) ||
			byTime(a, b),
	);
	running.sort(byTime);
	recent.sort(byTime);

	return { attention, running, recent: recent.slice(0, RECENT_SESSION_LIMIT) };
}

/** Last path segment, for compact directory labels. */
export function directoryLabel(path: string): string {
	const trimmed = path.replace(/[/\\]+$/, "");
	const segment = trimmed.split(/[/\\]/).pop();
	return segment || path;
}
