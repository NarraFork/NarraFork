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
 * delete rewrites existing rows. Those keep the reload path.
 *
 * Pure: no React, no DOM, no network.
 */

import { mergeToolRecordWithSubagentActivity } from "../message/message-tree-utils";
import { contentBlockIdentity } from "../streaming/streaming-block-supersede";

/** The subset of a message this module reads. */
export interface AppendCandidate {
	id?: unknown;
	seq?: unknown;
	role?: unknown;
	parentToolUseId?: unknown;
	contentJson?: unknown;
	children?: readonly unknown[];
	toolCalls?: readonly unknown[];
	deliveryId?: unknown;
	deliveryKind?: unknown;
	deliveryState?: unknown;
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
 * An ask-in-passing card and a context-cleared marker are inserted mid-history
 * and shift the seq of following messages, so the loaded window has to be rebuilt
 * from the server rather than extended locally. Mirrors the chunked path's
 * `isStructuralInsert`.
 *
 * Compact markers are deliberately NOT here any more. A compact / segment_compact
 * marker that lands at the TAIL extends the window like any other row: its
 * "everything before me is compacted away" meaning is a property of the SERVER's
 * next load (the window starts at the marker), not a reason to yank already-loaded
 * history out from under a reader who is browsing it — the deferred reload fired
 * by `compact_done` owns that eventual convergence. A marker that lands
 * MID-history (a segment compact, or a custom compact with a `beforeMessageId`)
 * is still declined here by the ordinary not-tail check, and the caller routes it
 * to `vlist-message-insert.ts`, which places it exactly.
 */
const STRUCTURAL_BLOCK_TYPES = new Set(["ask_in_passing", "context_cleared"]);

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

/**
 * Merge one realtime/catch-up message by its canonical id and seq.
 *
 * A duplicate id is not necessarily a no-op: delivery state, creator metadata and
 * edited content can advance after the first event. Conversely, a different id at an
 * already occupied seq is an out-of-order replay and must not mint a second row.
 */
export function upsertLoadedMessage<T extends AppendCandidate>(
	loaded: readonly T[],
	message: T,
	isSubagent: boolean,
): { messages: readonly T[]; changed: boolean; appended: boolean; reason?: AppendRejection } {
	if (typeof message.id !== "string" || message.id.length === 0)
		return { messages: loaded, changed: false, appended: false, reason: "no-id" };
	const sameId = loaded.findIndex((existing) => existing.id === message.id);
	if (sameId >= 0) {
		if (loaded[sameId] === message) return { messages: loaded, changed: false, appended: false };
		const previous = loaded[sameId];
		let contentJson = message.contentJson;
		if (Array.isArray(contentJson) && Array.isArray(previous.contentJson)) {
			const revisions = new Map(
				previous.contentJson.flatMap((block) => {
					const identity = block && typeof block === "object" ? contentBlockIdentity(block) : null;
					return identity ? [[identity.id, { block, revision: identity.revision }] as const] : [];
				}),
			);
			const previousTools = new Map(
				previous.contentJson.flatMap((block) => {
					const candidate = block as { type?: unknown; id?: unknown } | null;
					if (candidate?.type !== "tool_use" || typeof candidate.id !== "string") return [];
					return [[candidate.id, block] as const];
				}),
			);
			contentJson = contentJson.map((block) => {
				const identity = block && typeof block === "object" ? contentBlockIdentity(block) : null;
				const existing = identity ? revisions.get(identity.id) : undefined;
				if (existing && identity && existing.revision > identity.revision) return existing.block;
				// tool_use blocks have no stream revision identity. An upsert snapshot can
				// still carry the pre-completion status; merge by toolUseId so a live-patched
				// `success` is not overwritten by a stale `running`.
				const candidate = block as { type?: unknown; id?: unknown } | null;
				if (candidate?.type === "tool_use" && typeof candidate.id === "string") {
					const prior = previousTools.get(candidate.id);
					if (prior) {
						return mergeToolRecordWithSubagentActivity(prior, block);
					}
				}
				return block;
			});
		}
		const previousToolCalls = new Map(
			(Array.isArray(previous.toolCalls) ? previous.toolCalls : []).map((call) => {
				const id = (call as { toolUseId?: unknown } | null)?.toolUseId;
				return [typeof id === "string" ? id : "", call] as const;
			}),
		);
		const incomingToolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
		const toolCalls = incomingToolCalls.length
			? incomingToolCalls.map((call) => {
					const id = (call as { toolUseId?: unknown } | null)?.toolUseId;
					const prior = typeof id === "string" ? previousToolCalls.get(id) : undefined;
					if (!prior) return call;
					return mergeToolRecordWithSubagentActivity(prior, call);
				})
			: previous.toolCalls;
		const messages = [...loaded];
		messages[sameId] = {
			...previous,
			...message,
			// Same-block replay cannot roll an acknowledged revision backwards. Missing
			// blocks still follow the incoming snapshot (explicit rollback/edit semantics).
			contentJson,
			// Projection broadcasts intentionally omit aggregate children/tool calls; retain
			// the already-loaded rich tree while still applying canonical body/state fields.
			children: message.children?.length ? message.children : previous.children,
			toolCalls,
		} as T;
		return { messages, changed: true, appended: false };
	}
	const seq = seqOf(message);
	if (seq != null) {
		const sameSeq = loaded.findIndex((existing) => seqOf(existing) === seq);
		if (sameSeq >= 0) {
			// A canonical id is authoritative; do not overwrite another row merely because
			// an old catch-up payload reused a stale seq.
			return { messages: loaded, changed: false, appended: false, reason: "duplicate" };
		}
	}
	const appended = appendLoadedMessage(loaded, message, isSubagent);
	return {
		messages: appended.messages,
		changed: appended.appended,
		appended: appended.appended,
		reason: appended.reason,
	};
}
