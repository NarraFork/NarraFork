/**
 * Reading the outline plan an ExitPlanMode input carries (outline P2 PR 8): the server writes
 * `_planRoot`, `_planSeq`, `_planBaseSeq`, `_planDiff`, `_planSummary` and, when a plan review
 * left comments (PR 8b), `_planReview` when it resolves the call of an outline session; the
 * approval card and the inbox read them back. Pure.
 */
import type {
	OutlinePlanReview,
	OutlinePlanReviewComment,
	OutlinePlanSubmission,
} from "./outline-api";

/** Keys an outline submission adds to the ExitPlanMode input. */
export const OUTLINE_PLAN_SUBMISSION_KEYS = [
	"_planRoot",
	"_planSeq",
	"_planBaseSeq",
	"_planDiff",
	"_planSummary",
	"_planReview",
] as const;

/** Comments of a review an input may carry (the server writes at most this many). */
const MAX_REVIEW_COMMENTS = 50;

/** The review an ExitPlanMode input carries (`_planReview`), if a well-formed one. */
function reviewOf(value: unknown): OutlinePlanReview | null {
	const review = value as Partial<OutlinePlanReview> | null | undefined;
	if (
		!review ||
		typeof review !== "object" ||
		typeof review.blockId !== "string" ||
		typeof review.address !== "string" ||
		typeof review.round !== "number" ||
		typeof review.count !== "number" ||
		!Number.isFinite(review.count)
	)
		return null;
	const comments: OutlinePlanReviewComment[] = [];
	for (const entry of Array.isArray(review.comments) ? review.comments : []) {
		if (comments.length >= MAX_REVIEW_COMMENTS) break;
		const comment = entry as Partial<OutlinePlanReviewComment> | null;
		if (!comment || typeof comment.text !== "string") continue;
		const target = comment.target as Partial<NonNullable<OutlinePlanReviewComment["target"]>>;
		comments.push({
			text: comment.text,
			target:
				target && typeof target.address === "string"
					? {
							address: target.address,
							title: typeof target.title === "string" ? target.title : target.address,
						}
					: null,
		});
	}
	return {
		blockId: review.blockId,
		address: review.address,
		round: review.round,
		count: Math.max(0, Math.floor(review.count)),
		comments,
	};
}

/** The submission an ExitPlanMode input carries, if it is an outline plan's. */
export function outlinePlanSubmissionOf(
	input: Record<string, unknown> | null | undefined,
): OutlinePlanSubmission | null {
	const root = input?._planRoot as Partial<OutlinePlanSubmission["root"]> | undefined;
	if (
		!root ||
		typeof root !== "object" ||
		typeof root.blockId !== "string" ||
		typeof root.spaceId !== "string" ||
		typeof root.address !== "string"
	)
		return null;
	const diff = (input?._planDiff ?? {}) as {
		counts?: Partial<OutlinePlanSubmission["counts"]>;
		truncated?: boolean;
	};
	const count = (key: keyof OutlinePlanSubmission["counts"]) => {
		const value = diff.counts?.[key];
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	};
	return {
		root: {
			blockId: root.blockId,
			spaceId: root.spaceId,
			pageId: typeof root.pageId === "string" ? root.pageId : root.blockId,
			address: root.address,
			title: typeof root.title === "string" ? root.title : root.address,
			round: typeof root.round === "number" ? root.round : 1,
		},
		seq: typeof input?._planSeq === "number" ? input._planSeq : 0,
		baseSeq: typeof input?._planBaseSeq === "number" ? input._planBaseSeq : 0,
		counts: {
			added: count("added"),
			removed: count("removed"),
			text: count("text"),
			task: count("task"),
			moved: count("moved"),
		},
		truncated: diff.truncated === true,
		summary: typeof input?._planSummary === "string" ? input._planSummary : null,
		review: reviewOf(input?._planReview),
	};
}
