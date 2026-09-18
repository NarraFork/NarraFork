/**
 * vlist-ask-in-passing-target.ts — Pure resolution of a rendered vlist row into
 * the "ask in passing" interaction it should offer.
 *
 * The chunked path makes this decision inside the component that draws the card
 * (MessageBubble's ask_in_passing branch): a `pending` block mounts the real input
 * form bound to (narratorId, messageId), any other status renders the resolved card
 * which navigates to `block.targetNarratorId`. The vlist draws both as zero-DOM
 * layouts, so the same decision happens in the SHELL and is handed to the
 * renderer as controlled state / callbacks.
 *
 * `targetNarratorId` is deliberately NOT in the measured layout payload (it cannot
 * affect height), so it is read back from the row's own message blocks here — the
 * same place `MessageBubble` reads it from.
 *
 * Pure, DOM-free, i18n-free, so the gating rules cannot drift silently from the
 * chunked card.
 */

import type { VListElementKind } from "@shared/pretext-layout/element-kinds";

/** Which sub-card a row is: an open question form, or a link to its answer. */
export type VListAskInPassingKind = "pending" | "resolved";

export interface VListAskInPassingTarget {
	kind: VListAskInPassingKind;
	/** Owning message id (the ask-in-passing marker message itself). */
	messageId: string;
	/**
	 * Narrator the RESOLVED card opens. Null for a pending card, and also for a
	 * resolved one written before the field existed — in which case the row simply
	 * stays non-navigable instead of routing nowhere.
	 */
	targetNarratorId: string | null;
}

/** The minimal message shape this module reads. */
interface SourceMessage {
	id?: unknown;
	contentJson?: unknown;
}

/**
 * True for a row that hosts the PENDING question form.
 *
 * Depends only on the layout spec. Pending forms have deterministic geometry;
 * this predicate must never be used to opt them into post-paint height reporting.
 */
export function isVListAskInPassingPending(kind: VListElementKind, data: unknown): boolean {
	if (kind !== "ask-in-passing") return false;
	if (data == null || typeof data !== "object") return false;
	return (data as { kind?: unknown }).kind === "pending";
}

/**
 * Read `targetNarratorId` from the ask_in_passing block of the given message.
 * Returns null when the message is absent, has no such block, or the field is
 * missing (legacy rows).
 */
export function readAskInPassingTargetNarratorId(
	messages: readonly SourceMessage[],
	messageId: string,
): string | null {
	for (const msg of messages) {
		if (msg.id !== messageId) continue;
		const blocks = msg.contentJson;
		if (!Array.isArray(blocks)) return null;
		for (const block of blocks) {
			if (block == null || typeof block !== "object") continue;
			const candidate = block as { type?: unknown; targetNarratorId?: unknown };
			if (candidate.type !== "ask_in_passing") continue;
			return typeof candidate.targetNarratorId === "string" && candidate.targetNarratorId
				? candidate.targetNarratorId
				: null;
		}
		return null;
	}
	return null;
}

/**
 * Resolve the ask-in-passing interaction for one rendered row, or null when the
 * row is not such a card.
 *
 * `messageId` comes from the manifest's source ids because system cards carry no
 * `-b{n}` suffix in their spec key (see vlist-block-target) — the owning message
 * is the first source id of the row's render unit. Without it neither half works:
 * the pending form is bound to that id and the resolved lookup keys on it.
 */
export function resolveVListAskInPassingTarget(
	kind: VListElementKind,
	data: unknown,
	sourceMessageIds: readonly string[],
	messages: readonly SourceMessage[],
): VListAskInPassingTarget | null {
	if (kind !== "ask-in-passing") return null;
	if (data == null || typeof data !== "object") return null;
	const payload = data as { kind?: unknown };
	// Mirrors the adapter: `pending` iff the block status was "pending".
	const cardKind: VListAskInPassingKind = payload.kind === "pending" ? "pending" : "resolved";
	const messageId = sourceMessageIds[0];
	if (!messageId) return null;
	return {
		kind: cardKind,
		messageId,
		targetNarratorId:
			cardKind === "resolved" ? readAskInPassingTargetNarratorId(messages, messageId) : null,
	};
}
