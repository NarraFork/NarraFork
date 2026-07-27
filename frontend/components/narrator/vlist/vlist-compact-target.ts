/**
 * vlist-compact-target.ts — Pure resolution of a rendered vlist row into the
 * compact-marker interaction it should offer.
 *
 * The chunked path builds this decision inside the component that draws the
 * marker (MessageBubble's CompactIndicator / SegmentCompactIndicator): pick the
 * flavour from the block type, the affordance from the status, and gate both on
 * having a narrator + message id. The vlist draws markers as pure zero-DOM
 * copies, so the same decision has to happen in the SHELL and be handed to the
 * renderer as callbacks.
 *
 * Keeping it here (pure, DOM-free, i18n-free) means the gating rules that decide
 * "clickable summary" vs "cancel this run" vs "inert" are unit-testable and
 * cannot drift silently from the chunked card.
 */

import type { VListElementKind } from "@shared/pretext-layout/element-kinds";

/** Which compact flavour a marker belongs to (drives the summary API + modal). */
export type VListCompactKind = "context" | "segment";

/** Lifecycle status of a compact marker, as composed by the adapter. */
export type VListCompactStatus = "compacting" | "compacted" | "failed";

export interface VListCompactTarget {
	kind: VListCompactKind;
	/** Owning message id of the marker (the compact message itself). */
	messageId: string;
	status: VListCompactStatus;
	/**
	 * True when the row should open the summary modal. Mirrors the chunked
	 * `canClick`: everything except a run still in flight.
	 */
	canOpen: boolean;
	/**
	 * True when the row should instead ask to CANCEL the running compaction.
	 * Only the context flavour supports cancellation — the chunked
	 * SegmentCompactIndicator has no cancel affordance, and the API is
	 * narrator-scoped (`POST /narrators/:id/compact/cancel`).
	 */
	canCancel: boolean;
}

/** Status values the adapter can put on a system-simple compact payload. */
function normalizeStatus(value: unknown): VListCompactStatus {
	return value === "compacting" || value === "failed" ? value : "compacted";
}

/**
 * Resolve the compact interaction for one rendered row, or null when the row is
 * not a compact marker at all.
 *
 * A marker is identified from the MEASURED payload (`data.kind`), not the spec
 * kind alone: `system-simple` also covers merge_summary / review_feedback /
 * spec_continuation, none of which have compact interactions.
 *
 * `messageId` comes from the manifest's source ids because system cards carry no
 * `-b{n}` suffix in their spec key (see vlist-block-target) — the owning message
 * is the first source id of the row's render unit.
 */
export function resolveVListCompactTarget(
	kind: VListElementKind,
	data: unknown,
	sourceMessageIds: readonly string[],
): VListCompactTarget | null {
	if (kind !== "system-simple") return null;
	if (data == null || typeof data !== "object") return null;
	const payload = data as { kind?: unknown; status?: unknown };
	const flavour: VListCompactKind | null =
		payload.kind === "compact" ? "context" : payload.kind === "segment_compact" ? "segment" : null;
	if (!flavour) return null;
	const messageId = sourceMessageIds[0];
	if (!messageId) return null;
	const status = normalizeStatus(payload.status);
	const compacting = status === "compacting";
	return {
		kind: flavour,
		messageId,
		status,
		canOpen: !compacting,
		canCancel: compacting && flavour === "context",
	};
}
