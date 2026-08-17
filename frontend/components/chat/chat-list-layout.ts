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

/**
 * What the quote strip can say about the message being replied to.
 *
 * These three were previously collapsed into "null preview", which the row then
 * rendered as "this message was deleted" — wrong for the common case of quoting
 * something outside the loaded page window, and indistinguishable from a real delete.
 *
 *  - `quoted`      — text is available (from the stored snapshot, or resolved locally
 *                    for rows written before snapshots existed).
 *  - `deleted`     — the target was already deleted when the reply was posted, or is
 *                    deleted in the loaded window.
 *  - `unavailable` — a legacy row whose target is not in the loaded window. Nothing
 *                    can be said about its content; saying so is the honest answer.
 */
export type ChatReplyState = "quoted" | "deleted" | "unavailable";

export interface ChatReplyInfo {
	state: ChatReplyState;
	/** Quoted text; empty unless `state === "quoted"`. */
	preview: string;
	/** Display name of the quoted author, when known. */
	authorName: string | null;
	/** Target message id, for the jump action. */
	targetId: string;
	/**
	 * Target `seq`, when known.
	 *
	 * The jump needs it to decide whether the target is simply not loaded yet (fetch
	 * older pages until `seq` is covered) versus genuinely unreachable. Null on legacy
	 * rows, where the only option is "jump if already loaded".
	 */
	targetSeq: number | null;
}

export interface ChatRowInput {
	message: ChatMessage;
	/**
	 * Resolved quote strip, or null when the message is not a reply.
	 *
	 * `replyPreview` is kept as a separate flattened field because the measure layer
	 * keys on it, and it must be exactly the string the row draws.
	 */
	reply: ChatReplyInfo | null;
	/** Preview text the measure layer sizes the strip with. */
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
		const reply = resolveReplyInfo(message, byId);
		rows.push({
			message,
			reply,
			// Only a real quote contributes a preview string; the other two states draw
			// a fixed label, whose width never changes the single-line strip height.
			replyPreview: reply?.state === "quoted" ? reply.preview : reply ? "" : null,
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
	// So does an attachment: a headerless bubble containing only a thumbnail gives
	// the reader no author and no timestamp for a piece of content they may well
	// want to attribute.
	if (message.attachments && message.attachments.length > 0) return false;
	const gap = Date.parse(message.createdAt) - Date.parse(previous.createdAt);
	if (!Number.isFinite(gap)) return false;
	return gap >= 0 && gap <= CHAT_GROUPING_WINDOW_MS;
}

/**
 * Max characters of a quoted message shown in the strip.
 *
 * Mirrors the server's `CHAT_REPLY_PREVIEW_SNAPSHOT_MAX_CHARS`: snapshots arrive
 * already truncated, and this bound only applies to the legacy window-resolution
 * path, so the two must agree or an old row and a new one would clamp differently.
 */
export const CHAT_REPLY_PREVIEW_MAX_CHARS = 120;

function clampReplyPreview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= CHAT_REPLY_PREVIEW_MAX_CHARS) return flat;
	return `${flat.slice(0, CHAT_REPLY_PREVIEW_MAX_CHARS)}…`;
}

/**
 * Resolve everything the quote strip needs, snapshot first.
 *
 * Order matters. The server's snapshot (`replyToPreview` / `replyToSender` /
 * `replyToSeq`) is authoritative because it was captured at post time: it says what
 * the quoted message said WHEN IT WAS QUOTED and survives the target scrolling out
 * of the loaded window, an edit, or a later delete. Window resolution is only the
 * fallback for rows written before snapshots existed.
 *
 * `replyToPreview === ""` (empty, not null) is a real state from the server: the
 * target was already deleted at post time. Distinguishing it from null is what lets
 * this report "deleted" without guessing.
 */
export function resolveReplyInfo(
	message: ChatMessage,
	byId: ReadonlyMap<string, ChatMessage>,
): ChatReplyInfo | null {
	const targetId = message.replyToMessageId;
	if (!targetId) return null;

	const snapshotAuthor = message.replyToSender?.username ?? null;
	if (message.replyToPreview != null) {
		const preview = clampReplyPreview(message.replyToPreview);
		return {
			state: preview ? "quoted" : "deleted",
			preview,
			authorName: snapshotAuthor,
			targetId,
			targetSeq: message.replyToSeq ?? null,
		};
	}

	// Legacy row: no snapshot was taken, so the loaded window is all there is.
	const target = byId.get(targetId);
	if (!target) {
		return {
			state: "unavailable",
			preview: "",
			authorName: snapshotAuthor,
			targetId,
			targetSeq: message.replyToSeq ?? null,
		};
	}
	const preview = clampReplyPreview(target.deletedAt ? "" : target.contentText);
	return {
		state: target.deletedAt || !preview ? "deleted" : "quoted",
		preview,
		authorName: snapshotAuthor ?? target.sender?.username ?? null,
		targetId,
		targetSeq: target.seq,
	};
}

/**
 * Backwards-compatible preview-only resolution.
 *
 * Retained because `resolveReplyPreview` is a documented pure helper with its own
 * tests; new code should use {@link resolveReplyInfo}, which can distinguish the
 * three reply states.
 */
export function resolveReplyPreview(
	message: ChatMessage,
	byId: ReadonlyMap<string, ChatMessage>,
): string | null {
	const info = resolveReplyInfo(message, byId);
	if (!info) return null;
	if (info.state === "unavailable") return null;
	return info.preview;
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
		// Passed explicitly: a reply whose target is deleted or unresolvable has an
		// empty preview but still draws a strip, which the preview cannot express.
		hasReply: row.reply !== null,
		grouped: row.grouped,
		attachments: row.message.attachments ?? [],
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
