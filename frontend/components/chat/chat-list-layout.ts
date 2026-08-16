/**
 * chat-list-layout.ts — Pure layout logic for the chat virtual list.
 *
 * Split out of the component so the parts that are easy to get wrong — message
 * grouping, scroll anchoring across a prepended page, bottom-pin decisions — are
 * unit-testable without a DOM. No React, no measurement.
 */

import type { ChatMessage } from "../../lib/api/chat";
import type { ChatMeasureIdentity } from "./chat-measure-cache";

/**
 * Window within which a follow-up message from the same author is "grouped"
 * (header row omitted). 5 minutes: long enough to fold a burst of typing, short
 * enough that a reply hours later still carries its own timestamp.
 */
export const CHAT_GROUPING_WINDOW_MS = 5 * 60_000;

/**
 * Distance from the bottom, in px, still counted as "at the bottom".
 *
 * Not zero: the browser settles a programmatic `scrollTop` a fraction of a pixel
 * away, and a sub-pixel gap must not silently unpin the view.
 */
export const CHAT_BOTTOM_PIN_SLACK = 24;

/** Extra px above and below the viewport kept mounted. */
export const CHAT_OVERSCAN_PX = 600;

export interface ChatRowInput {
	message: ChatMessage;
	/** Preview of the quoted message, resolved from the loaded window. */
	replyPreview: string | null;
	/** Consecutive message from the same author inside the grouping window. */
	grouped: boolean;
}

/**
 * Decide grouping and resolve reply previews for a whole (oldest-first) list.
 *
 * Grouping depends on the PREVIOUS message, which is why it cannot be decided
 * per-row inside the render pass: a newly prepended page changes the grouping of
 * the row that used to be first.
 */
export function buildChatRows(messages: readonly ChatMessage[]): ChatRowInput[] {
	const byId = new Map(messages.map((message) => [message.id, message]));
	const rows: ChatRowInput[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const previous = i > 0 ? messages[i - 1] : undefined;
		rows.push({
			message,
			replyPreview: resolveReplyPreview(message, byId),
			grouped: isGroupedWith(previous, message),
		});
	}
	return rows;
}

/** True when `message` continues `previous`: same author, inside the window. */
export function isGroupedWith(previous: ChatMessage | undefined, message: ChatMessage): boolean {
	if (!previous) return false;
	if (previous.kind !== "text" || message.kind !== "text") return false;
	if (!previous.sender || !message.sender) return false;
	if (previous.sender.id !== message.sender.id) return false;
	// A reply opens a new visual group: the quote strip needs a header above it to
	// say who is replying.
	if (message.replyToMessageId) return false;
	const gap = Date.parse(message.createdAt) - Date.parse(previous.createdAt);
	if (!Number.isFinite(gap)) return false;
	return gap >= 0 && gap <= CHAT_GROUPING_WINDOW_MS;
}

/** Max characters of a quoted message shown in the strip. */
export const CHAT_REPLY_PREVIEW_MAX_CHARS = 120;

/**
 * One-line preview of the quoted message.
 *
 * Returns null when the target is not in the loaded window — the strip then just
 * says "replying" without a body, rather than triggering a fetch mid-layout.
 */
export function resolveReplyPreview(
	message: ChatMessage,
	byId: ReadonlyMap<string, ChatMessage>,
): string | null {
	if (!message.replyToMessageId) return null;
	const target = byId.get(message.replyToMessageId);
	if (!target) return null;
	const flat = (target.deletedAt ? "" : target.contentText).replace(/\s+/g, " ").trim();
	if (!flat) return "";
	return flat.length > CHAT_REPLY_PREVIEW_MAX_CHARS
		? `${flat.slice(0, CHAT_REPLY_PREVIEW_MAX_CHARS)}…`
		: flat;
}

/** Measure identity for one row (what the cache keys on). */
export function toMeasureIdentity(row: ChatRowInput): ChatMeasureIdentity {
	return {
		id: row.message.id,
		text: row.message.deletedAt ? "" : row.message.contentText,
		deleted: !!row.message.deletedAt,
		// `text` alone cannot separate two revisions of one message: the cache's text
		// signature is length plus the first and last 64 characters, so an edit that
		// preserves those would reuse the old measured height.
		editedAt: row.message.editedAt,
		replyPreview: row.replyPreview,
		grouped: row.grouped,
	};
}

/** Whether a scroll position counts as pinned to the bottom. */
export function isPinnedToBottom(
	scrollTop: number,
	clientHeight: number,
	scrollHeight: number,
	slack = CHAT_BOTTOM_PIN_SLACK,
): boolean {
	return scrollHeight - scrollTop - clientHeight <= slack;
}

/**
 * The `scrollTop` that keeps an anchored row visually still across a rebuild.
 *
 * Prepending older history shifts every existing row down by the height of the
 * inserted block. Without compensation the reader's viewport jumps backwards by
 * exactly that amount, which is the single most noticeable defect in an
 * infinite-scroll history. The caller captures the anchor's `top` BEFORE the
 * rebuild and its new `top` after, then writes the returned value.
 */
export function anchoredScrollTop(
	previousScrollTop: number,
	previousAnchorTop: number,
	nextAnchorTop: number,
): number {
	return Math.max(0, previousScrollTop + (nextAnchorTop - previousAnchorTop));
}
