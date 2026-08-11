/**
 * sidecar.ts — Pure, DOM-free side-car vocabulary for the vlist layout kernel.
 *
 * A "side-car" is a system-injected record attached to a narrator message or a tool
 * result (progress reminders, background-task notifications, spec injections, a
 * message from a teammate). The exact vlist renders each one as a FOOTNOTE: an
 * unadorned run of lines in the reader's column, at the same row height as a folded
 * trace row — no card, no border, no background, no accent rail.
 *
 * ## What lives here vs. in `@shared/sidecar-body`
 *
 * `sidecar-body.ts` owns the injection's DATA: the structured `SideCarBody`, its
 * projection to lines (`presentSideCarBody`), and the tone/form judgement. It is
 * shared with the server, which produces those bodies.
 *
 * THIS module owns the vlist-specific glue: the record shape the adapter reads off a
 * message, the visible-subset filter, and the geometry constants the footnote's
 * measure/render pair agree on. i18n labels are NOT here — they flow through
 * `ctx.labels` like every other adapter string.
 *
 * Zero DOM, zero React. Picked up automatically by shared-core.guard.test.ts.
 */

import type { SideCarBody } from "../sidecar-body";

// ─────────────────────────────────────────────────────────────────────────────
// Record shape (structural minimum the adapter reads)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Explicit discriminant stamped on every `SidecarSpecData` the adapter builds.
 *
 * Why a marker instead of a shape test: the measure cache has to tell a STANDALONE
 * sidecar element's data apart from a tool card's `sidecars` ARRAY, because the two
 * take different revision branches (own text vs. per-item texts). Recognizing the
 * standalone shape by "has `fullText` and `source`" happens to work today, but any
 * future payload carrying those two field names would silently fall into that
 * branch and be keyed by the wrong revision — i.e. served a stale HEIGHT. A literal
 * marker is a positive identification that cannot be collided into by accident.
 */
export const SIDECAR_PAYLOAD_KIND = "sidecar" as const;

/** Where the sidecar is attached: into a tool result, or into a user message. */
export type SidecarTarget = "tool_result" | "user_message";

/**
 * The structural subset of `SideCarRecord` (frontend/lib/api) the adapter
 * consumes. Kept interface-local so the pure kernel never imports the API type.
 */
export interface AdapterSidecar {
	/** Attachment point; drives whether it renders on a message or a tool card. */
	target: SidecarTarget | string;
	/** Free-form source tag (see `sideCarTone` for the known values). */
	source: string;
	/**
	 * The model-facing text. Still the visibility gate (an injection with no text is
	 * never rendered) and the fallback body for rows written before `body` existed.
	 */
	content: string;
	/** Structured form (WS shape). Read via `readSideCarBody`, never directly. */
	body?: SideCarBody;
	/** Structured form as loaded from the DB row (`body_json`). See `body`. */
	bodyJson?: SideCarBody | null;
	/** Owning tool call when target === "tool_result". */
	toolUseId?: string | null;
	/** Ordering within one attachment point. */
	orderIndex?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Footnote geometry (measure + render agree on these)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Left inset of a footnote's body lines, relative to its header row.
 *
 * The body is indented rather than railed: an accent rail (the old 2px `borderLeft`)
 * made the injection the heaviest thing on screen while carrying the least important
 * content. Indentation says "this belongs to the row above" using nothing but space.
 */
export const SIDECAR_BODY_INDENT = 10;

/**
 * Width reserved for a bullet line's marker, left of its text.
 *
 * A bullet therefore wraps at a NARROWER width than a plain text line, which is why
 * the measure layer prepares each line as its own block instead of measuring the
 * whole body as one.
 */
export const SIDECAR_BULLET_LANE = 12;

/**
 * How many body lines an `open` footnote shows before it needs asking.
 *
 * `open` exists so a message addressed to the reader is not hidden behind a click;
 * it is not a licence to take over the viewport. Past this, the rest goes behind the
 * fold with a "show all" row.
 *
 * ⚠️ Distinct in KIND from `SIDECAR_DETAIL_MAX_LINES` (in measure-sidecar): this one
 * is a default the reader can pass, that one is a hard ceiling on measurement cost.
 */
export const SIDECAR_INLINE_MAX_LINES = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Visibility filter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The visible subset of a sidecar list for one attachment target: non-empty
 * content, sorted by orderIndex (stable for entries without one).
 *
 * `content` remains the emptiness test even for structured rows, because it is the
 * one field every producer sets and an injection whose text is blank was never shown
 * to the model either.
 */
export function collectVisibleSidecars(
	sideCars: readonly AdapterSidecar[] | null | undefined,
	target: SidecarTarget,
): AdapterSidecar[] {
	if (!sideCars || sideCars.length === 0) return [];
	const out: AdapterSidecar[] = [];
	for (const sc of sideCars) {
		if (!sc || sc.target !== target) continue;
		if (typeof sc.content !== "string" || !sc.content.trim()) continue;
		out.push(sc);
	}
	out.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
	return out;
}

/**
 * Max chars of a RAW (unstructured) body the expanded footnote measures.
 *
 * Only the fallback path needs a char cap: a structured body is bounded by its own
 * producer (task digests are ≤4 entries, previews are pre-truncated), while a raw
 * row is an arbitrary historical string.
 */
export const SIDECAR_DETAIL_MAX_CHARS = 120_000;

/** Cap a raw body, appending the localized truncation label as its last line. */
export function sidecarDetailText(content: string, truncatedLabel: string): string {
	if (content.length <= SIDECAR_DETAIL_MAX_CHARS) return content;
	return `${content.slice(0, SIDECAR_DETAIL_MAX_CHARS)}\n\n${truncatedLabel}`;
}

/**
 * True when the message carries at least one visible CONTENT block (text /
 * image / reasoning…), i.e. it yields its own message segment whose bubble
 * already renders the message-level sidecars. Tool-only messages never reach
 * the bubble path, so the tool-run surfaces their sidecars instead — this is
 * the exact predicate the chunked MessageRenderer uses for the same decision.
 *
 * Duplicated here (rather than imported) because the pure kernel cannot reach
 * into frontend/message-segments.
 */
export function adapterMessageHasVisibleContent(msg: {
	role?: string;
	contentJson?: readonly { type: string; text?: string | null }[];
}): boolean {
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	for (const b of blocks) {
		if (!b) continue;
		switch (b.type) {
			case "text":
				if (b.text?.trim()) return true;
				break;
			case "image":
			case "text_file":
			case "web_search":
			case "image_generation":
				return true;
			case "reasoning":
			case "thinking":
				// An empty reasoning block is not visible; treat any non-empty as visible.
				if ((b as { thinking?: string | null }).thinking?.trim()) return true;
				if (b.text?.trim()) return true;
				break;
			default:
				break;
		}
	}
	return false;
}
