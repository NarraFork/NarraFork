/**
 * Pending changes (design §2.6) and the locks they come from (§2.2): locking and unlocking a
 * task tree, confirming and rejecting what an agent proposed for a locked plan, and the reads the
 * pages, the agent tools and the task source make of them.
 *
 * Proposals are made by the write path itself (`write.ts`, LOCKED PLANS AND PENDING
 * CONFIRMATION, and `pending-hold.ts`). This module decides them:
 *
 *   - CONFIRM ({@link confirmOutlinePending}): one `confirm` commit, written as the proposer (so
 *     the blocks are the proposer's, as written), its responsible person the decider's (a person
 *     confirming, or the person of the session confirming on the locker's behalf, design §2.5).
 *     The row becomes `confirmed` in the same atomic section. Blocks someone changed since the
 *     proposal are merged three ways from the version proposed against (`agent-merge.ts`: text
 *     that does not overlap, fields one by one); structure only has to still make sense (the
 *     targets exist, no cycle). When that fails nothing is written and the change stays open:
 *     the decider rejects it, or the proposer proposes again.
 *   - REJECT ({@link rejectOutlinePending}): no commit; the proposer is told once, on its next
 *     read of the page (`reported_at`). The proposer rejecting its own change withdraws it.
 *   - WHO DECIDES: the locker, or the session the locker named to confirm on their behalf (and
 *     its subagents). A session never confirms its own change (builder decision 7: the proposer is
 *     the proposing session, as for claims): a change the delegate proposed goes to the locker.
 *   - LOCK ({@link lockOutlineTask}, {@link unlockOutlineTask}): only people lock (owner decision
 *     Q5); the routes check who may. These are the server functions plan PR 5 (`/goal`) and PR 8
 *     (plan mode) lock through on a person's behalf. Unlocking withdraws the tree's open changes
 *     in the same commit (`write.ts`).
 *
 * Every read is indexed and bounded; merges run on the text worker when large.
 */
import { AppError, NotFoundError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { titleOf } from "@shared/outline";
import { readDisplayNames } from "./access-reads";
import { type AgentMerge, type AgentReplace, mergeAgentReplaces } from "./agent-merge";
import { OutlineWriteError } from "./errors";
import { contentLinks, type ExtractedLink } from "./links";
import { withOutlineLiveBarrier } from "./live-barrier";
import { OUTLINE_TEXT, OUTLINE_TOOL_TEXT } from "./messages";
import {
	OUTLINE_CHANGE,
	OUTLINE_LIMITS,
	OUTLINE_PENDING_LIMITS,
	type OutlinePendingDeciderJson,
	type OutlineTaskActorRef,
	type OutlineTaskLockJson,
	outlinePendingLabel,
} from "./model";
import { opBase, PENDING_WITHDRAW, pendingOps } from "./pending-hold";
import { outlineStore } from "./store";
import {
	type OutlineBlockMeta,
	type OutlinePendingHead,
	OutlinePendingMovedError,
	type OutlinePendingRow,
	type OutlineSpaceRow,
	type OutlineStore,
	type OutlineVersionRow,
} from "./store/port";
import type { OutlineTaskSubject } from "./tasks";
import {
	type OutlineCanonicalContent,
	type OutlineOp,
	type OutlineTaskPatch,
	type OutlineWriteResult,
	writeOutline,
} from "./write";

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type OutlinePendingErrorCode =
	/** No such pending change (or one the caller may not see). */
	| "OUTLINE_PENDING_NOT_FOUND"
	/** It was decided (or withdrawn) already. */
	| "OUTLINE_PENDING_DECIDED"
	/** The caller is not who decides it. */
	| "OUTLINE_PENDING_NOT_DECIDER"
	/** The caller's own session proposed it: it goes to the locker. */
	| "OUTLINE_PENDING_OWN"
	/** Blocks changed since it was proposed and the change no longer applies. */
	| "OUTLINE_PENDING_CONFLICT"
	/** Merged into (or decided) while being confirmed: look at it again. */
	| "OUTLINE_PENDING_CHANGED";

/** A decision that could not be made; nothing was written. */
export class OutlinePendingError extends AppError {
	constructor(
		message: string,
		readonly pendingCode: OutlinePendingErrorCode,
		/** For a conflict: what no longer applies, one line each. */
		readonly details: string[] = [],
	) {
		super(
			message,
			pendingCode === "OUTLINE_PENDING_NOT_FOUND"
				? 404
				: pendingCode === "OUTLINE_PENDING_NOT_DECIDER" || pendingCode === "OUTLINE_PENDING_OWN"
					? 403
					: 409,
			pendingCode,
		);
		this.name = "OutlinePendingError";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Who decides
// ─────────────────────────────────────────────────────────────────────────────

/** Who is deciding: a person, or a session (an agent confirming on the locker's behalf). */
export type OutlinePendingActor =
	| { kind: "human"; userId: string }
	| { kind: "agent"; narratorId: string; responsibleUserId: string | null };

/**
 * What the actor may do with an open change: decide it (`decider`), withdraw it (`proposer`: its
 * own session proposed it), or nothing.
 */
export type OutlinePendingRight = "decider" | "proposer" | "none";

/** The lock on a pending change's tree now (null when the tree is no longer locked). */
async function currentLock(
	store: OutlineStore,
	row: OutlinePendingHead,
): Promise<{ lock: OutlineTaskLockJson | null; root: OutlineBlockMeta | null }> {
	if (!row.rootBlockId) return { lock: null, root: null };
	const [root] = await store.getBlockMetas(row.spaceId, { ids: [row.rootBlockId] });
	const lock = root && !root.deleted ? (root.taskJson?.lock ?? null) : null;
	return { lock, root: root ?? null };
}

/** The session a narrator belongs to (a subagent's root). */
async function sessionOf(store: OutlineStore, narratorId: string): Promise<string> {
	return (await store.getNarratorRoots([narratorId])).get(narratorId)?.root ?? narratorId;
}

/**
 * The actor's right on an open change, against the lock as it is now (a delegate the locker
 * named since the proposal decides it).
 */
export async function pendingRightOf(
	row: OutlinePendingHead,
	actor: OutlinePendingActor,
	options: { store?: OutlineStore; lock?: OutlineTaskLockJson | null } = {},
): Promise<OutlinePendingRight> {
	const store = options.store ?? outlineStore;
	const lock = options.lock !== undefined ? options.lock : (await currentLock(store, row)).lock;
	if (actor.kind === "human") {
		return lock?.by.kind === "human" && lock.by.id === actor.userId ? "decider" : "none";
	}
	const session = await sessionOf(store, actor.narratorId);
	if (row.requesterSession !== null && session === row.requesterSession) return "proposer";
	if (!lock) return "none";
	if (lock.delegate && (await sessionOf(store, lock.delegate)) === session) return "decider";
	if (lock.by.kind === "agent" && (await sessionOf(store, lock.by.id)) === session)
		return "decider";
	return "none";
}

async function openRow(store: OutlineStore, pendingId: string): Promise<OutlinePendingRow> {
	const row = (await store.getPending([pendingId]))[0];
	if (!row) {
		throw new OutlinePendingError(
			OUTLINE_PENDING_TEXT.notFound(pendingId),
			"OUTLINE_PENDING_NOT_FOUND",
		);
	}
	if (row.status !== "open") {
		throw new OutlinePendingError(
			OUTLINE_PENDING_TEXT.decided(outlinePendingLabel(row.id), row.status),
			"OUTLINE_PENDING_DECIDED",
		);
	}
	return row;
}

function actorRef(actor: OutlinePendingActor): OutlineTaskActorRef {
	return actor.kind === "human"
		? { kind: "human", id: actor.userId }
		: { kind: "agent", id: actor.narratorId };
}

function emit(spaceId: string, pageIds: readonly string[]): void {
	if (pageIds.length > 0)
		eventBus.emit({ type: "outline:pending", spaceId, pageIds: [...pageIds] });
}

/** Agent- and API-facing text of decisions (English, like the rest of the outline's). */
export const OUTLINE_PENDING_TEXT = {
	notFound: (id: string) => `no pending change ${id}`,
	decided: (label: string, status: string) => `${label} is not open any more (${status})`,
	notDecider: (label: string) =>
		`${label} is not yours to decide: the person who locked the plan decides it, or the session they named to confirm on their behalf`,
	own: (label: string) =>
		`${label} was proposed by this session, so it cannot confirm it: it goes to the person who locked the plan. Reject it to withdraw it`,
	conflict: (label: string) =>
		`${label} no longer applies as proposed: blocks it changes were changed since. Nothing was written; reject it, or let its proposer propose again`,
	unlocked: (label: string) => `${label}: the plan is no longer locked`,
	subtreeUnchecked: (sid: string, why: OutlineUncheckedReason) =>
		why === "writers"
			? `[${sid}], which it deletes, could not be checked for changes made since it was proposed: too many writers of the proposing session wrote on top of one another to tell whether anyone else did`
			: `[${sid}], which it deletes, has too many blocks to check for changes made since it was proposed`,
	subtreeChanged: (sid: string, n: number) =>
		`[${sid}], which it deletes, changed since it was proposed: ${n === 1 ? "1 block" : `${n} blocks`} in it or under it added, changed or gone`,
	changed: (label: string) =>
		`${label} changed while it was being confirmed (more was proposed into it, or it was decided); look at it again`,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Confirm and reject
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineConfirmResult {
	row: OutlinePendingRow;
	/** The `confirm` commit; null when the change was all there already. */
	write: OutlineWriteResult;
}

/** One rewritten block of a pending change, laid over the block as it is now. */
export type OutlineProposalMerge =
	/** The block is as it was when proposed: the proposal applies as written. */
	| { state: "as-proposed" }
	/** Changed since, the changes do not overlap: the proposal merged over them. */
	| {
			state: "merged";
			content: string;
			links: ExtractedLink[];
			alias?: string;
			tags?: string[];
			task?: OutlineTaskPatch;
	  }
	/** Changed since, and the proposal no longer applies (why, for the agent and people). */
	| { state: "conflict"; detail: string };

/** One rewrite of a block a change holds (an update's fields, or a task patch), with its base. */
interface ProposalUnit {
	blockId: string;
	/** The version it was computed against (its own, review N-1). */
	base: number;
	op: Extract<OutlineOp, { op: "update" }> | Extract<OutlineOp, { op: "setTask" }>;
}

/**
 * Versions of blocks at given seqs, keyed `blockId@seq`: one read per round, a block once in
 * each (a change may hold a block's rewrites computed against different versions).
 */
async function versionsAt(
	store: OutlineStore,
	keys: ReadonlyArray<{ blockId: string; seq: number }>,
): Promise<Map<string, OutlineVersionRow>> {
	const out = new Map<string, OutlineVersionRow>();
	let rest = [...new Map(keys.map((k) => [`${k.blockId}@${k.seq}`, k])).values()];
	while (rest.length > 0) {
		const round = new Map<string, { blockId: string; seq: number }>();
		const later: typeof rest = [];
		for (const key of rest) {
			if (round.has(key.blockId)) later.push(key);
			else round.set(key.blockId, key);
		}
		for (const v of await store.listVersionsAtSeqs([...round.values()])) {
			const key = round.get(v.blockId);
			if (key) out.set(`${v.blockId}@${key.seq}`, v);
		}
		rest = later;
	}
	return out;
}

function mergeRefusalText(m: Extract<AgentMerge, { ok: false }>): string {
	return m.reason === "overlap"
		? OUTLINE_TOOL_TEXT.edit.overlaps(m.overlaps ?? [])
		: m.reason === "fields"
			? OUTLINE_TOOL_TEXT.edit.bothChanged(m.fields ?? [])
			: m.reason === "deleted"
				? OUTLINE_TOOL_TEXT.edit.nowDeleted
				: m.reason === "no-base"
					? OUTLINE_TOOL_TEXT.edit.noBase
					: OUTLINE_TOOL_TEXT.edit.mergeUnstable;
}

/**
 * The blocks a change rewrites (text, fields, checkbox), laid over each block as it is now:
 * unchanged since proposed, merged three ways (text that does not overlap, fields one by one;
 * `agent-merge.ts`), or in conflict. Each rewrite merges from the version it was itself computed
 * against (review N-1): a task change proposed before a person's change and a text rewrite
 * proposed after it each meet that change where they should. What a confirmation writes and what
 * the proposer reads (review S-2) both come from here.
 */
export async function mergeProposal(
	store: OutlineStore,
	row: Pick<OutlinePendingRow, "spaceId" | "baseJson" | "opsJson">,
): Promise<Map<string, OutlineProposalMerge>> {
	const units: ProposalUnit[] = [];
	for (const op of pendingOps(row)) {
		if ((op.op !== "update" && op.op !== "setTask") || !("id" in op.block)) continue;
		const base = opBase(op) ?? row.baseJson[op.block.id];
		// A block the change adds has no base: it is written as proposed.
		if (base !== undefined) units.push({ blockId: op.block.id, base, op });
	}
	const out = new Map<string, OutlineProposalMerge>();
	if (units.length === 0) return out;
	const byBlock = new Map<string, ProposalUnit[]>();
	for (const u of units) byBlock.set(u.blockId, [...(byBlock.get(u.blockId) ?? []), u]);
	const metas = new Map(
		(await store.getBlockMetas(row.spaceId, { ids: [...byBlock.keys()] })).map((m) => [m.id, m]),
	);
	const changed: Array<[string, ProposalUnit[]]> = [];
	for (const [id, list] of byBlock) {
		const meta = metas.get(id);
		if (meta && list.some((u) => u.base !== meta.versionSeq)) changed.push([id, list]);
		else out.set(id, { state: "as-proposed" });
	}
	if (changed.length === 0) return out;
	const versions = await versionsAt(
		store,
		changed.flatMap(([, list]) => list.map((u) => ({ blockId: u.blockId, seq: u.base }))),
	);
	const at = (u: ProposalUnit) => versions.get(`${u.blockId}@${u.base}`);
	interface Merged {
		content?: { content: string; links: ExtractedLink[] };
		current?: { content: string; links: ExtractedLink[] };
		alias?: string;
		tags?: string[];
		task?: OutlineTaskPatch;
		conflict?: string;
	}
	const merged = new Map<string, Merged>();
	const queue = new Map<string, ProposalUnit[]>();
	for (const [id, list] of changed) {
		const m: Merged = {};
		merged.set(id, m);
		const rest: ProposalUnit[] = [];
		for (const u of list) {
			if (u.op.op === "setTask" && u.op.task === null) {
				// Taking the checkbox away: only while the task is as proposed against.
				const before = at(u)?.taskJson ?? null;
				if (JSON.stringify(before) !== JSON.stringify(metas.get(id)?.taskJson ?? null))
					m.conflict ??= OUTLINE_TOOL_TEXT.edit.bothChanged(["checkbox"]);
			} else rest.push(u);
		}
		queue.set(id, rest);
	}
	// Rewrites of one block computed against different versions merge one per round; each owns
	// different fields (`mergePendingOps`), the text only one of them.
	for (let round = 0; ; round++) {
		const replaces: AgentReplace[] = [];
		const owner = new Map<string, ProposalUnit>();
		for (const [id, list] of queue) {
			const u = list[round];
			if (!u || merged.get(id)?.conflict) continue;
			const baseText = at(u)?.content ?? "";
			if (u.op.op === "update") {
				replaces.push({
					blockId: id,
					seen: u.base,
					content: u.op.content ?? baseText,
					...(u.op.alias !== undefined && u.op.alias !== null ? { alias: u.op.alias } : {}),
					...(u.op.tags !== undefined ? { tags: u.op.tags } : {}),
				});
			} else if (u.op.task !== null) {
				replaces.push({ blockId: id, seen: u.base, content: baseText, task: u.op.task });
			}
			owner.set(id, u);
		}
		if (replaces.length === 0) break;
		for (const r of await mergeAgentReplaces(store, replaces)) {
			const m = merged.get(r.blockId) as Merged;
			const u = owner.get(r.blockId) as ProposalUnit;
			if (!r.ok) {
				m.conflict ??= mergeRefusalText(r);
				continue;
			}
			m.current ??= { content: r.content, links: r.links };
			if (u.op.op === "update") {
				if (u.op.content !== undefined) m.content = { content: r.content, links: r.links };
				if (r.alias !== undefined) m.alias = r.alias;
				if (r.tags !== undefined) m.tags = r.tags;
			} else if (r.task !== undefined) m.task = { ...(m.task ?? {}), ...r.task };
		}
	}
	for (const [id, m] of merged) {
		const text = m.content ?? m.current;
		if (m.conflict) out.set(id, { state: "conflict", detail: m.conflict });
		else if (!text) out.set(id, { state: "as-proposed" });
		else
			out.set(id, {
				state: "merged",
				content: text.content,
				links: text.links,
				...(m.alias !== undefined ? { alias: m.alias } : {}),
				...(m.tags !== undefined ? { tags: m.tags } : {}),
				...(m.task !== undefined ? { task: m.task } : {}),
			});
	}
	return out;
}

/** Rows one request's checks of deleted subtrees read at most, in all (main-thread rule). */
export interface OutlineSubtreeBudget {
	left: number;
}

/** Change flags of anyone's versions a deleted subtree's check leaves out: page changes only. */
const PAGE_ONLY = OUTLINE_CHANGE.PAGE;
/** Change flags of the proposer's versions it leaves out: all of them. */
const ALL_CHANGES = 0x7fffffff;
/** Narrators of the proposing session one check finds and leaves out at most (rounds of reads). */
const SESSION_ROUNDS = 8;

/**
 * Why a deleted subtree was not checked: too many blocks for the request's budget (`size`), or
 * too many narrators of the proposing session wrote on top of one another to tell them apart
 * within the rounds (`writers`, review R4-N-1).
 */
export type OutlineUncheckedReason = "size" | "writers";

/** What a check of the subtrees a change deletes found. */
export interface OutlineDeletedSubtrees {
	/** By deleted block: how many blocks in or under it others changed since the proposal. */
	changed: Map<string, number>;
	/** Deleted blocks whose subtree could not be checked (none others are known to have changed). */
	unchecked: Map<string, OutlineUncheckedReason>;
}

/**
 * Of the blocks a change deletes, those whose subtree others changed since it was proposed:
 * blocks under it added, changed or gone, or the block itself changed, by anyone but the
 * proposer (review S-9, N-2; the direct delete path refuses the same, design §6.5: "changes by
 * others"). The proposer is the proposing session, its root and its subagents (decision 7,
 * review R3-1): their versions (the direct part of the same call, its later writes, its
 * subagents') do not count, nor do versions that only moved blocks to another page (the locked
 * task moved). A block the session brought in that someone else created does (what cannot be
 * told apart counts).
 *
 * Bounded: `only` limits it to some of the deletes (a diff checks the ones it shows), and
 * `budget` caps the rows read across calls of one request. A subtree past it is reported
 * unchecked (`size`), not changed (review R3-N-a); so is one whose session writers outnumber the
 * rounds (`writers`). Where someone else's version was found, it is changed, whatever else could
 * not be checked (review R4-N-1).
 */
export async function deletedSubtreeChanges(
	store: OutlineStore,
	row: Pick<
		OutlinePendingRow,
		"spaceId" | "baseJson" | "opsJson" | "subtreeJson" | "requestedByJson" | "requesterSession"
	>,
	options: { only?: ReadonlySet<string>; budget?: OutlineSubtreeBudget } = {},
): Promise<OutlineDeletedSubtrees> {
	const out: OutlineDeletedSubtrees = { changed: new Map(), unchecked: new Map() };
	const deletes = pendingOps(row).flatMap((op) =>
		op.op === "delete" &&
		"id" in op.block &&
		(options.only === undefined || options.only.has(op.block.id))
			? [{ id: op.block.id, base: opBase(op) ?? row.baseJson[op.block.id] }]
			: [],
	);
	if (deletes.length === 0) return out;
	const budget = options.budget ?? { left: OUTLINE_LIMITS.maxRowsTouched };
	// Rows within the budget: taken, or none and the budget spent (it never goes below zero).
	const take = (n: number): boolean => {
		if (n > budget.left) {
			budget.left = 0;
			return false;
		}
		budget.left -= n;
		return true;
	};
	const metas = new Map(
		(await store.getBlockMetas(row.spaceId, { ids: deletes.map((d) => d.id) })).map((m) => [
			m.id,
			m,
		]),
	);
	let keys: Array<{ blockId: string; afterSeq: number; of: string }> = [];
	for (const d of deletes) {
		if (budget.left === 0) {
			out.unchecked.set(d.id, "size");
			continue;
		}
		const mine: typeof keys = [];
		const recorded = row.subtreeJson[d.id] ?? {};
		const meta = metas.get(d.id);
		if (meta && d.base !== undefined && meta.versionSeq !== d.base)
			mine.push({ blockId: d.id, afterSeq: d.base, of: d.id });
		const seen = new Set<string>();
		let frontier = meta && !meta.deleted ? [d.id] : [];
		let fits = true;
		while (frontier.length > 0) {
			const kids = await store.listChildMetas(row.spaceId, frontier, budget.left + 1);
			if (!take(kids.length)) {
				fits = false;
				break;
			}
			for (const kid of kids) {
				seen.add(kid.id);
				const was = recorded[kid.id];
				// Added since (or brought in): any version by someone else counts.
				if (was === undefined) mine.push({ blockId: kid.id, afterSeq: 0, of: d.id });
				else if (was !== kid.versionSeq) mine.push({ blockId: kid.id, afterSeq: was, of: d.id });
			}
			frontier = kids.map((k) => k.id);
		}
		// Under it then and not now: deleted or moved away since.
		for (const [was, seq] of Object.entries(recorded))
			if (!seen.has(was)) mine.push({ blockId: was, afterSeq: seq, of: d.id });
		if (fits && take(mine.length)) keys.push(...mine);
		else out.unchecked.set(d.id, "size");
	}
	// The latest version of each that counts. A narrator of the proposing session found among the
	// writers is the proposer too: left out, and its blocks looked at again (a few rounds).
	const by = row.requestedByJson;
	const session = by.kind === "agent" ? (row.requesterSession ?? by.id) : null;
	const proposer = new Set<string>([by.id, ...(session ? [session] : [])]);
	for (let round = 0; keys.length > 0; round++) {
		const of = new Map(keys.map((k) => [k.blockId, k.of]));
		const [first, ...more] = [...proposer];
		const writes = await store.findLastWrites(
			keys.map(({ blockId, afterSeq }) => ({ blockId, afterSeq })),
			{
				actorKind: by.kind,
				actorId: first as string,
				actorIds: more,
				flags: ALL_CHANGES,
				anyoneFlags: PAGE_ONLY,
			},
		);
		const known = writes.filter((w) => w.fromSeq !== null);
		const commits =
			session && known.length > 0
				? await store.getCommitsBySeqs(row.spaceId, [
						...new Set(known.map((w) => w.fromSeq as number)),
					])
				: [];
		const agents = [
			...new Set(
				commits.flatMap((c) =>
					c.actorKind === "agent" && !proposer.has(c.actorId) ? [c.actorId] : [],
				),
			),
		];
		const roots = agents.length > 0 ? await store.getNarratorRoots(agents) : new Map();
		const siblings = new Set(agents.filter((id) => (roots.get(id)?.root ?? id) === session));
		const writer = new Map(commits.map((c) => [c.seq, c.actorId]));
		const again = new Set<string>();
		for (const w of writes) {
			const d = of.get(w.blockId);
			if (d === undefined) continue;
			if (w.fromSeq !== null && siblings.has(writer.get(w.fromSeq) ?? "")) again.add(w.blockId);
			else out.changed.set(d, (out.changed.get(d) ?? 0) + 1);
		}
		if (again.size === 0) break;
		for (const id of siblings) proposer.add(id);
		const next = keys.filter((k) => again.has(k.blockId));
		if (round + 1 >= SESSION_ROUNDS) {
			for (const k of next) if (!out.unchecked.has(k.of)) out.unchecked.set(k.of, "writers");
			break;
		}
		if (!take(next.length)) {
			for (const k of next) out.unchecked.set(k.of, "size");
			break;
		}
		keys = next;
	}
	// Someone else's version found: changed, whatever else was not checked.
	for (const d of out.changed.keys()) out.unchecked.delete(d);
	return out;
}

/**
 * The stored operations, rebased onto the blocks as they are now (`mergeProposal`); structural
 * operations go as they are (the write path checks the targets exist and nothing lands under
 * itself), except a delete whose subtree others changed since it was proposed. Throws
 * {@link OutlinePendingError} (`OUTLINE_PENDING_CONFLICT`) naming what no longer applies.
 */
async function rebase(
	store: OutlineStore,
	row: OutlinePendingRow,
): Promise<{ ops: OutlineOp[]; canonical: Array<OutlineCanonicalContent | undefined> }> {
	const ops: Array<OutlineOp | null> = pendingOps(row).map((op) => {
		const { baseVersionSeq: _base, ...rest } = op as OutlineOp & { baseVersionSeq?: number };
		return rest as OutlineOp;
	});
	const label = outlinePendingLabel(row.id);
	const merges = await mergeProposal(store, row);
	const conflicts: string[] = [];
	const sids = new Map(
		(await store.getBlockMetas(row.spaceId, { ids: [...merges.keys()] })).map((m) => [m.id, m.sid]),
	);
	for (const [id, m] of merges) {
		if (m.state === "conflict") conflicts.push(`[${sids.get(id) ?? id}] ${m.detail}`);
	}
	const subtrees = await deletedSubtreeChanges(store, row, {
		budget: { left: 2 * OUTLINE_LIMITS.maxRowsTouched },
	});
	if (subtrees.changed.size > 0 || subtrees.unchecked.size > 0) {
		const deletedSids = new Map(
			(
				await store.getBlockMetas(row.spaceId, {
					ids: [...subtrees.changed.keys(), ...subtrees.unchecked.keys()],
				})
			).map((m) => [m.id, m.sid]),
		);
		for (const [id, n] of subtrees.changed)
			conflicts.push(OUTLINE_PENDING_TEXT.subtreeChanged(deletedSids.get(id) ?? id, n));
		for (const [id, why] of subtrees.unchecked)
			conflicts.push(OUTLINE_PENDING_TEXT.subtreeUnchecked(deletedSids.get(id) ?? id, why));
	}
	if (conflicts.length > 0) {
		throw new OutlinePendingError(
			OUTLINE_PENDING_TEXT.conflict(label),
			"OUTLINE_PENDING_CONFLICT",
			conflicts,
		);
	}
	// A merged block's rewrites become one: its first update carries the merged text and fields,
	// its first task change the merged patch; the others are dropped.
	const written = new Set<string>();
	for (let k = 0; k < ops.length; k++) {
		const op = ops[k] as OutlineOp;
		if ((op.op !== "update" && op.op !== "setTask") || !("id" in op.block)) continue;
		const m = merges.get(op.block.id);
		if (m?.state !== "merged") continue;
		if (op.op === "setTask" && op.task === null) continue;
		const key = `${op.op}:${op.block.id}`;
		if (written.has(key)) {
			ops[k] = null;
			continue;
		}
		written.add(key);
		if (op.op === "update") {
			const { alias: _a, tags: _t, ...rest } = op;
			ops[k] = {
				...rest,
				content: m.content,
				...(m.alias !== undefined ? { alias: m.alias } : {}),
				...(m.tags !== undefined ? { tags: m.tags } : {}),
				merged: true,
			};
		} else {
			// Only the fields the proposal changed and nobody else did; none left, no change.
			ops[k] = { ...op, task: m.task ?? ({} as OutlineTaskPatch) };
		}
	}
	// A task patch the merge emptied changes nothing: drop it.
	const kept = ops.filter(
		(op): op is OutlineOp =>
			op !== null &&
			!(op.op === "setTask" && op.task !== null && Object.keys(op.task).length === 0),
	);
	const canonical = kept.map((op) =>
		(op.op === "insert" || op.op === "update" || op.op === "restore") && op.content !== undefined
			? { content: op.content, links: contentLinks(op.content) }
			: undefined,
	);
	return { ops: kept, canonical };
}

/**
 * Who a change is the proposal of: the root of the session that proposed it (decision 7: a
 * session and its subagents propose as one), or the actor itself when it is not a session's.
 */
export function proposerOf(
	row: Pick<OutlinePendingRow, "requestedByJson" | "requesterSession">,
): OutlineTaskActorRef {
	const by = row.requestedByJson;
	return by.kind === "agent" && row.requesterSession
		? { kind: "agent", id: row.requesterSession }
		: { kind: by.kind, id: by.id };
}

/**
 * Confirm an open change: one `confirm` commit written as its proposer, the row `confirmed` with
 * it. Throws {@link OutlinePendingError}: not found, decided already, not the actor's to decide,
 * the actor's own session's change, or no longer applying (a conflict; nothing is written and it
 * stays open).
 */
export async function confirmOutlinePending(args: {
	pendingId: string;
	by: OutlinePendingActor;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlineConfirmResult> {
	const store = args.store ?? outlineStore;
	const first = await openRow(store, args.pendingId);
	const label = outlinePendingLabel(first.id);
	return await withOutlineLiveBarrier(first.spaceId, async () => {
		// Behind the barrier: what people typed is committed, and nothing lands meanwhile.
		const row = await openRow(store, args.pendingId);
		const right = await pendingRightOf(row, args.by, { store });
		if (right === "proposer")
			throw new OutlinePendingError(OUTLINE_PENDING_TEXT.own(label), "OUTLINE_PENDING_OWN");
		if (right !== "decider")
			throw new OutlinePendingError(
				OUTLINE_PENDING_TEXT.notDecider(label),
				"OUTLINE_PENDING_NOT_DECIDER",
			);
		const { ops, canonical } = await rebase(store, row);
		// The session proposed it (decision 7), whichever of its narrators proposed last: the
		// commit is its root's (review R3-N-b), with the message and tool call only when the root
		// proposed last.
		const requester = row.requestedByJson;
		const proposer = proposerOf(row);
		const rootLast = proposer.id === requester.id;
		let write: OutlineWriteResult;
		try {
			write = await writeOutline(
				{
					spaceId: row.spaceId,
					ops,
					actor: proposer,
					narratorId: proposer.kind === "agent" ? proposer.id : requester.narratorId,
					messageId: rootLast ? requester.messageId : null,
					toolCallId: rootLast ? requester.toolCallId : null,
					responsibleUserId: args.by.kind === "human" ? args.by.userId : args.by.responsibleUserId,
					summary: OUTLINE_TEXT.confirmSummary(label, row.summary),
				},
				{
					store,
					canonical,
					confirm: { pendingId: row.id, expectRev: row.rev, decidedBy: actorRef(args.by) },
					confirmPageIds: [row.pageId],
					...(args.now ? { now: args.now } : {}),
				},
			);
		} catch (error) {
			if (error instanceof OutlinePendingMovedError) {
				throw new OutlinePendingError(
					OUTLINE_PENDING_TEXT.changed(label),
					"OUTLINE_PENDING_CHANGED",
				);
			}
			if (error instanceof OutlineWriteError) {
				throw new OutlinePendingError(
					OUTLINE_PENDING_TEXT.conflict(label),
					"OUTLINE_PENDING_CONFLICT",
					[error.message],
				);
			}
			throw error;
		}
		const decided = (await store.getPending([row.id]))[0] ?? row;
		return { row: decided, write };
	});
}

/**
 * Reject an open change (the decider, with a reason the proposer reads once), or withdraw it
 * (its proposer's session). No commit. Throws {@link OutlinePendingError}.
 */
export async function rejectOutlinePending(args: {
	pendingId: string;
	by: OutlinePendingActor;
	reason?: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlinePendingRow> {
	const store = args.store ?? outlineStore;
	for (let attempt = 0; attempt < 3; attempt++) {
		const row = await openRow(store, args.pendingId);
		const label = outlinePendingLabel(row.id);
		const right = await pendingRightOf(row, args.by, { store });
		if (right === "none")
			throw new OutlinePendingError(
				OUTLINE_PENDING_TEXT.notDecider(label),
				"OUTLINE_PENDING_NOT_DECIDER",
			);
		const now = (args.now?.() ?? new Date()).toISOString();
		const reason = args.reason?.trim().slice(0, OUTLINE_PENDING_LIMITS.maxReasonChars) || null;
		const withdrawn = right === "proposer";
		const ok = await store.decidePending({
			id: row.id,
			expectRev: row.rev,
			status: withdrawn ? "withdrawn" : "rejected",
			decidedAt: now,
			decidedBy: actorRef(args.by),
			decisionCommitId: null,
			reason: withdrawn ? (reason ?? PENDING_WITHDRAW.proposer) : reason,
			// The proposer withdrawing knows; a rejection is told to it on its next read.
			reportedAt: withdrawn ? now : null,
		});
		if (ok) {
			emit(row.spaceId, [row.pageId]);
			return (await store.getPending([row.id]))[0] ?? row;
		}
		// Merged into or decided meanwhile: look again.
	}
	throw new OutlinePendingError(
		OUTLINE_PENDING_TEXT.decided(outlinePendingLabel(args.pendingId), "changing"),
		"OUTLINE_PENDING_DECIDED",
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Locks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lock a task's tree on a person's behalf (owner decision Q5: only people lock), naming the
 * session that may confirm step changes for them (`delegate`, D25: per plan, no default).
 *
 * PRECONDITIONS, for every caller (the routes, `/goal` in plan PR 5, plan mode in PR 8):
 *   - the person may write the space, and may write the delegate session (callers check: this
 *     function decides nothing about access);
 *   - the task is not locked by someone else. Locking it again would take their lock over, which
 *     is refused (`OUTLINE_LOCK_HELD`, here and in the write path): it has to be unlocked first
 *     ({@link unlockOutlineTask}), by someone allowed to unlock (the locker, a manager of the
 *     space, an admin). Locking a task the same person locked already only changes the delegate
 *     and keeps the lock (its version, its open changes).
 */
export async function lockOutlineTask(args: {
	blockId: string;
	/** The person locking. */
	userId: string;
	delegate?: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlineWriteResult> {
	const store = args.store ?? outlineStore;
	const block = await store.getBlock(args.blockId);
	if (!block || block.deleted) throw new NotFoundError("Outline block", args.blockId);
	if (!block.taskJson)
		throw new OutlineWriteError("only a task can be locked", "OUTLINE_INVALID_OP");
	const current = block.taskJson.lock;
	if (current && !(current.by.kind === "human" && current.by.id === args.userId)) {
		// Checked again by the write path, against the state it plans on.
		const space = await store.getSpace(block.spaceId);
		throw new OutlineWriteError(
			OUTLINE_TEXT.lockHeld(`${space?.key ?? "?"}/${block.sid}`),
			"OUTLINE_LOCK_HELD",
		);
	}
	return await writeOutline(
		{
			spaceId: block.spaceId,
			ops: [
				{
					op: "setTask",
					block: { id: block.id },
					task: {
						lock: { by: { kind: "human", id: args.userId }, delegate: args.delegate ?? null },
					},
				},
			],
			actor: { kind: "human", id: args.userId },
			responsibleUserId: args.userId,
		},
		{ store, ...(args.now ? { now: args.now } : {}) },
	);
}

/** Unlock a task's tree (the routes check who may: the locker, a space manager, an admin). */
export async function unlockOutlineTask(args: {
	blockId: string;
	userId: string;
	/**
	 * Whether the person may unlock someone else's lock (a manager of the space, an admin; the
	 * route decides). Without it only the locker unlocks.
	 */
	mayUnlockAnyone?: boolean;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlineWriteResult> {
	const store = args.store ?? outlineStore;
	const block = await store.getBlock(args.blockId);
	if (!block || block.deleted) throw new NotFoundError("Outline block", args.blockId);
	return await writeOutline(
		{
			spaceId: block.spaceId,
			ops: [{ op: "setTask", block: { id: block.id }, task: { lock: null } }],
			actor: { kind: "human", id: args.userId },
			responsibleUserId: args.userId,
			unlockAuthority: async () => args.mayUnlockAnyone === true,
		},
		{ store, ...(args.now ? { now: args.now } : {}) },
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/** Open changes of a page, and its locked tasks: what a page shows of them. */
export async function readPagePending(
	pageId: string,
	options: { store?: OutlineStore } = {},
): Promise<{ pending: OutlinePendingHead[]; locked: OutlineBlockMeta[] }> {
	const store = options.store ?? outlineStore;
	const [pending, locked] = await Promise.all([
		store.listOpenPendingByPage(pageId, OUTLINE_PENDING_LIMITS.openPerPage),
		store.listLockedBlocks(pageId, OUTLINE_PENDING_LIMITS.openPerPage),
	]);
	return { pending, locked };
}

/** Whether any block a change touches changed since it was proposed. */
export async function pendingBaseChanged(
	rows: readonly OutlinePendingHead[],
	options: { store?: OutlineStore } = {},
): Promise<Set<string>> {
	const store = options.store ?? outlineStore;
	const out = new Set<string>();
	const bySpace = new Map<string, string[]>();
	for (const row of rows) {
		const list = bySpace.get(row.spaceId) ?? [];
		list.push(...Object.keys(row.baseJson));
		bySpace.set(row.spaceId, list);
	}
	const versions = new Map<string, OutlineBlockMeta>();
	for (const [spaceId, ids] of bySpace) {
		for (const meta of await store.getBlockMetas(spaceId, { ids: [...new Set(ids)] }))
			versions.set(meta.id, meta);
	}
	for (const row of rows) {
		for (const [id, seq] of Object.entries(row.baseJson)) {
			const meta = versions.get(id);
			if (!meta || meta.deleted || meta.versionSeq !== seq) {
				out.add(row.id);
				break;
			}
		}
	}
	return out;
}

/**
 * Of the given tasks, those an open change touches (design §2.2: "等确认"): the task is a
 * block the change rewrites, moves, deletes or adds under, or its root being done waits for
 * confirmation. The task source's continuation skips them (`deriveOutlineTaskWaits`). One
 * bounded read of the open changes per space.
 */
export async function findTasksWaitingForConfirmation(
	tasks: readonly OutlineTaskSubject[],
	options: { store?: OutlineStore } = {},
): Promise<Set<string>> {
	const store = options.store ?? outlineStore;
	const out = new Set<string>();
	const bySpace = new Map<string, Set<string>>();
	for (const task of tasks) {
		const set = bySpace.get(task.spaceId) ?? new Set();
		set.add(task.id);
		bySpace.set(task.spaceId, set);
	}
	for (const [spaceId, ids] of bySpace) {
		const open = await store.listOpenPendingBySpace(spaceId, OUTLINE_PENDING_LIMITS.scanPerSpace);
		for (const row of open) for (const id of row.blockIdsJson) if (ids.has(id)) out.add(id);
	}
	return out;
}

/**
 * Who decides each open change now: the lock on its tree as it is (a delegate the locker named
 * since the proposal decides it, review S-8), or the decider recorded at proposal time when the
 * tree is no longer locked. One indexed read of the roots per space.
 */
export async function currentDeciders(
	rows: readonly OutlinePendingHead[],
	options: { store?: OutlineStore } = {},
): Promise<Map<string, OutlinePendingDeciderJson>> {
	const store = options.store ?? outlineStore;
	const bySpace = new Map<string, Set<string>>();
	for (const row of rows) {
		if (!row.rootBlockId) continue;
		const set = bySpace.get(row.spaceId) ?? new Set<string>();
		set.add(row.rootBlockId);
		bySpace.set(row.spaceId, set);
	}
	const locks = new Map<string, OutlineTaskLockJson>();
	for (const [spaceId, ids] of bySpace) {
		for (const meta of await store.getBlockMetas(spaceId, { ids: [...ids] }))
			if (!meta.deleted && meta.taskJson?.lock) locks.set(meta.id, meta.taskJson.lock);
	}
	const out = new Map<string, OutlinePendingDeciderJson>();
	for (const row of rows) {
		const lock = row.rootBlockId ? locks.get(row.rootBlockId) : undefined;
		out.set(
			row.id,
			lock
				? { by: { kind: lock.by.kind, id: lock.by.id }, delegate: lock.delegate ?? null }
				: row.deciderJson,
		);
	}
	return out;
}

/** The rows with who decides them now ({@link currentDeciders}) as their decider. */
export async function withCurrentDeciders<Row extends OutlinePendingHead>(
	rows: readonly Row[],
	options: { store?: OutlineStore } = {},
): Promise<Row[]> {
	const deciders = await currentDeciders(rows, options);
	return rows.map((row) => ({ ...row, deciderJson: deciders.get(row.id) ?? row.deciderJson }));
}

/** People and sessions a pending change names, for showing them. */
export async function pendingNames(rows: readonly OutlinePendingHead[]): Promise<{
	users: Map<string, string>;
	narrators: Map<string, string | null>;
}> {
	const userIds = new Set<string>();
	const narratorIds = new Set<string>();
	for (const row of rows) {
		if (row.deciderJson.by.kind === "human") userIds.add(row.deciderJson.by.id);
		else narratorIds.add(row.deciderJson.by.id);
		if (row.deciderJson.delegate) narratorIds.add(row.deciderJson.delegate);
		if (row.requesterSession) narratorIds.add(row.requesterSession);
		if (row.requestedByJson.narratorId) narratorIds.add(row.requestedByJson.narratorId);
		if (row.decidedByJson?.kind === "human") userIds.add(row.decidedByJson.id);
		else if (row.decidedByJson) narratorIds.add(row.decidedByJson.id);
	}
	const names = await readDisplayNames({ userIds: [...userIds], narratorIds: [...narratorIds] });
	return { users: names.users, narrators: names.narrators };
}

/** One block of a pending change's diff: as proposed against, as proposed, and as it is now. */
export interface OutlinePendingDiffEntry {
	blockId: string;
	sid: string;
	kind: "update" | "insert" | "delete" | "move" | "task" | "restore";
	/** The block's text when proposed (null for a new block). */
	base: string | null;
	/** What the change makes it (null for a deletion). */
	proposed: string | null;
	/** The text now (null for a new block, or one deleted since). */
	now: string | null;
	/** Changed by someone since the proposal. */
	changedSince: boolean;
	/** For a task change: the fields as proposed. */
	task?: OutlineTaskPatch | null;
	/** For a move or an insert: the parent it goes under (title), null for the top level. */
	parentTitle?: string | null;
	/**
	 * For a delete: blocks in or under it others added, changed or moved away since it was
	 * proposed (a confirmation refuses then).
	 */
	changedUnder?: number;
	/**
	 * For a delete: its subtree could not be checked for that (reviews R3-N-a, R4-N-1): too many
	 * blocks (`size`), or too many of the session's writers on one block (`writers`).
	 */
	subtreeUnchecked?: OutlineUncheckedReason;
}

/**
 * A pending change block by block, at most {@link OUTLINE_PENDING_LIMITS.diffBlocks} entries and
 * {@link OUTLINE_PENDING_LIMITS.diffTextBytes} of each text. Point reads only: the blocks it
 * names, their versions as proposed against.
 */
export async function readPendingDiff(
	row: OutlinePendingRow,
	options: { store?: OutlineStore } = {},
): Promise<{ entries: OutlinePendingDiffEntry[]; truncated: boolean }> {
	const store = options.store ?? outlineStore;
	const ops = pendingOps(row);
	const limit = OUTLINE_PENDING_LIMITS.diffBlocks;
	const clip = (text: string | null | undefined): string | null => {
		if (text === null || text === undefined) return null;
		const max = OUTLINE_PENDING_LIMITS.diffTextBytes;
		if (Buffer.byteLength(text, "utf8") <= max) return text;
		return `${Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/�$/, "")}…`;
	};
	const shown = ops.slice(0, limit);
	const ids = new Set<string>();
	for (const op of shown) {
		if ("block" in op && "id" in op.block) ids.add(op.block.id);
		if ((op.op === "insert" || op.op === "move") && op.parent && "id" in op.parent)
			ids.add(op.parent.id);
	}
	const blocks = new Map((await store.getBlocks([...ids])).map((b) => [b.id, b]));
	// Each entry against the version its operation was computed against (review N-1).
	const baseOfOp = (op: OutlineOp): number | undefined =>
		op.op !== "insert" && "id" in op.block ? (opBase(op) ?? row.baseJson[op.block.id]) : undefined;
	const baseVersions = await versionsAt(
		store,
		shown.flatMap((op) => {
			const seq = baseOfOp(op);
			return seq !== undefined && op.op !== "insert" && "id" in op.block
				? [{ blockId: op.block.id, seq }]
				: [];
		}),
	);
	// Only the deletes the diff shows, within one request's budget (main-thread rule).
	const subtrees = await deletedSubtreeChanges(store, row, {
		only: new Set(
			shown.flatMap((op) => (op.op === "delete" && "id" in op.block ? [op.block.id] : [])),
		),
		budget: { left: OUTLINE_PENDING_LIMITS.diffSubtreeRows },
	});
	const titleOfBlock = (id: string | undefined) => {
		const b = id ? blocks.get(id) : undefined;
		return b ? titleOf(b.content).slice(0, 200) : null;
	};
	const entries: OutlinePendingDiffEntry[] = [];
	for (const op of shown) {
		if (op.op === "insert") {
			entries.push({
				blockId: op.id ?? "",
				sid: op.sid ?? "",
				kind: "insert",
				base: null,
				proposed: clip(op.content),
				now: null,
				changedSince: false,
				task: op.task ?? null,
				parentTitle: op.parent && "id" in op.parent ? titleOfBlock(op.parent.id) : null,
			});
			continue;
		}
		const id = "id" in op.block ? op.block.id : "";
		const now = blocks.get(id);
		const baseSeq = baseOfOp(op);
		const base = baseSeq === undefined ? undefined : baseVersions.get(`${id}@${baseSeq}`);
		const changedSince =
			baseSeq !== undefined && (!now || now.deleted || now.versionSeq !== baseSeq);
		const nowText = now && !now.deleted ? now.content : null;
		const baseText = base?.content ?? nowText;
		entries.push({
			blockId: id,
			sid: now?.sid ?? "",
			kind:
				op.op === "update"
					? "update"
					: op.op === "setTask"
						? "task"
						: op.op === "delete"
							? "delete"
							: op.op === "move"
								? "move"
								: "restore",
			base: clip(baseText),
			proposed: clip(
				op.op === "update" ? (op.content ?? baseText) : op.op === "delete" ? null : baseText,
			),
			now: clip(nowText),
			changedSince,
			...(op.op === "setTask" ? { task: op.task } : {}),
			...(op.op === "move"
				? { parentTitle: op.parent && "id" in op.parent ? titleOfBlock(op.parent.id) : null }
				: {}),
			...(op.op === "delete" && subtrees.changed.has(id)
				? { changedUnder: subtrees.changed.get(id) }
				: {}),
			...(op.op === "delete" && subtrees.unchecked.has(id)
				? { subtreeUnchecked: subtrees.unchecked.get(id) }
				: {}),
		});
	}
	return { entries, truncated: ops.length > shown.length };
}

/**
 * Decisions on a session's changes on a page it has not been shown, oldest first: shown once on
 * its next read of the page, then marked reported.
 */
export async function takePendingReports(
	session: string,
	options: { store?: OutlineStore; now?: () => Date; pageId: string },
): Promise<OutlinePendingHead[]> {
	const store = options.store ?? outlineStore;
	// Decided rows of this page only (the unreported index): open rows and other pages never
	// crowd them out (review S-6); each read tells the oldest and marks them told.
	const taken = await store.listUnreportedPending(
		session,
		options.pageId,
		OUTLINE_PENDING_LIMITS.reportsPerRead,
	);
	if (taken.length > 0) {
		await store.markPendingReported(
			taken.map((r) => r.id),
			(options.now?.() ?? new Date()).toISOString(),
		);
	}
	return taken;
}

/** The space of a pending change, for access checks. */
export async function pendingSpace(
	row: OutlinePendingRow,
	options: { store?: OutlineStore } = {},
): Promise<OutlineSpaceRow | null> {
	return await (options.store ?? outlineStore).getSpace(row.spaceId);
}
