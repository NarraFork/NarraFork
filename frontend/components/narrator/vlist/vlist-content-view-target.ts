/**
 * vlist-content-view-target.ts — Pure, DOM-free description of the CONTENT BODIES
 * a vlist row exposes to the fullscreen viewer.
 *
 * The chunked path wraps every body in a `ContentViewer`, which owns the hover
 * action bar (copy / wrap / source / fullscreen) and the fullscreen modal. The
 * exact vlist paints zero-DOM copies instead, so its bodies were plain
 * `maxHeight + overflow:auto` boxes: whatever the cap hid could only be reached
 * by scrolling a 200px window.
 *
 * This module is the bridge. Given an already-MEASURED row it derives one
 * `VListViewTarget` per readable body, carrying the raw text (plus diff rows and
 * highlighting hints) the viewer needs. It reads only measured output + the
 * localized label bundle, never the DOM, so it stays unit-testable and cannot
 * affect any height.
 *
 * IMPORTANT — height neutrality: nothing here is an input to the measure pass.
 * The wrap / source toggles these targets drive live in the SHELL's render state
 * (see PretextExactMessageList), deliberately outside `VListInteractionState`,
 * because that object feeds `computeLayout`. A vlist body box has a fixed
 * measured height and scrolls internally, so flipping `white-space` changes what
 * the reader sees inside the box and never the box itself. That is the one real
 * difference from the chunked path, where wrap DOES change the row height.
 */

import type { DiffLine } from "@shared/pretext-layout/diff-core";
import type { ElementSpec } from "@shared/pretext-layout/segment-adapter";
import type { MeasuredSubagent } from "./measure/measure-subagent";
import type {
	MeasuredToolCall,
	MeasuredToolDetail,
	MeasuredToolDetailSection,
} from "./measure/measure-tool-call";
import type { PreparedBlock } from "./prepared-block";

/** Which visual the fullscreen viewer uses for a body. */
export type VListViewKind = "code" | "markdown" | "diff" | "term";

/** One readable body of a row, addressable by a stable id. */
export interface VListViewTarget {
	/**
	 * `${specKey}:${slot}` — stable across rebuilds because both halves are.
	 * Keys the per-body wrap/source state and the shell's open-modal state.
	 */
	id: string;
	/**
	 * Position of this body WITHIN its row (`s0` / `b1` / `body` / `prompt` /
	 * `result`). The render layer derives the same string locally from the section
	 * or block it is drawing, which is how it finds its target without ever
	 * knowing the row's spec key.
	 */
	slot: string;
	kind: VListViewKind;
	/** Already-localized modal title; absent → the modal shows no title. */
	title?: string;
	/** The body text: what the modal renders and what "copy" writes. */
	text: string;
	/** Structured diff sides, for `kind === "diff"`. */
	diff?: { oldStr: string; newStr: string };
	/** Explicit Shiki language id. */
	codeLang?: string;
	/** File path whose extension implies the language (resolved by the caller). */
	codeLangPath?: string;
	/** `text` is only a prefix of the real body → the modal says so. */
	truncated?: boolean;
}

/** Localized strings this module needs; a subset of `VListRenderLabels`. */
export interface VListViewTargetLabels {
	/** Per section-label id (already localized). */
	sections?: Partial<Record<string, string>>;
	/** Subagent prompt block title. */
	prompt?: string;
	/** Reasoning card titles (the same words the row header shows). */
	reasoning?: string;
	thinking?: string;
}

/** Detail block tags whose body is a plain (non-markdown) text payload. */
const TEXT_BODY_TAG_PREFIX = "detail-";

/** Tags that carry no readable body of their own. */
const NON_BODY_TAGS = new Set([
	"detail-section-label",
	"detail-plan-source",
	"detail-meta-empty",
	"detail-sections-empty",
	"detail-media",
]);

/** A non-empty string, else undefined. */
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reconstruct the diff sides from the structured rows the measure layer kept. */
export function diffSidesFromLines(lines: readonly DiffLine[]): { oldStr: string; newStr: string } {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	for (const line of lines) {
		if (line.type !== "added") oldLines.push(line.content);
		if (line.type !== "removed") newLines.push(line.content);
	}
	return { oldStr: oldLines.join("\n"), newStr: newLines.join("\n") };
}

/** Which viewer visual a capped body's tag implies. */
function kindForTag(tag: string): VListViewKind {
	if (tag === "detail-diff") return "diff";
	if (tag === "detail-term" || tag === "detail-streaming-bash") return "term";
	return "code";
}

/**
 * Build a target from one fixed detail block, or null when the block carries no
 * readable body (labels, provenance lines, media placeholders, empty markers).
 */
function targetFromBlock(
	specKey: string,
	slot: string,
	block: PreparedBlock | undefined,
	title: string | undefined,
): VListViewTarget | null {
	if (!block || block.kind !== "fixed") return null;
	if (!block.tag.startsWith(TEXT_BODY_TAG_PREFIX)) return null;
	if (NON_BODY_TAGS.has(block.tag)) return null;
	const data = block.data ?? {};
	const body = text(data.text);
	if (!body) return null;
	const diffLines = Array.isArray(data.diffLines) ? (data.diffLines as DiffLine[]) : undefined;
	return {
		id: `${specKey}:${slot}`,
		slot,
		kind: kindForTag(block.tag),
		...(title ? { title } : {}),
		text: body,
		...(diffLines && diffLines.length > 0 ? { diff: diffSidesFromLines(diffLines) } : {}),
		...(text(data.codeLang) ? { codeLang: data.codeLang as string } : {}),
		...(text(data.codeLangPath) ? { codeLangPath: data.codeLangPath as string } : {}),
		// `textTruncated` (the payload is a server-side PREFIX), not `capped` (which
		// only says the body is taller than its box). The modal shows the whole text
		// it is handed, so only a genuinely incomplete payload deserves a notice.
		...(data.textTruncated === true ? { truncated: true } : {}),
	};
}

/** Localized title for a section label id, when both are present. */
function sectionTitle(
	label: MeasuredToolDetailSection["label"],
	labels: VListViewTargetLabels | undefined,
): string | undefined {
	if (!label) return undefined;
	return labels?.sections?.[label];
}

/** Targets of a markdown-bodied region (plan / skill / knowledge). */
function markdownTarget(
	specKey: string,
	slot: string,
	sourceText: string | undefined,
	title: string | undefined,
): VListViewTarget | null {
	const body = text(sourceText);
	if (!body) return null;
	return {
		id: `${specKey}:${slot}`,
		slot,
		kind: "markdown",
		...(title ? { title } : {}),
		text: body,
	};
}

/**
 * Every readable body of a measured tool card, in visual order.
 *
 * Ordering matters: `resolvePrimaryViewTarget` treats the LAST entry as the
 * card's main body, and tool details always run header/command → output/result.
 */
export function resolveToolDetailViewTargets(
	specKey: string,
	measured: Pick<MeasuredToolCall, "detail">,
	labels?: VListViewTargetLabels,
): VListViewTarget[] {
	const detail = measured.detail;
	if (!detail) return [];
	return resolveDetailViewTargets(specKey, detail, labels);
}

/** Same as above for a detail region reached directly (grouped child cards). */
export function resolveDetailViewTargets(
	specKey: string,
	detail: MeasuredToolDetail,
	labels?: VListViewTargetLabels,
): VListViewTarget[] {
	const out: VListViewTarget[] = [];
	if (detail.sections) {
		detail.sections.forEach((part, index) => {
			const slot = sectionSlot(index);
			const title = sectionTitle(part.label, labels);
			if (part.markdown) {
				const md = markdownTarget(specKey, slot, part.sourceText, title);
				if (md) out.push(md);
				return;
			}
			// The label row (when present) is the slice's first block; the body follows.
			const bodyStart = part.blockStart + (part.hasLabel ? 1 : 0);
			const target = targetFromBlock(specKey, slot, detail.blocks[bodyStart], title);
			if (target) out.push(target);
		});
		return out;
	}
	if (detail.markdown) {
		const md = markdownTarget(specKey, BODY_SLOT, detail.sourceText, undefined);
		return md ? [md] : [];
	}
	// capped / generic: one fixed block per body, in order.
	detail.blocks.forEach((block, index) => {
		const target = targetFromBlock(specKey, blockSlot(index), block, undefined);
		if (target) out.push(target);
	});
	return out;
}

/** Slot id of the Nth section body (`s0`, `s1`, …). */
export function sectionSlot(index: number): string {
	return `s${index}`;
}

/** Slot id of the Nth block body inside a single-kind detail region. */
export function blockSlot(index: number): string {
	return `b${index}`;
}

/** Slot id of a row's / region's single body. */
export const BODY_SLOT = "body";
/** Slot ids of the subagent card's two bodies. */
export const PROMPT_SLOT = "prompt";
export const RESULT_SLOT = "result";

/** Find the target for a slot in an ordered list, or undefined. */
export function findViewTarget(
	targets: readonly VListViewTarget[] | undefined,
	slot: string,
): VListViewTarget | undefined {
	return targets?.find((target) => target.slot === slot);
}

/**
 * The subagent card's two bodies: the prompt (monospace) and the result
 * (markdown). Only the ones actually drawn are returned, so a collapsed card
 * offers nothing.
 */
export function resolveSubagentViewTargets(
	specKey: string,
	measured: Pick<MeasuredSubagent, "promptMeasured" | "resultMeasured">,
	opts: { promptText?: string; resultText?: string; title?: string },
	labels?: VListViewTargetLabels,
): VListViewTarget[] {
	const out: VListViewTarget[] = [];
	const promptText = text(opts.promptText);
	if (measured.promptMeasured && promptText) {
		out.push({
			id: `${specKey}:${PROMPT_SLOT}`,
			slot: PROMPT_SLOT,
			kind: "code",
			...(labels?.prompt ? { title: labels.prompt } : {}),
			text: promptText,
		});
	}
	const resultText = text(opts.resultText);
	if (measured.resultMeasured && resultText) {
		out.push({
			id: `${specKey}:${RESULT_SLOT}`,
			slot: RESULT_SLOT,
			kind: "markdown",
			...(opts.title ? { title: opts.title } : {}),
			text: resultText,
		});
	}
	return out;
}

/**
 * The body of a plain content row (assistant markdown / a reasoning run).
 *
 * Read from the SPEC rather than the selection index's `copyText`: a reasoning
 * run displays its translation unless the reader asked for the original, while
 * `copyText` always holds the original — reusing it would put the source text in
 * the fullscreen modal while the row on screen shows the translation.
 */
export function resolveRowViewTargets(
	spec: Pick<ElementSpec, "kind" | "key" | "data" | "opts">,
	labels?: VListViewTargetLabels,
): VListViewTarget[] {
	if (spec.kind === "markdown") {
		// markdownData() returns the block text directly.
		const body = text(spec.data);
		// No title: the chunked path's assistant ContentViewer passes none either.
		return body
			? [{ id: `${spec.key}:${BODY_SLOT}`, slot: BODY_SLOT, kind: "markdown", text: body }]
			: [];
	}
	if (spec.kind === "reasoning") {
		const data = (spec.data ?? {}) as { text?: unknown; translatedText?: unknown };
		const original = text(data.text);
		const translated = text(data.translatedText);
		const showOriginal = spec.opts?.showOriginal === true;
		const body = showOriginal ? original : (translated ?? original);
		if (!body) return [];
		const title = labels?.reasoning ?? labels?.thinking;
		return [
			{
				id: `${spec.key}:${BODY_SLOT}`,
				slot: BODY_SLOT,
				kind: "markdown",
				...(title ? { title } : {}),
				text: body,
			},
		];
	}
	return [];
}

/**
 * The row's MAIN body — what a single row-level "fullscreen" menu item opens.
 *
 * The last body wins because tool details are always ordered
 * header/command → output/result, so the final one is the payload the reader
 * came for (Bash → output, Edit → diff, ExitPlanMode → the plan). A row with one
 * body trivially resolves to it.
 */
export function resolvePrimaryViewTarget(
	targets: readonly VListViewTarget[],
): VListViewTarget | undefined {
	return targets.length > 0 ? targets[targets.length - 1] : undefined;
}

/**
 * Render-state signature for one row's bodies, appended to `interactionSig` so
 * the `ExactRow` memo re-renders when a wrap / source toggle flips.
 *
 * Only ids belonging to `specKey` are considered (target ids are
 * `${specKey}:${slot}`), so one row's toggle never invalidates another's memo.
 */
export function viewStateSig(
	wrap: ReadonlyMap<string, boolean>,
	showSource: ReadonlyMap<string, boolean>,
	specKey: string,
): string {
	if (wrap.size === 0 && showSource.size === 0) return "";
	const prefix = `${specKey}:`;
	const parts: string[] = [];
	for (const [id, value] of wrap) {
		if (id.startsWith(prefix)) parts.push(`w${id.slice(prefix.length)}=${value ? 1 : 0}`);
	}
	for (const [id, value] of showSource) {
		if (id.startsWith(prefix)) parts.push(`s${id.slice(prefix.length)}=${value ? 1 : 0}`);
	}
	// Sorted so Map insertion order (which the shell does not control) cannot
	// produce two different signatures for the same state.
	return parts.sort().join(",");
}
