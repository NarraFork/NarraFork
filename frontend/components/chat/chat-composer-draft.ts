/**
 * chat-composer-draft.ts — An unsent chat composer, across a reload.
 *
 * `ChatRoomView` is mounted with `key={roomId}`, so switching rooms remounts it
 * and destroys the composer state exactly like a refresh does. What is lost is
 * the typed text and the list of attachments already uploaded but not yet sent.
 *
 * WHY THIS IS NOT THE NARRATOR MECHANISM
 * --------------------------------------
 * A chat attachment is uploaded the moment it is picked: the bytes are already
 * on the server as an unclaimed `chat_attachments` row (`message_id IS NULL`),
 * and the composer only holds an id. So there is nothing to store but a few
 * hundred bytes of metadata — no Blobs, hence `sessionStorage` (through the
 * session store, which already provides the LRU, byte budget, key caps, write
 * coalescing and quota handling) rather than IndexedDB.
 *
 * Narrator attachments are the opposite case: never uploaded, so their bytes
 * have nowhere else to live. See `narrator/composer/draft-image-attachments.ts`.
 */

import { readSession, removeSession, writeSession } from "@frontend/lib/session-store";

const CHAT_DRAFT_STORAGE_VERSION = 1;

/**
 * The server's reclaim window for an unclaimed attachment
 * (`CHAT_DRAFT_ATTACHMENT_TTL_MS` in server/lib/chat-attachments.ts).
 *
 * Mirrored rather than imported because `@server/lib/chat-attachments` pulls in
 * `node:path` and the server data directory at module scope, which cannot be
 * bundled for the browser. This follows the existing convention in
 * `ChatRoomView.tsx`, where `CHAT_MESSAGE_MAX_CHARS` and
 * `CHAT_ATTACHMENTS_PER_MESSAGE_MAX` are mirrored the same way.
 *
 * If the server value changes, change this one with it.
 */
const SERVER_RECLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Safety margin subtracted from the server's window.
 *
 * Restoring an attachment the sweep is about to take is indistinguishable, from the
 * user's side, from restoring one it already took: the chip looks fine and the send
 * fails with a message naming no file and suggesting no fix. Without a margin that is
 * reachable in ordinary use — an attachment 23h59m old passes the check here and is
 * reclaimed while the request is in flight.
 *
 * An hour, because the cost of the two directions is not symmetric: expiring slightly
 * early drops a chip the user can re-attach in seconds, while expiring slightly late
 * produces a failure they cannot act on. The unavailable-code path in `ChatRoomView`
 * still marks the chips as failed if this margin is ever wrong.
 */
const RECLAIM_SAFETY_MARGIN_MS = 60 * 60 * 1000;

/**
 * How long this module will restore an attachment id for.
 *
 * Deliberately SHORTER than the server's window; see the two constants above. It must
 * never exceed it.
 */
export const CHAT_DRAFT_ATTACHMENT_TTL_MS = SERVER_RECLAIM_WINDOW_MS - RECLAIM_SAFETY_MARGIN_MS;

/** One already-uploaded attachment, as little as is needed to rebuild its chip. */
export interface StoredChatDraftAttachment {
	id: string;
	filename: string;
	sizeBytes: number;
	kind: "image" | "file";
	/**
	 * Stored so the restored chip carries the server's real type.
	 *
	 * Cheap, and the alternative is fabricating one (`"image/*"`), which would put a
	 * value the server never sent into a `ChatAttachment` — invisible in the chip
	 * itself, and wrong for anything downstream that later trusts the field.
	 */
	mediaType: string;
	/**
	 * When this attachment was UPLOADED, which is what its expiry is measured from.
	 *
	 * Deliberately per-attachment rather than per-draft. The server's sweep keys on
	 * the attachment row's `created_at`, so anchoring expiry on when the draft was
	 * last touched would be wrong in a way that produces exactly the failure this
	 * TTL exists to prevent: attach a file, keep typing in that room for two days,
	 * and the draft looks fresh while the attachment was reclaimed on day one.
	 */
	uploadedAtMs: number;
}

export interface StoredChatDraft {
	text: string;
	attachments: StoredChatDraftAttachment[];
}

interface StoredChatDraftEnvelope extends StoredChatDraft {
	version: typeof CHAT_DRAFT_STORAGE_VERSION;
	savedAtMs: number;
}

function emptyDraft(): StoredChatDraft {
	return { text: "", attachments: [] };
}

/**
 * Storage id for one `(user, room)` pair.
 *
 * The user id is length-prefixed so `("a_b", "c")` and `("a", "b_c")` cannot
 * collide — the same reasoning as `narrator-draft-storage.ts`, where without it
 * a crafted id could address another account's draft.
 */
export function getChatDraftStorageId(userId: string, roomId: string): string {
	return `${userId.length}:${userId}:${roomId}`;
}

function isStoredAttachment(value: unknown): value is StoredChatDraftAttachment {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<StoredChatDraftAttachment>;
	return (
		typeof item.id === "string" &&
		item.id.length > 0 &&
		typeof item.filename === "string" &&
		typeof item.sizeBytes === "number" &&
		Number.isFinite(item.sizeBytes) &&
		(item.kind === "image" || item.kind === "file") &&
		typeof item.mediaType === "string" &&
		item.mediaType.length > 0 &&
		typeof item.uploadedAtMs === "number" &&
		Number.isFinite(item.uploadedAtMs) &&
		item.uploadedAtMs > 0
	);
}

/**
 * Read back a stored composer.
 *
 * An expired ATTACHMENT is dropped while the TEXT is always kept: text has no
 * server-side dependency, so it is equally valid at any age, whereas an expired
 * attachment id names a row the server's sweep has already deleted. Expiry is
 * per attachment, so a two-day-old draft still restores an image attached ten
 * minutes ago.
 */
export function readChatComposerDraft(
	userId: string,
	roomId: string,
	now: number = Date.now(),
): StoredChatDraft {
	const id = getChatDraftStorageId(userId, roomId);
	try {
		const raw = readSession("chat-draft", id);
		if (!raw) return emptyDraft();
		const parsed = JSON.parse(raw) as Partial<StoredChatDraftEnvelope>;
		if (parsed.version !== CHAT_DRAFT_STORAGE_VERSION || typeof parsed.text !== "string") {
			removeSession("chat-draft", id);
			return emptyDraft();
		}
		const cutoff = now - CHAT_DRAFT_ATTACHMENT_TTL_MS;
		const attachments = (Array.isArray(parsed.attachments) ? parsed.attachments : [])
			.filter(isStoredAttachment)
			.filter((item) => item.uploadedAtMs > cutoff);
		return { text: parsed.text, attachments };
	} catch {
		// A malformed value is treated as absent rather than thrown: a composer
		// draft is a convenience and must never take the room view down.
		return emptyDraft();
	}
}

/**
 * Mirror the composer locally.
 *
 * An empty composer REMOVES the entry instead of storing an empty one, so a sent
 * message does not leave a key behind occupying the namespace cap.
 */
export function persistChatComposerDraft(
	userId: string,
	roomId: string,
	draft: StoredChatDraft,
	now: number = Date.now(),
): void {
	const id = getChatDraftStorageId(userId, roomId);
	if (!draft.text && draft.attachments.length === 0) {
		removeSession("chat-draft", id);
		return;
	}
	const envelope: StoredChatDraftEnvelope = {
		version: CHAT_DRAFT_STORAGE_VERSION,
		savedAtMs: now,
		text: draft.text,
		attachments: draft.attachments,
	};
	writeSession("chat-draft", id, JSON.stringify(envelope));
}

export function clearChatComposerDraft(userId: string, roomId: string): void {
	removeSession("chat-draft", getChatDraftStorageId(userId, roomId));
}
