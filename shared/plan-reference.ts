/**
 * plan-reference.ts — the model-facing ExitPlanMode plan reference sentence.
 *
 * A file-based plan's full body is persisted for the UI but replaced in MODEL
 * history by a short path reference, so the plan text does not re-enter the
 * context on every rebuilt turn (see server/lib/agent/strip-plan-body.ts).
 *
 * That reference sits in exactly the place the real plan would (`input.plan`),
 * which means a model can echo the sentence back as a NEW ExitPlanMode plan. Two
 * different layers must recognize it:
 *
 *   - the server, so an echoed reference is never accepted as a complete inline
 *     plan and never overwrites a stored plan body;
 *   - the render layers, so a card whose persisted input holds the reference
 *     falls back to the authoritative plan body instead of showing the sentence
 *     to the user as if it were the plan.
 *
 * The builder and the detector therefore live together here, in `shared/`, where
 * both sides can reach them. Keeping them adjacent is the point: a detector that
 * drifts from what we actually emit silently stops working.
 *
 * The text is deliberately English-only. It is model-facing (mirroring the tool
 * result message style) and must not vary with the UI locale.
 */

/** Build the reference that replaces a file-based plan body in model history. */
export function buildPlanReference(planFile: string, status: string): string {
	const prefix = status === "fail" ? "The plan was not approved." : "The plan was approved.";
	return (
		`${prefix} Its full content is saved in the plan file: ${planFile}. ` +
		"Re-read that file with the Read tool if you need the plan details."
	);
}

/** Distinctive fragments of the sentence built above. */
const PLAN_REFERENCE_MARKERS = [
	"its full content is saved in the plan file",
	"re-read that file with the read tool",
];

/** How much of a candidate string is scanned for the markers (see below). */
const PLAN_REFERENCE_SCAN_CHARS = 400;

/**
 * Is this text OUR model-facing plan reference rather than a real plan body?
 *
 * Only a bounded prefix is scanned: the reference is short and always leads the
 * string, so a window both bounds the cost for megabyte-sized plans and avoids
 * flagging a genuine plan that merely quotes the phrase somewhere in its body.
 */
export function isModelPlanReference(text: string): boolean {
	if (!text) return false;
	const window = text.slice(0, PLAN_REFERENCE_SCAN_CHARS).toLowerCase();
	return PLAN_REFERENCE_MARKERS.some((marker) => window.includes(marker));
}

/**
 * Does this tool input's `plan` field hold the reference instead of a plan body?
 *
 * The shape check is shared by both render paths, which see the same persisted
 * `inputJson` and must make the same call about whether to trust its `plan`.
 */
export function isPlanReferencePlaceholder(plan: unknown): boolean {
	return typeof plan === "string" && isModelPlanReference(plan);
}

/**
 * Does a persisted `plan` field carry something worth showing the user AS the plan?
 *
 * This is the single rule every render path applies before trusting `inputJson.plan`.
 * Two kinds of value fail it: a blank/absent plan (a file-based plan resolved
 * server-side never enters the streamed tool_use input) and our own model-facing
 * reference (echoed back by the model from its stripped history). Both mean the same
 * thing to the UI — "this row does not hold the plan, look to the authoritative
 * source" — so they must be answered the same way, or one render path shows the
 * reference while another shows the plan.
 */
export function hasUsablePlanBody(plan: unknown): boolean {
	return typeof plan === "string" && !!plan.trim() && !isModelPlanReference(plan);
}
