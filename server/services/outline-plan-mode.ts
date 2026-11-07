/**
 * Plan mode in an outline session (outline P2 PR 8, D48; design §4.3): the session half of
 * `services/outline/plans.ts`. Spec sessions keep the plan-file flow untouched; everything here
 * applies only to a root session whose task backend is `outline` while the outline is on.
 *
 * THE FLOW
 * --------
 *   1. `EnterPlanMode` (the tool, or the plan-mode switch) makes or resumes the plan root
 *      ({@link enterOutlinePlanMode}); its result names it. The narrator's plan-file identity is
 *      still allocated (the plan-mode state machine keys on it) but never shown or read.
 *   2. The agent writes the plan under the root with `OutlineEdit`.
 *   3. `ExitPlanMode` resolves to the plan as of now ({@link resolveOutlineExitPlanInput}): the
 *      rendering goes into `input.plan` (the card shows it as before), the submission (root, seq,
 *      the version compared with, the diff's counts) into `_planRoot`, `_planSeq`, `_planBaseSeq`,
 *      `_planDiff`. It then waits for a person as every ExitPlanMode does. A model's fresh call
 *      whose plan is not laid out in levels (plan readability: the root a title, every block one
 *      short point) is refused first, naming the blocks to fix: nothing waits, nothing is written.
 *   4. The person decides on the card through `POST /narrators/permissions/:id/plan`
 *      ({@link decideOutlinePlanRequest}): the outline is written first (`decideOutlinePlan`),
 *      then the request is resolved. A refused write (409, 403) leaves the request waiting.
 *   5. Any approval, whichever way it came (the card, the plain approve route or frame, a plan
 *      review), ends in `onExitPlanMode`: {@link settleApprovedOutlinePlan} makes sure the plan is
 *      approved (as a draft, on the approver's behalf, when it did not come through the card).
 *      The pass then restarts with {@link startApprovedOutlinePlan}: the root and its first step
 *      that can start are started for the session, and the message names that step.
 *
 * PLAN REVIEW (计划反思; PR 8b, D48 Q1)
 * -----------------------------------
 * When the session runs plan review (the switch and its conditions are as for a spec session),
 * the review sees the plan as submitted, each block with its short id, and has one tool,
 * `PlanReview({ verdict, comments })`:
 *
 *   - `ok`: no concerns. The plan is approved as before (step 5 records it as a draft on the
 *     person's behalf, `approvedBy: system:plan-review`, never locked, not the person's work).
 *   - `concerns`: {@link reviewOutlinePlan} writes the comments under the root (`plans.ts`), and
 *     the call waits for a person like any ExitPlanMode: nothing goes back to the agent. The
 *     submission carries the review (`_planReview`): the card counts it, the diff shows it on its
 *     own (this version's reviews are not the plan: not in its rendering, budget or changes), and
 *     the agent is told of it once the person decides.
 *   - a review that could not finish hands the plan to a person too, without comments.
 *
 * The review reaches the call's permission through a server-side channel (by session and tool
 * use; review round 1 S2), never through keys a model can write; a call restored from what was
 * persisted names it in its persisted input. Either way it is attached only as the outline proves
 * it: one of this version's reviews, written by plan-review for this session and this very call.
 * The version the person decides on stays the one submitted (`_planSeq`; S1): what changed since,
 * while the review ran too, is told to the agent as the person's changes while deciding.
 *
 * The review's block id is derived from the review's request id and the version, so a review
 * restored after a restart finds the comments it wrote ({@link recoverOutlinePlanReview}) instead
 * of reviewing again. A taken-over review (`stop-plan-reflection`) is the person's as before, with
 * any comments written a moment before. A plan restored while a person was asked, and changed
 * since, is put to them again as it is now, not sent back to the agent.
 */

import type {
	OutlinePlanDecisionRequest,
	OutlinePlanReview,
	OutlinePlanSubmission,
} from "@shared/outline-api";
import {
	OUTLINE_PLAN_SUBMISSION_KEYS,
	outlinePlanSubmissionOf,
} from "@shared/outline-plan-submission";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorToolCalls } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import {
	getOutlinePlanApprovedPrompt,
	getOutlinePlanEnterOutput,
	getOutlinePlanReturnedMessage,
	getOutlinePlanReviewPrompt,
	type Locale,
} from "../lib/prompt-i18n";
import { canWriteSpace, narratorUsersWith, type OutlinePrincipal } from "./outline/access";
import { readNarrator } from "./outline/access-reads";
import { isOutlineEnabled } from "./outline/feature";
import {
	OUTLINE_PLAN_LIMITS,
	planDiffIsEmpty,
	planDiffLines,
	readPlanDiff,
} from "./outline/plan-diff";
import {
	decideOutlinePlan,
	discardEmptyPlanRoot,
	ensurePlanRoot,
	findPlanningRoot,
	OUTLINE_PLAN_ACTOR,
	OUTLINE_PLAN_REVIEW_ACTOR,
	OutlinePlanError,
	type OutlinePlanReviewBlock,
	type OutlinePlanReviewClaim,
	type OutlinePlanReviewFound,
	type OutlinePlanRoot,
	omittableReviews,
	type PlanReviewCommentInput,
	planReviewBlockId,
	planReviewBlocks,
	planSubmitProblemText,
	readPlanReview,
	readPlanSubmission,
	renderPlanForReview,
	reviewDiffOptions,
	undoOutlinePlanDecision,
	writePlanReview,
} from "./outline/plans";
import { outlineStore } from "./outline/store";
import { readTaskSession } from "./task-source/backend";

/** Whether `narratorId` plans in the outline: an outline root session while the outline is on. */
export async function isOutlinePlanSession(narratorId: string): Promise<boolean> {
	if (!isOutlineEnabled()) return false;
	const session = await readTaskSession(narratorId).catch(() => null);
	return (
		!!session &&
		session.backend === "outline" &&
		!session.subagent &&
		session.sessionNarratorId === narratorId
	);
}

/**
 * How a session's plan-mode cycle plans (review round 1 S7): `outline` (its plan root, null until
 * EnterPlanMode made one), or `legacy` for a plan-file cycle begun before plan PR 8 (plan mode on,
 * a plan file identity, and no plan being planned), which keeps the plan-file flow until it ends.
 * Null when the session does not plan in the outline at all (spec, a subagent, outline off).
 */
export async function outlinePlanCycle(
	narratorId: string,
): Promise<{ kind: "outline"; root: OutlinePlanRoot | null } | { kind: "legacy" } | null> {
	if (!(await isOutlinePlanSession(narratorId))) return null;
	const root = await findPlanningRoot(narratorId).catch((error) => {
		logger.warn("Outline plan root could not be read", { narratorId, error: String(error) });
		return null;
	});
	if (root) return { kind: "outline", root };
	const { narrators } = await import("../db/schema");
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { planFileId: true, planMode: true },
	});
	return row?.planMode && row.planFileId ? { kind: "legacy" } : { kind: "outline", root: null };
}

/**
 * The plan-mode prompt's view of the session's plan (review round 1 S4): its address only, which
 * does not change while the plan is planned (its title is the agent's to rewrite, and the prompt
 * is the front of the request prefix). Null root: none yet. Null: not an outline cycle.
 */
export async function outlinePlanPromptRoot(
	narratorId: string,
): Promise<{ root: { address: string } | null } | null> {
	const cycle = await outlinePlanCycle(narratorId);
	if (cycle?.kind !== "outline") return null;
	return { root: cycle.root ? { address: cycle.root.address } : null };
}

/**
 * `EnterPlanMode` in an outline session: make or resume the plan root and say where it is. Null
 * when the session does not plan in the outline (the plan-file flow applies).
 */
export async function enterOutlinePlanMode(args: {
	narratorId: string;
	userId: string | null;
	input: Record<string, unknown>;
	locale: Locale;
	toolCallId?: string | null;
	messageId?: string | null;
}): Promise<{ output: string; isError?: boolean } | null> {
	if (!(await isOutlinePlanSession(args.narratorId))) return null;
	const text = (key: string) =>
		typeof args.input[key] === "string" ? (args.input[key] as string) : null;
	try {
		const ensured = await ensurePlanRoot({
			session: args.narratorId,
			userId: args.userId,
			title: text("plan_name"),
			under: text("under"),
			root: text("root"),
			locale: args.locale,
			toolCallId: args.toolCallId ?? null,
			messageId: args.messageId ?? null,
		});
		return {
			output: getOutlinePlanEnterOutput(
				args.locale,
				{
					address: ensured.root.address,
					title: ensured.root.title,
					version: (ensured.root.task.plan?.round ?? 0) + 1,
				},
				ensured.how,
			),
		};
	} catch (error) {
		if (error instanceof OutlinePlanError) return { output: error.message, isError: true };
		throw error;
	}
}

/** The plan-mode switch was turned off: an empty plan is removed, any other stays planning. */
export async function cancelOutlinePlanMode(narratorId: string, userId: string | null) {
	if (!(await isOutlinePlanSession(narratorId))) return;
	await discardEmptyPlanRoot({ session: narratorId, userId }).catch((error) => {
		logger.warn("Empty outline plan root could not be removed", {
			narratorId,
			error: String(error),
		});
	});
}

export { outlinePlanSubmissionOf };

/** An ExitPlanMode input without the keys only the server writes (review round 1 S6). */
export function withoutOutlinePlanKeys(input: Record<string, unknown>): Record<string, unknown> {
	if (!OUTLINE_PLAN_SUBMISSION_KEYS.some((key) => key in input)) return input;
	const out: Record<string, unknown> = { ...input };
	for (const key of OUTLINE_PLAN_SUBMISSION_KEYS) delete out[key];
	return out;
}

/**
 * Whether `submission` was decided already by an approval of `narratorId` (review round 1 S2: a
 * decision written before its resolution was lost): its root is that session's approved plan at
 * a round at least the submitted one.
 */
async function decidedSubmission(
	narratorId: string,
	submission: OutlinePlanSubmission | null,
): Promise<boolean> {
	if (!submission) return false;
	const block = await outlineStore.getBlock(submission.root.blockId).catch(() => null);
	const plan = block && !block.deleted ? block.taskJson?.plan : undefined;
	return (
		plan?.state === "approved" && plan.by === narratorId && plan.round >= submission.root.round
	);
}

/**
 * Resolve ExitPlanMode for an outline session (see the module header, step 3). Null when the
 * session does not plan in the outline, or when its cycle is a plan-file one begun before plan PR
 * 8 (`outlinePlanCycle`, S7) and the call does not declare `outline`: the plan-file flow applies
 * (the caller strips the `_plan*` keys first, S6).
 *
 * A persisted submission whose plan was approved since (its decision written, its resolution lost
 * to a restart; S2) is kept as it is, so the request is decided as approved: only for a call
 * restored from what was persisted (`recovered`; review round 2 N3).
 */
export async function resolveOutlineExitPlanInput(
	narratorId: string,
	input: Record<string, unknown>,
	locale: Locale,
	options: {
		/**
		 * The call is one persisted before (a request restored after a restart, a recovered
		 * gate): its `_plan*` keys are the server's own resolution. A model's fresh call never is,
		 * so its keys are dropped and the plan read anew (review round 2 N3).
		 */
		recovered?: boolean;
		/**
		 * This is the call's permission resolving it (`handlePermission`): what the review gate
		 * handed on for this tool use is taken, once (PR 8b, review rounds 1 S2 and 2 N8): its
		 * review, never one the input names, and the version it was submitted at.
		 */
		toolUseId?: string | null;
		/** The call's tool call: a review counts only as written for this call. */
		toolCallId?: string | null;
	} = {},
): Promise<
	| { ok: true; input: Record<string, unknown> }
	| { ok: false; message: string; input: Record<string, unknown> }
	| null
> {
	const cycle = await outlinePlanCycle(narratorId);
	if (!cycle) return null;
	const mode = typeof input.mode === "string" ? input.mode.trim().toLowerCase() : "";
	const rootRef = typeof input.root === "string" && input.root.trim() ? input.root : null;
	if (cycle.kind === "legacy" && mode !== "outline" && !rootRef) return null;
	if (
		options.recovered === true &&
		(await decidedSubmission(narratorId, outlinePlanSubmissionOf(input)))
	) {
		return { ok: true, input };
	}
	const planning = cycle.kind === "outline" ? cycle.root : null;
	const legacyMode = mode === "inline" || mode === "file";
	const {
		inline_plan: _inline,
		plan: _plan,
		plan_file_path: _file,
		_planFile: _resolvedFile,
		summary,
		...rest
	} = input;
	// The agent's summary of the version, from its argument, or kept from an input resolved before
	// (a call resolved again: a taken-over or reviewed plan's permission). Display text only.
	const summaryText =
		typeof summary === "string"
			? summary
			: typeof input._planSummary === "string"
				? input._planSummary
				: null;
	// The review this call has (PR 8b), never from a model's own keys (review round 1 S2): for a
	// fresh call, the one the review gate handed on for it; for a call restored from what was
	// persisted, the one its persisted input names. `readPlanSubmission` attaches it only as the
	// outline proves it: one of this version's reviews, written for this call.
	const persisted = options.recovered === true ? outlinePlanSubmissionOf(input) : null;
	const handed =
		!persisted && options.toolUseId ? takeHandedCall(narratorId, options.toolUseId) : null;
	const review = persisted
		? claimOf(persisted, options.toolCallId ?? null)
		: handed?.blockId
			? {
					rootId: handed.rootId,
					blockId: handed.blockId,
					round: handed.round,
					submittedSeq: handed.submittedSeq,
					toolCallId: handed.toolCallId,
				}
			: null;
	const stripped = withoutOutlinePlanKeys(rest);
	if (legacyMode) {
		return {
			ok: false,
			input: stripped,
			message: planSubmitProblemText(locale, {
				kind: "wrongMode",
				address: planning?.address ?? rootRef ?? "",
			}),
		};
	}
	const read = await readPlanSubmission({
		session: narratorId,
		rootRef,
		summary: summaryText,
		review,
		// Only a model's fresh call is held to the plan's layout (plan readability): a call restored
		// from what was persisted, or one the review gate handed on, is in front of a person already.
		checkStructure: !persisted && !handed,
	});
	if (!read.ok) {
		return { ok: false, input: stripped, message: planSubmitProblemText(locale, read.problem) };
	}
	const s = read.submission;
	// The version the person decides on is the one submitted (review round 1 S1): a restored call
	// keeps the seq it persisted, a call the review gate handed on (with or without comments;
	// round 2 N7) the one it was submitted at; what changed since is told to the agent as the
	// person's changes while deciding.
	const kept =
		persisted ??
		(handed
			? { root: { blockId: handed.rootId, round: handed.round }, seq: handed.submittedSeq }
			: null);
	const seq =
		kept && kept.root.blockId === s.root.blockId && kept.root.round === s.root.round && kept.seq > 0
			? Math.min(kept.seq, s.seq)
			: s.seq;
	return {
		ok: true,
		input: {
			...stripped,
			mode: "outline",
			plan: read.markdown,
			_planRoot: s.root,
			_planSeq: seq,
			_planBaseSeq: s.baseSeq,
			_planDiff: { counts: s.counts, truncated: s.truncated },
			...(s.summary ? { _planSummary: s.summary } : {}),
			...(s.review ? { _planReview: s.review } : {}),
		},
	};
}

// ─── Plan review (PR 8b) ───

/** The review a persisted submission names, as a claim for this call. */
function claimOf(
	submission: OutlinePlanSubmission,
	toolCallId: string | null,
): OutlinePlanReviewClaim | null {
	const review = submission.review;
	return review
		? {
				rootId: submission.root.blockId,
				blockId: review.blockId,
				round: review.round,
				submittedSeq: review.submittedSeq || submission.seq,
				toolCallId,
			}
		: null;
}

/**
 * What the review gate hands on to the call's permission (review rounds 1 S2 and 2 N7): the
 * version submitted, and the review's block when it left comments.
 */
interface HandedCall {
	rootId: string;
	round: number;
	submittedSeq: number;
	toolCallId: string | null;
	blockId: string | null;
}

/**
 * The calls the review gate handed on to a person (review round 1 S2), by session and tool use:
 * a server-side channel, so a model's call can never name a review. Taken once, by the call's
 * permission resolving it; a new review of the same tool use starts by forgetting what an earlier
 * attempt left (review round 2 N8). At most {@link HANDED_CALLS}, the oldest dropped first.
 */
const handedCalls = hotSafe(
	"narrafork.outlinePlanHandedCalls",
	() => new Map<string, HandedCall>(),
);
const HANDED_CALLS = 2048;

function callKey(narratorId: string, toolUseId: string): string {
	return `${narratorId}\n${toolUseId}`;
}

function handOn(narratorId: string, toolUseId: string, call: HandedCall): void {
	const key = callKey(narratorId, toolUseId);
	handedCalls.delete(key);
	handedCalls.set(key, call);
	while (handedCalls.size > HANDED_CALLS) {
		const oldest = handedCalls.keys().next().value;
		if (oldest === undefined) break;
		handedCalls.delete(oldest);
	}
}

/** What was handed on for the call, taken (it is in the call's resolved input from then on). */
function takeHandedCall(narratorId: string, toolUseId: string): HandedCall | null {
	const key = callKey(narratorId, toolUseId);
	const call = handedCalls.get(key) ?? null;
	handedCalls.delete(key);
	return call;
}

/**
 * Forget what was handed on for a call (a new review of it begins, its permission ran, or it was
 * decided): a later attempt never picks up an earlier one's (review round 2 N8). With `only`, just
 * that hand-off, if it is still the one there.
 */
export function forgetHandedCall(
	narratorId: string,
	toolUseId: string | null | undefined,
	only?: object | null,
): void {
	if (!toolUseId) return;
	const key = callKey(narratorId, toolUseId);
	if (only === undefined || handedCalls.get(key) === only) handedCalls.delete(key);
}

/**
 * A review gate handing an outline plan to a person without comments (the review could not
 * finish, or was taken over before it wrote any): the version submitted goes on, so what the
 * person changes from then on is told to the agent (review round 2 N7). Never over what this
 * attempt's review handed on already (its comments). Returns the hand-off written, for the caller
 * to take back if its handover does not happen (review round 3); null when nothing was written.
 */
export function handOnSubmission(args: {
	narratorId: string;
	toolUseId: string;
	toolCallId?: string | null;
	input: Record<string, unknown>;
}): object | null {
	const submission = outlinePlanSubmissionOf(args.input);
	if (!submission || handedCalls.has(callKey(args.narratorId, args.toolUseId))) return null;
	const call: HandedCall = {
		rootId: submission.root.blockId,
		round: submission.root.round,
		submittedSeq: submission.seq,
		toolCallId: args.toolCallId ?? null,
		blockId: null,
	};
	handOn(args.narratorId, args.toolUseId, call);
	return call;
}

/** The call was decided: what was handed on for it is in its persisted input from now on. */
function dropHandedReview(narratorId: string, toolUseId: string | null | undefined): void {
	forgetHandedCall(narratorId, toolUseId);
}

export { planReviewBlockId };

/** The submission with its review, handed on to the call's permission. */
function withReview(
	narratorId: string,
	toolUseId: string,
	submission: OutlinePlanSubmission,
	input: Record<string, unknown>,
	block: OutlinePlanReviewBlock,
	toolCallId: string | null,
): { review: OutlinePlanReview; input: Record<string, unknown> } {
	const review: OutlinePlanReview = { ...block, submittedSeq: submission.seq };
	handOn(narratorId, toolUseId, {
		rootId: submission.root.blockId,
		blockId: review.blockId,
		round: review.round,
		submittedSeq: review.submittedSeq,
		toolCallId,
	});
	// The plan, its counts and `_planSeq` stay the submission's: the review's comments are not
	// part of the plan's rendering or its diff (review round 1 N1, N2), and the version the person
	// decides on is the one submitted (S1).
	return { review, input: { ...input, _planReview: review } };
}

export type OutlinePlanReviewResult =
	| { ok: true; review: OutlinePlanReview; input: Record<string, unknown> }
	| { ok: false; message: string };

/**
 * A review's concerns on the outline plan a waiting ExitPlanMode submitted (`input`, as resolved):
 * written under the plan root (`writePlanReview`), and handed on to the call's permission
 * (`_planReview`). `ok: false`: refused, the message for the reviewer (out of bounds, a target
 * outside the plan, the plan decided meanwhile).
 */
export async function reviewOutlinePlan(args: {
	narratorId: string;
	requestId: string;
	/** The ExitPlanMode call reviewed: its tool use and tool call. */
	toolUseId: string;
	toolCallId?: string | null;
	input: Record<string, unknown>;
	comments: readonly PlanReviewCommentInput[];
	/** The person the turn runs for: the commit's responsible person. */
	userId: string | null;
	locale: Locale;
}): Promise<OutlinePlanReviewResult> {
	const submission = outlinePlanSubmissionOf(args.input);
	if (!submission || !(await isOutlinePlanSession(args.narratorId)))
		return {
			ok: false,
			message: "This review is not of a plan in the outline; PlanReview does not apply.",
		};
	let block: OutlinePlanReviewBlock;
	try {
		block = await writePlanReview({
			session: args.narratorId,
			rootId: submission.root.blockId,
			round: submission.root.round,
			blockId: planReviewBlockId(args.requestId, submission.root.round),
			comments: args.comments,
			userId: args.userId,
			locale: args.locale,
			toolCallId: args.toolCallId ?? null,
		});
	} catch (error) {
		if (error instanceof OutlinePlanError) return { ok: false, message: error.message };
		throw error;
	}
	return {
		ok: true,
		...withReview(
			args.narratorId,
			args.toolUseId,
			submission,
			args.input,
			block,
			args.toolCallId ?? null,
		),
	};
}

/**
 * A review restored after a restart that had written its comments already (they are under the
 * plan as the block {@link planReviewBlockId} names, written for this call): the submission with
 * them, handed on for a person to decide on. Null when it had not (the review runs again).
 */
export async function recoverOutlinePlanReview(args: {
	narratorId: string;
	requestId: string;
	toolUseId: string;
	toolCallId?: string | null;
	input: Record<string, unknown>;
	locale: Locale;
}): Promise<{ review: OutlinePlanReview; input: Record<string, unknown> } | null> {
	const submission = outlinePlanSubmissionOf(args.input);
	if (!submission) return null;
	const block = await readPlanReview({
		session: args.narratorId,
		rootId: submission.root.blockId,
		blockId: planReviewBlockId(args.requestId, submission.root.round),
		round: submission.root.round,
		toolCallId: args.toolCallId ?? null,
	}).catch(() => null);
	if (!block) return null;
	return withReview(
		args.narratorId,
		args.toolUseId,
		submission,
		args.input,
		block,
		args.toolCallId ?? null,
	);
}

/**
 * The prompt of an outline plan's review: the plan as submitted (as of its seq), each block with
 * its short id. Null when the input is not an outline submission.
 */
export async function outlinePlanReviewPrompt(args: {
	narratorId: string;
	requestId: string;
	input: Record<string, unknown>;
	locale: Locale;
}): Promise<string | null> {
	const submission = outlinePlanSubmissionOf(args.input);
	if (!submission) return null;
	// Without this version's earlier reviews (a cancelled call's; review round 1 N1), while they
	// are only what the review wrote (review round 2 S3).
	const labelled = await planReviewBlocks(
		outlineStore,
		args.narratorId,
		{ id: submission.root.blockId, spaceId: submission.root.spaceId },
		submission.baseSeq,
	)
		.then((reviews) =>
			renderPlanForReview({
				rootId: submission.root.blockId,
				seq: submission.seq,
				omit: omittableReviews(reviews),
			}),
		)
		.catch((error) => {
			logger.warn("Outline plan could not be rendered for its review", {
				root: submission.root.address,
				error: String(error),
			});
			return null;
		});
	return getOutlinePlanReviewPrompt(args.locale, {
		requestId: args.requestId,
		address: submission.root.address,
		version: submission.root.round,
		summary: submission.summary,
		plan: labelled ?? (typeof args.input.plan === "string" ? args.input.plan : ""),
		limits: {
			comments: OUTLINE_PLAN_LIMITS.reviewComments,
			chars: OUTLINE_PLAN_LIMITS.reviewCommentChars,
		},
	});
}

/**
 * What the person changed in the plan since the version submitted (`submission.seq`) until
 * `untilSeq` (null: now), as diff lines for the agent; empty when nothing. The version's reviews
 * are left out while they are only what the review wrote: the agent is told of them on their own
 * (review round 1 S1). Anything written into or under one is told as a change (round 2 S3).
 */
async function editsSinceSubmitted(
	narratorId: string,
	submission: OutlinePlanSubmission,
	untilSeq: number | null,
): Promise<string> {
	if (untilSeq !== null && untilSeq <= submission.seq) return "";
	const root = submission.root;
	const reviews = await planReviewBlocks(
		outlineStore,
		narratorId,
		{ id: root.blockId, spaceId: root.spaceId },
		submission.baseSeq,
	).catch(() => new Map<string, OutlinePlanReviewFound>());
	// Only what the person added or changed is told, inside a review too (review round 3 N9).
	const diff = await readPlanDiff({
		rootId: root.blockId,
		fromSeq: submission.seq,
		toSeq: untilSeq,
		...reviewDiffOptions(reviews),
	}).catch(() => null);
	if (!diff || planDiffIsEmpty(diff.counts)) return "";
	return planDiffLines(diff, root.address.split("/")[0] ?? "");
}

/** A review as the agent's prompts name it (count and address), when it left comments. */
function reviewForPrompt(
	submission: OutlinePlanSubmission,
): { count: number; address: string } | null {
	const review = submission.review;
	return review && review.count > 0 ? { count: review.count, address: review.address } : null;
}

/** A person's decision made on the card, kept until the approved pass restarts. */
interface OutlinePlanDecisionRecord {
	rootId: string;
	action: "draft" | "lock";
	delegateTitle: string | null;
	/** The person's changes while deciding, as diff lines (empty: none). */
	edits: string;
}

const decisions = hotSafe<Map<string, OutlinePlanDecisionRecord>>(
	"narrafork.outlinePlanDecisions",
	() => new Map(),
);

async function narratorTitle(narratorId: string): Promise<string | null> {
	const { narrators } = await import("../db/schema");
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { title: true },
	});
	return row?.title ?? null;
}

/**
 * A person's decision on a submitted outline plan (`POST /narrators/permissions/:id/plan`): the
 * outline first, then the waiting ExitPlanMode. The caller checked the person may decide for the
 * session (write access to it). 404: no such waiting plan; 403: locking without write access to
 * the session space, or naming a delegate they may not write; 409: the plan changed since the
 * version they looked at, or was decided already.
 */
export async function decideOutlinePlanRequest(args: {
	requestId: string;
	principal: OutlinePrincipal;
	body: OutlinePlanDecisionRequest;
}): Promise<{ commit: { id: string; seq: number } | null }> {
	const { pendingPermissions } = await import("./narrator-session-state");
	const pending = pendingPermissions.get(args.requestId);
	const submission =
		pending?.toolName === "ExitPlanMode" ? outlinePlanSubmissionOf(pending.input) : null;
	if (!pending || !submission || !(await isOutlinePlanSession(pending.narratorId)))
		throw new NotFoundError("Outline plan waiting for a decision", args.requestId);
	const narratorId = pending.narratorId;
	const locale = pending.locale ?? "en";
	const { body, principal } = args;
	if (body.action === "lock") {
		const space = await outlineStore.getSpace(submission.root.spaceId);
		if (!space || !(await canWriteSpace(principal, space)))
			throw new OutlinePlanForbidden("You cannot lock this plan");
		if (body.delegate) {
			const narrator = await readNarrator(body.delegate);
			const reads =
				narrator &&
				(principal.isAdmin ||
					(await narratorUsersWith(narrator, [principal.userId], "read")).has(principal.userId));
			if (!narrator || !reads) throw new NotFoundError("Narrator", body.delegate);
			const writes =
				principal.isAdmin ||
				(await narratorUsersWith(narrator, [principal.userId], "write")).has(principal.userId);
			if (!writes) throw new OutlinePlanForbidden("You cannot name this session to confirm");
		}
	}
	const { resolvePermission } = await import("./narrator-permission");
	const feedback = body.feedback?.trim() || null;
	let decision: Awaited<ReturnType<typeof decideOutlinePlan>>;
	try {
		decision = await decideOutlinePlan({
			session: narratorId,
			rootId: submission.root.blockId,
			round: submission.root.round,
			action: body.action,
			decider: { kind: "human", userId: principal.userId },
			feedback,
			delegate: body.action === "lock" ? (body.delegate ?? null) : null,
			seenSeq: body.seenSeq,
			locale,
		});
	} catch (error) {
		// The plan is gone (deleted, its checkbox taken away, moved off; review round 1 N1): a
		// return still sends it back, with nothing to write.
		if (
			body.action === "return" &&
			error instanceof OutlinePlanError &&
			error.planCode === "OUTLINE_PLAN_NOT_FOUND"
		) {
			const resolved = await resolvePermission(args.requestId, "deny", {
				userId: principal.userId,
				decidedBy: "user",
				...(feedback ? { feedbackText: feedback } : {}),
				outlinePlanMessage: getOutlinePlanReturnedMessage(locale, {
					feedback,
					noteAddress: null,
					rootAddress: submission.root.address,
					gone: true,
					edits: "",
				}),
			});
			if (!resolved) throw notWaiting(args.requestId);
			return { commit: null };
		}
		throw error;
	}
	// What the person changed while deciding: the plan as submitted against the plan just before
	// the decision's own commit (told to the agent on a return too; review round 1 N3).
	// Since the version submitted, while a review ran too (review round 1 S1).
	let edits = "";
	const decidedAt = decision.result?.commit?.seq;
	if (decision.effective !== "return" || body.action === "return")
		edits = await editsSinceSubmitted(narratorId, submission, decidedAt ? decidedAt - 1 : null);
	// The request was gone when this decision was to be resolved (review round 1 S1). The plan is
	// put back only when the request was not approved meanwhile (review round 2 N2): someone else's
	// approval a moment earlier means the plan is being executed, and it stays approved.
	const undo = async () => {
		const elsewhere = await howDecidedElsewhere(args.requestId);
		if (elsewhere === "allowed") throw decidedElsewhere(args.requestId);
		await undoOutlinePlanDecision({
			session: narratorId,
			decision,
			responsibleUserId: principal.userId,
		}).catch((error) => {
			logger.error("A plan decision whose request was gone could not be taken back", {
				narratorId,
				root: submission.root.address,
				error: String(error),
			});
		});
		throw notWaiting(args.requestId);
	};
	if (decision.effective === "return") {
		const resolved = await resolvePermission(args.requestId, "deny", {
			userId: principal.userId,
			decidedBy: "user",
			...(feedback ? { feedbackText: feedback } : {}),
			outlinePlanMessage: getOutlinePlanReturnedMessage(locale, {
				feedback,
				noteAddress: decision.noteAddress,
				rootAddress: decision.root.address,
				edits,
				review: reviewForPrompt(submission),
			}),
		});
		if (!resolved) await undo();
		dropHandedReview(narratorId, pending.toolUseId);
		return { commit: decision.result?.commit ?? null };
	}
	// What the plan is now, not what was asked (S2: a lock asked of a draft written before).
	const after = await outlineStore.getBlock(submission.root.blockId);
	const lock = after?.taskJson?.lock ?? null;
	const record: OutlinePlanDecisionRecord = {
		rootId: submission.root.blockId,
		action: lock ? "lock" : "draft",
		delegateTitle: lock?.delegate ? ((await narratorTitle(lock.delegate)) ?? null) : null,
		edits,
	};
	decisions.set(narratorId, record);
	const resolved = await resolvePermission(args.requestId, "allow", {
		userId: principal.userId,
		decidedBy: "user",
		...(body.compactAfter ? { compactAfter: true } : {}),
		...(feedback ? { feedbackText: feedback } : {}),
	});
	if (!resolved) {
		// Cancelled, refused or approved meanwhile: this decision's record is not the approval's
		// (an approval elsewhere reads the plan as it is), and the plan goes back unless approved.
		if (decisions.get(narratorId) === record) decisions.delete(narratorId);
		await undo();
	}
	return { commit: decision.result?.commit ?? null };
}

/** How long a request that went away is watched for its decision to be persisted. */
const DECIDED_ELSEWHERE_WAIT = { attempts: 10, intervalMs: 50 };

/**
 * How a request that went away was decided, from its tool call (review round 2 N2): `allowed`
 * once it runs or ran, `refused` when it failed (denied, cancelled, aborted), and `undecided` when
 * nothing was persisted within a short wait (its session dropped the waiting request; it is not
 * executed, and a restored request asks again). The decision is persisted right after the
 * request leaves the waiting set, so a few short waits see it.
 */
async function howDecidedElsewhere(
	requestId: string,
): Promise<"allowed" | "refused" | "undecided"> {
	for (let attempt = 0; attempt < DECIDED_ELSEWHERE_WAIT.attempts; attempt++) {
		const row = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, requestId),
			columns: { status: true },
		});
		if (!row) return "undecided";
		if (row.status === "running" || row.status === "success") return "allowed";
		if (row.status === "fail") return "refused";
		await new Promise((resolve) => setTimeout(resolve, DECIDED_ELSEWHERE_WAIT.intervalMs));
	}
	return "undecided";
}

/** 409: the request was not waiting any more when the decision was to be resolved. */
function notWaiting(requestId: string): OutlinePlanError {
	return new OutlinePlanError(
		`The plan is no longer waiting for a decision (${requestId}); nothing was kept`,
		"OUTLINE_PLAN_NOT_WAITING",
	);
}

/** 409: the request was approved elsewhere a moment earlier; the plan stays approved. */
function decidedElsewhere(requestId: string): OutlinePlanError {
	return new OutlinePlanError(
		`The plan was approved elsewhere a moment ago (${requestId}); it is being executed`,
		"OUTLINE_PLAN_DECIDED",
	);
}

/** 403 for a decision the person may not make. */
export class OutlinePlanForbidden extends OutlinePlanError {
	constructor(message: string) {
		super(message, "OUTLINE_PLAN_FORBIDDEN");
		this.name = "OutlinePlanForbidden";
	}
}

/** The outline plan an ExitPlanMode tool call submitted, read from its persisted input. */
async function submittedPlanOf(
	narratorId: string,
	toolUseId: string,
): Promise<OutlinePlanSubmission | null> {
	const row = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
		columns: { inputJson: true },
	});
	return outlinePlanSubmissionOf(row?.inputJson as Record<string, unknown> | null);
}

/** An approved outline plan, ready for its first pass. */
export interface ApprovedOutlinePlan {
	submission: OutlinePlanSubmission;
	approval: { kind: "draft" } | { kind: "locked"; delegate: string | null };
	edits: string;
}

/**
 * The plan an approved ExitPlanMode submitted, made sure to be approved: a decision taken on the
 * card is used as it was; an approval that came another way (the plain approve route or frame, a
 * plan review, a restored request) is recorded now as a draft on the approver's behalf (only
 * people lock). Null when the call was not an outline plan's.
 */
export async function settleApprovedOutlinePlan(args: {
	narratorId: string;
	toolUseId: string;
	locale: Locale;
	/** The person who approved, when one did (ignored when a plan review approved it). */
	approverUserId: string | null;
	/** The person the turn runs for (responsible for an approval the system records). */
	turnUserId: string | null;
	/** A plan review approved it. */
	byReview: boolean;
	/**
	 * The call's input as just resolved, when the caller has it before it is persisted (a re-run
	 * of a denied call; review round 1 N2). Default: the persisted input.
	 */
	input?: Record<string, unknown> | null;
}): Promise<ApprovedOutlinePlan | null> {
	// Only an outline session's call (review round 1 S6): a model cannot divert another's.
	if (!(await isOutlinePlanSession(args.narratorId))) return null;
	const submitted = args.input
		? outlinePlanSubmissionOf(args.input)
		: await submittedPlanOf(args.narratorId, args.toolUseId).catch(() => null);
	if (!submitted) return null;
	dropHandedReview(args.narratorId, args.toolUseId);
	// A review's own approval found no concerns: there are no comments to tell the agent of.
	const submission = args.byReview ? { ...submitted, review: null } : submitted;
	const recorded = decisions.get(args.narratorId);
	if (recorded && recorded.rootId === submission.root.blockId) {
		decisions.delete(args.narratorId);
		return {
			submission,
			approval:
				recorded.action === "lock"
					? { kind: "locked", delegate: recorded.delegateTitle }
					: { kind: "draft" },
			edits: recorded.edits,
		};
	}
	let approval: ApprovedOutlinePlan["approval"] = { kind: "draft" };
	let decidedAt: number | null = null;
	// A review's approval is the system's, even with a person's approval left over from an
	// earlier allow (D48 ⑦: it must not count as the person's work; review round 2 N4).
	const approver = args.byReview ? null : args.approverUserId;
	try {
		const decision = await decideOutlinePlan({
			session: args.narratorId,
			rootId: submission.root.blockId,
			round: submission.root.round,
			action: "draft",
			decider: {
				kind: "system",
				id: args.byReview ? OUTLINE_PLAN_REVIEW_ACTOR : OUTLINE_PLAN_ACTOR,
				responsibleUserId: approver ?? args.turnUserId,
				approvedBy: approver
					? { kind: "human", id: approver }
					: { kind: "system", id: args.byReview ? OUTLINE_PLAN_REVIEW_ACTOR : OUTLINE_PLAN_ACTOR },
			},
			locale: args.locale,
		});
		decidedAt = decision.result?.commit?.seq ?? null;
		// Decided before (a card decision whose resolution was lost): tell what the plan is.
		const lock = decision.result ? null : (decision.before.lock ?? null);
		if (decision.effective === "lock" && lock)
			approval = {
				kind: "locked",
				delegate: lock.delegate ? ((await narratorTitle(lock.delegate)) ?? null) : null,
			};
	} catch (error) {
		logger.warn("Approved outline plan could not be recorded as approved", {
			narratorId: args.narratorId,
			root: submission.root.address,
			error: String(error),
		});
	}
	// What changed since the version submitted (while a review ran, or the person decided another
	// way) is told too (review round 1 S1).
	const edits = await editsSinceSubmitted(
		args.narratorId,
		submitted,
		decidedAt !== null ? decidedAt - 1 : null,
	);
	return { submission, approval, edits };
}

/**
 * The message that starts an approved plan's first pass: the root and its first step that can
 * start are started for the session (the same system start as a continuation), and named.
 */
export async function startApprovedOutlinePlan(args: {
	narratorId: string;
	approved: ApprovedOutlinePlan;
	locale: Locale;
	compact: boolean;
}): Promise<string> {
	const { taskSourceForNarrator } = await import("./task-source");
	const source = await taskSourceForNarrator(args.narratorId);
	const root = args.approved.submission.root;
	let task: { address: string | null; title: string; status: "doing" | "blocked" } | null = null;
	try {
		const target = await source.prepareContinuation({
			promoteTodo: true,
			preferTaskId: root.blockId,
		});
		if (target.openTask)
			task = {
				address: source.taskAddress?.(target.openTask) ?? null,
				title: target.openTask.text,
				status: target.openTask.status,
			};
	} catch (error) {
		logger.warn("Approved outline plan could not start its first step", {
			narratorId: args.narratorId,
			root: root.address,
			error: String(error),
		});
	}
	return getOutlinePlanApprovedPrompt({
		locale: args.locale,
		approval: args.approved.approval,
		root: { address: root.address, title: root.title },
		task,
		edits: args.approved.edits,
		compact: args.compact,
		review: reviewForPrompt(args.approved.submission),
	});
}
