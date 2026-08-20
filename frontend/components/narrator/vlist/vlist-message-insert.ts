/**
 * vlist-message-insert.ts — Places a mid-window structural marker into the
 * loaded document IN PLACE, instead of answering it with a full structural
 * reload.
 *
 * Why inserting at all
 * -------------------
 * A compact marker is not always a tail append (`vlist-message-append.ts`
 * covers that case): a segment-compact marker is persisted at the seq of the
 * FIRST message it compresses (`persistSegmentCompactMarker`), and a custom
 * compact with a `beforeMessageId` lands mid-history the same way. Both used
 * to fall through to the structural reload — which is DEFERRED while the
 * reader is scrolled up (`vlist-reload-policy.ts`), and a reader watching a
 * segment they just selected for compacting is by construction scrolled up.
 * The marker they are waiting for therefore only appeared after they scrolled
 * back to the bottom, exactly backwards from the feedback the action needs.
 *
 * The event carries the message body AND its seq, so no refetch is needed to
 * place it: splice it at the first loaded row whose seq is >= the marker's,
 * pay one anchor-preserving rebuild, and the reader is not moved.
 *
 * Why the following seqs are NOT shifted
 * --------------------------------------
 * The server shifts every ref at or after the insert point up by one; this
 * module deliberately does not. The seq is read in exactly three places, and
 * none of them can observe the drift:
 *
 *   - the append path's tail check is `seq > maxLoadedSeq` — the server's next
 *     message is newer than the local max with or without the shift;
 *   - the catch-up cursor is a message ID (`buildExactCatchUpCursor`), not a
 *     seq at all;
 *   - the upward-pagination cursor is `oldestLoadedSeq`, which a mid-window
 *     insert never moves.
 *
 * Skipping the shift keeps the inserted rows' message objects untouched (their
 * identities feed measure-cache keys), and any later reload — the one
 * `compact_done` already schedules — converges the numbering with the server.
 *
 * What must still reload
 * ---------------------
 * Anything this module is not sure about — see the rejection reasons. The
 * reload path is always correct, just slower and (while scrolled up) deferred.
 *
 * Pure: no React, no DOM, no network.
 */

/** The subset of a message this module reads. */
export interface InsertCandidate {
	id?: unknown;
	seq?: unknown;
}

export type InsertRejection =
	/** No usable id — cannot be de-duplicated, so it is not safe to insert. */
	| "no-id"
	/** Already present in the loaded window (a duplicate broadcast / catch-up replay). */
	| "duplicate"
	/** Carries no seq, so its position in the document is unknown. */
	| "no-seq"
	/**
	 * Not inside the loaded window: it is newer than the loaded tail (that is an
	 * append, `vlist-message-append.ts` owns it) or no loaded row carries a seq to
	 * place it against. Handed to the structural reload, which is always correct.
	 */
	| "not-mid-window";

export interface InsertResult<T extends InsertCandidate> {
	messages: readonly T[];
	inserted: boolean;
	reason?: InsertRejection;
}

function seqOf(message: InsertCandidate): number | undefined {
	return typeof message.seq === "number" && Number.isFinite(message.seq) ? message.seq : undefined;
}

/**
 * Insert `message` into `loaded` at its seq position, returning the SAME array
 * when it must not be inserted (so the caller can skip a rebuild by identity).
 *
 * The insert point is the first loaded row whose seq is >= the marker's — with
 * the server-side shift not yet applied locally, a segment marker's seq EQUALS
 * its first compressed row's local seq, so `>=` places the marker immediately
 * before the run it will replace, which is exactly where the server put it.
 */
export function insertLoadedMessage<T extends InsertCandidate>(
	loaded: readonly T[],
	message: T,
): InsertResult<T> {
	if (typeof message.id !== "string" || message.id.length === 0) {
		return { messages: loaded, inserted: false, reason: "no-id" };
	}
	for (const existing of loaded) {
		if (existing.id === message.id) {
			return { messages: loaded, inserted: false, reason: "duplicate" };
		}
	}
	const seq = seqOf(message);
	if (seq == null) return { messages: loaded, inserted: false, reason: "no-seq" };

	let insertAt = -1;
	for (let index = 0; index < loaded.length; index++) {
		const existingSeq = seqOf(loaded[index]);
		if (existingSeq == null) continue;
		if (existingSeq >= seq) {
			insertAt = index;
			break;
		}
	}
	// No loaded row at or after the marker's seq means it belongs at the TAIL
	// (the append path's job — it was declined there, so the safe answer is the
	// reload) or that nothing loaded carries a seq to place it against.
	if (insertAt < 0) return { messages: loaded, inserted: false, reason: "not-mid-window" };

	const messages = [...loaded];
	messages.splice(insertAt, 0, message);
	return { messages, inserted: true };
}
