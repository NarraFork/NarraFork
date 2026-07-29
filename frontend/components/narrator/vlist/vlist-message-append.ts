/**
 * vlist-message-append.ts — Decides whether a newly broadcast message can be
 * appended to the loaded document IN PLACE, instead of answering it with a full
 * structural reload.
 *
 * Why appending at all
 * -------------------
 * A landed message used to trigger a tail refetch: 40-100 messages plus a complete
 * re-measure, coalesced over 120ms-1s (`vlist-reload-policy.ts`). And because a
 * reload replaces the whole loaded window, it had to be DEFERRED while the reader
 * was scrolled up — so browsing history during a live turn meant the view knowingly
 * fell behind.
 *
 * The message body arrives in the event itself (the chunked path already appends
 * from it), so none of that is necessary. Appending costs one row's measurement:
 * measured, an append perturbs at most ONE already-committed item (the previous
 * card's trailing divider flips when it stops being its run's last), so every other
 * row keeps its cached height.
 *
 * What must still reload
 * ---------------------
 * Appending is only valid for a message that goes at the TAIL of the loaded window
 * and does not restructure anything around it. A structural insert (compact marker,
 * ask-in-passing) lands mid-history and shifts every following seq; an edit, a
 * delete or a prune rewrites existing rows. Those keep the reload path.
 *
 * Pure: no React, no DOM, no network.
 */

/** The subset of a message this module reads. */
export interface AppendCandidate {
	id?: unknown;
	seq?: unknown;
	role?: unknown;
	parentToolUseId?: unknown;
	contentJson?: unknown;
}

export type AppendRejection =
	/** No usable id — cannot be de-duplicated, so it is not safe to append. */
	| "no-id"
	/** Already present in the loaded window (a duplicate broadcast / catch-up replay). */
	| "duplicate"
	/** A child message; it belongs to a subagent page's own document. */
	| "child-message"
	/** Carries no seq, so its position in the document is unknown. */
	| "no-seq"
	/** Not newer than the loaded tail — it would land mid-window. */
	| "not-tail"
	/** Restructures the document (compact / ask-in-passing markers). */
	| "structural";

export type AppendDecision = { append: true } | { append: false; reason: AppendRejection };

/**
 * Block types that RESTRUCTURE the document rather than extend it.
 *
 * A compact marker hides everything before it and an ask-in-passing card is
 * inserted mid-history; both shift the seq of following messages, so the loaded
 * window has to be rebuilt from the server rather than extended locally. Mirrors the
 * chunked path's `isStructuralInsert`.
 */
const STRUCTURAL_BLOCK_TYPES = new Set([
	"compact",
	"segment_compact",
	"ask_in_passing",
	"context_cleared",
]);

function hasStructuralBlock(message: AppendCandidate): boolean {
	const blocks = message.contentJson;
	if (!Array.isArray(blocks)) return false;
	for (const block of blocks) {
		const type = (block as { type?: unknown } | null)?.type;
		if (typeof type === "string" && STRUCTURAL_BLOCK_TYPES.has(type)) return true;
	}
	return false;
}

function seqOf(message: AppendCandidate): number | undefined {
	return typeof message.seq === "number" && Number.isFinite(message.seq) ? message.seq : undefined;
}

export interface ResolveAppendInput {
	message: AppendCandidate;
	/** PERSISTED messages of the loaded window, ascending by seq. */
	loaded: readonly AppendCandidate[];
	/** A subagent page treats its own (parent-pointing) messages as top-level. */
	isSubagent: boolean;
}

/**
 * Resolve whether `message` may extend the loaded window in place.
 *
 * Deliberately conservative: anything it is not sure about falls back to the reload
 * path, which is always correct (just slower). The reasons are returned rather than
 * a bare boolean so the caller can tell "already have it" (do nothing at all) from
 * "cannot append" (reload).
 */
export function resolveMessageAppend(input: ResolveAppendInput): AppendDecision {
	const { message, loaded, isSubagent } = input;
	if (typeof message.id !== "string" || message.id.length === 0) {
		return { append: false, reason: "no-id" };
	}
	// A child message belongs to the subagent's own page; on a parent page only the
	// activity summary reflects it (maintained by the live patch channel).
	if (!isSubagent && message.parentToolUseId) {
		return { append: false, reason: "child-message" };
	}
	if (hasStructuralBlock(message)) return { append: false, reason: "structural" };
	for (const existing of loaded) {
		if (existing.id === message.id) return { append: false, reason: "duplicate" };
	}
	const seq = seqOf(message);
	if (seq == null) return { append: false, reason: "no-seq" };
	// Must extend the TAIL. A lower seq means it belongs inside the loaded window
	// (or below it), which only the server can place correctly.
	let maxLoadedSeq: number | undefined;
	for (const existing of loaded) {
		const existingSeq = seqOf(existing);
		if (existingSeq == null) continue;
		if (maxLoadedSeq == null || existingSeq > maxLoadedSeq) maxLoadedSeq = existingSeq;
	}
	if (maxLoadedSeq != null && seq <= maxLoadedSeq) {
		return { append: false, reason: "not-tail" };
	}
	return { append: true };
}

/**
 * Append `message` to `loaded`, returning the same array when it must not be
 * appended (so the caller can skip a rebuild by identity).
 */
export function appendLoadedMessage<T extends AppendCandidate>(
	loaded: readonly T[],
	message: T,
	isSubagent: boolean,
): { messages: readonly T[]; appended: boolean; reason?: AppendRejection } {
	const decision = resolveMessageAppend({ message, loaded, isSubagent });
	if (!decision.append) return { messages: loaded, appended: false, reason: decision.reason };
	return { messages: [...loaded, message], appended: true };
}
