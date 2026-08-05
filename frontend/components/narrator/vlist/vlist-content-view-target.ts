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
	/**
	 * `text` is COMPLETE, but the row paints only a prefix of it (the body exceeded
	 * the markdown parse ceiling).
	 *
	 * The opposite direction from `truncated`: there the modal has less than the
	 * real payload, here the modal has MORE than the row shows. Both are statements
	 * about a gap between what is on screen and what exists, which is why they live
	 * side by side, but they point the reader at different places — `truncated`
	 * needs a server fetch, this one only needs the viewer that already has the text.
	 */
	rowShowsPrefix?: boolean;
	/**
	 * The ROW can swap this markdown body for its raw source IN PLACE.
	 *
	 * The inline action bar's source/rendered toggle is gated on this, because that
	 * button only flips shell state — the row's renderer has to actually honour it.
	 * A body whose renderer cannot (a collapsed reasoning header paints no body at
	 * all) would otherwise offer a control that changes nothing on screen.
	 *
	 * Absent → the toggle is hidden from the bar only; the fullscreen modal still
	 * offers it, since the modal renders the text itself and never depends on the
	 * row.
	 */
	sourceInline?: boolean;
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
	/** The row paints only a prefix of `sourceText` (parse ceiling). */
	bodyIsPrefix?: boolean,
	/** `sourceText` is itself only a server-side prefix (payload truncation). */
	textTruncated?: boolean,
): VListViewTarget | null {
	const body = text(sourceText);
	if (!body) return null;
	return {
		id: `${specKey}:${slot}`,
		slot,
		kind: "markdown",
		...(title ? { title } : {}),
		text: body,
		// A tool card's markdown body lives in a measure-fixed, internally scrolling
		// box, and both renderers (CappedMarkdownBody / MarkdownDetailBody) already
		// swap it for the raw source, so the inline toggle is real here.
		sourceInline: true,
		// The full text IS here, but the ROW only painted a prefix of it, so the
		// fullscreen viewer is the only place the rest can be read. Flagged so the
		// bar can point there instead of letting the inline body end mid-document.
		...(bodyIsPrefix === true ? { rowShowsPrefix: true } : {}),
		// Even `sourceText` is incomplete: the server sent a preview, so the rest has
		// to be fetched. Without this a plan / skill / knowledge body had no way to
		// ask for its own bytes (the measure layer used to drop the flag entirely).
		...(textTruncated === true ? { truncated: true } : {}),
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
				const md = markdownTarget(
					specKey,
					slot,
					part.sourceText,
					title,
					part.bodyIsPrefix,
					part.textTruncated,
				);
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
		const md = markdownTarget(
			specKey,
			BODY_SLOT,
			detail.sourceText,
			undefined,
			detail.bodyIsPrefix,
			detail.textTruncated,
		);
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

/**
 * The view/interaction key of ONE drilled-in trace row.
 *
 * A folded trace is a single vlist element with a single `spec.key`, but a reader
 * can drill into several of its rows at once — each nesting a tool card with its
 * own bodies. Without a per-row scope every drilled-in card would mint `…:s0`, so
 * two open rows would share one wrap/source state and one "load full content"
 * request, and the fullscreen modal could not tell their bodies apart.
 *
 * Deliberately still PREFIXED by the trace's spec key: `viewStateSig` filters a
 * row's state by `${specKey}:` and `resolveVListBlockTarget`-style lookups walk
 * back to the owning element, both of which keep working unchanged.
 */
export function traceRowViewKey(specKey: string, itemIndex: number): string {
	return `${specKey}${TRACE_ROW_KEY_SEPARATOR}row${itemIndex}`;
}

/** Separator between a trace's spec key and its per-row scope. */
const TRACE_ROW_KEY_SEPARATOR = "#";
const TRACE_ROW_KEY_PATTERN = /^(.*)#row(\d+)$/;

/**
 * Split a drilled-in row's key back into its trace element + row index.
 *
 * The inverse of {@link traceRowViewKey}, needed because a body id only carries
 * the ROW key (`…#row3:s0`), while re-deriving that body from the current document
 * requires finding the trace ITEM and then its measured row.
 *
 * Returns null for a plain element key, which is what every non-trace row has.
 */
export function parseTraceRowViewKey(key: string): { specKey: string; itemIndex: number } | null {
	const match = TRACE_ROW_KEY_PATTERN.exec(key);
	if (!match) return null;
	const specKey = match[1];
	const itemIndex = Number(match[2]);
	if (!specKey || !Number.isInteger(itemIndex) || itemIndex < 0) return null;
	return { specKey, itemIndex };
}

/** Find the target for a slot in an ordered list, or undefined. */
export function findViewTarget(
	targets: readonly VListViewTarget[] | undefined,
	slot: string,
): VListViewTarget | undefined {
	return targets?.find((target) => target.slot === slot);
}

/**
 * The spec key half of a target id (`${specKey}:${slot}` → `specKey`).
 *
 * Needed because the fullscreen modal holds a target SNAPSHOT: to refresh it — or
 * to request the row's un-truncated payload on the reader's behalf — the shell has
 * to get back from the body to the row that owns it. Split on the LAST colon, as
 * slots never contain one while a spec key may.
 *
 * Returns null for an id with no slot separator (never produced here, but a
 * caller should not have to trust that).
 */
export function viewTargetSpecKey(id: string): string | null {
	const sep = id.lastIndexOf(":");
	return sep > 0 ? id.slice(0, sep) : null;
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
			// SubagentBody paints the result inside a capped scroll box and honours
			// `isSourceShown` there, so the inline toggle has a real effect.
			sourceInline: true,
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
	opts?: RowViewTargetOptions,
): VListViewTarget[] {
	const inline = opts?.sourceInline === true ? { sourceInline: true as const } : {};
	if (spec.kind === "markdown") {
		// markdownData() returns the block text directly.
		const body = text(spec.data);
		// No title: the chunked path's assistant ContentViewer passes none either.
		return body
			? [
					{
						id: `${spec.key}:${BODY_SLOT}`,
						slot: BODY_SLOT,
						kind: "markdown",
						text: body,
						...inline,
					},
				]
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
				...inline,
			},
		];
	}
	return [];
}

/** Caller-supplied render capabilities for a plain content row's body. */
export interface RowViewTargetOptions {
	/**
	 * This row's renderer will honour an in-place source view.
	 *
	 * Declared by the CALLER because it depends on the MEASURED form, which this
	 * module never sees: a markdown row always paints its body, while a reasoning
	 * row paints one only in the expanded form — a collapsed header has nowhere to
	 * put the raw text, so offering the toggle there would be a dead control.
	 */
	sourceInline?: boolean;
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
 * Only ids belonging to `specKey` are considered, so one row's toggle never
 * invalidates another's memo. Two id shapes qualify:
 *   - `${specKey}:${slot}`            — the element's own bodies
 *   - `${specKey}#row{n}:${slot}`     — a drilled-in trace row's nested card
 *
 * The second is why this cannot simply test `${specKey}:`: a nested card's bodies
 * live under a per-row scope, and missing them would leave a wrap toggle inside a
 * drilled-in card invisible to the memo (the toggle would appear to do nothing
 * until some unrelated change re-rendered the trace).
 */
export function viewStateSig(
	wrap: ReadonlyMap<string, boolean>,
	showSource: ReadonlyMap<string, boolean>,
	specKey: string,
): string {
	if (wrap.size === 0 && showSource.size === 0) return "";
	const prefix = `${specKey}:`;
	// `#row` (not a bare `#`) so a deduped sibling key (`tool-x#dup1`) is not
	// mistaken for this element's row scope.
	const rowPrefix = `${specKey}${TRACE_ROW_KEY_SEPARATOR}row`;
	const scoped = (id: string): string | null => {
		if (id.startsWith(prefix)) return id.slice(prefix.length);
		if (id.startsWith(rowPrefix)) return id.slice(specKey.length);
		return null;
	};
	const parts: string[] = [];
	for (const [id, value] of wrap) {
		const suffix = scoped(id);
		if (suffix !== null) parts.push(`w${suffix}=${value ? 1 : 0}`);
	}
	for (const [id, value] of showSource) {
		const suffix = scoped(id);
		if (suffix !== null) parts.push(`s${suffix}=${value ? 1 : 0}`);
	}
	// Sorted so Map insertion order (which the shell does not control) cannot
	// produce two different signatures for the same state.
	return parts.sort().join(",");
}
