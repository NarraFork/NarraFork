/**
 * Pure helpers for the per-connection, per-narrator catch-up buffer.
 *
 * While a catch-up query runs for a narrator that the socket is already
 * subscribed to, realtime broadcast frames must be held back and replayed in
 * order AFTER the historical `catch_up` frame is sent — otherwise a live
 * `message` could render before the history it belongs after. These helpers own
 * the accumulation, overflow, and dedup decisions so they can be unit-tested
 * without the WebSocket machinery.
 */

import type { NarratorServerMessage } from "./narrator-ws-types";

export const CATCH_UP_BUFFER_MAX_MESSAGES = 1000;
export const CATCH_UP_BUFFER_MAX_BYTES = 2_000_000;

export interface CatchUpBuffer {
	messages: NarratorServerMessage[];
	bytes: number;
	overflowed: boolean;
	/** Message ids already delivered via a `catch_up` frame during this window. */
	sentMessageIds: Set<string>;
}

export function createCatchUpBuffer(): CatchUpBuffer {
	return { messages: [], bytes: 0, overflowed: false, sentMessageIds: new Set() };
}

/**
 * Accumulate a realtime frame into the buffer. Sets `overflowed` (and drops the
 * frame) when the message-count or byte budget would be exceeded, so a hot
 * stream during a slow catch-up degrades to a single `full_reload` instead of
 * unbounded memory growth.
 */
export function bufferRealtimeMessage(
	buffer: CatchUpBuffer,
	message: NarratorServerMessage,
	payloadLength: number,
): void {
	if (buffer.overflowed) return;
	const nextBytes = buffer.bytes + payloadLength;
	if (
		buffer.messages.length >= CATCH_UP_BUFFER_MAX_MESSAGES ||
		nextBytes > CATCH_UP_BUFFER_MAX_BYTES
	) {
		buffer.overflowed = true;
		return;
	}
	buffer.messages.push(message);
	buffer.bytes = nextBytes;
}

/** Recursively collect every message id embedded in a catch-up payload. */
export function collectMessageIds(value: unknown, ids = new Set<string>()): Set<string> {
	if (!value || typeof value !== "object") return ids;
	if (Array.isArray(value)) {
		for (const item of value) collectMessageIds(item, ids);
		return ids;
	}
	const record = value as { id?: unknown; message?: unknown; children?: unknown };
	if (typeof record.id === "string") ids.add(record.id);
	if (record.message) collectMessageIds(record.message, ids);
	if (Array.isArray(record.children)) {
		for (const child of record.children) collectMessageIds(child, ids);
	}
	return ids;
}

/** Extract the message id from a buffered message/user_message frame, if any. */
export function getBufferedMessageId(message: NarratorServerMessage): string | undefined {
	if (message.type !== "message" && message.type !== "user_message") return undefined;
	const payload = message.message;
	if (!payload || typeof payload !== "object") return undefined;
	const id = (payload as { id?: unknown }).id;
	return typeof id === "string" ? id : undefined;
}

/**
 * Compute the frames to actually send when a catch-up buffer window closes.
 * Returns `{ overflow: true }` when the buffer overflowed (caller should send a
 * single `full_reload`); otherwise the buffered frames minus any whose message
 * id was already delivered inside a `catch_up` frame.
 */
export function drainCatchUpBuffer(
	buffer: CatchUpBuffer,
): { overflow: true } | { overflow: false; messages: NarratorServerMessage[] } {
	if (buffer.overflowed) return { overflow: true };
	const out: NarratorServerMessage[] = [];
	for (const message of buffer.messages) {
		const bufferedMessageId = getBufferedMessageId(message);
		if (bufferedMessageId && buffer.sentMessageIds.has(bufferedMessageId)) continue;
		out.push(message);
	}
	return { overflow: false, messages: out };
}
