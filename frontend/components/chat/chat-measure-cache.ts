/**
 * chat-measure-cache.ts — Memoised chat-bubble measurements.
 *
 * The list needs a TOTAL height (to size the scrollbar and restore anchors), so
 * every layout pass measures every message, not just the mounted window. Without
 * a cache a resize would re-parse the whole room's markdown; with one, a width
 * change costs only the frame arithmetic (the parse itself is additionally
 * memoised across widths by `prepared-markdown-cache`).
 *
 * ## Key composition
 *
 * `id | width | revision`, where the revision covers everything that can change a
 * height WITHOUT the id changing:
 *
 *   - `deleted`  — a soft delete swaps the body for a fixed placeholder line.
 *   - `grouped`  — the header row appears/disappears when a neighbour changes.
 *   - `reply`    — the quote strip adds a line.
 *   - text       — signed by length + a bounded sample, never hashed in full.
 *   - `editedAt` — an edit rewrites the body under the same id, and the bounded
 *     text signature cannot see a change that keeps the length and both ends
 *     (a typo fix in the middle of a long message is exactly that). The edit
 *     timestamp is the only field guaranteed to move on every edit.
 *   - attachments — count, kinds and image dimensions, all of which change the
 *     reserved block (see `attachmentsSignature`). A soft delete drops the
 *     attachments, so the `deleted` flag alone would NOT distinguish the two
 *     states' heights.
 *
 * `seq` is deliberately absent: it never changes for a given id.
 *
 * ⚠️ Omitting a height-affecting field from the revision is the classic failure
 * here (CONTRACT.md §4.5 documents the same hazard for the narrator list): the key
 * would match a stale entry and the new content would be drawn into the old box.
 */

import type { ChatMessageMeasureData, MeasuredChatMessage } from "./measure-chat-message";
import {
	attachmentsSignature,
	measureChatMessage,
	preparedChatBlocks,
} from "./measure-chat-message";

/**
 * Cache ceiling. One entry per (message, width) pair, so a room scrolled at two
 * widths holds two entries per message. Generous enough to cover a long session
 * and small enough that the map cannot grow without bound.
 */
const MAX_ENTRIES = 4_000;

/** Characters sampled from each end when signing a body. */
const SIGNATURE_SAMPLE = 64;

const cache = new Map<string, MeasuredChatMessage>();

/**
 * O(1) text signature: length plus a bounded prefix/suffix sample.
 *
 * Called on every measure, so it must not walk the whole body. This is a
 * heuristic, not a hash — two same-length bodies with identical ends collide.
 * The key pairs it with `editedAt` so that an edit (the only way a body changes
 * under a stable id, other than the soft delete the flags cover) still misses.
 */
function textSignature(text: string): string {
	if (text.length <= SIGNATURE_SAMPLE * 2) return `${text.length}:${text}`;
	return `${text.length}:${text.slice(0, SIGNATURE_SAMPLE)}:${text.slice(-SIGNATURE_SAMPLE)}`;
}

export interface ChatMeasureIdentity extends ChatMessageMeasureData {
	/** Stable message id. */
	id: string;
	/**
	 * Edit timestamp (`ChatMessage.editedAt`), null when never edited.
	 *
	 * Optional so a caller that predates editing keeps compiling; it must be
	 * forwarded once an edit path exists, or the bounded text signature will let
	 * an equal-length edit reuse the old height.
	 */
	editedAt?: string | null;
}

function buildKey(identity: ChatMeasureIdentity, outerWidth: number): string {
	// `hasReply` joins the flags rather than riding on the preview signature: a reply
	// to a deleted message has an EMPTY preview but still reserves the strip, so the
	// preview alone cannot separate "reply, no text" from "not a reply".
	const flags = `${identity.deleted ? "d" : "-"}${identity.grouped ? "g" : "-"}${
		(identity.hasReply ?? !!identity.replyPreview?.trim()) ? "q" : "-"
	}`;
	const reply = identity.replyPreview?.trim() ? textSignature(identity.replyPreview) : "";
	const edited = identity.editedAt ?? "";
	const attachments = attachmentsSignature(identity.attachments);
	return `${identity.id}|${outerWidth}|${flags}|e${edited}|r${reply}|a${attachments}|t${textSignature(identity.text)}`;
}

/** Measure with memoisation. Identical inputs always return the same object. */
export function measureChatMessageCached(
	identity: ChatMeasureIdentity,
	outerWidth: number,
): MeasuredChatMessage {
	const key = buildKey(identity, outerWidth);
	const hit = cache.get(key);
	if (hit) {
		// Refresh recency: re-inserting moves the key to the end of the iteration
		// order, which is what makes the eviction below approximate an LRU.
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	const measured = measureChatMessage(identity, outerWidth, {
		// An empty body needs no parse regardless of why it is empty (deleted, or an
		// attachment-only message), and `measureChatMessage` distinguishes those two
		// cases itself from `deleted` + `attachments`.
		preparedBlocks:
			identity.deleted || !identity.text.trim() ? [] : preparedChatBlocks(identity.text),
	});
	if (cache.size >= MAX_ENTRIES) {
		// Drop the oldest ~10% in one pass rather than one entry per insert, so a
		// steady-state overflow does not pay the eviction cost on every measure.
		const drop = Math.max(1, Math.floor(MAX_ENTRIES / 10));
		let removed = 0;
		for (const staleKey of cache.keys()) {
			cache.delete(staleKey);
			if (++removed >= drop) break;
		}
	}
	cache.set(key, measured);
	return measured;
}

/** Drop every entry (tests, and a hard reset of the surface). */
export function resetChatMeasureCache(): void {
	cache.clear();
}

/** Entry count, for tests and diagnostics. */
export function chatMeasureCacheSize(): number {
	return cache.size;
}
