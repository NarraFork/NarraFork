/**
 * What a report says (汇报, outline P2 PR 11; design §3.4, §7.2): how one space's commits over a
 * window become items, and how a person's items become one stored report.
 *
 * FROM COMMITS, NOT FROM TEXT (principle 6)
 * -----------------------------------------
 * A space's window is a seq range `(from, to]`. Its commits, and the versions they wrote without
 * their content, say everything a report needs, compared with each block's version just before
 * the window (`from`) or just before the commit:
 *
 *   | section            | from                                                                |
 *   |--------------------|---------------------------------------------------------------------|
 *   | 代你做的 delegated | a `confirm` commit whose pending change an agent confirmed for its   |
 *   |                    | locker; a `plan` commit by `plan-review` approving a plan as a draft |
 *   |                    | (`approvedBy: system:plan-review`); an `answer` commit whose answers  |
 *   |                    | a session relayed (`ask_json.answer.relayed`). The person is the     |
 *   |                    | locker, the commit's responsible person, the answer's person.        |
 *   | 新知识 knowledge   | project and personal spaces: blocks that are facts now and live now, |
 *   |                    | created in the window or whose `content_hash` differs from before it |
 *   |                    | (made and deleted the same day, or changed back: not listed); facts  |
 *   |                    | the person alone wrote are counted, not listed; deleted ones counted |
 *   | 任务 tasks         | `task_json.status` before the window against after it: done,        |
 *   |                    | cancelled, reopened; handed to the person (`assignee`); new and      |
 *   |                    | started only counted; tasks the lease job gave back counted apart    |
 *   | 计划 plans         | each `plan` commit: the root's `task_json.plan` before and after it  |
 *   | 提问 questions     | each version with the question flag: its `ask_json` before and after |
 *   | 其他 other         | reverts, imports, confirmations by people, tasks handed to subagents |
 *   |                    | and their reports (PR 9), commits of other system actors              |
 *
 * Whether a block is a fact is asked of it as it is now (`readInProcess`), as the prototype did.
 * What a person is shown of a space ({@link selectForPerson}) and how the parts become one report
 * within its limits ({@link assembleDigest}) are pure. Nothing here writes.
 */
import type {
	OutlineDelegatedKind,
	OutlineDigestActor,
	OutlineDigestCounts,
	OutlineDigestDelegatedStored,
	OutlineDigestKnowledgeStored,
	OutlineDigestOtherStored,
	OutlineDigestPlanEvent,
	OutlineDigestPlanStored,
	OutlineDigestQuestionEvent,
	OutlineDigestQuestionStored,
	OutlineDigestSection,
	OutlineDigestSpaceStored,
	OutlineDigestStored,
	OutlineDigestTaskEvent,
	OutlineDigestTaskStored,
} from "@shared/outline-digest";
import { OUTLINE_DIGEST_SECTIONS } from "@shared/outline-digest";
import { readInProcess } from "./in-process";
import {
	OUTLINE_CHANGE,
	type OutlineAskJson,
	type OutlineSpaceKind,
	type OutlineTaskJson,
} from "./model";
import { OUTLINE_PLAN_ACTOR, OUTLINE_PLAN_REVIEW_ACTOR } from "./plans";
import type { OutlineRangeChange, OutlineVersionMeta } from "./store/digest-port";
import type {
	OutlineCommitRow,
	OutlinePendingHead,
	OutlineSpaceRow,
	OutlineStore,
	OutlineTaskClaimRow,
} from "./store/port";
import { OUTLINE_LEASE_ACTOR } from "./tasks";

/** Limits of one report and of one space's window (design §3.4). */
export const OUTLINE_DIGEST_LIMITS = {
	/** Commits of one space's window read; past it the window is summarized in part. */
	commitsPerSpace: 2000,
	/** Versions those commits wrote, read without content. */
	versionsPerSpace: 5000,
	/** Blocks whose version before the window is read. */
	priorPerSpace: 2000,
	/** Question versions whose `ask_json` is read (each with the one before it). */
	asksPerSpace: 100,
	/** Plan-root versions of `plan` commits read with the one before them. */
	plansPerSpace: 200,
	/** Spaces one report shows; the rest are counted. */
	spacesPerDigest: 50,
	/** Items one report lists; each section lists at most `itemsPerSection`. */
	itemsPerDigest: 300,
	itemsPerSection: 50,
	/** Blocks named per page of new knowledge. */
	blocksPerPage: 3,
	/** UTF-8 bytes of a stored report's items. */
	itemsBytes: 64 * 1024,
	/** Space ranges one report keeps for the next day to continue from. */
	rangesPerDigest: 500,
} as const;

export type OutlineDigestLimits = { readonly [K in keyof typeof OUTLINE_DIGEST_LIMITS]: number };

/**
 * The system actors of delegation (outline P2 PR 9): a task handed to a subagent (in progress, its
 * claim passed on) and the subagent's report written under it. Named here rather than imported:
 * the module that defines them (`delegation.ts`) is not on this branch's base yet.
 */
export const OUTLINE_DIGEST_DELEGATE_ACTOR = "outline-delegate";
export const OUTLINE_DIGEST_REPORT_ACTOR = "outline-report";

/**
 * System actors whose commits are routine bookkeeping (counted or classified elsewhere, or not
 * news): the report lists commits of any other system actor under 其他.
 */
const ROUTINE_SYSTEM_ACTORS = new Set([
	OUTLINE_LEASE_ACTOR,
	OUTLINE_PLAN_ACTOR,
	OUTLINE_PLAN_REVIEW_ACTOR,
	"outline-task-start",
	"outline-questions",
	"outline-live",
	"outline-live-sync",
	"outline-behavior-fork",
	"outline-behavior-import",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Classification (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** What one task's state did over a window: before it (null: created in it) against after. */
export interface OutlineTaskTransition {
	event: Extract<OutlineDigestTaskEvent, "done" | "cancelled" | "reopened"> | null;
	created: boolean;
	started: boolean;
	/** The task was handed to this assignee (`agent:…` / `human:…`) in the window. */
	assignedTo: string | null;
}

export function taskTransition(
	before: OutlineTaskJson | null,
	after: OutlineTaskJson | null,
	createdInWindow: boolean,
): OutlineTaskTransition {
	const out: OutlineTaskTransition = {
		event: null,
		created: false,
		started: false,
		assignedTo: null,
	};
	if (!after) return out;
	const prior = createdInWindow ? null : before;
	const was = prior?.status ?? null;
	const now = after.status;
	if (!prior) out.created = true;
	if (now === "done" && was !== "done") out.event = "done";
	else if (now === "cancelled" && was !== "cancelled") out.event = "cancelled";
	else if ((was === "done" || was === "cancelled") && (now === "todo" || now === "doing"))
		out.event = "reopened";
	if (now === "doing" && was !== "doing" && out.event === null) out.started = true;
	if (after.assignee && after.assignee !== (prior?.assignee ?? null))
		out.assignedTo = after.assignee;
	return out;
}

/** What one `plan` commit did to a plan root: its `task_json` before and after the commit. */
export function planEvent(
	before: OutlineTaskJson | null,
	after: OutlineTaskJson | null,
): OutlineDigestPlanEvent | null {
	const a = after?.plan;
	if (!a) return null;
	const b = before?.plan;
	if (a.state === "planning") {
		if (!b || b.state === "approved") return "planning";
		return a.round > b.round ? "returned" : null;
	}
	if (b?.state === "approved" && b.round === a.round) return null;
	return after?.lock ? "approved_locked" : "approved_draft";
}

/** Whether a plan was approved by the plan review on a person's behalf (D48 ⑦). */
export function isPlanReviewApproval(after: OutlineTaskJson | null): boolean {
	const by = after?.plan?.approvedBy;
	return (
		after?.plan?.state === "approved" &&
		by?.kind === "system" &&
		by.id === OUTLINE_PLAN_REVIEW_ACTOR
	);
}

/** What one version did to a question: its `ask_json` before and after. */
export function questionEvent(
	before: OutlineAskJson | null,
	after: OutlineAskJson | null,
): OutlineDigestQuestionEvent | null {
	if (!after) return null;
	if (after.withdrawn && !before?.withdrawn) return "withdrawn";
	if (after.answer && JSON.stringify(after.answer) !== JSON.stringify(before?.answer ?? null))
		return "answered";
	if (!before && !after.answer && !after.withdrawn) return "asked";
	return null;
}

/** The person whose answer a session wrote down (D45), or null when the answer is not relayed. */
export function relayedAnswerPerson(ask: OutlineAskJson | null): string | null {
	const answer = ask?.answer;
	return answer?.relayed && answer.by.kind === "human" ? answer.by.id : null;
}

/** The locker an agent confirmed a pending change for (P2 PR 7), or null. */
export function delegateConfirmationPerson(row: OutlinePendingHead): string | null {
	return row.status === "confirmed" && row.decidedByJson?.kind === "agent" && row.deciderUserId
		? row.deciderUserId
		: null;
}

function actorOf(kind: string, id: string): OutlineDigestActor {
	return { kind: kind === "human" || kind === "agent" ? kind : "system", id };
}

function claimActor(claim: OutlineTaskClaimRow | undefined): OutlineDigestActor | null {
	if (!claim) return null;
	const narrator = claim.holderNarratorId ?? claim.lastHolderNarratorId;
	if (narrator) return { kind: "agent", id: narrator };
	const user = claim.holderUserId ?? claim.lastHolderUserId;
	return user ? { kind: "human", id: user } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// One space's window
// ─────────────────────────────────────────────────────────────────────────────

/** A fact created or rewritten in the window. */
interface KnowledgeFact {
	blockId: string;
	pageId: string;
	parentId: string | null;
	created: boolean;
	seq: number;
	commitId: string;
	at: string;
	/** `kind:id` of the commits that created or rewrote it in the window. */
	writers: string[];
}

interface TaskFact extends Omit<OutlineDigestTaskStored, "forYou"> {
	/** For `assigned`: to whom. */
	assignee: string | null;
}

/** Everything one space's window says, for whoever it concerns. */
export interface OutlineSpaceSummary {
	spaceId: string;
	kind: OutlineSpaceKind;
	from: number;
	to: number;
	commits: number;
	truncated: boolean;
	/** People responsible for a commit of the window, or who wrote one themselves. */
	actors: Set<string>;
	knowledge: KnowledgeFact[];
	deletedFacts: number;
	tasks: TaskFact[];
	tasksCreated: number;
	tasksStarted: number;
	leaseReturned: number;
	plans: OutlineDigestPlanStored[];
	reviewComments: number;
	questions: Array<Omit<OutlineDigestQuestionStored, "toYou">>;
	delegated: Array<OutlineDigestDelegatedStored & { person: string }>;
	other: OutlineDigestOtherStored[];
}

const KNOWLEDGE_FLAGS =
	OUTLINE_CHANGE.CREATE | OUTLINE_CHANGE.CONTENT | OUTLINE_CHANGE.DELETE | OUTLINE_CHANGE.RESTORE;
const WRITE_FLAGS = OUTLINE_CHANGE.CREATE | OUTLINE_CHANGE.CONTENT;

function versionKey(blockId: string, seq: number): string {
	return `${blockId}@${seq}`;
}

/**
 * The space's commits in `(from, to]`, at most `limit` (true when there were more). Seqs are
 * contiguous, so the window holds `to - from` commits and no more than those are read.
 */
export async function readWindowCommits(
	store: OutlineStore,
	spaceId: string,
	from: number,
	to: number,
	limit: number,
): Promise<{ commits: OutlineCommitRow[]; truncated: boolean }> {
	if (to <= from) return { commits: [], truncated: false };
	const rows = await store.listCommits(spaceId, {
		afterSeq: from,
		limit: Math.min(limit, to - from),
	});
	return { commits: rows.filter((c) => c.seq > from && c.seq <= to), truncated: to - from > limit };
}

/**
 * Summarize one space's window `(from, to]`: its commits (at most `commitsPerSpace`), the versions
 * they wrote without content (at most `versionsPerSpace`, read off the main thread on SQLite), the
 * versions before them that the comparisons need (bounded per kind), whether blocks are facts now,
 * claims of finished tasks and the pending changes confirmed. Never reads block text.
 */
export async function summarizeSpaceWindow(
	store: OutlineStore,
	space: OutlineSpaceRow,
	from: number,
	to: number,
	limits: OutlineDigestLimits = OUTLINE_DIGEST_LIMITS,
	/** The window's commits when the caller read them already ({@link readWindowCommits}). */
	preread?: { commits: OutlineCommitRow[]; truncated: boolean },
): Promise<OutlineSpaceSummary> {
	const summary: OutlineSpaceSummary = {
		spaceId: space.id,
		kind: space.kind,
		from,
		to,
		commits: 0,
		truncated: false,
		actors: new Set(),
		knowledge: [],
		deletedFacts: 0,
		tasks: [],
		tasksCreated: 0,
		tasksStarted: 0,
		leaseReturned: 0,
		plans: [],
		reviewComments: 0,
		questions: [],
		delegated: [],
		other: [],
	};
	if (to <= from) return summary;
	const read =
		preread ?? (await readWindowCommits(store, space.id, from, to, limits.commitsPerSpace));
	const commits = read.commits;
	summary.truncated = read.truncated;
	summary.commits = commits.length;
	if (commits.length === 0) return summary;
	const commitOf = new Map(commits.map((c) => [c.id, c]));
	for (const c of commits) {
		if (c.responsibleUserId) summary.actors.add(c.responsibleUserId);
		if (c.actorKind === "human") summary.actors.add(c.actorId);
	}
	const last = (commits[commits.length - 1] as OutlineCommitRow).seq;
	const changes = await store.listCommitRangeChanges(
		space.id,
		from,
		last,
		limits.versionsPerSpace + 1,
	);
	if (changes.length > limits.versionsPerSpace) {
		summary.truncated = true;
		changes.length = limits.versionsPerSpace;
	}
	const versionsOf = new Map<string, OutlineRangeChange[]>();
	const versionsByCommit = new Map<string, OutlineRangeChange[]>();
	for (const row of changes) {
		const list = versionsOf.get(row.blockId);
		if (list) list.push(row);
		else versionsOf.set(row.blockId, [row]);
		const ofCommit = versionsByCommit.get(row.commitId);
		if (ofCommit) ofCommit.push(row);
		else versionsByCommit.set(row.commitId, [row]);
	}
	for (const list of versionsOf.values()) list.sort((a, b) => a.seq - b.seq);

	// Which blocks need their version before the window, and the current state of which.
	const facts = space.kind !== "session";
	const created = (id: string) =>
		((versionsOf.get(id)?.[0]?.changeFlags ?? 0) & OUTLINE_CHANGE.CREATE) !== 0;
	const knowledgeIds: string[] = [];
	const taskIds: string[] = [];
	for (const [id, list] of versionsOf) {
		if (facts && list.some((v) => (v.changeFlags & KNOWLEDGE_FLAGS) !== 0)) knowledgeIds.push(id);
		// A task's state changed, or a task was made (a text edit of a task is not a task event).
		if (
			list.some(
				(v) =>
					(v.changeFlags & OUTLINE_CHANGE.TASK) !== 0 ||
					((v.changeFlags & OUTLINE_CHANGE.CREATE) !== 0 && v.taskJson !== null),
			)
		)
			taskIds.push(id);
	}
	const priorWanted = [...new Set([...knowledgeIds, ...taskIds])].filter((id) => !created(id));
	if (priorWanted.length > limits.priorPerSpace) summary.truncated = true;
	const priorKeys = priorWanted.slice(0, limits.priorPerSpace);
	const prior = new Map<string, OutlineVersionMeta>();
	if (from > 0 && priorKeys.length > 0) {
		for (const meta of await store.listVersionMetasAt(
			priorKeys.map((blockId) => ({ blockId, seq: from })),
		))
			prior.set(meta.blockId, meta);
	}
	const known = (id: string) => created(id) || prior.has(id);

	// New knowledge: facts now, live now, new or rewritten over the window.
	if (facts && knowledgeIds.length > 0) {
		const ids = knowledgeIds.filter(known);
		const current = new Map((await store.getBlockMetasByIds(ids)).map((m) => [m.id, m]));
		const inProcess = await readInProcess(space.id, ids, { store });
		for (const id of ids) {
			const list = versionsOf.get(id) as OutlineRangeChange[];
			const lastVersion = list[list.length - 1] as OutlineRangeChange;
			const now = current.get(id);
			if (!now || inProcess.get(id) !== false) continue;
			const before = prior.get(id) ?? null;
			if (now.deleted) {
				if (!created(id) && before && !before.deleted && lastVersion.deleted)
					summary.deletedFacts++;
				continue;
			}
			if (lastVersion.deleted) continue;
			const isNew = created(id);
			if (!isNew && (!before || before.contentHash === lastVersion.contentHash)) continue;
			const writes = list.filter((v) => (v.changeFlags & WRITE_FLAGS) !== 0);
			const writers = [
				...new Set(
					writes.flatMap((v) => {
						const c = commitOf.get(v.commitId);
						return c ? [`${c.actorKind}:${c.actorId}`] : [];
					}),
				),
			];
			const latest = (writes[writes.length - 1] ?? lastVersion) as OutlineRangeChange;
			const commit = commitOf.get(latest.commitId);
			summary.knowledge.push({
				blockId: id,
				pageId: lastVersion.pageId,
				parentId: lastVersion.parentId,
				created: isNew,
				seq: latest.seq,
				commitId: latest.commitId,
				at: commit?.createdAt ?? "",
				writers,
			});
		}
	}

	// Tasks: the state before the window against the state after it.
	const finished: string[] = [];
	for (const id of taskIds) {
		if (!known(id)) continue;
		const list = versionsOf.get(id) as OutlineRangeChange[];
		const lastVersion = list[list.length - 1] as OutlineRangeChange;
		if (lastVersion.deleted) continue;
		const isNew = created(id);
		const before = isNew ? null : (prior.get(id)?.taskJson ?? null);
		if (!isNew && prior.get(id)?.deleted) continue;
		const after = lastVersion.taskJson;
		const leased = list.some((v) => {
			const c = commitOf.get(v.commitId);
			return (
				(v.changeFlags & OUTLINE_CHANGE.TASK) !== 0 &&
				c?.actorKind === "system" &&
				c.actorId === OUTLINE_LEASE_ACTOR
			);
		});
		if (leased) summary.leaseReturned++;
		const change = taskTransition(before, after, isNew);
		if (change.created && after) summary.tasksCreated++;
		if (change.started) summary.tasksStarted++;
		const taskVersion = ([...list]
			.reverse()
			.find((v) => (v.changeFlags & OUTLINE_CHANGE.TASK) !== 0) ??
			lastVersion) as OutlineRangeChange;
		const commit = commitOf.get(taskVersion.commitId);
		if (!commit || !after) continue;
		const base = {
			space: space.id,
			commitId: commit.id,
			seq: commit.seq,
			at: commit.createdAt,
			blockId: id,
			pageId: lastVersion.pageId,
			by: actorOf(commit.actorKind, commit.actorId),
			executor: null,
			manager: after.manager ? actorOf(after.manager.kind, after.manager.id) : null,
			goal: after.humanCreated === true,
		};
		if (change.event) {
			summary.tasks.push({ ...base, event: change.event, assignee: null });
			if (change.event !== "reopened") finished.push(id);
		}
		if (change.assignedTo?.startsWith("human:"))
			summary.tasks.push({ ...base, event: "assigned", assignee: change.assignedTo });
	}
	if (finished.length > 0) {
		const claims = new Map((await store.getTaskClaims(finished)).map((c) => [c.taskBlockId, c]));
		for (const task of summary.tasks) task.executor = claimActor(claims.get(task.blockId));
	}

	// Plans and questions: each decision on its own, against the version just before it.
	const planVersions = changes
		.filter(
			(v) =>
				commitOf.get(v.commitId)?.kind === "plan" &&
				(v.changeFlags & (OUTLINE_CHANGE.TASK | OUTLINE_CHANGE.CREATE)) !== 0 &&
				v.taskJson?.plan !== undefined,
		)
		.slice(0, limits.plansPerSpace);
	// A question asked, answered or withdrawn (a block made as a question carries `CREATE` only).
	const askVersions = changes.filter(
		(v) =>
			(v.changeFlags & (OUTLINE_CHANGE.ASK | OUTLINE_CHANGE.CREATE)) !== 0 &&
			v.hasAsk &&
			!v.deleted,
	);
	if (askVersions.length > limits.asksPerSpace) summary.truncated = true;
	const asks = askVersions.slice(0, limits.asksPerSpace);
	const metaKeys = [
		...planVersions.map((v) => ({ blockId: v.blockId, seq: v.seq - 1 })),
		...asks.flatMap((v) => [
			{ blockId: v.blockId, seq: v.seq },
			{ blockId: v.blockId, seq: v.seq - 1 },
		]),
	].filter((k) => k.seq > 0);
	const metas = new Map<string, OutlineVersionMeta>();
	if (metaKeys.length > 0) {
		const wanted = new Set(metaKeys.map((k) => versionKey(k.blockId, k.seq)));
		const keyed = await store.listVersionMetasAt(metaKeys);
		// A meta answers each wanted seq it is valid at.
		for (const meta of keyed) {
			for (const k of metaKeys) {
				if (k.blockId !== meta.blockId) continue;
				if (meta.fromSeq <= k.seq && (meta.toSeq === null || meta.toSeq > k.seq)) {
					const key = versionKey(k.blockId, k.seq);
					if (wanted.has(key)) metas.set(key, meta);
				}
			}
		}
	}
	const decidedPlanCommits = new Set<string>();
	for (const v of planVersions) {
		const commit = commitOf.get(v.commitId) as OutlineCommitRow;
		const before = metas.get(versionKey(v.blockId, v.seq - 1))?.taskJson ?? null;
		const event = planEvent(before, v.taskJson);
		if (!event) continue;
		decidedPlanCommits.add(commit.id);
		const plan = v.taskJson?.plan;
		const item: OutlineDigestPlanStored = {
			space: space.id,
			commitId: commit.id,
			seq: commit.seq,
			at: commit.createdAt,
			event,
			blockId: v.blockId,
			pageId: v.pageId,
			round: plan?.round ?? 0,
			narratorId: plan?.by ?? commit.narratorId,
			approvedBy: plan?.approvedBy ? actorOf(plan.approvedBy.kind, plan.approvedBy.id) : null,
		};
		summary.plans.push(item);
		if (
			event === "approved_draft" &&
			isPlanReviewApproval(v.taskJson) &&
			commit.actorKind === "system" &&
			commit.actorId === OUTLINE_PLAN_REVIEW_ACTOR &&
			commit.responsibleUserId
		) {
			summary.delegated.push({
				kind: "plan_review_approval",
				person: commit.responsibleUserId,
				space: space.id,
				commitId: commit.id,
				seq: commit.seq,
				at: commit.createdAt,
				blockId: v.blockId,
				pageId: v.pageId,
				narratorId: plan?.by ?? commit.narratorId,
				round: plan?.round ?? 0,
			});
		}
	}
	for (const c of commits) {
		if (
			c.kind === "plan" &&
			c.actorKind === "system" &&
			c.actorId === OUTLINE_PLAN_REVIEW_ACTOR &&
			!decidedPlanCommits.has(c.id)
		)
			summary.reviewComments++;
	}
	const relayed = new Map<string, OutlineDigestDelegatedStored & { person: string }>();
	for (const v of asks) {
		const commit = commitOf.get(v.commitId) as OutlineCommitRow;
		const after = metas.get(versionKey(v.blockId, v.seq))?.askJson ?? null;
		const before = metas.get(versionKey(v.blockId, v.seq - 1))?.askJson ?? null;
		const event = questionEvent(before, after);
		if (!event || !after) continue;
		const answer = event === "answered" ? after.answer : undefined;
		summary.questions.push({
			space: space.id,
			commitId: commit.id,
			seq: commit.seq,
			at: commit.createdAt,
			event,
			blockId: v.blockId,
			pageId: v.pageId,
			to: after.to.kind === "human" ? after.to.id : null,
			by: answer ? actorOf(answer.by.kind, answer.by.id) : null,
			adopted: answer?.adopted === true,
			relayed: answer?.relayed !== undefined,
		});
		const person = event === "answered" ? relayedAnswerPerson(after) : null;
		if (person && commit.kind === "answer") {
			const found = relayed.get(commit.id);
			if (found) found.questions = (found.questions ?? 0) + 1;
			else
				relayed.set(commit.id, {
					kind: "relayed_answer",
					person,
					space: space.id,
					commitId: commit.id,
					seq: commit.seq,
					at: commit.createdAt,
					blockId: v.blockId,
					pageId: v.pageId,
					narratorId: after.answer?.relayed?.narratorId ?? commit.narratorId,
					questions: 1,
				});
		}
	}
	summary.delegated.push(...relayed.values());

	// Confirmations: an agent's on a locker's behalf, or a person's own.
	const confirms = commits.filter((c) => c.kind === "confirm");
	const pendingOf = new Map(
		confirms.length > 0
			? (await store.getPendingByDecisionCommits(confirms.map((c) => c.id))).map((p) => [
					p.decisionCommitId as string,
					p,
				])
			: [],
	);
	for (const c of commits) {
		const base = { space: space.id, commitId: c.id, seq: c.seq, at: c.createdAt };
		const written = versionsByCommit.get(c.id) ?? [];
		const blocks = written.length;
		if (c.kind === "confirm") {
			const pending = pendingOf.get(c.id);
			const person = pending ? delegateConfirmationPerson(pending) : null;
			if (pending && person) {
				summary.delegated.push({
					...base,
					kind: "confirmation",
					person,
					blockId: pending.rootBlockId,
					pageId: pending.pageId,
					narratorId: pending.decidedByJson?.id ?? null,
					pendingId: pending.id,
				});
			} else {
				const by = pending?.decidedByJson ?? { kind: c.actorKind, id: c.actorId };
				summary.other.push({ ...base, event: "confirm", actor: actorOf(by.kind, by.id), blocks });
			}
			continue;
		}
		const system = c.actorKind === "system" ? c.actorId : null;
		const event: OutlineDigestOtherStored["event"] | null =
			c.kind === "revert"
				? "revert"
				: c.kind === "import"
					? "import"
					: system === OUTLINE_DIGEST_DELEGATE_ACTOR
						? "delegation"
						: system === OUTLINE_DIGEST_REPORT_ACTOR
							? "report"
							: system !== null && !ROUTINE_SYSTEM_ACTORS.has(system)
								? "system"
								: null;
		if (!event) continue;
		// A delegation names the task it handed over (the version that set it in progress); a report
		// the task it was written under (the parent of the block it added).
		const task =
			event === "delegation"
				? (written.find((v) => (v.changeFlags & OUTLINE_CHANGE.TASK) !== 0) ?? null)
				: null;
		const made = new Set(
			written.filter((v) => (v.changeFlags & OUTLINE_CHANGE.CREATE) !== 0).map((v) => v.blockId),
		);
		const container =
			event === "report"
				? (written.find(
						(v) => made.has(v.blockId) && v.parentId !== null && !made.has(v.parentId),
					) ?? null)
				: null;
		summary.other.push({
			...base,
			event,
			actor: actorOf(c.actorKind, c.actorId),
			blocks,
			...(task ? { blockId: task.blockId, pageId: task.pageId } : {}),
			...(container ? { blockId: container.parentId, pageId: container.pageId } : {}),
		});
	}
	return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// One person's part of a space
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineDigestPerson {
	userId: string;
	username: string;
}

/** What one space's window gives one person. */
export interface OutlinePersonContribution {
	space: OutlineDigestSpaceStored;
	delegated: OutlineDigestDelegatedStored[];
	knowledge: OutlineDigestKnowledgeStored[];
	tasks: OutlineDigestTaskStored[];
	plans: OutlineDigestPlanStored[];
	questions: OutlineDigestQuestionStored[];
	other: OutlineDigestOtherStored[];
	/** Items past a section's cap in this space: counted, not listed. */
	more: Record<OutlineDigestSection, number>;
}

/**
 * The person's part of a space's window: everything in it but the decisions made in someone
 * else's name, tasks handed to someone else, and facts the person alone wrote (counted).
 */
export function selectForPerson(
	summary: OutlineSpaceSummary,
	person: OutlineDigestPerson,
	limits: OutlineDigestLimits = OUTLINE_DIGEST_LIMITS,
): OutlinePersonContribution {
	const own = `human:${person.userId}`;
	let ownEdits = 0;
	const pages = new Map<string, KnowledgeFact[]>();
	for (const fact of summary.knowledge) {
		if (fact.writers.length > 0 && fact.writers.every((w) => w === own)) {
			ownEdits++;
			continue;
		}
		const list = pages.get(fact.pageId);
		if (list) list.push(fact);
		else pages.set(fact.pageId, [fact]);
	}
	const knowledge: OutlineDigestKnowledgeStored[] = [];
	for (const [pageId, list] of pages) {
		list.sort((a, b) => a.seq - b.seq || (a.blockId < b.blockId ? -1 : 1));
		const ids = new Set(list.map((f) => f.blockId));
		const latest = list.reduce((a, b) => (b.seq > a.seq ? b : a));
		knowledge.push({
			space: summary.spaceId,
			commitId: latest.commitId,
			seq: latest.seq,
			at: latest.at,
			pageId,
			created: list.filter((f) => f.created).length,
			changed: list.filter((f) => !f.created).length,
			blocks: list
				.filter((f) => f.parentId === null || !ids.has(f.parentId))
				.slice(0, limits.blocksPerPage)
				.map((f) => ({ id: f.blockId, seq: f.seq, created: f.created })),
		});
	}
	const mine = (actor: OutlineDigestActor | null) =>
		actor?.kind === "human" && actor.id === person.userId;
	const tasks: OutlineDigestTaskStored[] = [];
	for (const { assignee, ...task } of summary.tasks) {
		if (task.event === "assigned") {
			if (assignee !== `human:${person.username}`) continue;
			tasks.push({ ...task, forYou: true });
		} else tasks.push({ ...task, forYou: mine(task.manager) });
	}
	const part: OutlinePersonContribution = {
		space: {
			id: summary.spaceId,
			kind: summary.kind,
			from: summary.from,
			to: summary.to,
			commits: summary.commits,
			truncated: summary.truncated,
			deletedFacts: summary.deletedFacts,
			ownEdits,
			tasksCreated: summary.tasksCreated,
			tasksStarted: summary.tasksStarted,
			leaseReturned: summary.leaseReturned,
			reviewComments: summary.reviewComments,
		},
		delegated: summary.delegated
			.filter((d) => d.person === person.userId)
			.map(({ person: _person, ...item }) => item),
		knowledge,
		tasks,
		plans: summary.plans,
		questions: summary.questions.map((q) => ({ ...q, toYou: q.to === person.userId })),
		other: summary.other,
		more: emptyMore(),
	};
	// Each section in the order the report shows it, cut to what one report can list.
	part.tasks.sort((a, b) => Number(b.forYou) - Number(a.forYou) || byTime(a, b));
	part.questions.sort((a, b) => Number(b.toYou) - Number(a.toYou) || byTime(a, b));
	const sections = part as unknown as Record<OutlineDigestSection, unknown[]>;
	for (const section of OUTLINE_DIGEST_SECTIONS) {
		const list = sections[section];
		if (list.length > limits.itemsPerSection) {
			part.more[section] += list.length - limits.itemsPerSection;
			sections[section] = list.slice(0, limits.itemsPerSection);
		}
	}
	return part;
}

/** Whether an item of a `done` task is what the report calls newly done for its reader. */
export function newlyDoneForReader(task: OutlineDigestTaskStored, readerId: string): boolean {
	return (
		task.event === "done" &&
		task.manager?.kind === "human" &&
		task.manager.id === readerId &&
		(task.by.kind === "agent" || task.executor?.kind === "agent")
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// One report
// ─────────────────────────────────────────────────────────────────────────────

function emptyMore(): Record<OutlineDigestSection, number> {
	return { delegated: 0, knowledge: 0, tasks: 0, plans: 0, questions: 0, other: 0 };
}

function spaceWeight(c: OutlinePersonContribution): number {
	return (
		OUTLINE_DIGEST_SECTIONS.reduce((n, s) => n + c.more[s], 0) +
		c.delegated.length +
		c.knowledge.length +
		c.tasks.length +
		c.plans.length +
		c.questions.length +
		c.other.length +
		c.space.deletedFacts +
		c.space.ownEdits +
		c.space.tasksCreated +
		c.space.tasksStarted +
		c.space.leaseReturned +
		c.space.reviewComments
	);
}

const byTime = <T extends { at: string; seq: number; space: string }>(a: T, b: T) =>
	a.at < b.at
		? -1
		: a.at > b.at
			? 1
			: a.space < b.space
				? -1
				: a.space > b.space
					? 1
					: a.seq - b.seq;

export interface AssembledDigest {
	items: OutlineDigestStored;
	counts: OutlineDigestCounts;
	itemCount: number;
	truncated: boolean;
}

/**
 * The person's parts as one report: the busiest spaces first (at most `spacesPerDigest`; items of
 * the others are dropped and the spaces counted), each section in time order (the person's own
 * tasks first) and cut to `itemsPerSection`, at most `itemsPerDigest` items and `itemsBytes` of
 * JSON (the largest section gives way first). Counts include what was cut.
 */
export function assembleDigest(
	parts: readonly OutlinePersonContribution[],
	limits: OutlineDigestLimits = OUTLINE_DIGEST_LIMITS,
): AssembledDigest {
	const active = parts.filter((p) => spaceWeight(p) > 0);
	active.sort((a, b) => spaceWeight(b) - spaceWeight(a) || (a.space.id < b.space.id ? -1 : 1));
	const shown = active.slice(0, limits.spacesPerDigest);
	const spaces = shown.map((p) => {
		const more: Partial<Record<OutlineDigestSection, number>> = {};
		for (const section of OUTLINE_DIGEST_SECTIONS)
			if (p.more[section] > 0) more[section] = p.more[section];
		return { ...p.space, ...(Object.keys(more).length > 0 ? { more } : {}) };
	});
	const spaceOf = new Map(spaces.map((s) => [s.id, s]));
	let truncated =
		spaces.some((s) => s.truncated || s.more !== undefined) || active.length > shown.length;
	const items: OutlineDigestStored = {
		v: 1,
		spaces,
		moreSpaces: active.length - shown.length,
		delegated: shown.flatMap((p) => p.delegated).sort(byTime),
		knowledge: shown.flatMap((p) => p.knowledge).sort(byTime),
		tasks: shown
			.flatMap((p) => p.tasks)
			.sort((a, b) => Number(b.forYou) - Number(a.forYou) || byTime(a, b)),
		plans: shown.flatMap((p) => p.plans).sort(byTime),
		questions: shown
			.flatMap((p) => p.questions)
			.sort((a, b) => Number(b.toYou) - Number(a.toYou) || byTime(a, b)),
		other: shown.flatMap((p) => p.other).sort(byTime),
		more: emptyMore(),
	};
	const sections = items as unknown as Record<OutlineDigestSection, Array<{ space: string }>>;
	// An item cut is counted against its own space, so a reader who can no longer read that space
	// is not told about it either.
	const cut = (section: OutlineDigestSection, item: { space: string } | undefined) => {
		if (!item) return;
		const space = spaceOf.get(item.space);
		if (space) {
			space.more = space.more ?? {};
			space.more[section] = (space.more[section] ?? 0) + 1;
		}
		truncated = true;
	};
	for (const section of OUTLINE_DIGEST_SECTIONS) {
		const list = sections[section];
		while (list.length > limits.itemsPerSection) cut(section, list.pop());
	}
	const listed = () => OUTLINE_DIGEST_SECTIONS.reduce((n, s) => n + sections[s].length, 0);
	const largest = () =>
		OUTLINE_DIGEST_SECTIONS.reduce((a, b) => (sections[b].length > sections[a].length ? b : a));
	const dropOne = () => {
		const section = largest();
		if (sections[section].length === 0) return false;
		cut(section, sections[section].pop());
		return true;
	};
	let fits = true;
	while (fits && listed() > limits.itemsPerDigest) fits = dropOne();
	fits = true;
	while (fits && Buffer.byteLength(JSON.stringify(items)) > limits.itemsBytes) fits = dropOne();
	for (const space of spaces)
		for (const section of OUTLINE_DIGEST_SECTIONS)
			items.more[section] += space.more?.[section] ?? 0;
	const counts: OutlineDigestCounts = {
		delegated: items.delegated.length + items.more.delegated,
		knowledge: items.knowledge.length + items.more.knowledge,
		tasks: items.tasks.length + items.more.tasks,
		plans: items.plans.length + items.more.plans,
		questions: items.questions.length + items.more.questions,
		other: items.other.length + items.more.other,
		spaces: active.length,
		ownEdits: shown.reduce((n, p) => n + p.space.ownEdits, 0),
	};
	const itemCount = OUTLINE_DIGEST_SECTIONS.reduce((n, s) => n + counts[s], 0);
	return { items, counts, itemCount, truncated };
}

/** The kinds of decision made in a person's name, as the undo names them. */
export const OUTLINE_DELEGATED_KINDS: readonly OutlineDelegatedKind[] = [
	"confirmation",
	"plan_review_approval",
	"relayed_answer",
];
