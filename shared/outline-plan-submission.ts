/**
 * Reading the outline plan an ExitPlanMode input carries (outline P2 PR 8): the server writes
 * `_planRoot`, `_planSeq`, `_planBaseSeq`, `_planDiff` and `_planSummary` when it resolves the
 * call of an outline session; the approval card and the inbox read them back. Pure.
 */
import type { OutlinePlanSubmission } from "./outline-api";

/** Keys an outline submission adds to the ExitPlanMode input. */
export const OUTLINE_PLAN_SUBMISSION_KEYS = [
	"_planRoot",
	"_planSeq",
	"_planBaseSeq",
	"_planDiff",
	"_planSummary",
] as const;

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
	};
}
