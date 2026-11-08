/**
 * Agents in a live page's presence (outline P2 PR 10b, design §2.9, owner decision Q4 A): which
 * sessions to show on a page, where their cursors are, and who may see their names. The live
 * session (`session.ts`) owns the presence frames; this module only reads.
 *
 * WHO IS PRESENT
 * --------------
 * A session (or a subagent: each its own avatar, its session named beside it) is present only while
 * it runs (status `working` or `waiting`, as the team status reads it), and only on a page where it
 * has a cursor: a task in progress on the page that it holds, or a block of the page it wrote in
 * the last {@link OUTLINE_LIVE_AGENT_BOUNDS.writeMs}. An idle session holding a task is not present
 * (the board and the task say who is doing it); a run that ends takes the agent away at once,
 * whatever it wrote. At most {@link OUTLINE_LIVE_LIMITS.agentsPerPage} a page, the most recent
 * writers first; the rest are counted.
 *
 * NAMES
 * -----
 * A person sees an agent's title (and can open its session) only when they may read that session
 * (`narratorUsersWith`, a subagent judged on its session, admins always); everyone else sees
 * "Agent". Agents never take a participant's place: they are not counted against the page's
 * editors or viewers and hold no socket.
 *
 * Reads are bounded and only made for a page that is open live: the claims of at most
 * {@link OUTLINE_LIVE_AGENT_BOUNDS.doingRead} tasks in progress, at most
 * {@link OUTLINE_LIVE_AGENT_BOUNDS.narrators} narrators by primary key and their sessions' titles.
 */
import { OUTLINE_LIVE_LIMITS } from "@shared/outline-live-protocol";
import { narratorUsersWith } from "../access";
import { readDisplayNames, readNarrator, readNarratorPresence } from "../access-reads";
import { outlineStore } from "../store";
import type { OutlineStore } from "../store/port";

export const OUTLINE_LIVE_AGENT_BOUNDS = {
	/** Tasks in progress of a page whose claims are read. */
	doingRead: 200,
	/** How long a block an agent wrote keeps its cursor there. */
	writeMs: 60_000,
	/** Blocks of an agent's latest write kept as its cursor. */
	writtenBlocks: 3,
	/** Narrators (holders and writers) read per refresh. */
	narrators: 64,
};

/** Statuses of a narrator whose run is on (`subagent-team.ts` reads the same two). */
const RUNNING = new Set(["working", "waiting"]);

/** An agent to show on a page. */
export interface LiveAgent {
	narratorId: string;
	title: string;
	/** For a subagent: its session's title. */
	session: string | null;
	/** Blocks its cursor covers: tasks it holds, then blocks it just wrote. */
	blocks: string[];
}

/** An agent's recent write on a page. */
export interface LiveAgentWrite {
	blocks: string[];
	at: number;
}

/**
 * The agents present on a page: from its tasks in progress (`doing`, block ids) and the writes it
 * saw (`writes`, by narrator). `interest` is every narrator whose run starting or ending may
 * change the answer (holders, writers, their sessions).
 */
export async function readLiveAgents(input: {
	doing: readonly string[];
	writes: ReadonlyMap<string, LiveAgentWrite>;
	now: number;
	store?: OutlineStore;
}): Promise<{ agents: LiveAgent[]; more: number; interest: Set<string> }> {
	const store = input.store ?? outlineStore;
	const held = new Map<string, string[]>();
	const doing = input.doing.slice(0, OUTLINE_LIVE_AGENT_BOUNDS.doingRead);
	if (doing.length > 0) {
		for (const claim of await store.getTaskClaims(doing)) {
			if (!claim.holderNarratorId) continue;
			const list = held.get(claim.holderNarratorId);
			if (list) list.push(claim.taskBlockId);
			else held.set(claim.holderNarratorId, [claim.taskBlockId]);
		}
	}
	const writes = [...input.writes]
		.filter(([, w]) => input.now - w.at < OUTLINE_LIVE_AGENT_BOUNDS.writeMs)
		.sort((a, b) => b[1].at - a[1].at);
	// The most recent writers first, then holders in a stable order.
	const candidates = [...new Set([...writes.map(([id]) => id), ...[...held.keys()].sort()])].slice(
		0,
		OUTLINE_LIVE_AGENT_BOUNDS.narrators,
	);
	const interest = new Set(candidates);
	if (candidates.length === 0) return { agents: [], more: 0, interest };
	const facts = await readNarratorPresence(candidates);
	const roots = [
		...new Set([...facts.values()].flatMap((f) => (f.subagent && f.root ? [f.root] : []))),
	];
	for (const root of roots) interest.add(root);
	const rootTitles =
		roots.length > 0 ? (await readDisplayNames({ narratorIds: roots })).narrators : null;
	const written = new Map(writes);
	const present: LiveAgent[] = [];
	for (const id of candidates) {
		const fact = facts.get(id);
		if (!fact || !RUNNING.has(fact.status)) continue;
		const blocks = [...new Set([...(held.get(id) ?? []), ...(written.get(id)?.blocks ?? [])])];
		if (blocks.length === 0) continue;
		present.push({
			narratorId: id,
			title: (fact.title ?? "").trim(),
			session:
				fact.subagent && fact.root ? (rootTitles?.get(fact.root) ?? "").trim() || null : null,
			blocks,
		});
	}
	const limit = OUTLINE_LIVE_LIMITS.agentsPerPage;
	return {
		agents: present.slice(0, limit),
		more: Math.max(0, present.length - limit),
		interest,
	};
}

/** Of these people, who may read the agent's session (and so see its name). */
export async function readLiveAgentReaders(
	narratorId: string,
	people: ReadonlyArray<{ userId: string; isAdmin: boolean }>,
): Promise<Set<string>> {
	const out = new Set<string>();
	for (const p of people) if (p.isAdmin && p.userId) out.add(p.userId);
	const rest = people.filter((p) => !p.isAdmin && p.userId).map((p) => p.userId);
	if (rest.length === 0) return out;
	const row = await readNarrator(narratorId);
	if (!row) return out;
	for (const userId of await narratorUsersWith(row, rest, "read")) out.add(userId);
	return out;
}
