/**
 * vlist-message-replace.ts — Decides whether a `message_updated` event can be
 * applied to the loaded document IN PLACE, instead of answering it with a full
 * structural reload.
 *
 * Why this exists at all (it is the other half of a rollback)
 * ---------------------------------------------------------
 * `rollbackToBlock` mutates history in TWO steps and broadcasts accordingly:
 *
 *   1. every message after the target is deleted        → `messages_deleted`
 *   2. the target's own blocks after the rollback point → `message_updated`
 *      are dropped                                        (or `messages_deleted`
 *                                                          if that emptied it)
 *
 * So handling only the deletion leaves the rollback visibly half-applied: the
 * messages below vanish, while the tail blocks of the very card the reader
 * right-clicked stay on screen until a structural reload happens — which, because
 * that reload is gated on `pinnedToBottom` (`vlist-reload-policy.ts`) and the reader
 * is by construction scrolled up in history, is exactly what they were waiting for
 * and did not get.
 *
 * Why ONLY a prefix truncation is accepted
 * ---------------------------------------
 * An in-place update keeps `messageVersion` fixed (CONTRACT.md §4.5 constraint 2),
 * so `documentRevision` does not move and the measure cache key's only remaining
 * discriminator is `spec.key`. An assistant block's key is `${msg.id}-b${bi}` where
 * `bi` is the block's index in the ORIGINAL array (`segment-adapter.ts`).
 *
 * That makes truncation — and only truncation — safe: dropping trailing blocks
 * means the high `-b{bi}` keys stop appearing, while every surviving key still
 * denotes the same block with the same content, so no cached height can be served
 * for content it was not measured from.
 *
 * Any other shape of update breaks that. Rewritten text under a stable `-b{bi}`
 * would hit the pre-edit cache entry and render new content in the old box — the
 * precise failure mode CONTRACT.md §4.5 constraint 3 warns about. Those updates
 * keep the structural reload, which replaces the window together with its
 * `messageVersion` and is therefore always correct.
 *
 * This module is consequently a GUARD, not a general merge: the strict length
 * decrease is what buys safety, and the per-block comparison exists to reject a
 * "truncated AND edited" payload that the length check alone would wave through.
 *
 * Pure: no React, no DOM, no network.
 */

/** The subset of a message this module reads. */
export interface ReplaceCandidate {
	id?: unknown;
	contentJson?: unknown;
}

export type ReplaceRejection =
	/** No usable id, so the target cannot be located. */
	| "no-id"
	/** Not in the loaded window — there is no row on screen to update. */
	| "not-loaded"
	/**
	 * Not a pure trailing-block truncation: same or greater block count, a
	 * non-array payload, or a surviving block whose content changed. Handed to the
	 * structural reload, which is always correct.
	 */
	| "not-a-truncation";

export interface ReplaceResult<T extends ReplaceCandidate> {
	messages: readonly T[];
	replaced: boolean;
	reason?: ReplaceRejection;
}

/**
 * Fields compared to decide that a surviving block is unchanged.
 *
 * Deliberately a small, explicit list rather than a deep compare: these are the
 * block's identity (`type`, `id`, `name`) plus the payloads that carry its rendered
 * text (`text`, `thinking`, `summary`) and its lifecycle (`status`). A block whose
 * height moved for any other reason arrives through the live-patch channel, which
 * owns its own revision keying (CONTRACT.md §4.5).
 *
 * Comparing text is O(length), but it runs once per event over one message's
 * surviving blocks — not per measure — so it is not on any hot path.
 */
const COMPARED_BLOCK_FIELDS = [
	"type",
	"id",
	"name",
	"text",
	"thinking",
	"summary",
	"status",
] as const;

function blocksEquivalent(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return false;
	if (typeof a !== "object" || typeof b !== "object") return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	for (const field of COMPARED_BLOCK_FIELDS) {
		if (left[field] !== right[field]) return false;
	}
	return true;
}

/**
 * Replace the loaded copy of `message` when the update is a pure trailing-block
 * truncation, returning the SAME array otherwise so the caller can skip a rebuild
 * by identity (and fall back to the reload path).
 */
export function replaceLoadedMessage<T extends ReplaceCandidate>(
	loaded: readonly T[],
	message: T,
): ReplaceResult<T> {
	const id = message.id;
	if (typeof id !== "string" || id.length === 0) {
		return { messages: loaded, replaced: false, reason: "no-id" };
	}
	const index = loaded.findIndex((existing) => existing.id === id);
	if (index < 0) return { messages: loaded, replaced: false, reason: "not-loaded" };

	const previous = loaded[index];
	const nextBlocks = message.contentJson;
	const prevBlocks = previous?.contentJson;
	if (!Array.isArray(nextBlocks) || !Array.isArray(prevBlocks)) {
		return { messages: loaded, replaced: false, reason: "not-a-truncation" };
	}
	// STRICTLY fewer blocks. Equal length is not a truncation (it is an edit, whose
	// stable keys would serve stale heights), and more blocks is an append the
	// reload path places correctly.
	if (nextBlocks.length >= prevBlocks.length || nextBlocks.length === 0) {
		return { messages: loaded, replaced: false, reason: "not-a-truncation" };
	}
	for (let i = 0; i < nextBlocks.length; i++) {
		if (!blocksEquivalent(prevBlocks[i], nextBlocks[i])) {
			return { messages: loaded, replaced: false, reason: "not-a-truncation" };
		}
	}

	const messages = [...loaded];
	messages[index] = message;
	return { messages, replaced: true };
}
