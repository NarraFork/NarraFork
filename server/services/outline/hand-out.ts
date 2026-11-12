/**
 * Handing a task out (outline P2 PR 10c-3; design v2 §E.2, owner decision Q2 A): a task of a
 * session's own space is given to the team as a COPY on the task page of the session's main
 * project, and the original stays with the session, waiting on that copy.
 *
 * WHEN
 * ----
 * A task of a session space is given to someone other than the session and its owner (a person,
 * `@human:name`; another session, `@agent:<id or handle>`), or to the team ("交给团队": the pool,
 * nobody named). Giving it to the session itself or to its owner keeps it where it is. Only the
 * session's owner (the board) or the session itself (its own `OutlineEdit`) hands its tasks out;
 * the board's "give to someone" and an agent's `@agent:` / `@human:` on such a task come here.
 *
 * WHAT, IN TWO COMMITS
 * --------------------
 *   1. The copy (one system commit in the project space, actor {@link OUTLINE_HAND_OUT_ACTOR}):
 *      the task and its subtree, breadth first, at most {@link OUTLINE_HAND_OUT_LIMITS.blocks}
 *      blocks with the provenance and {@link OUTLINE_HAND_OUT_LIMITS.bytes} of content, last on
 *      the project's task page (alias `tasks`, made when missing). The copy is to do, managed by
 *      the original session, assigned to whoever it was given to (none for the team, which also
 *      marks it `claimable`). Steps keep their checkbox (one in progress is to do: nobody claims
 *      a copy), their people as assignees and their prerequisites (one inside the copy points to
 *      its copy; one written as a bare reference keeps pointing into the session's space);
 *      notes are copied as text; questions as plain blocks; aliases, tags, locks and plans are
 *      not. The first block under the copy says where it came from: a link to the original,
 *      which a reader who may not read the session's space sees as a link without a title (as
 *      every link to what they may not read), plus how many blocks were left out.
 *   2. The original (one commit in the session space): it now depends on the copy (`depends::`),
 *      to do again if it was in progress (its claim released), with a note "handed to …: [[copy]]".
 *      It waits for its prerequisite, so continuation passes it by; when the copy is done or
 *      cancelled by a session, the original's session is told and woken (`team-events.ts`, "a
 *      prerequisite ended") to check the result and tick the original itself.
 *
 * Who writes them: a hand-out the session made is written for it (the commits carry its id), so
 * a session it assigns the copy to is told and woken (an agent's act). A hand-out a person made
 * on the board is theirs: the copy's commit carries no session (team events read such a commit
 * as the person's: it records, it never wakes, PR 5's rule), and the original's change is the
 * person's own commit, which the session is told of as of any change a person makes to its
 * tasks (`outline-task-edits.ts`).
 *
 * ONE COPY, WHATEVER IS RETRIED
 * -----------------------------
 * The copy's first block, its provenance, the note under the original and the failure note all
 * have ids derived from (task, the task's version when it was handed out): a retry finds the
 * copy and does not write a second one, and a step 2 that failed is written by the next attempt.
 * Hand-outs of one task run one at a time; a task that already depends on an open copy of its
 * own is not handed out again (the copy is answered). Two commits cannot be one: when step 2
 * still fails after {@link OUTLINE_HAND_OUT_LIMITS.attempts} attempts, a note under the copy
 * says the original was not updated, and the hand-out fails (`original_not_updated`).
 *
 * REFUSED (nothing written): not a task of a session space; finished; part of a plan not approved
 * yet; held by someone other than the session; handed out by someone other than the session or
 * its owner; the session has no main project (a directory outside any git repository); the
 * writer may not write the project's space; the person or session it is given to could not work
 * there.
 *
 * COST: the task's page structure (one read), the bodies of at most `blocks` blocks within the
 * byte budget, the task page's alias, the original's prerequisites in the project space by sid
 * (one read). Two commits.
 */
import { createHash } from "node:crypto";
import { AppError, ValidationError } from "@server/lib/errors";
import { getUserLanguage } from "@server/lib/i18n";
import { logger } from "@server/lib/logger";
import { type LinkTarget, parseAddress } from "@shared/outline";
import type { OutlineBoardHandOutRefusal } from "@shared/outline-task-board";
import { canWriteSpace, type OutlinePrincipal } from "./access";
import { readNarrator, readSessionWriteFacts, readUserByUsername } from "./access-reads";
import { canSessionWorkIn, resolveAgentAssignee, sessionAssignee } from "./assignee";
import { type DelegationLocale, delegationLocale } from "./delegation-text";
import {
	OutlineBusyError,
	OutlineConflictError,
	OutlineTaskClaimedError,
	OutlineWriteError,
} from "./errors";
import { OUTLINE_HAND_OUT_ACTOR, OUTLINE_TASKS_PAGE_ALIAS, type OutlineTaskJson } from "./model";
import { OUTLINE_TASKS_PAGE_TITLE, oneAtATime } from "./person-tasks";
import { loadBodiesWithin, readSubtree } from "./read";
import { outlineStore } from "./store";
import type { OutlineBlockRow, OutlineSpaceRow, OutlineStore } from "./store/port";
import { isFinishedTask, isOpenTask, isPlanningRoot } from "./task-json";
import { isClaimLive } from "./tasks";
import { projectSpaceOrPending, transferProjectOf } from "./transfer";
import { breadthFirst, type OutlineNode } from "./tree";
import { type OutlineOp, type OutlineTaskInput, writeOutline } from "./write";

export { OUTLINE_HAND_OUT_ACTOR };

export const OUTLINE_HAND_OUT_LIMITS = {
	/** Blocks of one copy, its provenance included (one commit, with the task page if made). */
	blocks: 199,
	/** UTF-8 bytes of the copied content (one transaction carries 128 KiB). */
	bytes: 120 * 1024,
	/** Attempts at step 2 before the failure is recorded. */
	attempts: 3,
	/** Tasks one agent write may hand out. */
	perWrite: 5,
	/** Prerequisites of the original looked at for an open copy of it. */
	dependsLooked: 50,
} as const;

/** Ids of a hand-out's blocks start with this, then a hash of (role, task, version). */
const HAND_OUT_ID_PREFIX = "hout";

type HandOutRole = "copy" | "from" | "note" | "failed";

/** The id of a hand-out's block of `role`: the same on every retry of the same hand-out. */
export function handOutBlockId(role: HandOutRole, taskBlockId: string, version: number): string {
	const hash = createHash("sha256")
		.update(`${role}\u0000${taskBlockId}\u0000${version}`)
		.digest("base64url");
	return `${HAND_OUT_ID_PREFIX}${hash.slice(0, 28)}`;
}

/** Whether a block is one a hand-out wrote ({@link handOutBlockId}). */
export function isHandOutBlockId(id: string): boolean {
	return id.length === HAND_OUT_ID_PREFIX.length + 28 && id.startsWith(HAND_OUT_ID_PREFIX);
}

/** Who a task is handed out to. */
export type OutlineHandOutTarget =
	/** The team: nobody named, in the pool. */
	| { kind: "team" }
	/** A person who can write the project's space. */
	| { kind: "person"; userId: string; username: string }
	/** A root session of the project that could work there. */
	| { kind: "session"; narratorId: string };

/** Who hands it out: the session's owner (the board), or the session itself (its agent). */
export type OutlineHandOutBy =
	| { kind: "person"; principal: OutlinePrincipal }
	| {
			kind: "session";
			narratorId: string;
			/** The person its turn runs for; null when none (it then writes nothing). */
			principal: OutlinePrincipal | null;
	  };

export type OutlineHandOutRefusal = OutlineBoardHandOutRefusal;

const REFUSAL_TEXT: Record<OutlineHandOutRefusal, string> = {
	not_session_task: "Only a task of a session's own space is handed out",
	not_owner: "Only the session's owner or the session itself hands its tasks out",
	no_project: "The session belongs to no project (its directory is in no git repository)",
	cannot_write_project: "You cannot write the project's space, where the copy would go",
	finished: "The task is finished already",
	planning: "The task is part of a plan that is not approved yet",
	held: "Someone other than the session is doing the task",
	changed: "The task changed since it was read",
	original_not_updated:
		"The copy was made, but the original task could not be set to wait for it; a note under the copy says so",
};

const REFUSAL_STATUS: Record<OutlineHandOutRefusal, number> = {
	not_session_task: 409,
	not_owner: 403,
	no_project: 409,
	cannot_write_project: 403,
	finished: 409,
	planning: 409,
	held: 409,
	changed: 409,
	original_not_updated: 500,
};

/** A hand-out refused (nothing written), or one whose second step failed. */
export class OutlineHandOutError extends AppError {
	constructor(
		readonly reason: OutlineHandOutRefusal,
		readonly copy: { id: string; address: string } | null = null,
	) {
		super(
			REFUSAL_TEXT[reason],
			REFUSAL_STATUS[reason],
			`OUTLINE_HAND_OUT_${reason.toUpperCase()}`,
			undefined,
			{ reason, ...(copy ? { copy } : {}) },
		);
		this.name = "OutlineHandOutError";
	}
}

export interface OutlineHandOutResult {
	/** The copy (an existing one when `already`). */
	copy: { id: string; sid: string; address: string; spaceId: string };
	/** The task depended on an open copy of itself already: nothing was written. */
	already: boolean;
	/** Blocks under the original left out of the copy (past the limits). */
	omitted: number;
	/** The original's version after the hand-out. */
	versionSeq: number;
}

/** What people read under the copy and the original (in the language of the session's owner). */
export const HAND_OUT_TEXT: Record<
	DelegationLocale,
	{
		from: (original: string, omitted: number) => string;
		note: (copy: string, to: string) => string;
		failed: (original: string) => string;
		team: string;
	}
> = {
	en: {
		from: (original, omitted) =>
			`Handed out from [[${original}]]${
				omitted > 0
					? `; ${omitted} more block${omitted === 1 ? "" : "s"} under it were not copied`
					: ""
			}`,
		note: (copy, to) => `Handed to ${to}: [[${copy}]] (this task waits for it)`,
		failed: (original) =>
			`The original task [[${original}]] could not be set to wait for this copy; please link them by hand`,
		team: "the team",
	},
	"zh-CN": {
		from: (original, omitted) =>
			`出处：[[${original}]]${omitted > 0 ? `；它下面还有 ${omitted} 块没有复制` : ""}`,
		note: (copy, to) =>
			`已交给${to.startsWith("@") ? ` ${to}` : to}：[[${copy}]]（这个任务等它完成）`,
		failed: (original) => `原任务 [[${original}]] 没能改成等这份副本，请手动处理`,
		team: "团队",
	},
};

// ─────────────────────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────────────────────

/** What a hand-out of a task of `space` would go to, checked (nothing is written). */
export interface OutlineHandOutPlace {
	/** The session whose space holds the task. */
	sessionId: string;
	ownerUserId: string | null;
	projectId: string;
	/** The project's space (not created yet when its `id` starts with `pending:`). */
	projectSpace: OutlineSpaceRow;
}

/**
 * Where tasks of session space `space` are handed out to, and whether `by` may: the session's
 * owner or the session itself, its main project, and the writer's write access to the project's
 * space. Throws {@link OutlineHandOutError}.
 */
export async function handOutPlace(
	space: OutlineSpaceRow,
	by: OutlineHandOutBy,
	options: { store?: OutlineStore } = {},
): Promise<OutlineHandOutPlace> {
	const store = options.store ?? outlineStore;
	if (space.kind !== "session" || !space.narratorId)
		throw new OutlineHandOutError("not_session_task");
	const sessionId = space.narratorId;
	const narrator = await readNarrator(sessionId);
	const ownerUserId = narrator?.ownerUserId ?? null;
	if (by.kind === "person") {
		if (ownerUserId === null || by.principal.userId !== ownerUserId)
			throw new OutlineHandOutError("not_owner");
	} else {
		const root = (await store.getNarratorRoots([by.narratorId])).get(by.narratorId)?.root;
		if ((root ?? by.narratorId) !== sessionId) throw new OutlineHandOutError("not_owner");
	}
	const projectId = await transferProjectOf(space);
	if (!projectId) throw new OutlineHandOutError("no_project");
	const projectSpace = await projectSpaceOrPending(projectId, store);
	if (!by.principal || !(await canWriteSpace(by.principal, projectSpace)))
		throw new OutlineHandOutError("cannot_write_project");
	return { sessionId, ownerUserId, projectId, projectSpace };
}

/**
 * Check the target against the project's space: a person must be able to write it (their own
 * grants: an admin's reach everywhere is not asked, so names do not tell admins apart), a session
 * must be a live root session that could work there. The message is the board's for an unknown
 * name.
 */
export async function checkHandOutTarget(
	target: OutlineHandOutTarget,
	place: OutlineHandOutPlace,
	options: { store?: OutlineStore } = {},
): Promise<void> {
	if (target.kind === "team") return;
	if (target.kind === "person") {
		if (!(await canWriteSpace({ userId: target.userId, isAdmin: false }, place.projectSpace)))
			throw new ValidationError(`No one named ${target.username} can work on this task`);
		return;
	}
	const session = await resolveAgentAssignee(sessionAssignee(target.narratorId), options);
	if (
		!session ||
		session.archived ||
		!(await canSessionWorkIn(session.narratorId, place.projectSpace))
	)
		throw new ValidationError("This session cannot work on this task");
}

/** The person `username` names, as a hand-out target; null when nobody has it. */
export async function handOutPersonTarget(
	username: string,
): Promise<Extract<OutlineHandOutTarget, { kind: "person" }> | null> {
	const user = await readUserByUsername(username);
	return user ? { kind: "person", userId: user.id, username: user.username } : null;
}

/** The assignee a copy given to `target` gets (none for the team). */
export function assigneeOfTarget(target: OutlineHandOutTarget): string | null {
	if (target.kind === "person") return `human:${target.username}`;
	if (target.kind === "session") return sessionAssignee(target.narratorId);
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The copy
// ─────────────────────────────────────────────────────────────────────────────

function utf8(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * The prerequisites a copied task gets: one that names a block that is copied names its copy;
 * one written bare (resolved in the space it was written in) is written with the session space's
 * key, so it still names what it named; any other is kept.
 */
function copiedDepends(
	depends: readonly LinkTarget[] | undefined,
	sessionKey: string,
	copied: { bySid: Map<string, string>; byAlias: Map<string, string> },
): LinkTarget[] | undefined {
	if (!depends?.length) return undefined;
	return depends.map((d) => {
		const target = d.target.trim();
		const address = parseAddress(target);
		const own =
			address?.space === sessionKey
				? (copied.bySid.get(address.sid) ?? copied.byAlias.get(address.sid))
				: !target.includes("/")
					? (copied.bySid.get(target) ?? copied.byAlias.get(target))
					: undefined;
		if (own) return { target: own, label: d.label };
		if (!target.includes("/")) return { target: `${sessionKey}/${target}`, label: d.label };
		return { target, label: d.label };
	});
}

/** The task a copied step gets (see the module header). */
function copiedStep(task: OutlineTaskJson, depends: LinkTarget[] | undefined): OutlineTaskInput {
	return {
		status: task.status === "doing" ? "todo" : task.status,
		assignee: task.assignee?.startsWith("human:") ? task.assignee : null,
		...(depends ? { depends } : {}),
		...(task.due ? { due: task.due } : {}),
		manager: null,
	};
}

interface CopyPlan {
	ops: OutlineOp[];
	sid: string;
	omitted: number;
}

/**
 * The ops of step 1: the task page when missing, the copy and its provenance. `newSid` draws a
 * sid for each copied block (so prerequisites between copied steps can name their copies).
 */
async function planCopy(args: {
	store: OutlineStore;
	original: OutlineBlockRow;
	sessionSpace: OutlineSpaceRow;
	place: OutlineHandOutPlace & { projectSpace: OutlineSpaceRow };
	version: number;
	target: OutlineHandOutTarget;
	locale: DelegationLocale;
	newSid: () => string;
}): Promise<CopyPlan> {
	const { store, original, sessionSpace, place, version } = args;
	const subtree = await readSubtree(original.id, { store });
	if (!subtree) throw new OutlineHandOutError("changed");
	// Breadth first, the hand-outs' own notes left out (with what is under them).
	const order = breadthFirst(subtree.root, "all", Number.MAX_SAFE_INTEGER).filter(
		(node) => node === subtree.root || !isHandOutBlockId(node.id),
	);
	const reachable = new Set<string>([subtree.root.id]);
	const candidates = order.filter((node) => {
		if (node === subtree.root) return true;
		if (!node.parentId || !reachable.has(node.parentId)) return false;
		reachable.add(node.id);
		return true;
	});
	const room = OUTLINE_HAND_OUT_LIMITS.blocks - 1;
	const window = candidates.slice(0, room);
	await loadBodiesWithin(subtree.state, window, OUTLINE_HAND_OUT_LIMITS.bytes, { store });
	const taken: OutlineNode[] = [];
	const takenIds = new Set<string>();
	let bytes = 0;
	for (const node of window) {
		if (node.content === null) break;
		if (node !== subtree.root && !takenIds.has(node.parentId as string)) continue;
		const size = utf8(node.content);
		if (bytes + size > OUTLINE_HAND_OUT_LIMITS.bytes) break;
		bytes += size;
		taken.push(node);
		takenIds.add(node.id);
	}
	if (taken.length === 0) throw new OutlineHandOutError("changed");
	const omitted = candidates.length - taken.length;

	const sids = new Map(taken.map((node) => [node.id, args.newSid()]));
	const projectKey = place.projectSpace.key;
	const copied = {
		bySid: new Map(taken.map((node) => [node.sid, `${projectKey}/${sids.get(node.id)}`])),
		byAlias: new Map(
			taken.flatMap((node) =>
				node.alias ? [[node.alias, `${projectKey}/${sids.get(node.id)}`] as const] : [],
			),
		),
	};
	const ops: OutlineOp[] = [];
	const [page] = await store.findAliasOwners(place.projectSpace.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (!page) {
		ops.push({
			op: "insert",
			tempId: "page",
			parent: null,
			content: OUTLINE_TASKS_PAGE_TITLE[args.locale],
			alias: OUTLINE_TASKS_PAGE_ALIAS,
		});
	}
	const root = subtree.root;
	const rootTask = root.task as OutlineTaskJson;
	const rootDepends = copiedDepends(rootTask.depends, sessionSpace.key, copied);
	const assignee = assigneeOfTarget(args.target);
	ops.push({
		op: "insert",
		tempId: `c:${root.id}`,
		id: handOutBlockId("copy", original.id, version),
		sid: sids.get(root.id) as string,
		parent: page ? { id: page.id } : { tempId: "page" },
		position: { last: true },
		content: root.content as string,
		task: {
			status: "todo",
			assignee,
			...(rootDepends ? { depends: rootDepends } : {}),
			...(rootTask.due ? { due: rootTask.due } : {}),
			manager: { kind: "agent", id: place.sessionId },
			...(rootTask.humanCreated ? { humanCreated: true } : {}),
			...(args.target.kind === "team" ? { claimable: true } : {}),
		},
	});
	ops.push({
		op: "insert",
		id: handOutBlockId("from", original.id, version),
		parent: { tempId: `c:${root.id}` },
		position: { first: true },
		content: HAND_OUT_TEXT[args.locale].from(`${sessionSpace.key}/${original.sid}`, omitted),
	});
	for (const node of taken) {
		if (node === root) continue;
		ops.push({
			op: "insert",
			tempId: `c:${node.id}`,
			sid: sids.get(node.id) as string,
			parent: { tempId: `c:${node.parentId}` },
			position: { last: true },
			content: node.content as string,
			task: node.task
				? copiedStep(node.task, copiedDepends(node.task.depends, sessionSpace.key, copied))
				: null,
		});
	}
	return { ops, sid: sids.get(root.id) as string, omitted };
}

// ─────────────────────────────────────────────────────────────────────────────
// The hand-out
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An open copy of the task this task depends on already (a hand-out not finished yet): its
 * prerequisites in the project's space, by sid, whose id a hand-out derived.
 */
async function openCopyOf(
	store: OutlineStore,
	task: OutlineTaskJson,
	projectSpace: OutlineSpaceRow,
): Promise<{ id: string; sid: string } | null> {
	if (projectSpace.id.startsWith("pending:")) return null;
	const sids = (task.depends ?? []).slice(0, OUTLINE_HAND_OUT_LIMITS.dependsLooked).flatMap((d) => {
		const address = parseAddress(d.target);
		return address && address.space === projectSpace.key ? [address.sid] : [];
	});
	if (sids.length === 0) return null;
	const metas = await store.getBlockMetas(projectSpace.id, { sids });
	const open = metas.find((m) => !m.deleted && isHandOutBlockId(m.id) && isOpenTask(m.taskJson));
	return open ? { id: open.id, sid: open.sid } : null;
}

function refusedWrite(error: unknown): boolean {
	return (
		error instanceof OutlineConflictError ||
		error instanceof OutlineTaskClaimedError ||
		error instanceof OutlineWriteError ||
		error instanceof OutlineBusyError
	);
}

/**
 * Hand task `taskId` out (the module header). `baseVersionSeq`: the version the board read (a
 * change since is `changed`); an agent's write passes none. Throws {@link OutlineHandOutError},
 * or a `ValidationError` for a target that could not work in the project.
 */
export async function handOutTask(args: {
	taskId: string;
	by: OutlineHandOutBy;
	target: OutlineHandOutTarget;
	baseVersionSeq?: number;
	store?: OutlineStore;
	now?: () => Date;
	/** Tests: what step 2's write does (the real write path by default). */
	writeOriginal?: typeof writeOutline;
}): Promise<OutlineHandOutResult> {
	return await oneAtATime(`hand-out:${args.taskId}`, () => handOutOne(args));
}

async function handOutOne(args: Parameters<typeof handOutTask>[0]): Promise<OutlineHandOutResult> {
	const store = args.store ?? outlineStore;
	const writeOptions = { store, ...(args.now ? { now: args.now } : {}) };
	const original = await store.getBlock(args.taskId);
	const space = original ? await store.getSpace(original.spaceId) : null;
	if (!original || original.deleted || !original.taskJson || !space)
		throw new OutlineHandOutError("changed");
	const place = await handOutPlace(space, args.by, { store });
	const task = original.taskJson;
	if (args.baseVersionSeq !== undefined && args.baseVersionSeq !== original.versionSeq)
		throw new OutlineHandOutError("changed");
	if (isFinishedTask(task)) throw new OutlineHandOutError("finished");
	await checkHandOutTarget(args.target, place, { store });

	// Already handed out and the copy still open: the copy is the answer.
	const existingCopy = await openCopyOf(store, task, place.projectSpace);
	if (existingCopy) {
		return {
			copy: {
				id: existingCopy.id,
				sid: existingCopy.sid,
				address: `${place.projectSpace.key}/${existingCopy.sid}`,
				spaceId: place.projectSpace.id,
			},
			already: true,
			omitted: 0,
			versionSeq: original.versionSeq,
		};
	}

	const nowIso = (args.now?.() ?? new Date()).toISOString();
	const [claim] = await store.getTaskClaims([original.id]);
	if (claim?.holderUserId || (claim?.holderNarratorId && isClaimLive(claim, nowIso))) {
		const holder = claim.holderNarratorId;
		const root = holder
			? ((await store.getNarratorRoots([holder])).get(holder)?.root ?? holder)
			: null;
		if (claim.holderUserId !== null || root !== place.sessionId)
			throw new OutlineHandOutError("held");
	}
	const locale = delegationLocale(
		place.ownerUserId ? await getUserLanguage(place.ownerUserId).catch(() => "en") : "en",
	);
	const version = original.versionSeq;
	const copyId = handOutBlockId("copy", original.id, version);

	// ── 1. The copy (found when an earlier attempt wrote it). ──
	let copy = await store.getBlock(copyId);
	let omitted = 0;
	if (!copy || copy.deleted) {
		const subtree = await readSubtree(original.id, { store });
		if (!subtree) throw new OutlineHandOutError("changed");
		if ([subtree.root, ...subtree.path].some((node) => isPlanningRoot(node.task)))
			throw new OutlineHandOutError("planning");
		const projectSpace = place.projectSpace.id.startsWith("pending:")
			? await store.ensureSpace({ kind: "project", projectId: place.projectId }, nowIso)
			: place.projectSpace;
		const { newOutlineSid } = await import("./keys");
		const plan = await planCopy({
			store,
			original,
			sessionSpace: space,
			place: { ...place, projectSpace },
			version,
			target: args.target,
			locale,
			newSid: newOutlineSid,
		});
		omitted = plan.omitted;
		place.projectSpace = projectSpace;
		const responsibleUserId =
			args.by.kind === "person" ? args.by.principal.userId : (args.by.principal?.userId ?? null);
		await writeOutline(
			{
				spaceId: projectSpace.id,
				ops: plan.ops,
				actor: { kind: "system", id: OUTLINE_HAND_OUT_ACTOR },
				responsibleUserId,
				// A session's hand-out is written for it; a person's carries no session (its team
				// events are the person's: they record and never wake).
				...(args.by.kind === "session" ? { narratorId: args.by.narratorId } : {}),
				summary: `handed out ${space.key}/${original.sid} as ${projectSpace.key}/${plan.sid}`,
			},
			writeOptions,
		);
		copy = await store.getBlock(copyId);
		if (!copy) throw new OutlineHandOutError("changed");
	}
	const copyAddress = `${place.projectSpace.key}/${copy.sid}`;
	const result = (versionSeq: number): OutlineHandOutResult => ({
		copy: {
			id: copy.id,
			sid: copy.sid,
			address: copyAddress,
			spaceId: place.projectSpace.id,
		},
		already: false,
		omitted,
		versionSeq,
	});

	// ── 2. The original waits on the copy. ──
	const noteId = handOutBlockId("note", original.id, version);
	const to = targetWords(args.target, locale);
	const write = args.writeOriginal ?? writeOutline;
	let lastError: unknown = null;
	for (let attempt = 0; attempt < OUTLINE_HAND_OUT_LIMITS.attempts; attempt++) {
		const now = await store.getBlock(original.id);
		if (!now || now.deleted || !now.taskJson) break;
		const depends = now.taskJson.depends ?? [];
		const waits = depends.some((d) => d.target.trim() === copyAddress);
		const noted = (await store.getBlock(noteId))?.deleted === false;
		if (waits && noted) return result(now.versionSeq);
		const ops: OutlineOp[] = [];
		const back = now.taskJson.status === "doing";
		if (!waits || back) {
			ops.push({
				op: "setTask",
				block: { id: now.id },
				task: {
					...(waits ? {} : { depends: [...depends, { target: copyAddress, label: null }] }),
					...(back ? { status: "todo" as const } : {}),
				},
				baseVersionSeq: now.versionSeq,
			});
		}
		if (!noted) {
			ops.push({
				op: "insert",
				id: noteId,
				parent: { id: now.id },
				position: { last: true },
				content: HAND_OUT_TEXT[locale].note(copyAddress, to),
			});
		}
		try {
			const written = await write(
				{
					spaceId: space.id,
					ops,
					...(args.by.kind === "person"
						? {
								actor: { kind: "human" as const, id: args.by.principal.userId },
								responsibleUserId: args.by.principal.userId,
							}
						: {
								actor: { kind: "system" as const, id: OUTLINE_HAND_OUT_ACTOR },
								responsibleUserId: args.by.principal?.userId ?? null,
								narratorId: args.by.narratorId,
							}),
					summary: `handed ${space.key}/${original.sid} out as ${copyAddress}`,
				},
				writeOptions,
			);
			return result(written.commit?.seq ?? now.versionSeq);
		} catch (error) {
			lastError = error;
			if (!refusedWrite(error)) break;
		}
	}
	logger.warn("A hand-out could not set the original task to wait for its copy", {
		taskId: original.id,
		copyId: copy.id,
		error: String(lastError),
	});
	await writeOutline(
		{
			spaceId: place.projectSpace.id,
			ops: [
				{
					op: "insert",
					id: handOutBlockId("failed", original.id, version),
					parent: { id: copy.id },
					position: { last: true },
					content: HAND_OUT_TEXT[locale].failed(`${space.key}/${original.sid}`),
				},
			],
			actor: { kind: "system", id: OUTLINE_HAND_OUT_ACTOR },
			responsibleUserId: place.ownerUserId,
			summary: `the original of ${copyAddress} was not updated`,
		},
		writeOptions,
	).catch((error: unknown) =>
		logger.warn("Could not record a hand-out's failure under its copy", {
			copyId: copy.id,
			error: String(error),
		}),
	);
	throw new OutlineHandOutError("original_not_updated", { id: copy.id, address: copyAddress });
}

/** How the note under the original names who it went to: `@human:name`, `@agent:<id>`, the team. */
function targetWords(target: OutlineHandOutTarget, locale: DelegationLocale): string {
	if (target.kind === "team") return HAND_OUT_TEXT[locale].team;
	return `@${assigneeOfTarget(target)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// An agent's write (`OutlineEdit`)
// ─────────────────────────────────────────────────────────────────────────────

/** A task an agent's write hands out once the write is committed. */
export interface AgentHandOut {
	/** The operation that named the assignee (its result names the task). */
	opIndex: number;
	target: OutlineHandOutTarget;
}

/**
 * Normalise an agent's write to its own session space (design §E.2): an `@agent:` or `@human:`
 * assignee the write gives a task, naming someone other than the session and its owner, is taken
 * out of the write and becomes a hand-out after it (`handOutTask`). A name nobody has stays a
 * label, as it always was. The checks that need no task (the project, the writer's access, the
 * target) are made here, so a hand-out that could not happen refuses the write: `refused` holds
 * why. `ops` is changed in place.
 */
export async function planAgentHandOuts(args: {
	space: OutlineSpaceRow;
	by: Extract<OutlineHandOutBy, { kind: "session" }>;
	ops: OutlineOp[];
	/** A task's assignee before the write (an existing block), undefined for a new one. */
	assigneeBefore: (blockId: string) => string | null | undefined;
	store?: OutlineStore;
}): Promise<{ handOuts: AgentHandOut[] } | { refused: string[] }> {
	const { space, ops } = args;
	if (space.kind !== "session" || !space.narratorId) return { handOuts: [] };
	const sessionId = space.narratorId;
	const { assigneeNamesSession, assigneeNamesUser } = await import("./assignee");
	const owner = (await readNarrator(sessionId))?.ownerUserId ?? null;
	const found: AgentHandOut[] = [];
	for (const [opIndex, op] of ops.entries()) {
		if (op.op !== "insert" && op.op !== "setTask") continue;
		const assignee = op.task?.assignee;
		if (typeof assignee !== "string") continue;
		if (op.op === "setTask" && "id" in op.block && args.assigneeBefore(op.block.id) === assignee)
			continue;
		if (await assigneeNamesSession(assignee, sessionId, args.store)) continue;
		if (owner && (await assigneeNamesUser(assignee, owner))) continue;
		let target: OutlineHandOutTarget | null = null;
		if (assignee.startsWith("agent:")) {
			const session = await resolveAgentAssignee(assignee, { store: args.store });
			if (session) target = { kind: "session", narratorId: session.narratorId };
		} else if (assignee.startsWith("human:")) {
			target = await handOutPersonTarget(assignee.slice("human:".length));
		}
		if (!target) continue;
		found.push({ opIndex, target });
	}
	if (found.length === 0) return { handOuts: [] };
	if (found.length > OUTLINE_HAND_OUT_LIMITS.perWrite)
		return {
			refused: [
				`one write hands out at most ${OUTLINE_HAND_OUT_LIMITS.perWrite} tasks (this one would hand out ${found.length})`,
			],
		};
	let place: OutlineHandOutPlace;
	try {
		place = await handOutPlace(space, args.by, { store: args.store });
	} catch (error) {
		if (error instanceof OutlineHandOutError) return { refused: [handOutRefusalText(error)] };
		throw error;
	}
	const refused: string[] = [];
	for (const { target } of found) {
		try {
			await checkHandOutTarget(target, place, { store: args.store });
		} catch (error) {
			if (error instanceof ValidationError)
				refused.push(`${error.message} (a copy would go to the project's task page)`);
			else throw error;
		}
	}
	if (refused.length > 0) return { refused };
	// Written after the commit, by the hand-out: not by this write.
	for (const { opIndex } of found) {
		const op = ops[opIndex];
		if ((op?.op === "insert" || op?.op === "setTask") && op.task) {
			const { assignee: _handedOut, ...rest } = op.task;
			op.task = rest as typeof op.task;
		}
	}
	return { handOuts: found };
}

/** Why a hand-out was refused, as an agent is told. */
export function handOutRefusalText(error: OutlineHandOutError): string {
	return `giving a task of this session's own space to someone else hands it out as a copy to the project's task page, which is refused here: ${REFUSAL_TEXT[error.reason]}`;
}

/**
 * Of the given spaces, the session spaces whose tasks `principal` may hand out (the board's
 * 「交给团队」): the checks of {@link handOutPlace} for many at once. The sessions' owners and
 * projects in one read (`readSessionWriteFacts`), then the person's access once per project.
 */
export async function handOutSessionSpaces(
	principal: OutlinePrincipal,
	spaces: readonly OutlineSpaceRow[],
): Promise<Set<string>> {
	const out = new Set<string>();
	const sessions = spaces.filter((space) => space.kind === "session" && space.narratorId);
	if (sessions.length === 0) return out;
	const facts = await readSessionWriteFacts(sessions.map((space) => space.narratorId as string));
	const writes = new Map<string, Promise<boolean>>();
	for (const space of sessions) {
		const fact = facts.get(space.narratorId as string);
		if (!fact || fact.type === "subagent" || fact.ownerUserId !== principal.userId) continue;
		const projectId = fact.gateProjectId;
		if (!projectId) continue;
		let verdict = writes.get(projectId);
		if (!verdict) {
			// Access to a project's space depends on its kind and project only.
			verdict = canWriteSpace(principal, {
				id: `pending:project:${projectId}`,
				key: "",
				kind: "project",
				projectId,
				narratorId: null,
				ownerUserId: null,
				nextSeq: 1,
				createdAt: "",
				inProcessEpoch: 0,
			});
			writes.set(projectId, verdict);
		}
		if (await verdict) out.add(space.id);
	}
	return out;
}
