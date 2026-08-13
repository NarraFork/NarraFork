/**
 * vlist-message-remove.ts — Decides whether a `messages_deleted` event can be
 * applied to the loaded document IN PLACE, instead of answering it with a full
 * structural reload.
 *
 * Why removing in place at all
 * ---------------------------
 * A structural reload is gated on `pinnedToBottom` (`vlist-reload-policy.ts`):
 * replacing the whole loaded window would yank a reader who has scrolled up back
 * to the tail and discard their loadOlder pages, so while they are scrolled up the
 * reload is DEFERRED and surfaced as an unread affordance.
 *
 * That gate is right for content that ARRIVES on its own, but a deletion is
 * something the reader just asked for — they right-clicked a message in history
 * (so they are, by construction, not at the bottom) and are waiting for it to
 * disappear. Deferring that reads as a broken UI, and an unread badge is the wrong
 * thing to say about it: the reader has nothing unread, their own action simply did
 * not land.
 *
 * The deleted ids arrive in the event itself, exactly like an appended message's
 * body does (`vlist-message-append.ts`), so no refetch is needed to know what to
 * drop. Removing them costs one anchor-preserving rebuild.
 *
 * Why this cannot serve a stale height
 * ------------------------------------
 * An in-place update keeps `messageVersion` fixed (CONTRACT.md §4.5 constraint 2 —
 * moving it invalidates every committed row's cached measurement while their
 * content did not change), so `documentRevision` does not move and cache-key
 * correctness rests on `spec.key`. For a removal that is trivially satisfied: the
 * removed rows' keys simply stop appearing, and every surviving row keeps both its
 * key and its content.
 *
 * What must still reload
 * ---------------------
 * Anything this module is not sure about — see the rejection reasons. The reload
 * path is always correct, just slower and (while scrolled up) deferred.
 *
 * Pure: no React, no DOM, no network.
 */

/** The subset of a message this module reads. */
export interface RemoveCandidate {
	id?: unknown;
}

export type RemovalRejection =
	/** No ids to act on (a malformed or empty event). */
	| "no-ids"
	/**
	 * None of the ids are in the loaded window. The event targets history outside
	 * it, so there is no row on screen to remove — and, notably, nothing to refetch
	 * either: answering this with a reload was pure waste.
	 */
	| "not-loaded"
	/**
	 * Every loaded message would be removed. An empty document has its own load
	 * path (the shell's `hasIndex` branch owns it), so this is handed to the reload
	 * rather than produced here.
	 */
	| "empty-result";

export interface RemovalResult<T extends RemoveCandidate> {
	messages: readonly T[];
	removed: boolean;
	reason?: RemovalRejection;
}

/**
 * Remove `deletedIds` from `loaded`, returning the SAME array when nothing must
 * change so the caller can skip a rebuild by identity.
 *
 * Child messages are deliberately not walked: on a parent page a child is not a
 * top-level layout item (the same boundary `resolveMessageAppend` draws with its
 * `child-message` rejection), and the server already includes descendant ids in
 * `deletedMessageIds` (see `deleteMessagesAfter`'s orphan sweep). A subagent page
 * loads its own document, where those messages ARE top-level and this same
 * top-level filter applies.
 */
export function removeLoadedMessages<T extends RemoveCandidate>(
	loaded: readonly T[],
	deletedIds: readonly string[],
): RemovalResult<T> {
	const ids = new Set<string>();
	for (const id of deletedIds) {
		if (typeof id === "string" && id.length > 0) ids.add(id);
	}
	if (ids.size === 0) return { messages: loaded, removed: false, reason: "no-ids" };

	const kept: T[] = [];
	for (const message of loaded) {
		const id = message.id;
		if (typeof id === "string" && ids.has(id)) continue;
		kept.push(message);
	}
	if (kept.length === loaded.length) {
		return { messages: loaded, removed: false, reason: "not-loaded" };
	}
	if (kept.length === 0) {
		return { messages: loaded, removed: false, reason: "empty-result" };
	}
	return { messages: kept, removed: true };
}
