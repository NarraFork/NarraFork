/**
 * Plans in the outline (outline P2 PR 8, D48; design §4.3, §2.2): a plan is a task tree whose
 * root carries the plan's state (`task_json.plan`). This module is the outline half of plan mode:
 * where the root is, what a submission shows, and what each decision writes. The session half
 * (the tools, the approval, the continuation) is `services/outline-plan-mode.ts`.
 *
 * THE ROOT
 * --------
 * `EnterPlanMode` makes the root ({@link ensurePlanRoot}): a to-do in the session space, last on
 * the task page (alias `tasks`, D37, D48 Q4) or under a task the agent names (`under`, a goal it
 * plans for), managed by the session, with `plan = { state: planning, by: session, round: 0,
 * baseSeq: 0 }`. A session plans one plan at a time: entering plan mode again resumes the plan it
 * has not had approved (D48 Q3). An existing task tree can be planned again (`root`), unless a
 * person locked it.
 *
 * While `planning`, the root and every task under it are left out of continuation and the
 * "current tasks" view (`tasks.ts`): an unapproved plan is never executed.
 *
 * SUBMITTING
 * ----------
 * {@link readPlanSubmission} reads the plan behind the live-session barrier (live edits are
 * committed first): its rendering (the snapshot the approval shows) and its diff against the
 * version it is compared with (`plan.baseSeq`, `plan-diff.ts`). Nothing is written.
 *
 * DECIDING ({@link decideOutlinePlan}): one `plan` commit, behind the barrier.
 *
 *   | decision | the root                                                          | also       |
 *   |----------|-------------------------------------------------------------------|------------|
 *   | return   | `plan.round` + 1, `baseSeq` = this commit (still `planning`)      | the person's feedback as a block under the root |
 *   | draft    | `plan.state = approved`, `round` + 1, `approvedBy`                 | —          |
 *   | lock     | as draft, and locked by the person with an optional delegate     | —          |
 *
 * Only people lock (D42): the system approving on a person's behalf (a plan review, an approval
 * that did not come through the card) approves as a draft. A person's decision names the version
 * of the plan they looked at (`seenSeq`): a commit since then by anyone else that touched the plan
 * refuses it (`OUTLINE_PLAN_CHANGED`, 409) and they look again. Their own edits do not.
 *
 * A cancelled plan mode leaves the plan `planning`; a root nothing was written under or into is
 * deleted ({@link discardEmptyPlanRoot}, D48 Q3).
 *
 * Every read is bounded: the session space's open tasks (one indexed read), the plan's page
 * structure (as `OutlineRead`), the commits since the seen version (at most
 * {@link OUTLINE_PLAN_LIMITS.commitScan}).
 */
import { AppError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import {
	getOutlinePlanReturnedNote,
	getOutlinePlanSubmitProblem,
	type Locale,
	type OutlinePlanSubmitProblem,
} from "@server/lib/prompt-i18n";
import { blockTitle, isShortId, parseAddress } from "@shared/outline";
import type { OutlinePlanDiffCounts, OutlinePlanSubmission } from "@shared/outline-api";
import { withOutlineLiveBarrier } from "./live-barrier";
import {
	OUTLINE_LIMITS,
	OUTLINE_TASKS_PAGE_ALIAS,
	type OutlineTaskActorRef,
	type OutlineTaskJson,
} from "./model";
import { OUTLINE_TASKS_PAGE_TITLE } from "./person-tasks";
import { OUTLINE_PLAN_LIMITS, readPlanDiff } from "./plan-diff";
import { readOutline, readSubtree } from "./read";
import { outlineStore } from "./store";
import type { OutlineBlockRow, OutlineSpaceRow, OutlineStore } from "./store/port";
import { isOpenTask, isPlanningRoot } from "./task-json";
import type { OutlineNode } from "./tree";
import { type OutlineWriteResult, writeOutline } from "./write";

export { OUTLINE_PLAN_LIMITS };

/** The system actor of plan mode's commits (a root made or re-planned, an approval for a person). */
export const OUTLINE_PLAN_ACTOR = "outline-plan";

export type OutlinePlanErrorCode =
	/** No plan root, or not this session's plan being planned. */
	| "OUTLINE_PLAN_NOT_FOUND"
	/** The task named cannot be planned (finished, not a task, not in the session space). */
	| "OUTLINE_PLAN_INVALID"
	/** A person locked the tree: it is unlocked first. */
	| "OUTLINE_PLAN_LOCKED"
	/** The plan is not waiting for a decision (approved already). */
	| "OUTLINE_PLAN_DECIDED"
	/** Someone else changed the plan since the version the person looked at. */
	| "OUTLINE_PLAN_CHANGED"
	/** The person may not make this decision (lock without writing the space, a delegate). */
	| "OUTLINE_PLAN_FORBIDDEN"
	/** The submission is no longer waiting (cancelled or decided meanwhile): nothing was kept. */
	| "OUTLINE_PLAN_NOT_WAITING";

export class OutlinePlanError extends AppError {
	constructor(
		message: string,
		readonly planCode: OutlinePlanErrorCode,
	) {
		super(
			message,
			planCode === "OUTLINE_PLAN_NOT_FOUND"
				? 404
				: planCode === "OUTLINE_PLAN_INVALID"
					? 400
					: planCode === "OUTLINE_PLAN_FORBIDDEN"
						? 403
						: 409,
			planCode,
		);
		this.name = "OutlinePlanError";
	}
}

/** A plan's root as plan mode names it. */
export interface OutlinePlanRoot {
	blockId: string;
	spaceId: string;
	pageId: string;
	sid: string;
	/** `key/sid`. */
	address: string;
	title: string;
	task: OutlineTaskJson;
	versionSeq: number;
}

/** The plan field of a task, when it is a plan being planned by `session`. */
function planningBy(task: OutlineTaskJson | null, session: string): boolean {
	return task?.plan?.state === "planning" && task.plan.by === session;
}

async function rootOf(
	store: OutlineStore,
	space: OutlineSpaceRow,
	block: Pick<OutlineBlockRow, "id" | "sid" | "pageId" | "taskJson" | "versionSeq">,
	content?: string,
): Promise<OutlinePlanRoot> {
	let title = content !== undefined ? blockTitle(content) : "";
	if (content === undefined) {
		const heads = await store.getContentHeads([block.id], OUTLINE_PLAN_LIMITS.titleChars);
		title = blockTitle(heads.get(block.id) ?? "");
	}
	return {
		blockId: block.id,
		spaceId: space.id,
		pageId: block.pageId,
		sid: block.sid,
		address: `${space.key}/${block.sid}`,
		title: title.slice(0, OUTLINE_PLAN_LIMITS.titleChars) || block.sid,
		task: block.taskJson as OutlineTaskJson,
		versionSeq: block.versionSeq,
	};
}

/**
 * The root each session was last found planning, by session (review round 1 S4): the plan-mode
 * prompt asks before every request, so a hit costs one primary-key read (the root, checked to be
 * still that session's plan being planned) instead of the space's open tasks. At most
 * {@link PLANNING_ROOT_CACHE} sessions, the oldest dropped first.
 */
const planningRoots = hotSafe("narrafork.outlinePlanningRoots", () => new Map<string, string>());
const PLANNING_ROOT_CACHE = 2048;

function rememberPlanningRoot(session: string, blockId: string | null): void {
	planningRoots.delete(session);
	if (blockId === null) return;
	planningRoots.set(session, blockId);
	while (planningRoots.size > PLANNING_ROOT_CACHE) {
		const oldest = planningRoots.keys().next().value;
		if (oldest === undefined) break;
		planningRoots.delete(oldest);
	}
}

/**
 * The plan `session` is planning: the to-do or in-progress task of its session space whose plan
 * is `planning` and its own, the latest changed when there are several. The root found last is
 * checked first (one primary-key read); otherwise one indexed read of the space's open tasks.
 */
export async function findPlanningRoot(
	session: string,
	options: { store?: OutlineStore } = {},
): Promise<OutlinePlanRoot | null> {
	const store = options.store ?? outlineStore;
	const cached = planningRoots.get(session);
	if (cached) {
		const block = await store.getBlock(cached);
		if (
			block &&
			!block.deleted &&
			isOpenTask(block.taskJson) &&
			planningBy(block.taskJson, session)
		) {
			const space = await store.getSpace(block.spaceId);
			if (space) return await rootOf(store, space, block, block.content);
		}
	}
	const space = await store.findSpace({ kind: "session", narratorId: session });
	if (!space) {
		rememberPlanningRoot(session, null);
		return null;
	}
	const open = await store.listOpenTasks(space.id, 500);
	let best: (typeof open)[number] | null = null;
	for (const block of open) {
		if (block.deleted || !planningBy(block.taskJson, session)) continue;
		if (!best || block.versionSeq > best.versionSeq) best = block;
	}
	rememberPlanningRoot(session, best?.id ?? null);
	return best ? await rootOf(store, space, best) : null;
}

/** A task of the session space named by its address (`key/sid`) or short id. */
async function taskByAddress(
	store: OutlineStore,
	space: OutlineSpaceRow,
	ref: string,
): Promise<OutlineBlockRow | null> {
	const trimmed =
		ref
			.trim()
			.replace(/^\[\[|\]\]$/g, "")
			.split("|")[0]
			?.trim() ?? "";
	const address = parseAddress(trimmed);
	const sid = address ? (address.space === space.key ? address.sid : null) : trimmed;
	if (!sid || !isShortId(sid)) return null;
	const block = await store.getBlockBySid(space.id, sid);
	return block && !block.deleted ? block : null;
}

/** Plan roots of one session are made one at a time (find-or-create must not interleave). */
const ensuring = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const before = ensuring.get(key) ?? Promise.resolve();
	const run = before.catch(() => {}).then(fn);
	const settled = run.catch(() => {});
	ensuring.set(key, settled);
	try {
		return await run;
	} finally {
		if (ensuring.get(key) === settled) ensuring.delete(key);
	}
}

export interface EnsuredPlanRoot {
	root: OutlinePlanRoot;
	/** `created`: a new root; `resumed`: the session's unapproved plan; `replanning`: `root`. */
	how: "created" | "resumed" | "replanning";
}

/**
 * The root `session` plans under (EnterPlanMode, the plan-mode switch): its plan being planned,
 * if it has one; else the task `root` names, planned again; else a new to-do under `under` (a
 * task of the session space) or last on the task page. The caller has checked `session` is an
 * outline root session.
 */
export async function ensurePlanRoot(args: {
	session: string;
	/** The person the turn runs for: the commit's responsible person. */
	userId: string | null;
	title?: string | null;
	under?: string | null;
	root?: string | null;
	locale: Locale;
	toolCallId?: string | null;
	messageId?: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<EnsuredPlanRoot> {
	const store = args.store ?? outlineStore;
	return await oneAtATime(args.session, async () => {
		const existing = await findPlanningRoot(args.session, { store });
		if (existing) return { root: existing, how: "resumed" as const };
		const at = (args.now?.() ?? new Date()).toISOString();
		const space = await store.ensureSpace({ kind: "session", narratorId: args.session }, at);
		const provenance = {
			actor: { kind: "system" as const, id: OUTLINE_PLAN_ACTOR },
			responsibleUserId: args.userId,
			narratorId: args.session,
			...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
			...(args.messageId ? { messageId: args.messageId } : {}),
		};
		const options = { store, kind: "plan" as const, ...(args.now ? { now: args.now } : {}) };

		if (args.root?.trim()) {
			const block = await taskByAddress(store, space, args.root);
			if (!block?.taskJson)
				throw new OutlinePlanError(
					`${args.root} is not a task of this session's space`,
					"OUTLINE_PLAN_INVALID",
				);
			if (block.taskJson.status === "done" || block.taskJson.status === "cancelled")
				throw new OutlinePlanError(
					`${space.key}/${block.sid} is finished; plan a new one instead`,
					"OUTLINE_PLAN_INVALID",
				);
			if (block.taskJson.lock?.by.kind === "human")
				throw new OutlinePlanError(
					`${space.key}/${block.sid} is locked by a person: ask them to unlock it, or plan under it (under: "${space.key}/${block.sid}")`,
					"OUTLINE_PLAN_LOCKED",
				);
			const result = await writeOutline(
				{
					spaceId: space.id,
					ops: [
						{
							op: "setTask",
							block: { id: block.id },
							task: {
								plan: {
									state: "planning",
									by: args.session,
									round: block.taskJson.plan?.round ?? 0,
								},
							},
							baseVersionSeq: block.versionSeq,
						},
					],
					...provenance,
					summary: `plan mode: planning ${space.key}/${block.sid} again`,
				},
				options,
			);
			const after = await store.getBlock(block.id);
			rememberPlanningRoot(args.session, block.id);
			return {
				root: await rootOf(
					store,
					space,
					after ?? { ...block, versionSeq: result.commit?.seq ?? block.versionSeq },
					after?.content ?? block.content,
				),
				how: "replanning" as const,
			};
		}

		let parent: { id: string } | { tempId: string };
		const ops: Parameters<typeof writeOutline>[0]["ops"][number][] = [];
		if (args.under?.trim()) {
			const goal = await taskByAddress(store, space, args.under);
			if (!goal?.taskJson)
				throw new OutlinePlanError(
					`${args.under} is not a task of this session's space`,
					"OUTLINE_PLAN_INVALID",
				);
			if (!isOpenTask(goal.taskJson))
				throw new OutlinePlanError(
					`${space.key}/${goal.sid} is finished; plan under an open task`,
					"OUTLINE_PLAN_INVALID",
				);
			// Not inside a plan that is itself being planned: a plan under it would stay hidden.
			let above: Pick<OutlineBlockRow, "id" | "parentId" | "taskJson" | "sid"> | null = goal;
			for (let depth = 0; above && depth <= OUTLINE_LIMITS.maxDepth; depth++) {
				if (isPlanningRoot(above.taskJson))
					throw new OutlinePlanError(
						`${space.key}/${above.sid} is a plan not approved yet; plan inside it with OutlineEdit instead`,
						"OUTLINE_PLAN_INVALID",
					);
				above = above.parentId ? await store.getBlock(above.parentId) : null;
			}
			parent = { id: goal.id };
		} else {
			const [page] = await store.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
			if (page) parent = { id: page.id };
			else {
				ops.push({
					op: "insert",
					tempId: "page",
					parent: null,
					content: OUTLINE_TASKS_PAGE_TITLE[args.locale === "zh-CN" ? "zh-CN" : "en"],
					alias: OUTLINE_TASKS_PAGE_ALIAS,
				});
				parent = { tempId: "page" };
			}
		}
		const fallback = args.locale === "zh-CN" ? "计划" : "Plan";
		const title =
			(args.title ?? "").replace(/\s+/g, " ").trim().slice(0, OUTLINE_PLAN_LIMITS.titleChars) ||
			fallback;
		ops.push({
			op: "insert",
			parent,
			content: title,
			task: {
				status: "todo",
				manager: { kind: "agent", id: args.session },
				plan: { state: "planning", by: args.session, round: 0, baseSeq: 0 },
			},
		});
		const result = await writeOutline(
			{ spaceId: space.id, ops, ...provenance, summary: "plan mode: a new plan" },
			options,
		);
		const added = result.results[ops.length - 1];
		if (!added) throw new Error("the plan root was not written");
		const block = await store.getBlock(added.blockId);
		if (!block) throw new Error("the plan root was not written");
		rememberPlanningRoot(args.session, block.id);
		return { root: await rootOf(store, space, block, block.content), how: "created" as const };
	});
}

/** The plan root the given block is, when it is `session`'s plan being planned. */
async function planningRootById(
	store: OutlineStore,
	session: string,
	blockId: string,
): Promise<{ space: OutlineSpaceRow; block: OutlineBlockRow } | null> {
	const block = await store.getBlock(blockId);
	if (!block || block.deleted || !planningBy(block.taskJson, session)) return null;
	const space = await store.getSpace(block.spaceId);
	return space ? { space, block } : null;
}

export type OutlinePlanSubmissionRead =
	| {
			ok: true;
			submission: OutlinePlanSubmission;
			/** The plan as the approval shows it (markdown outline, no labels). */
			markdown: string;
	  }
	| { ok: false; problem: OutlinePlanSubmitProblem };

/**
 * What submitting the plan shows: the plan as of now (behind the live-session barrier) and its
 * diff against the version it is compared with. `rootRef` names the root (an address); without
 * it, the plan `session` is planning. Nothing is written.
 */
export async function readPlanSubmission(args: {
	session: string;
	rootRef?: string | null;
	summary?: string | null;
	store?: OutlineStore;
}): Promise<OutlinePlanSubmissionRead> {
	const store = args.store ?? outlineStore;
	let root: OutlinePlanRoot | null;
	if (args.rootRef?.trim()) {
		const space = await store.findSpace({ kind: "session", narratorId: args.session });
		const block = space ? await taskByAddress(store, space, args.rootRef) : null;
		if (!block || !space)
			return { ok: false, problem: { kind: "notFound", address: args.rootRef } };
		if (!planningBy(block.taskJson, args.session))
			return { ok: false, problem: { kind: "notPlanning", address: `${space.key}/${block.sid}` } };
		root = await rootOf(store, space, block, block.content);
	} else {
		root = await findPlanningRoot(args.session, { store });
		if (!root) return { ok: false, problem: { kind: "noRoot" } };
	}
	const found = root;
	return await withOutlineLiveBarrier(found.spaceId, async () => {
		const read = await readOutline({
			blockId: found.blockId,
			view: "all",
			budget: { blocks: OUTLINE_PLAN_LIMITS.maxBlocks, bytes: OUTLINE_PLAN_LIMITS.renderBytes },
			planNotes: false,
			store,
		});
		if (!read) return { ok: false, problem: { kind: "notFound", address: found.address } };
		if (read.truncated)
			return {
				ok: false,
				problem: {
					kind: "tooLarge",
					address: found.address,
					blocks: OUTLINE_PLAN_LIMITS.maxBlocks,
				},
			};
		const block = await store.getBlock(found.blockId);
		const plan = block?.taskJson?.plan;
		if (!block || block.deleted || !plan || plan.state !== "planning")
			return { ok: false, problem: { kind: "notPlanning", address: found.address } };
		const diff = await readPlanDiff({
			rootId: found.blockId,
			fromSeq: plan.baseSeq,
			toSeq: read.seq,
			store,
		});
		const counts: OutlinePlanDiffCounts = diff?.counts ?? {
			added: 0,
			removed: 0,
			text: 0,
			task: 0,
			moved: 0,
		};
		const summary = (args.summary ?? "").trim();
		const clipped =
			Buffer.byteLength(summary, "utf8") > OUTLINE_PLAN_LIMITS.summaryBytes
				? `${Buffer.from(summary, "utf8").subarray(0, OUTLINE_PLAN_LIMITS.summaryBytes).toString("utf8").replace(/�$/, "")}…`
				: summary;
		return {
			ok: true,
			markdown: read.markdown,
			submission: {
				root: {
					blockId: found.blockId,
					spaceId: found.spaceId,
					pageId: block.pageId,
					address: found.address,
					title: blockTitle(block.content).slice(0, OUTLINE_PLAN_LIMITS.titleChars) || found.sid,
					round: plan.round + 1,
				},
				seq: read.seq,
				baseSeq: plan.baseSeq,
				counts,
				truncated: diff?.truncated ?? false,
				summary: clipped || null,
			},
		};
	});
}

/** The text an agent is given for a submission it could not make. */
export function planSubmitProblemText(locale: Locale, problem: OutlinePlanSubmitProblem): string {
	return getOutlinePlanSubmitProblem(locale, problem);
}

/** Ids of the plan's blocks now and as of `seq` (the version a person looked at). */
async function planBlockIds(
	store: OutlineStore,
	rootId: string,
	seq: number,
): Promise<Set<string>> {
	const ids = new Set<string>();
	const collect = (root: OutlineNode | undefined) => {
		const stack = root ? [root] : [];
		while (stack.length > 0 && ids.size <= OUTLINE_PLAN_LIMITS.maxBlocks * 2) {
			const node = stack.pop() as OutlineNode;
			ids.add(node.id);
			for (const child of node.children) stack.push(child);
		}
	};
	collect((await readSubtree(rootId, { store }))?.root);
	if (seq >= 1) collect((await readSubtree(rootId, { asOf: seq, store }))?.root);
	return ids;
}

/**
 * Whether anyone but `decider` changed the plan after `seenSeq`: a version of the plan's page
 * recorded since then (one indexed read, at most {@link OUTLINE_PLAN_LIMITS.maxBlocks}; more
 * counts as changed) of a block of the plan, written by a commit of someone else (the commits
 * since then read once, at most {@link OUTLINE_PLAN_LIMITS.commitScan}; one past them counts as
 * changed). A live session's flush with nobody to name (`system:outline-live`) is not counted: it
 * is most often the person's own typing saved for them (review round 1 N7). A block moved off the
 * page since then is not seen.
 */
async function changedByOthersSince(
	store: OutlineStore,
	space: OutlineSpaceRow,
	root: { id: string; pageId: string },
	seenSeq: number,
	decider: OutlineTaskActorRef,
): Promise<boolean> {
	if (space.nextSeq - 1 <= seenSeq) return false;
	const versions = await store.listPageVersions(root.pageId, {
		afterSeq: seenSeq,
		limit: OUTLINE_PLAN_LIMITS.maxBlocks + 1,
	});
	if (versions.length > OUTLINE_PLAN_LIMITS.maxBlocks) return true;
	if (versions.length === 0) return false;
	const ids = await planBlockIds(store, root.id, seenSeq);
	const touching = new Set(versions.filter((v) => ids.has(v.blockId)).map((v) => v.commitId));
	if (touching.size === 0) return false;
	const commits = await store.listCommits(space.id, {
		afterSeq: seenSeq,
		limit: OUTLINE_PLAN_LIMITS.commitScan + 1,
	});
	const byId = new Map(commits.map((c) => [c.id, c]));
	for (const commitId of touching) {
		const commit = byId.get(commitId);
		if (!commit) return true;
		if (commit.actorKind === decider.kind && commit.actorId === decider.id) continue;
		if (commit.actorKind === "system" && commit.actorId === LIVE_FLUSH_ACTOR) continue;
		return true;
	}
	return false;
}

/** The actor of a live session's flush with nobody to name (`live/session.ts`). */
const LIVE_FLUSH_ACTOR = "outline-live";

export type OutlinePlanDecider =
	| { kind: "human"; userId: string }
	| {
			/** The system on a person's behalf (a review, an approval not made on the card). */
			kind: "system";
			id: string;
			responsibleUserId: string | null;
			approvedBy: OutlineTaskActorRef;
	  };

export interface OutlinePlanDecision {
	/** Null when nothing was written (decided already: the same decision again). */
	result: OutlineWriteResult | null;
	/** The block the feedback was written as (a return with feedback), and its id. */
	noteAddress: string | null;
	noteId: string | null;
	root: OutlinePlanRoot;
	/**
	 * What the plan is now (review round 1 S2): `lock` when it ended up locked (asked now, or a
	 * draft locked by this lock), `draft` when approved unlocked, `return` when returned.
	 */
	effective: "return" | "draft" | "lock";
	/** The root's task before this decision wrote anything: what undoing it puts back. */
	before: OutlineTaskJson;
}

/**
 * A decision on a submitted plan; see the module header. `round` is the version submitted.
 * `seenSeq` (a person's decision): the version they looked at.
 */
export async function decideOutlinePlan(args: {
	session: string;
	rootId: string;
	round: number;
	action: "return" | "draft" | "lock";
	decider: OutlinePlanDecider;
	feedback?: string | null;
	delegate?: string | null;
	seenSeq?: number | null;
	locale: Locale;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlinePlanDecision> {
	const store = args.store ?? outlineStore;
	const first = await store.getBlock(args.rootId);
	if (!first || first.deleted || first.taskJson?.plan?.by !== args.session)
		throw new OutlinePlanError("the plan was not found", "OUTLINE_PLAN_NOT_FOUND");
	if (args.action === "lock" && args.decider.kind !== "human")
		throw new OutlinePlanError("only a person locks a plan", "OUTLINE_PLAN_INVALID");
	if (args.delegate && args.delegate === args.session)
		throw new OutlinePlanError(
			"the session that wrote the plan cannot confirm changes to it",
			"OUTLINE_PLAN_INVALID",
		);
	return await withOutlineLiveBarrier(first.spaceId, async () => {
		const block = await store.getBlock(args.rootId);
		const space = block ? await store.getSpace(block.spaceId) : null;
		const plan = block?.taskJson?.plan;
		if (!block || block.deleted || !space || !plan || plan.by !== args.session)
			throw new OutlinePlanError("the plan was not found", "OUTLINE_PLAN_NOT_FOUND");
		const root = await rootOf(store, space, block, block.content);
		const before = block.taskJson as OutlineTaskJson;
		const none = { result: null, noteAddress: null, noteId: null, root, before };
		if (plan.state === "approved") {
			if (args.action === "return" || plan.round < args.round)
				throw new OutlinePlanError("the plan is approved already", "OUTLINE_PLAN_DECIDED");
			// Decided already (a retried request, or one whose resolution was lost, S2): the same
			// approval again writes nothing; a lock asked of a draft by a person locks it now.
			if (args.action === "draft" || before.lock)
				return { ...none, effective: before.lock ? ("lock" as const) : ("draft" as const) };
			if (args.decider.kind !== "human")
				throw new OutlinePlanError("only a person locks a plan", "OUTLINE_PLAN_INVALID");
			const locked = await writeOutline(
				{
					spaceId: space.id,
					ops: [
						{
							op: "setTask",
							block: { id: block.id },
							task: { lock: { delegate: args.delegate ?? null } },
						},
					],
					actor: { kind: "human", id: args.decider.userId },
					responsibleUserId: args.decider.userId,
					narratorId: args.session,
					summary: `plan ${root.address} locked (version ${plan.round})`,
				},
				{ store, kind: "plan", ...(args.now ? { now: args.now } : {}) },
			);
			return { ...none, result: locked, effective: "lock" as const };
		}
		if (args.action === "return" && plan.round >= args.round)
			return { ...none, effective: "return" as const };
		const deciderRef: OutlineTaskActorRef =
			args.decider.kind === "human"
				? { kind: "human", id: args.decider.userId }
				: { kind: "system", id: args.decider.id };
		if (
			args.decider.kind === "human" &&
			typeof args.seenSeq === "number" &&
			(await changedByOthersSince(
				store,
				space,
				{ id: block.id, pageId: block.pageId },
				args.seenSeq,
				deciderRef,
			))
		) {
			throw new OutlinePlanError(
				"the plan changed since you looked at it; look at the changes again",
				"OUTLINE_PLAN_CHANGED",
			);
		}
		const feedback = (args.feedback ?? "").trim().slice(0, OUTLINE_PLAN_LIMITS.feedbackChars);
		const ops: Parameters<typeof writeOutline>[0]["ops"][number][] = [];
		if (args.action === "return" && feedback) {
			ops.push({
				op: "insert",
				parent: { id: block.id },
				content: getOutlinePlanReturnedNote(args.locale, args.round, feedback),
			});
		}
		const approvedBy =
			args.decider.kind === "human"
				? { kind: "human" as const, id: args.decider.userId }
				: args.decider.approvedBy;
		ops.push({
			op: "setTask",
			block: { id: block.id },
			task:
				args.action === "return"
					? { plan: { state: "planning", by: args.session, round: args.round } }
					: {
							plan: { state: "approved", by: args.session, round: args.round, approvedBy },
							...(args.action === "lock" ? { lock: { delegate: args.delegate ?? null } } : {}),
						},
		});
		const result = await writeOutline(
			{
				spaceId: space.id,
				ops,
				actor:
					args.decider.kind === "human"
						? { kind: "human", id: args.decider.userId }
						: { kind: "system", id: args.decider.id },
				responsibleUserId:
					args.decider.kind === "human" ? args.decider.userId : args.decider.responsibleUserId,
				narratorId: args.session,
				summary:
					args.action === "return"
						? `plan ${root.address} returned (version ${args.round})`
						: args.action === "lock"
							? `plan ${root.address} locked and approved (version ${args.round})`
							: `plan ${root.address} approved as a draft (version ${args.round})`,
			},
			{ store, kind: "plan", ...(args.now ? { now: args.now } : {}) },
		);
		const note = args.action === "return" && feedback ? result.results[0] : undefined;
		return {
			result,
			noteAddress: note?.address ?? null,
			noteId: note?.blockId ?? null,
			root,
			effective: args.action,
			before,
		};
	});
}

/**
 * Take back a decision whose request was gone by the time it was to be resolved (review round 1
 * S1: cancelled or decided meanwhile): one system `plan` commit puts the root's plan state back
 * as it was (round, baseSeq), takes away a lock the decision added, and deletes the feedback it
 * wrote. A cancelled plan mode then leaves the plan 计划中 (D48 Q3). Changes made since are not
 * touched; a root gone meanwhile has nothing to undo.
 */
export async function undoOutlinePlanDecision(args: {
	session: string;
	decision: Pick<OutlinePlanDecision, "root" | "before" | "noteId" | "result">;
	responsibleUserId: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<void> {
	if (!args.decision.result?.commit) return;
	const store = args.store ?? outlineStore;
	const rootId = args.decision.root.blockId;
	const block = await store.getBlock(rootId);
	if (!block || block.deleted || !block.taskJson) return;
	const before = args.decision.before;
	const ops: Parameters<typeof writeOutline>[0]["ops"][number][] = [
		{
			op: "setTask",
			block: { id: rootId },
			task: {
				plan: before.plan ?? null,
				...(before.lock ? {} : { lock: null }),
			},
		},
	];
	if (args.decision.noteId) {
		const note = await store.getBlock(args.decision.noteId);
		if (note && !note.deleted) ops.push({ op: "delete", block: { id: note.id } });
	}
	await writeOutline(
		{
			spaceId: block.spaceId,
			ops,
			actor: { kind: "system", id: OUTLINE_PLAN_ACTOR },
			responsibleUserId: args.responsibleUserId,
			narratorId: args.session,
			summary: `plan ${args.decision.root.address}: a decision taken back (the request was gone)`,
		},
		{ store, kind: "plan", ...(args.now ? { now: args.now } : {}) },
	);
	if (before.plan?.state === "planning") rememberPlanningRoot(args.session, rootId);
}

/**
 * A cancelled plan mode (D48 Q3): the plan `session` is planning stays `planning` (never executed;
 * resumed on the next EnterPlanMode), unless nothing was ever written into it or under it: then
 * the root is deleted. Returns whether it was.
 */
export async function discardEmptyPlanRoot(args: {
	session: string;
	userId: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<boolean> {
	const store = args.store ?? outlineStore;
	const root = await findPlanningRoot(args.session, { store });
	if (!root) return false;
	return await withOutlineLiveBarrier(root.spaceId, async () => {
		const found = await planningRootById(store, args.session, root.blockId);
		if (!found) return false;
		const children = await store.listChildMetas(found.space.id, [found.block.id], 1);
		if (children.length > 0) return false;
		// Written into after it was made: its text is the person's or the agent's work.
		const [created] = await store.getFirstVersions([found.block.id]);
		if (!created || created.fromSeq !== found.block.versionSeq || found.block.taskJson?.plan?.round)
			return false;
		const result = await writeOutline(
			{
				spaceId: found.space.id,
				ops: [
					{ op: "delete", block: { id: found.block.id }, baseVersionSeq: found.block.versionSeq },
				],
				actor: { kind: "system", id: OUTLINE_PLAN_ACTOR },
				responsibleUserId: args.userId,
				narratorId: args.session,
				summary: `plan mode cancelled: the empty plan ${root.address} removed`,
			},
			{ store, kind: "plan", ...(args.now ? { now: args.now } : {}) },
		);
		return !!result.commit;
	});
}
