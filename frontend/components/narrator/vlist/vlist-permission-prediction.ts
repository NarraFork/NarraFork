/**
 * vlist-permission-prediction.ts — First-frame region layout of a live
 * InlinePermission form, predicted from its pending request.
 *
 * ## Why a prediction at all
 *
 * The approve/deny form is the REAL chunked component (keyboard nav, drafts, the plan
 * editor, a fetched StructSed diff), so its exact height is only known once it has
 * painted. It used to be hosted by an UNCLIPPED card whose height arrived one frame
 * later through a ResizeObserver — every request therefore grew its card twice (to the
 * arithmetic card, then to the painted form) and neither step could be animated,
 * because the second one was not a layout the shell ever planned.
 *
 * Reserving `measureInlinePermission(prediction)` on the request's first frame puts
 * the form's box into the layout from the start. The painted height, once reported,
 * replaces it (see `ToolCallData.permissionForm`), and a residual difference is a
 * small, planned rebuild instead of an unplanned second growth.
 *
 * ## What is predicted, and what is left to the reading
 *
 * Mirrors the regions `InlinePermission` paints for a NON-AskUserQuestion request, in
 * its order: the execution-target block (not for ExitPlanMode), StructSed's preview
 * loading row, the decision reason, the feedback box (one row: the draft restore is
 * sessionStorage-only and invisible here), and the button bar. Wrapped line counts are
 * estimated from character counts against the card's inner width — the prediction
 * only has to be close; the reading makes it exact.
 *
 * Pure: no DOM, no React.
 */

import type { PendingPermission } from "../narrator-panel-types";
import type { InlinePermissionData } from "./measure/measure-permission";

/**
 * Average advance of an xs glyph, in px, for the wrap ESTIMATE only.
 *
 * 12px × ~0.55 for latin; CJK is ~2× wider per character, which `estimateLines`
 * accounts for by counting wide characters twice. Deliberately not the pretext path:
 * this runs once per request on the shell's render, and an estimate is all it needs.
 */
const XS_GLYPH_ADVANCE = 6.6;

/** Execution-target Paper inner padding + border on each side (px). */
const TARGET_HORIZONTAL_CHROME = (10 + 1) * 2;

/** True for East Asian wide / fullwidth code points (a coarse, cheap test). */
function isWide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6)
	);
}

/**
 * Wrapped line count of one xs paragraph at `width`, estimated.
 *
 * Bounded: a pathological 100KB reason costs one pass capped at `MAX_SCAN` chars,
 * beyond which the count is extrapolated — the form's own reason text is short in
 * practice, and the reading corrects any estimate.
 */
export function estimateLines(text: string, width: number): number {
	if (!text) return 0;
	const perLine = Math.max(1, Math.floor(width / XS_GLYPH_ADVANCE));
	let lines = 0;
	for (const paragraph of text.split("\n")) {
		let units = 0;
		const scan = Math.min(paragraph.length, MAX_SCAN);
		for (let i = 0; i < scan; i++) units += isWide(paragraph.charCodeAt(i)) ? 2 : 1;
		if (paragraph.length > scan) units = Math.round((units / scan) * paragraph.length);
		lines += Math.max(1, Math.ceil(units / perLine));
	}
	return lines;
}
const MAX_SCAN = 4_000;

export interface PermissionPredictionContext {
	/** The card's inner width (px) — what the form wraps against. */
	innerWidth: number;
	/** Whether the reader may decide here (else the form shows a read-only note). */
	canDecide: boolean;
}

/**
 * The region layout a live InlinePermission form paints on its first frame, or null
 * when the request is not hosted by an InlinePermission form at all (AskUserQuestion
 * mounts its own banner, whose height stays on the dynamic path).
 */
export function predictInlinePermission(
	permission: PendingPermission,
	ctx: PermissionPredictionContext,
): InlinePermissionData | null {
	if (permission.toolName === "AskUserQuestion") return null;
	const isExitPlanMode = permission.toolName === "ExitPlanMode";
	const target = permission.executionTarget ?? permission.executionTargets?.[0];
	const deviceId = target?.deviceId ?? permission.executionDeviceId;
	const cwd = target?.cwd ?? permission.executionCwd ?? null;
	const lexicalPath = target?.lexicalPath ?? permission.resolvedFilePath ?? null;
	const canonicalPath = target?.canonicalPath ?? null;
	const targetWidth = Math.max(1, ctx.innerWidth - TARGET_HORIZONTAL_CHROME);
	// The cwd / path rows are prefixed labels ("工作目录：…"); a short fixed allowance
	// covers the label so the estimate wraps at the right point for a long path.
	const labelled = (value: string | null) =>
		value ? estimateLines(`xxxxxxxx${value}`, targetWidth) : 0;
	const reason = permission.decisionReason ?? "";
	return {
		readOnly: !ctx.canDecide,
		hasExecutionTarget: !!deviceId && !isExitPlanMode,
		executionCwdLines: labelled(cwd),
		executionPathLines: labelled(lexicalPath) + labelled(canonicalPath),
		isExitPlanMode,
		// A structural edit's diff preview is fetched after the form mounts; its loading
		// row is what the first frame paints.
		hasPreviewLoading:
			permission.toolName === "StructSed" && !!(permission.ownerNarratorId && permission.toolUseId),
		hasDecisionReason: reason.length > 0,
		decisionReasonLines: estimateLines(reason, ctx.innerWidth),
		feedbackRows: 1,
		buttonRows: 1,
	};
}
