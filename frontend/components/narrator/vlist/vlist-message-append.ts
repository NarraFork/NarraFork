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

import type { BaseContentBlock } from "@frontend/lib/api/types";
import {
	blockAtIndex,
	type MessageBodySource,
	type MessageWithBody,
	mapRowElements,
	messageBody,
	withoutBody,
} from "@shared/narrator-blocks/message-blocks";
import { mergeToolRecordWithSubagentActivity } from "../message/message-tree-utils";
import { endOfNestedRows, isNestedRow } from "../message/nested-rows";
import { contentBlockIdentity } from "../streaming/streaming-block-supersede";
import { preserveReasoningTranslationElement } from "./vlist-live-patch";

/** The subset of a message this module reads. */
export interface AppendCandidate extends MessageBodySource {
	id?: unknown;
	seq?: unknown;
	stateRevision?: number;
	role?: unknown;
	parentToolUseId?: unknown;
	parentMessageId?: unknown;
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
	/**
	 * A child message: it belongs to a subagent page's own document, or is nested under
	 * a row that is not loaded.
	 */
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

/** The candidate as the block accessors read it. */
const asRow = (message: AppendCandidate) =>
	message as unknown as MessageWithBody<Record<string, unknown>>;

function hasStructuralBlock(message: AppendCandidate): boolean {
	for (const block of messageBody(asRow(message))) {
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
	// activity summary reflects it (maintained by the live patch channel). A nested row
	// goes under its parent, never at the tail.
	if ((!isSubagent && message.parentToolUseId) || isNestedRow(message)) {
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
		if (isNestedRow(existing)) continue;
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
		const previousBody = messageBody(asRow(previous));
		let incoming = message;
		if (previousBody.length > 0) {
			const revisions = new Map(
				previousBody.flatMap((block) => {
					const identity = block && typeof block === "object" ? contentBlockIdentity(block) : null;
					return identity ? [[identity.id, { block, revision: identity.revision }] as const] : [];
				}),
			);
			const previousTools = new Map(
				previousBody.flatMap((block) => {
					const candidate = block as { type?: unknown; id?: unknown } | null;
					if (candidate?.type !== "tool_use" || typeof candidate.id !== "string") return [];
					return [[candidate.id, block] as const];
				}),
			);
			const translationElements = new Map(
				previous.blocks?.flatMap((held) =>
					held.elements.flatMap((value) => {
						const element = value as BaseContentBlock;
						return element?.id ? [[JSON.stringify([held.id, element.id]), element] as const] : [];
					}),
				) ?? [],
			);
			const previousBlocks = new Map(previous.blocks?.map((block) => [block.id, block]));
			incoming = mapRowElements(asRow(message), (block, index) => {
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
				const held = blockAtIndex(asRow(message), index);
				const priorHeld = held ? previousBlocks.get(held.id) : undefined;
				const olderSameBody =
					!!held?.named &&
					!!priorHeld?.named &&
					held.revision === priorHeld.revision &&
					typeof message.stateRevision === "number" &&
					typeof previous.stateRevision === "number" &&
					message.stateRevision < previous.stateRevision;
				return preserveReasoningTranslationElement(
					block as unknown as BaseContentBlock,
					translationElements.get(JSON.stringify([held?.id, block.id])),
					olderSameBody,
				) as unknown as typeof block;
			}) as unknown as T;
			if (incoming.blocks) {
				const blocks = incoming.blocks.map((block) => {
					const prior = previousBlocks.get(block.id);
					// A delayed checkpoint cannot roll either a reasoning body or its
					// persistent body revision backwards after a state patch was accepted.
					return block.kind === "reasoning" &&
						block.named &&
						prior?.named &&
						prior.kind === "reasoning" &&
						prior.revision > block.revision
						? prior
						: block;
				});
				if (blocks.some((block, index) => block !== incoming.blocks?.[index]))
					incoming = { ...incoming, blocks } as T;
			}
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
			// The body is the incoming one, never the previous row's.
			...withoutBody(previous),
			// Same-block replay cannot roll an acknowledged revision backwards. Missing
			// blocks still follow the incoming snapshot (explicit rollback/edit semantics).
			...incoming,
			stateRevision: Math.max(previous.stateRevision ?? 0, incoming.stateRevision ?? 0),
			// Projection broadcasts intentionally omit aggregate tool calls; retain the
			// already-loaded ones while still applying canonical body/state fields. Rows
			// nested under this one stay where they are.
			toolCalls,
		} as T;
		return { messages, changed: true, appended: false };
	}
	if (isNestedRow(message)) {
		// A new nested row goes after its parent and the rows already nested under it.
		const parent = loaded.findIndex((existing) => existing.id === message.parentMessageId);
		if (parent < 0)
			return { messages: loaded, changed: false, appended: false, reason: "child-message" };
		const messages = [...loaded];
		messages.splice(endOfNestedRows(loaded, parent), 0, message);
		return { messages, changed: true, appended: false };
	}
	const seq = seqOf(message);
	if (seq != null) {
		const sameSeq = loaded.findIndex(
			(existing) => !isNestedRow(existing) && seqOf(existing) === seq,
		);
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
