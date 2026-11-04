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
 *      `_planDiff`. It then waits for a person as every ExitPlanMode does.
 *   4. The person decides on the card through `POST /narrators/permissions/:id/plan`
 *      ({@link decideOutlinePlanRequest}): the outline is written first (`decideOutlinePlan`),
 *      then the request is resolved. A refused write (409, 403) leaves the request waiting.
 *   5. Any approval, whichever way it came (the card, the plain approve route or frame, a plan
 *      review), ends in `onExitPlanMode`: {@link settleApprovedOutlinePlan} makes sure the plan is
 *      approved (as a draft, on the approver's behalf, when it did not come through the card).
 *      The pass then restarts with {@link startApprovedOutlinePlan}: the root and its first step
 *      that can start are started for the session, and the message names that step.
 *
 * Plan review (plan reflection) is unchanged in this PR: it reviews the rendered plan and, when it
 * confirms, approves it (step 5 records that as a draft on the person's behalf, never a lock);
 * when it asks for a revision the plan goes back to the agent as before. Turning its findings into
 * comments under the plan is plan PR 8b.
 */

import type { OutlinePlanDecisionRequest, OutlinePlanSubmission } from "@shared/outline-api";
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
	type Locale,
} from "../lib/prompt-i18n";
import { canWriteSpace, narratorUsersWith, type OutlinePrincipal } from "./outline/access";
import { readNarrator } from "./outline/access-reads";
import { isOutlineEnabled } from "./outline/feature";
import { planDiffIsEmpty, planDiffLines, readPlanDiff } from "./outline/plan-diff";
import {
	decideOutlinePlan,
	discardEmptyPlanRoot,
	ensurePlanRoot,
	findPlanningRoot,
	OUTLINE_PLAN_ACTOR,
	OutlinePlanError,
	planSubmitProblemText,
	readPlanSubmission,
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

/** The plan-mode prompt's view of the session's plan: its root and the next version. */
export async function outlinePlanPromptRoot(
	narratorId: string,
): Promise<{ address: string; title: string; version: number } | null> {
	if (!(await isOutlinePlanSession(narratorId))) return null;
	const root = await findPlanningRoot(narratorId).catch((error) => {
		logger.warn("Outline plan root could not be read for the plan-mode prompt", {
			narratorId,
			error: String(error),
		});
		return null;
	});
	return root
		? { address: root.address, title: root.title, version: (root.task.plan?.round ?? 0) + 1 }
		: null;
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

/**
 * Resolve ExitPlanMode for an outline session (see the module header, step 3). Null when the
 * session does not plan in the outline, or when it is a plan-file cycle begun before plan PR 8
 * (no plan being planned, and the call declares `inline` or `file`): the plan-file flow applies.
 */
export async function resolveOutlineExitPlanInput(
	narratorId: string,
	input: Record<string, unknown>,
	locale: Locale,
): Promise<
	| { ok: true; input: Record<string, unknown> }
	| { ok: false; message: string; input: Record<string, unknown> }
	| null
> {
	if (!(await isOutlinePlanSession(narratorId))) return null;
	const mode = typeof input.mode === "string" ? input.mode.trim().toLowerCase() : "";
	const rootRef = typeof input.root === "string" && input.root.trim() ? input.root : null;
	const legacyMode = mode === "inline" || mode === "file";
	const planning = rootRef ? null : await findPlanningRoot(narratorId);
	if (legacyMode && !rootRef && !planning) return null;
	const {
		inline_plan: _inline,
		plan: _plan,
		plan_file_path: _file,
		_planFile: _resolvedFile,
		summary,
		...rest
	} = input;
	const stripped: Record<string, unknown> = { ...rest };
	for (const key of OUTLINE_PLAN_SUBMISSION_KEYS) delete stripped[key];
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
		summary: typeof summary === "string" ? summary : null,
	});
	if (!read.ok) {
		return { ok: false, input: stripped, message: planSubmitProblemText(locale, read.problem) };
	}
	const s = read.submission;
	return {
		ok: true,
		input: {
			...stripped,
			mode: "outline",
			plan: read.markdown,
			_planRoot: s.root,
			_planSeq: s.seq,
			_planBaseSeq: s.baseSeq,
			_planDiff: { counts: s.counts, truncated: s.truncated },
			...(s.summary ? { _planSummary: s.summary } : {}),
		},
	};
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
	if (!pending || !submission)
		throw new NotFoundError("Outline plan waiting for a decision", args.requestId);
	const narratorId = pending.narratorId;
	const locale = pending.locale ?? "en";
	const { body, principal } = args;
	let delegateTitle: string | null = null;
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
			delegateTitle = (await narratorTitle(body.delegate)) ?? null;
		}
	}
	const decision = await decideOutlinePlan({
		session: narratorId,
		rootId: submission.root.blockId,
		round: submission.root.round,
		action: body.action,
		decider: { kind: "human", userId: principal.userId },
		feedback: body.feedback ?? null,
		delegate: body.action === "lock" ? (body.delegate ?? null) : null,
		seenSeq: body.seenSeq,
		locale,
	});
	const { resolvePermission } = await import("./narrator-permission");
	if (body.action === "return") {
		const feedback = body.feedback?.trim() || null;
		await resolvePermission(args.requestId, "deny", {
			userId: principal.userId,
			decidedBy: "user",
			...(feedback ? { feedbackText: feedback } : {}),
			outlinePlanMessage: getOutlinePlanReturnedMessage(locale, {
				feedback,
				noteAddress: decision.noteAddress,
				rootAddress: decision.root.address,
			}),
		});
		return { commit: decision.result?.commit ?? null };
	}
	// What the person changed while deciding: the plan as submitted against the plan just before
	// the decision's own commit.
	let edits = "";
	const decidedAt = decision.result?.commit?.seq;
	if (decidedAt && decidedAt - 1 > submission.seq) {
		const diff = await readPlanDiff({
			rootId: submission.root.blockId,
			fromSeq: submission.seq,
			toSeq: decidedAt - 1,
		}).catch(() => null);
		if (diff && !planDiffIsEmpty(diff.counts)) {
			const key = submission.root.address.split("/")[0] ?? "";
			edits = planDiffLines(diff, key);
		}
	}
	decisions.set(narratorId, {
		rootId: submission.root.blockId,
		action: body.action,
		delegateTitle,
		edits,
	});
	const resolved = await resolvePermission(args.requestId, "allow", {
		userId: principal.userId,
		decidedBy: "user",
		...(body.compactAfter ? { compactAfter: true } : {}),
		...(body.feedback?.trim() ? { feedbackText: body.feedback.trim() } : {}),
	});
	if (!resolved) decisions.delete(narratorId);
	return { commit: decision.result?.commit ?? null };
}

/** 403 for a decision the person may not make. */
export class OutlinePlanForbidden extends OutlinePlanError {
	constructor(message: string) {
		super(message, "OUTLINE_PLAN_INVALID");
		this.statusCode = 403;
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
	/** The person who approved, when one did. */
	approverUserId: string | null;
	/** The person the turn runs for (responsible for an approval the system records). */
	turnUserId: string | null;
	/** A plan review approved it. */
	byReview: boolean;
}): Promise<ApprovedOutlinePlan | null> {
	const submission = await submittedPlanOf(args.narratorId, args.toolUseId).catch(() => null);
	if (!submission) return null;
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
	try {
		await decideOutlinePlan({
			session: args.narratorId,
			rootId: submission.root.blockId,
			round: submission.root.round,
			action: "draft",
			decider: {
				kind: "system",
				id: OUTLINE_PLAN_ACTOR,
				responsibleUserId: args.approverUserId ?? args.turnUserId,
				approvedBy: args.approverUserId
					? { kind: "human", id: args.approverUserId }
					: { kind: "system", id: args.byReview ? "plan-review" : OUTLINE_PLAN_ACTOR },
			},
			locale: args.locale,
		});
	} catch (error) {
		logger.warn("Approved outline plan could not be recorded as approved", {
			narratorId: args.narratorId,
			root: submission.root.address,
			error: String(error),
		});
	}
	return { submission, approval: { kind: "draft" }, edits: "" };
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
	});
}
