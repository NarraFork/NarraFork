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
 * A model's fresh submission is also held to the plan format (`checkStructure`, plan
 * readability; `@shared/outline-plan-structure`): the root a one-line title, its first block a
 * background paragraph, big and small points one idea each with their implementation details
 * under them, the notable points last, no flat list of many blocks. A plan that breaks it is
 * refused with the blocks to fix, before anything waits for a person. The notes for the agent
 * under the root (returned feedback, earlier reviews: {@link isPlanNoteBlock}) are not the
 * agent's text and are left out.
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
 * REVIEWING (PR 8b, D48 Q1)
 * -------------------------
 * A plan review (计划反思) with concerns leaves them under the root ({@link writePlanReview}): one
 * block 「审查意见（第 N 版）」 written by the system actor `plan-review`, each comment a child
 * of it, linking the step it is about. Its id is derived from the review ({@link planReviewBlockId},
 * so a review restored after a restart finds what it wrote: {@link readPlanReview}), and its
 * commit names the ExitPlanMode call it reviewed. A review with no concerns writes nothing: the
 * approval it leads to is a draft decided on the person's behalf.
 *
 * The reviews of the version being planned ({@link planReviewBlocks}: children of the root that
 * plan-review wrote for the session since the version's base) are not the plan: the submission's
 * rendering and size budget, its diff, the next reviewer's view, the person's edits told to the
 * agent and the 409 check all leave them out.
 *
 * Every read is bounded: the session space's open tasks (one indexed read), the plan's page
 * structure (as `OutlineRead`), the commits since the seen version (at most
 * {@link OUTLINE_PLAN_LIMITS.commitScan}).
 */
import { createHash } from "node:crypto";
import { AppError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import {
	getOutlinePlanReturnedNote,
	getOutlinePlanReviewTitle,
	getOutlinePlanSubmitProblem,
	type Locale,
	type OutlinePlanSubmitProblem,
} from "@server/lib/prompt-i18n";
import { blockTitle, isShortId, parseAddress } from "@shared/outline";
import type {
	OutlinePlanDiffCounts,
	OutlinePlanReview,
	OutlinePlanReviewComment,
	OutlinePlanSubmission,
} from "@shared/outline-api";
import {
	OUTLINE_PLAN_STRUCTURE,
	type PlanStructureNode,
	planStructureIssues,
} from "@shared/outline-plan-structure";
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

/** The system actor of a plan review's comments, and the approver of a plan it found no fault in. */
export const OUTLINE_PLAN_REVIEW_ACTOR = "plan-review";

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
		// A title the plan format accepts as its root (plan readability): one line, at most
		// `rootChars` characters, so the root plan mode makes is never the first thing refused.
		const title =
			Array.from((args.title ?? "").replace(/\s+/g, " ").trim())
				.slice(0, OUTLINE_PLAN_STRUCTURE.rootChars)
				.join("")
				.trim() || fallback;
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

/**
 * The notes written under a plan root for the agent, as their first words (both languages, any
 * version): a person's returned feedback (`getOutlinePlanReturnedNote`) and a review's block
 * (`getOutlinePlanReviewTitle`).
 */
const PLAN_NOTE_PREFIXES: readonly RegExp[] = (["en", "zh-CN"] as const)
	.flatMap((locale) => [
		getOutlinePlanReturnedNote(locale, 0, ""),
		getOutlinePlanReviewTitle(locale, 0),
	])
	.map(
		(text) =>
			new RegExp(
				`^${text
					.trim()
					.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
					.replace("0", "\\d+")}`,
			),
	);

/** Whether a child of a plan root is a note for the agent (a person's or a review's, not its). */
export function isPlanNoteBlock(node: Pick<PlanStructureNode, "content">): boolean {
	const content = node.content ?? "";
	return PLAN_NOTE_PREFIXES.some((prefix) => prefix.test(content));
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
	/**
	 * The review the call has (PR 8b; the server's, never a model's: see `outline-plan-mode.ts`):
	 * attached, as the outline has it now, when it is one of this version's reviews
	 * ({@link planReviewBlocks}) written for that very call (its commit's tool call) and of this
	 * version. Anything else is ignored.
	 */
	review?: OutlinePlanReviewClaim | null;
	/**
	 * Hold the plan to its format (a model's fresh submission; not a call restored or handed on,
	 * which a person already has in front of them): refused as `structure` when it breaks it.
	 */
	checkStructure?: boolean;
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
		const block = await store.getBlock(found.blockId);
		const plan = block?.taskJson?.plan;
		if (!block || block.deleted)
			return { ok: false, problem: { kind: "notFound", address: found.address } };
		if (!plan || plan.state !== "planning")
			return { ok: false, problem: { kind: "notPlanning", address: found.address } };
		// This version's reviews: left out of the rendering, its budget and the diff (N1, N2) while
		// they are only what the review wrote (review round 2 S3).
		const reviews = await planReviewBlocks(store, args.session, block, plan.baseSeq);
		const omit = omittableReviews(reviews);
		const read = await readOutline({
			blockId: found.blockId,
			view: "all",
			budget: { blocks: OUTLINE_PLAN_LIMITS.maxBlocks, bytes: OUTLINE_PLAN_LIMITS.renderBytes },
			planNotes: false,
			omit,
			withTree: args.checkStructure === true,
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
					kib: OUTLINE_PLAN_LIMITS.renderBytes / 1024,
				},
			};
		if (args.checkStructure === true && read.tree) {
			const report = planStructureIssues(read.tree, { isNote: isPlanNoteBlock });
			if (report.total > 0) {
				const key = read.space.key;
				return {
					ok: false,
					problem: {
						kind: "structure",
						address: found.address,
						issues: report.issues.map((issue) => ({ ...issue, address: `${key}/${issue.sid}` })),
						total: report.total,
					},
				};
			}
		}
		const claim = args.review;
		const written = claim ? reviews.get(claim.blockId) : undefined;
		const review =
			claim &&
			written &&
			claim.rootId === found.blockId &&
			claim.round === plan.round + 1 &&
			(!claim.toolCallId || written.toolCallId === claim.toolCallId)
				? {
						...(await reviewFromBlock(
							store,
							read.space,
							{ id: claim.blockId, sid: written.sid },
							claim.round,
						)),
						submittedSeq: claim.submittedSeq,
					}
				: null;
		const diff = await readPlanDiff({
			rootId: found.blockId,
			fromSeq: plan.baseSeq,
			toSeq: read.seq,
			...reviewDiffOptions(reviews),
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
				review,
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
 * is most often the person's own typing saved for them (review round 1 N7), nor are the plan
 * review's comments for `session` (PR 8b). A block moved off the page since then is not seen.
 */
async function changedByOthersSince(
	store: OutlineStore,
	space: OutlineSpaceRow,
	root: { id: string; pageId: string },
	seenSeq: number,
	decider: OutlineTaskActorRef,
	session: string,
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
		// The plan review's comments for this session are not someone changing the plan (PR 8b).
		if (
			commit.actorKind === "system" &&
			commit.actorId === OUTLINE_PLAN_REVIEW_ACTOR &&
			commit.narratorId === session
		)
			continue;
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
				args.session,
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
 * S1: cancelled or refused meanwhile): one system `plan` commit puts the root's plan state back
 * as it was (round, baseSeq), takes away the lock the decision added, and deletes the feedback it
 * wrote. A cancelled plan mode then leaves the plan 计划中 (D48 Q3). Changes made since are not
 * touched (review round 2 N1): a lock is taken away only while it is still the one this decision
 * wrote (its `versionSeq` is the decision's commit), and the feedback block only while it is as
 * written and nothing was written under it. A root gone meanwhile has nothing to undo.
 */
export async function undoOutlinePlanDecision(args: {
	session: string;
	decision: Pick<OutlinePlanDecision, "root" | "before" | "noteId" | "result">;
	responsibleUserId: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<void> {
	const commit = args.decision.result?.commit;
	if (!commit) return;
	const store = args.store ?? outlineStore;
	const rootId = args.decision.root.blockId;
	const block = await store.getBlock(rootId);
	if (!block || block.deleted || !block.taskJson) return;
	const before = args.decision.before;
	const ownLock = !before.lock && block.taskJson.lock?.versionSeq === commit.seq;
	const ops: Parameters<typeof writeOutline>[0]["ops"][number][] = [
		{
			op: "setTask",
			block: { id: rootId },
			task: { plan: before.plan ?? null, ...(ownLock ? { lock: null } : {}) },
		},
	];
	if (args.decision.noteId) {
		const note = await store.getBlock(args.decision.noteId);
		const untouched =
			note &&
			!note.deleted &&
			note.versionSeq === commit.seq &&
			(await store.listChildMetas(note.spaceId, [note.id], 1)).length === 0;
		if (untouched) ops.push({ op: "delete", block: { id: note.id } });
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

// ─────────────────────────────────────────────────────────────────────────────
// Reviewing (PR 8b, D48 Q1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The plan as of `seq` for its review: the submission's rendering with each block labelled by its
 * short id (`[sid]`, as `OutlineRead` labels the session's own space), so a comment can name the
 * step it is about. One page-structure read within the submission's budget. Null when the root is
 * not there at `seq`.
 */
export async function renderPlanForReview(args: {
	rootId: string;
	seq: number;
	/** Blocks left out: this version's earlier reviews (review round 1 N1). */
	omit?: ReadonlySet<string>;
	store?: OutlineStore;
}): Promise<string | null> {
	const read = await readOutline({
		...(args.omit && args.omit.size > 0 ? { omit: args.omit } : {}),
		blockId: args.rootId,
		...(args.seq >= 1 ? { asOf: args.seq } : {}),
		view: "all",
		budget: { blocks: OUTLINE_PLAN_LIMITS.maxBlocks, bytes: OUTLINE_PLAN_LIMITS.renderBytes },
		planNotes: false,
		label: (node) => `[${node.sid}]`,
		store: args.store ?? outlineStore,
	});
	return read?.markdown ?? null;
}

/**
 * The review a call has, as the server handed it on (PR 8b): the root and version it is about,
 * its block, the seq of the version it reviewed, and the call (tool call) it was written for.
 */
export interface OutlinePlanReviewClaim {
	rootId: string;
	blockId: string;
	round: number;
	submittedSeq: number;
	toolCallId?: string | null;
}

/** The ids a review's block gets ({@link planReviewBlockId}) start with this. */
export const PLAN_REVIEW_ID_PREFIX = "plrv";

/**
 * The id of the block a review writes its comments under: derived from the review's request id
 * (kept across a restart) and the version, so a review restored finds what it wrote.
 */
export function planReviewBlockId(requestId: string, round: number): string {
	return `${PLAN_REVIEW_ID_PREFIX}${createHash("sha256").update(`${requestId}\n${round}`).digest("hex").slice(0, 28)}`;
}

/** One of the version's reviews, as {@link planReviewBlocks} finds it. */
export interface OutlinePlanReviewFound {
	sid: string;
	/** The ExitPlanMode call the review was written for (its commit's tool call). */
	toolCallId: string | null;
	/**
	 * Whether the plan may leave it out (its rendering, budget, diff, the next reviewer's view, the
	 * edits told to the agent): only while it is exactly what the review's commit wrote, its block
	 * and its comments unchanged, nothing else under it and no task in it (review round 2 S3).
	 * Anything written into or under it since is the plan's, shown and counted as such.
	 */
	omittable: boolean;
	/**
	 * Its blocks still exactly as the review's commit wrote them (the block, its comments): what a
	 * diff passes over in a review that is not left out, so only what was added or changed in it
	 * is counted, listed and told (review round 3 N9).
	 */
	quiet: string[];
}

/**
 * The reviews of the version being planned: children of the plan root that the plan-review
 * actor wrote for `session` after `afterSeq` (the version's base), by block id, with the call
 * each was written for and whether it is still only what the review wrote. The agent cannot
 * write as that actor, so it cannot make one up. One indexed read of the root's children, then
 * for each review block (at most {@link OUTLINE_PLAN_LIMITS.reviewScan}, the last ones) its first
 * version and that commit, its comments and what is under them (two child reads, bounded).
 */
export async function planReviewBlocks(
	store: OutlineStore,
	session: string,
	root: Pick<OutlineBlockRow, "id" | "spaceId">,
	afterSeq: number,
): Promise<Map<string, OutlinePlanReviewFound>> {
	const out = new Map<string, OutlinePlanReviewFound>();
	const children = await store.listChildMetas(
		root.spaceId,
		[root.id],
		OUTLINE_PLAN_LIMITS.maxBlocks,
	);
	const candidates = children
		.filter((child) => child.id.startsWith(PLAN_REVIEW_ID_PREFIX))
		.slice(-OUTLINE_PLAN_LIMITS.reviewScan);
	if (candidates.length === 0) return out;
	const byId = new Map(candidates.map((child) => [child.id, child]));
	for (const first of await store.getFirstVersions(candidates.map((child) => child.id))) {
		if (first.fromSeq <= afterSeq) continue;
		const [commit] = await store.listCommits(root.spaceId, {
			afterSeq: first.fromSeq - 1,
			limit: 1,
		});
		if (
			!commit ||
			commit.id !== first.commitId ||
			commit.actorKind !== "system" ||
			commit.actorId !== OUTLINE_PLAN_REVIEW_ACTOR ||
			commit.narratorId !== session
		)
			continue;
		const block = byId.get(first.blockId);
		const written = block
			? await whatTheReviewWrote(store, block, commit.seq)
			: { omittable: false, quiet: [] };
		out.set(first.blockId, {
			sid: block?.sid ?? "",
			toolCallId: commit.toolCallId,
			...written,
		});
	}
	return out;
}

/**
 * What of a review block is still exactly what its commit (`seq`) wrote: its blocks at the version
 * that commit made (the commit only creates them, so an edit, a move or a task makes a new one),
 * none a task (`quiet`), and whether that is all of it: the block and every comment, at most
 * {@link OUTLINE_PLAN_LIMITS.reviewComments}, nothing under any of them (`omittable`).
 */
async function whatTheReviewWrote(
	store: OutlineStore,
	block: Pick<OutlineBlockRow, "id" | "spaceId" | "versionSeq" | "taskJson">,
	seq: number,
): Promise<{ omittable: boolean; quiet: string[] }> {
	const asWritten = (b: { versionSeq: number; taskJson: unknown }) =>
		b.versionSeq === seq && !b.taskJson;
	const quiet = asWritten(block) ? [block.id] : [];
	const max = OUTLINE_PLAN_LIMITS.reviewComments;
	const comments = await store.listChildMetas(block.spaceId, [block.id], max + 1);
	for (const comment of comments.slice(0, max)) if (asWritten(comment)) quiet.push(comment.id);
	if (comments.length > max || quiet.length !== comments.length + 1)
		return { omittable: false, quiet };
	const below =
		comments.length > 0
			? await store.listChildMetas(
					block.spaceId,
					comments.map((comment) => comment.id),
					1,
				)
			: [];
	return { omittable: below.length === 0, quiet };
}

/**
 * How a diff of the plan passes over this version's reviews: `skip` leaves out the reviews that
 * are only what the review wrote, with what is under them; `quiet` passes over the blocks still as
 * written in the others, so only what was added or changed in them shows (review round 3 N9).
 */
export function reviewDiffOptions(reviews: ReadonlyMap<string, OutlinePlanReviewFound>): {
	skip?: Set<string>;
	quiet?: Set<string>;
} {
	const skip = omittableReviews(reviews);
	const quiet = new Set(
		[...reviews.values()].flatMap((found) => (found.omittable ? [] : found.quiet)),
	);
	return {
		...(skip.size > 0 ? { skip } : {}),
		...(quiet.size > 0 ? { quiet } : {}),
	};
}

/** The ids of the reviews the plan leaves out (see {@link OutlinePlanReviewFound.omittable}). */
export function omittableReviews(
	reviews: ReadonlyMap<string, OutlinePlanReviewFound>,
): Set<string> {
	return new Set([...reviews].flatMap(([id, found]) => (found.omittable ? [id] : [])));
}

/**
 * The review written as `blockId` under the plan `rootId` of `session` (a review restored after a
 * restart): one of the version's reviews ({@link planReviewBlocks}) and, when `toolCallId` is
 * given, written for that call. Null when there is none.
 */
export async function readPlanReview(args: {
	session: string;
	rootId: string;
	blockId: string;
	round: number;
	toolCallId?: string | null;
	store?: OutlineStore;
}): Promise<OutlinePlanReviewBlock | null> {
	const store = args.store ?? outlineStore;
	const root = await store.getBlock(args.rootId);
	const plan = root && !root.deleted ? root.taskJson?.plan : undefined;
	if (!root || !plan || plan.by !== args.session || plan.round + 1 !== args.round) return null;
	const written = (await planReviewBlocks(store, args.session, root, plan.baseSeq)).get(
		args.blockId,
	);
	if (!written || (args.toolCallId && written.toolCallId !== args.toolCallId)) return null;
	const space = await store.getSpace(root.spaceId);
	return space
		? await reviewFromBlock(store, space, { id: args.blockId, sid: written.sid }, args.round)
		: null;
}

/** A comment a review asks to leave: its text, and the block of the plan it is about. */
export interface PlanReviewCommentInput {
	target?: string | null;
	text: string;
}

/**
 * Why a review's comments cannot be written as given (a message for the reviewer), or null. A
 * review with concerns leaves 1 to {@link OUTLINE_PLAN_LIMITS.reviewComments} comments, each with
 * text of at most {@link OUTLINE_PLAN_LIMITS.reviewCommentChars} characters.
 */
export function planReviewCommentsProblem(
	comments: readonly PlanReviewCommentInput[],
): string | null {
	const max = OUTLINE_PLAN_LIMITS.reviewComments;
	if (comments.length === 0)
		return 'verdict "concerns" needs at least one comment; with no concerns, use verdict "ok"';
	if (comments.length > max)
		return `at most ${max} comments; keep the ${max} that matter most, or merge related ones`;
	for (const [index, comment] of comments.entries()) {
		const text = typeof comment.text === "string" ? comment.text.trim() : "";
		if (!text) return `comment ${index + 1} has no text`;
		if (text.length > OUTLINE_PLAN_LIMITS.reviewCommentChars)
			return `comment ${index + 1} is longer than ${OUTLINE_PLAN_LIMITS.reviewCommentChars} characters; shorten it`;
	}
	return null;
}

/**
 * A link at the start of a comment block. It is the comment's target (the step it is about, as
 * {@link writePlanReview} writes one) only when it is an address in the plan's space; any other
 * link stays in the comment's text (review round 1 N4).
 */
const COMMENT_TARGET = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*/;

/** A review as its block holds it (the version it reviewed is the caller's to say). */
export type OutlinePlanReviewBlock = Omit<OutlinePlanReview, "submittedSeq">;

/** The review a review block holds: its comments (its children) and their targets' titles. */
async function reviewFromBlock(
	store: OutlineStore,
	space: Pick<OutlineSpaceRow, "id" | "key">,
	block: Pick<OutlineBlockRow, "id" | "sid">,
	round: number,
): Promise<OutlinePlanReviewBlock> {
	const max = OUTLINE_PLAN_LIMITS.reviewComments;
	const children = await store.listChildren(space.id, block.id, max + 1);
	const parsed = children.slice(0, max).map((child) => {
		const match = COMMENT_TARGET.exec(child.content);
		const address = match ? parseAddress((match[1] ?? "").trim()) : null;
		const target = match && address && address.space === space.key ? address.sid : null;
		return {
			text: (target && match ? child.content.slice(match[0].length) : child.content).trim(),
			sid: target,
		};
	});
	const sids = [...new Set(parsed.flatMap((p) => (p.sid ? [p.sid] : [])))];
	const metas = sids.length > 0 ? await store.getBlockMetas(space.id, { sids }) : [];
	const live = metas.filter((meta) => !meta.deleted);
	const heads =
		live.length > 0
			? await store.getContentHeads(
					live.map((meta) => meta.id),
					OUTLINE_PLAN_LIMITS.titleChars,
				)
			: new Map<string, string>();
	const titles = new Map(live.map((meta) => [meta.sid, blockTitle(heads.get(meta.id) ?? "")]));
	const comments: OutlinePlanReviewComment[] = parsed.map((p) => ({
		text: p.text,
		target: p.sid
			? {
					address: `${space.key}/${p.sid}`,
					title: (titles.get(p.sid) ?? "").slice(0, OUTLINE_PLAN_LIMITS.titleChars) || p.sid,
				}
			: null,
	}));
	return {
		blockId: block.id,
		address: `${space.key}/${block.sid}`,
		round,
		count: comments.length,
		comments,
	};
}

/**
 * A review's concerns on version `round` of the plan `rootId` of `session`, written under the
 * root behind the live-session barrier (see the module header): one `plan` commit by the system
 * actor `plan-review`, the turn's person responsible. `blockId` is the review block's id; when
 * that block is there already (written before a restart), it is returned as it is and nothing is
 * written again. Refused (`OutlinePlanError`, the message for the reviewer) when the plan is not
 * waiting for this version's decision, when the comments are out of bounds, or when a target is
 * not a block of the plan (the root and what is under it, now).
 */
export async function writePlanReview(args: {
	session: string;
	rootId: string;
	round: number;
	blockId: string;
	comments: readonly PlanReviewCommentInput[];
	userId: string | null;
	locale: Locale;
	toolCallId?: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlinePlanReviewBlock> {
	const store = args.store ?? outlineStore;
	const problem = planReviewCommentsProblem(args.comments);
	if (problem) throw new OutlinePlanError(problem, "OUTLINE_PLAN_INVALID");
	const first = await store.getBlock(args.rootId);
	if (!first || first.deleted || first.taskJson?.plan?.by !== args.session)
		throw new OutlinePlanError("the plan was not found", "OUTLINE_PLAN_NOT_FOUND");
	return await withOutlineLiveBarrier(first.spaceId, async () => {
		const block = await store.getBlock(args.rootId);
		const space = block ? await store.getSpace(block.spaceId) : null;
		const plan = block?.taskJson?.plan;
		if (!block || block.deleted || !space || !plan || plan.by !== args.session)
			throw new OutlinePlanError("the plan was not found", "OUTLINE_PLAN_NOT_FOUND");
		const written = await store.getBlock(args.blockId);
		if (written) {
			if (written.deleted || written.parentId !== block.id)
				throw new OutlinePlanError(
					"this review was written already and has been removed since",
					"OUTLINE_PLAN_DECIDED",
				);
			return await reviewFromBlock(store, space, written, args.round);
		}
		if (plan.state !== "planning" || plan.round + 1 !== args.round)
			throw new OutlinePlanError(
				`version ${args.round} of the plan is not waiting for a decision any more`,
				"OUTLINE_PLAN_DECIDED",
			);
		const address = `${space.key}/${block.sid}`;
		// Targets: blocks of the plan as it is now (one page-structure read, only when named).
		const targets = new Map<string, string>();
		if (args.comments.some((comment) => comment.target?.trim())) {
			const subtree = await readSubtree(block.id, { store });
			if (!subtree) throw new OutlinePlanError("the plan was not found", "OUTLINE_PLAN_NOT_FOUND");
			const stack = [subtree.root];
			while (stack.length > 0 && targets.size <= OUTLINE_PLAN_LIMITS.maxBlocks * 2) {
				const node = stack.pop() as OutlineNode;
				targets.set(node.sid, node.sid);
				targets.set(node.id, node.sid);
				for (const child of node.children) stack.push(child);
			}
		}
		const ops: Parameters<typeof writeOutline>[0]["ops"][number][] = [
			{
				op: "insert",
				id: args.blockId,
				tempId: "review",
				parent: { id: block.id },
				content: getOutlinePlanReviewTitle(args.locale, args.round),
			},
		];
		for (const [index, comment] of args.comments.entries()) {
			const text = comment.text.trim();
			const ref = comment.target?.trim();
			let link = "";
			if (ref) {
				const sid = targetSid(ref, space.key, targets);
				if (!sid)
					throw new OutlinePlanError(
						`comment ${index + 1}: target "${ref}" is not a block of the plan ${address}; give the short id of the plan root or of a block under it, or no target`,
						"OUTLINE_PLAN_INVALID",
					);
				link = `[[${space.key}/${sid}]] `;
			}
			ops.push({ op: "insert", parent: { tempId: "review" }, content: `${link}${text}` });
		}
		await writeOutline(
			{
				spaceId: space.id,
				ops,
				actor: { kind: "system", id: OUTLINE_PLAN_REVIEW_ACTOR },
				responsibleUserId: args.userId,
				narratorId: args.session,
				...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
				summary: `plan ${address}: review of version ${args.round} (${args.comments.length} comment(s))`,
			},
			{ store, kind: "plan", ...(args.now ? { now: args.now } : {}) },
		);
		const review = await store.getBlock(args.blockId);
		if (!review) throw new Error("the plan review was not written");
		return await reviewFromBlock(store, space, review, args.round);
	});
}

/**
 * The short id a review comment's target names (`sid`, `key/sid`, `[sid]`, `[[key/sid|title]]`,
 * or a block id) when it is a block of the plan (`plan`: the plan's blocks by sid and id).
 */
function targetSid(ref: string, key: string, plan: ReadonlyMap<string, string>): string | null {
	const inner =
		ref
			.trim()
			.replace(/^\[{1,2}|\]{1,2}$/g, "")
			.split("|")[0]
			?.trim() ?? "";
	const address = parseAddress(inner);
	if (address) return address.space === key ? (plan.get(address.sid) ?? null) : null;
	return plan.get(inner) ?? null;
}
