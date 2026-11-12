/**
 * A person's reports as the API shows them (汇报, outline P2 PR 11; design §5.3, §6): the list,
 * one report with its titles and links, marking them read, asking for "today so far", and taking
 * back a decision made in the person's name.
 *
 * Reports store ids, seqs and kinds. What is shown is decided now: items of spaces the reader can
 * no longer read are dropped and not counted (D4); titles are the blocks' first lines as they are
 * now; a session is named only to people who may read it; whether a decision made in their name
 * still stands, and can be undone, is read live.
 *
 * Every read is bounded: lists read heads only (never `items_json`); a detail reads one row, at
 * most 50 spaces (access memoized), the current state and first line of at most the blocks its
 * items name (a few hundred, in chunks), and the live state of at most 50 decisions.
 */
import { AppError, ForbiddenError, NotFoundError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { logger } from "@server/lib/logger";
import { titleOf } from "@shared/outline";
import {
	OUTLINE_DIGEST_SECTIONS,
	OUTLINE_DIGEST_UNDO_CODES,
	type OutlineDelegatedKind,
	type OutlineDigestActor,
	type OutlineDigestDetailResponse,
	type OutlineDigestHead,
	type OutlineDigestLink,
	type OutlineDigestListResponse,
	type OutlineDigestNames,
	type OutlineDigestNowResponse,
	type OutlineDigestSection,
	type OutlineDigestSession,
	type OutlineDigestUndoResponse,
} from "@shared/outline-digest";
import {
	canManageSpace,
	canReadSpace,
	canWriteSpace,
	narratorVisibility,
	type OutlinePrincipal,
} from "./access";
import { readDisplayNames } from "./access-reads";
import {
	delegateConfirmationPerson,
	isPlanReviewApproval,
	newlyDoneForReader,
	planEvent,
	relayedAnswerPerson,
} from "./digest";
import { requestOutlineDigestPreview } from "./digest-job";
import { OUTLINE_CHANGE } from "./model";
import { OUTLINE_PLAN_REVIEW_ACTOR } from "./plans";
import { previewRevert, revertCommit } from "./revert";
import { outlineStore } from "./store";
import type { OutlineDigestHeadRow } from "./store/digest-port";
import type {
	OutlineBlockMeta,
	OutlineCommitRow,
	OutlineSpaceRow,
	OutlineStore,
} from "./store/port";

export const OUTLINE_DIGEST_VIEW = {
	/** Reports per page of the list. */
	pageDefault: 14,
	pageMax: 50,
	/** Unread reports the inbox row reads. */
	inboxUnread: 8,
	/** Characters of a block read for its title. */
	titleChars: 200,
	/** Versions of a decision's commit read to tell what it decided. */
	decisionVersions: 2000,
	/** Unread reports one "mark all read" marks at most. */
	markAll: 100,
	/** Sessions named as actors whose visibility a detail checks (the rest stay unnamed). */
	actorSessions: 100,
} as const;

function toHead(row: OutlineDigestHeadRow): OutlineDigestHead {
	return {
		id: row.id,
		kind: row.kind,
		periodKey: row.periodKey,
		timeZone: row.timeZone,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		counts: row.counts,
		itemCount: row.itemCount,
		truncated: row.truncated,
		createdAt: row.createdAt,
		seenAt: row.seenAt,
	};
}

/** The person's daily reports, latest day first, `limit` at a time, and the current preview. */
export async function listOutlineDigests(
	principal: OutlinePrincipal,
	query: { before?: string | null; limit?: number },
	options: { store?: OutlineStore } = {},
): Promise<OutlineDigestListResponse> {
	const store = options.store ?? outlineStore;
	const limit = Math.min(
		Math.max(Math.trunc(query.limit ?? OUTLINE_DIGEST_VIEW.pageDefault), 1),
		OUTLINE_DIGEST_VIEW.pageMax,
	);
	const rows = await store.listDigestHeads(principal.userId, {
		kind: "daily",
		before: query.before ?? null,
		limit: limit + 1,
	});
	const page = rows.slice(0, limit);
	const [preview] = await store.listDigestHeads(principal.userId, { kind: "today", limit: 1 });
	return {
		digests: page.map(toHead),
		preview: preview ? toHead(preview) : null,
		nextCursor: rows.length > limit ? (page[page.length - 1]?.periodKey ?? null) : null,
	};
}

/** The person's unread reports with something in them (the inbox row), latest first. */
export async function listUnreadOutlineDigests(
	principal: OutlinePrincipal,
	options: { store?: OutlineStore } = {},
): Promise<OutlineDigestHead[]> {
	const store = options.store ?? outlineStore;
	const rows = await store.listUnseenDigestHeads(principal.userId, OUTLINE_DIGEST_VIEW.inboxUnread);
	return rows.filter((r) => r.itemCount > 0).map(toHead);
}

/**
 * Mark the person's reports read: those named, or (`"all"`) every unread one, at most
 * {@link OUTLINE_DIGEST_VIEW.markAll} (retention keeps a person far below it). Returns how many
 * were unread.
 */
export async function markOutlineDigestsSeen(
	principal: OutlinePrincipal,
	ids: readonly string[] | "all",
	options: { store?: OutlineStore; now?: () => Date } = {},
): Promise<number> {
	const store = options.store ?? outlineStore;
	const which =
		ids === "all"
			? (await store.listUnseenDigestHeads(principal.userId, OUTLINE_DIGEST_VIEW.markAll)).map(
					(r) => r.id,
				)
			: ids.slice(0, OUTLINE_DIGEST_VIEW.pageMax);
	const marked = await store.markDigestsSeen(
		principal.userId,
		which,
		(options.now?.() ?? new Date()).toISOString(),
	);
	if (marked > 0) eventBus.emit({ type: "human_attention:changed", userIds: [principal.userId] });
	return marked;
}

/** Ask for "today so far"; answers with the preview there is now. */
export async function requestOutlineDigestNow(
	principal: OutlinePrincipal,
	options: { store?: OutlineStore; now?: number; kick?: boolean } = {},
): Promise<OutlineDigestNowResponse> {
	const store = options.store ?? outlineStore;
	const asked = requestOutlineDigestPreview(principal.userId, {
		...(options.now !== undefined ? { now: options.now } : {}),
		...(options.kick !== undefined ? { kick: options.kick } : {}),
	});
	const [preview] = await store.listDigestHeads(principal.userId, { kind: "today", limit: 1 });
	return {
		queued: asked.queued,
		reason: asked.queued ? null : asked.reason,
		previewId: preview?.id ?? null,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// One report
// ─────────────────────────────────────────────────────────────────────────────

/** Read and write access of the reader to spaces, memoized for one request. */
function accessOf(principal: OutlinePrincipal, store: OutlineStore) {
	const memo = new Map<string, Promise<{ space: OutlineSpaceRow; write: boolean } | null>>();
	return (spaceId: string) => {
		let found = memo.get(spaceId);
		if (!found) {
			found = (async () => {
				const space = await store.getSpace(spaceId);
				if (!space || !(await canReadSpace(principal, space))) return null;
				return { space, write: await canWriteSpace(principal, space) };
			})();
			memo.set(spaceId, found);
		}
		return found;
	};
}

/**
 * One of the person's reports as they may see it now; 404 for anyone else's (and for one that is
 * gone), the same as for one that never was.
 */
export async function readOutlineDigestDetail(
	principal: OutlinePrincipal,
	id: string,
	options: { store?: OutlineStore } = {},
): Promise<OutlineDigestDetailResponse> {
	const store = options.store ?? outlineStore;
	const row = await store.getDigest(id);
	if (!row || row.userId !== principal.userId) throw new NotFoundError("Outline report", id);
	const stored = row.items;
	const access = accessOf(principal, store);
	const spaceIds = new Set<string>(stored.spaces.map((s) => s.id));
	for (const section of OUTLINE_DIGEST_SECTIONS)
		for (const item of stored[section] as Array<{ space: string }>) spaceIds.add(item.space);
	const readable = new Map<string, { space: OutlineSpaceRow; write: boolean }>();
	for (const spaceId of spaceIds) {
		const a = await access(spaceId);
		if (a) readable.set(spaceId, a);
	}
	const keep = <T extends { space: string }>(list: readonly T[]) =>
		list.filter((item) => readable.has(item.space));
	const delegated = keep(stored.delegated);
	const knowledge = keep(stored.knowledge);
	const tasks = keep(stored.tasks);
	const plans = keep(stored.plans);
	const questions = keep(stored.questions);
	const other = keep(stored.other);

	// The blocks the items name, as they are now, and their first lines.
	const blockIds = new Set<string>();
	const add = (id: string | null | undefined) => {
		if (id) blockIds.add(id);
	};
	for (const d of delegated) add(d.blockId);
	for (const k of knowledge) {
		add(k.pageId);
		for (const b of k.blocks) add(b.id);
	}
	for (const t of tasks) add(t.blockId);
	for (const p of plans) add(p.blockId);
	for (const q of questions) add(q.blockId);
	for (const o of other) add(o.blockId);
	const ids = [...blockIds];
	const metas = new Map<string, OutlineBlockMeta>(
		(await store.getBlockMetasByIds(ids)).map((m) => [m.id, m]),
	);
	const heads = await store.getContentHeads(ids, OUTLINE_DIGEST_VIEW.titleChars);
	const title = (blockId: string | null) => {
		if (!blockId) return null;
		const head = heads.get(blockId);
		return head === undefined ? null : titleOf(head);
	};

	// Sessions, named only to people who may read them.
	const visible = narratorVisibility(principal);
	const narratorIds = [
		...delegated.flatMap((d) => (d.narratorId ? [d.narratorId] : [])),
		...plans.flatMap((p) => (p.narratorId ? [p.narratorId] : [])),
	];
	const shownNarrators = new Set<string>();
	for (const narratorId of new Set(narratorIds))
		if (await visible(narratorId)) shownNarrators.add(narratorId);
	const names = await readDisplayNames({ narratorIds: [...shownNarrators] });
	// Gone since (an admin is told every session is readable without one being read): not named.
	for (const narratorId of [...shownNarrators])
		if (!names.narrators.has(narratorId)) shownNarrators.delete(narratorId);
	const session = (narratorId: string | null): OutlineDigestSession =>
		narratorId && shownNarrators.has(narratorId)
			? { narratorId, title: names.narrators.get(narratorId) ?? null, hidden: false }
			: { narratorId: null, title: null, hidden: narratorId !== null };

	const link = (
		item: { space: string; seq: number; commitId: string },
		blockId: string | null,
		pageId: string | null,
		narratorId: string | null = null,
	): OutlineDigestLink => {
		const space = (readable.get(item.space) as { space: OutlineSpaceRow }).space;
		const meta = blockId ? metas.get(blockId) : undefined;
		return {
			spaceId: space.id,
			spaceKey: space.key,
			blockId,
			pageId: meta?.pageId ?? pageId,
			address: meta ? `${space.key}/${meta.sid}` : null,
			seq: item.seq,
			commitId: item.commitId,
			narratorId: narratorId && shownNarrators.has(narratorId) ? narratorId : null,
		};
	};
	const base = (
		item: { space: string; seq: number; commitId: string; at: string },
		blockId: string | null,
		pageId: string | null,
		narratorId: string | null = null,
	) => ({
		link: link(item, blockId, pageId, narratorId),
		title: title(blockId),
		deleted: blockId ? (metas.get(blockId)?.deleted ?? true) : false,
		at: item.at,
	});

	// Whether each decision made in the person's name still stands.
	const confirmations = delegated.filter((d) => d.kind === "confirmation").map((d) => d.commitId);
	const confirmed = new Set(
		(confirmations.length > 0 ? await store.getPendingByDecisionCommits(confirmations) : [])
			.filter((p) => delegateConfirmationPerson(p) === principal.userId)
			.map((p) => p.decisionCommitId),
	);
	const answers = delegated.filter((d) => d.kind === "relayed_answer" && d.blockId);
	const answerRows = new Map(
		(answers.length > 0
			? await store.getQuestions(answers.map((d) => d.blockId as string))
			: []
		).map((q) => [q.blockId, q]),
	);
	const stands = (d: (typeof delegated)[number]): boolean => {
		if (d.kind === "confirmation") return confirmed.has(d.commitId);
		const meta = d.blockId ? metas.get(d.blockId) : undefined;
		if (!meta || meta.deleted) return false;
		if (d.kind === "plan_review_approval")
			return isPlanReviewApproval(meta.taskJson) && meta.taskJson?.plan?.round === d.round;
		const q = answerRows.get(meta.id);
		return q?.state === "answered" && q.answerCommitId === d.commitId;
	};

	// Counts of what is shown: the readable spaces' items, listed or past the caps.
	const spaces = stored.spaces.filter((s) => readable.has(s.id));
	const more = Object.fromEntries(
		OUTLINE_DIGEST_SECTIONS.map((section) => [
			section,
			spaces.reduce((n, s) => n + (s.more?.[section] ?? 0), 0),
		]),
	) as Record<OutlineDigestSection, number>;
	const counts = {
		delegated: delegated.length + more.delegated,
		knowledge: knowledge.length + more.knowledge,
		tasks: tasks.length + more.tasks,
		plans: plans.length + more.plans,
		questions: questions.length + more.questions,
		other: other.length + more.other,
		spaces: spaces.length + stored.moreSpaces,
		ownEdits: spaces.reduce((n, s) => n + s.ownEdits, 0),
	};
	const spaceLabels = await readDisplayNames({
		projectIds: spaces.flatMap((s) => {
			const space = readable.get(s.id)?.space;
			return space?.kind === "project" && space.projectId ? [space.projectId] : [];
		}),
		narratorIds: (
			await Promise.all(
				spaces.map(async (s) => {
					const space = readable.get(s.id)?.space;
					return space?.kind === "session" && space.narratorId && (await visible(space.narratorId))
						? [space.narratorId]
						: [];
				}),
			)
		).flat(),
	});

	// People and sessions the items name: usernames, and titles of the sessions the reader may
	// read (at most `actorSessions` of them are checked).
	const actorUsers = new Set<string>();
	const actorSessions = new Set<string>();
	const named = (actor: OutlineDigestActor | null) => {
		if (actor?.kind === "human") actorUsers.add(actor.id);
		else if (actor?.kind === "agent") actorSessions.add(actor.id);
	};
	for (const t of tasks) {
		named(t.by);
		named(t.executor);
		named(t.manager);
	}
	for (const p of plans) named(p.approvedBy);
	for (const q of questions) {
		named(q.by);
		if (q.to) actorUsers.add(q.to);
	}
	for (const o of other) named(o.actor);
	const readableSessions: string[] = [];
	for (const narratorId of [...actorSessions].slice(0, OUTLINE_DIGEST_VIEW.actorSessions))
		if (await visible(narratorId)) readableSessions.push(narratorId);
	const actorNames = await readDisplayNames({
		userIds: [...actorUsers],
		narratorIds: readableSessions,
	});
	const actorNamesView: OutlineDigestNames = {
		users: Object.fromEntries(actorNames.users),
		// Only sessions that are still there.
		sessions: Object.fromEntries(
			readableSessions
				.filter((id) => actorNames.narrators.has(id))
				.map((id) => [id, actorNames.narrators.get(id) ?? null]),
		),
	};

	return {
		digest: {
			...toHead(row),
			counts,
			itemCount: OUTLINE_DIGEST_SECTIONS.reduce((n, s) => n + counts[s], 0),
		},
		spaces: spaces.map((s) => {
			const space = (readable.get(s.id) as { space: OutlineSpaceRow }).space;
			return {
				id: s.id,
				key: space.key,
				kind: s.kind,
				label:
					space.kind === "project" && space.projectId
						? (spaceLabels.projects.get(space.projectId) ?? null)
						: space.kind === "session" && space.narratorId
							? (spaceLabels.narrators.get(space.narratorId) ?? null)
							: null,
				from: s.from,
				to: s.to,
				commits: s.commits,
				truncated: s.truncated,
				deletedFacts: s.deletedFacts,
				ownEdits: s.ownEdits,
				tasksCreated: s.tasksCreated,
				tasksStarted: s.tasksStarted,
				leaseReturned: s.leaseReturned,
				handedBack: s.handedBack ?? 0,
				reviewComments: s.reviewComments,
				more: s.more ?? {},
			};
		}),
		moreSpaces: stored.moreSpaces,
		delegated: delegated.map((d) => {
			const standing = stands(d);
			return {
				...base(d, d.blockId, d.pageId, d.narratorId),
				kind: d.kind,
				session: session(d.narratorId),
				pendingId: d.pendingId ?? null,
				round: d.round ?? null,
				questions: d.questions ?? null,
				stands: standing,
				canUndo: standing && (readable.get(d.space)?.write ?? false),
			};
		}),
		knowledge: knowledge.map((k) => ({
			...base(k, k.pageId, k.pageId),
			created: k.created,
			changed: k.changed,
			blocks: k.blocks.map((b) => ({
				link: link({ space: k.space, seq: b.seq, commitId: k.commitId }, b.id, k.pageId),
				title: title(b.id) ?? "",
				deleted: metas.get(b.id)?.deleted ?? true,
				created: b.created,
			})),
		})),
		tasks: tasks.map((t) => ({
			...base(t, t.blockId, t.pageId),
			event: t.event,
			by: t.by,
			executor: t.executor,
			manager: t.manager,
			goal: t.goal,
			forYou: t.forYou,
			newlyDoneForYou: newlyDoneForReader(t, principal.userId),
		})),
		plans: plans.map((p) => ({
			...base(p, p.blockId, p.pageId, p.narratorId),
			event: p.event,
			round: p.round,
			session: session(p.narratorId),
			approvedBy: p.approvedBy,
		})),
		questions: questions.map((q) => ({
			...base(q, q.blockId, q.pageId),
			event: q.event,
			to: q.to,
			by: q.by,
			adopted: q.adopted,
			relayed: q.relayed,
			toYou: q.toYou,
		})),
		other: other.map((o) => ({
			...base(o, o.blockId ?? null, o.pageId ?? null),
			event: o.event,
			actor: o.actor,
			blocks: o.blocks,
		})),
		more,
		names: actorNamesView,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Undoing a decision made in the person's name (Q5)
// ─────────────────────────────────────────────────────────────────────────────

/** A decision a commit made in someone's name, as the commit itself shows it. */
export interface OutlineDelegatedDecision {
	kind: OutlineDelegatedKind;
	/** Whose name it was made in. */
	person: string;
	/** The blocks the decision is about: undoing it must put at least one of them back. */
	blockIds: string[];
	/** A plan's version. */
	round: number | null;
}

/**
 * What a commit decided in someone's name, read from the commit and its versions (never from
 * what a client or a report says): an agent's confirmation for a locker, the plan review's draft
 * approval for the turn's person, a session's relaying of a person's answers. Null for anything
 * else.
 */
export async function classifyDelegatedCommit(
	store: OutlineStore,
	commit: OutlineCommitRow,
): Promise<OutlineDelegatedDecision | null> {
	if (commit.kind === "confirm") {
		const [pending] = await store.getPendingByDecisionCommits([commit.id]);
		const person = pending ? delegateConfirmationPerson(pending) : null;
		return pending && person
			? {
					kind: "confirmation",
					person,
					blockIds: [
						...(pending.rootBlockId ? [pending.rootBlockId] : []),
						...pending.blockIdsJson,
					],
					round: null,
				}
			: null;
	}
	const isReview =
		commit.kind === "plan" &&
		commit.actorKind === "system" &&
		commit.actorId === OUTLINE_PLAN_REVIEW_ACTOR;
	const isRelay = commit.kind === "answer" && commit.actorKind === "agent";
	if (!isReview && !isRelay) return null;
	const versions = await store.listCommitRangeChanges(
		commit.spaceId,
		commit.seq - 1,
		commit.seq,
		OUTLINE_DIGEST_VIEW.decisionVersions,
	);
	if (isReview) {
		if (!commit.responsibleUserId) return null;
		for (const v of versions) {
			if ((v.changeFlags & OUTLINE_CHANGE.TASK) === 0 || !isPlanReviewApproval(v.taskJson))
				continue;
			const [before] = await store.listVersionMetasAt([
				{ blockId: v.blockId, seq: commit.seq - 1 },
			]);
			if (planEvent(before?.taskJson ?? null, v.taskJson) !== "approved_draft") continue;
			return {
				kind: "plan_review_approval",
				person: commit.responsibleUserId,
				blockIds: [v.blockId],
				round: v.taskJson?.plan?.round ?? null,
			};
		}
		return null;
	}
	const asked = versions.filter((v) => (v.changeFlags & OUTLINE_CHANGE.ASK) !== 0 && v.hasAsk);
	if (asked.length === 0) return null;
	const metas = await store.listVersionMetasAt(
		asked.map((v) => ({ blockId: v.blockId, seq: commit.seq })),
		{ withAsk: true },
	);
	let person: string | null = null;
	const blockIds: string[] = [];
	for (const meta of metas) {
		const who = relayedAnswerPerson(meta.askJson);
		if (!who) continue;
		if (person !== null && person !== who) return null;
		person = who;
		blockIds.push(meta.blockId);
	}
	return person ? { kind: "relayed_answer", person, blockIds, round: null } : null;
}

/** Whether the decision still stands as it was made (not undone or superseded since). */
async function decisionStands(
	store: OutlineStore,
	commit: OutlineCommitRow,
	decision: OutlineDelegatedDecision,
): Promise<boolean> {
	if (decision.kind === "confirmation") return true;
	if (decision.kind === "plan_review_approval") {
		const [root] = await store.getBlockMetasByIds(decision.blockIds.slice(0, 1));
		return (
			!!root &&
			!root.deleted &&
			isPlanReviewApproval(root.taskJson) &&
			root.taskJson?.plan?.round === decision.round
		);
	}
	const rows = await store.getQuestions(decision.blockIds);
	return rows.some((q) => q.state === "answered" && q.answerCommitId === commit.id);
}

export class OutlineDigestUndoError extends AppError {
	constructor(message: string) {
		super(message, 409, OUTLINE_DIGEST_UNDO_CODES.gone);
		this.name = "OutlineDigestUndoError";
	}
}

/** 403 with a code that says why, so a client can say it in the reader's language. */
class OutlineDigestUndoForbiddenError extends ForbiddenError {
	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Take back a decision made in the person's name by reverting its commit (the outline's own
 * revert, as the person). Only the person it was made for may (403 `…_NOT_YOURS` for anyone else
 * who can read the space; 404 when they cannot, or the commit is unknown), only while they may
 * write the space (403 `…_READ_ONLY`), and only while it can still be taken back: it still
 * stands, and reverting would put back what it decided (409 `…_GONE` otherwise, nothing written).
 */
export async function undoOutlineDelegatedDecision(
	principal: OutlinePrincipal,
	commitId: string,
	options: { store?: OutlineStore; now?: () => Date } = {},
): Promise<OutlineDigestUndoResponse> {
	const store = options.store ?? outlineStore;
	const commit = await store.getCommit(commitId);
	const space = commit ? await store.getSpace(commit.spaceId) : null;
	if (!commit || !space || !(await canReadSpace(principal, space)))
		throw new NotFoundError("Outline commit", commitId);
	const decision = await classifyDelegatedCommit(store, commit);
	if (!decision || decision.person !== principal.userId)
		throw new OutlineDigestUndoForbiddenError(
			"Only the person this decision was made for can undo it",
			OUTLINE_DIGEST_UNDO_CODES.notYours,
		);
	if (!(await canWriteSpace(principal, space)))
		throw new OutlineDigestUndoForbiddenError(
			"You may not write where this decision was made",
			OUTLINE_DIGEST_UNDO_CODES.readOnly,
		);
	if (!(await decisionStands(store, commit, decision)))
		throw new OutlineDigestUndoError("This decision was already undone or changed since");
	const preview = await previewRevert(commitId, { store });
	const putBack = new Set(preview.changed);
	// A confirmation may only have added blocks (named by sid, not here): anything put back counts.
	// A plan or an answer must get the root or a question back, or nothing was undone.
	const undoes =
		decision.kind === "confirmation"
			? putBack.size > 0
			: decision.blockIds.some((id) => putBack.has(id));
	if (!undoes)
		throw new OutlineDigestUndoError("This decision can no longer be undone: it was changed since");
	const result = await revertCommit(
		{
			commitId,
			actor: { kind: "human", id: principal.userId },
			responsibleUserId: principal.userId,
			unlockAuthority: async () => principal.isAdmin || (await canManageSpace(principal, space)),
		},
		{ store, ...(options.now ? { now: options.now } : {}) },
	);
	// Changed between the check and the revert, so that nothing was put back after all.
	if (!result.commit)
		throw new OutlineDigestUndoError("This decision can no longer be undone: it was changed since");
	// A confirmation taken back is one the person has seen: it leaves the unacknowledged ones (its
	// pending row keeps reading as confirmed, so it would otherwise be offered again).
	// Best effort: the undo is done either way.
	if (decision.kind === "confirmation") {
		try {
			const [pending] = await store.getPendingByDecisionCommits([commitId]);
			if (pending)
				await store.markDelegateConfirmationsSeen(
					principal.userId,
					[pending.id],
					(options.now?.() ?? new Date()).toISOString(),
				);
		} catch (error) {
			logger.warn("Outline report: an undone confirmation could not be marked seen", {
				commitId,
				error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
			});
		}
	}
	eventBus.emit({ type: "human_attention:changed", userIds: [principal.userId] });
	return { kind: decision.kind, commit: result.commit, skipped: result.skipped.length };
}
