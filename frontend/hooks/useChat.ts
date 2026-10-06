import {
	type InfiniteData,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "../lib/api";
import type {
	ChatAttachment,
	ChatMessage,
	ChatMessagePage,
	ChatRoomSummary,
	ChatUnreadSummary,
} from "../lib/api/chat";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const CHAT_GC_TIME_MS = 60_000;
const CHAT_PAGE_SIZE = 50;

/**
 * Freshness window for the badge and room-list summaries.
 *
 * These are kept current by WebSocket frames (`useChatUnreadLive` patches the cache on
 * `chat:unread_changed`, and a reconnect refetches), so a fetch triggered merely by mounting
 * or by refocusing the window is redundant work: the cached value is already the live one.
 *
 * Without this the badge query defaulted to `staleTime: 0`, which combined badly with two
 * things at once — `useNavBadges` is consumed from both the nav rail and the overflow menu,
 * so each mount refetched, and React Query's `refetchOnWindowFocus` fired on every Alt-Tab
 * back into the app. The endpoint counts unread rows across a user's rooms, so this was
 * repeated server work to re-derive a number the socket had already delivered.
 *
 * 30 s rather than `Infinity`: the socket is the fast path, not a guarantee. If a frame is
 * ever dropped outside a detected reconnect, a focus or remount within the next half-minute
 * still reconciles it.
 */
const CHAT_SUMMARY_STALE_TIME_MS = 30_000;

export const chatKeys = {
	directory: (q?: string) => ["chat", "directory", q ?? ""] as const,
	rooms: () => ["chat", "rooms"] as const,
	unread: () => ["chat", "unread"] as const,
	narratorRoom: (narratorId: string) => ["chat", "narrator-room", narratorId] as const,
	messages: (roomId: string) => ["chat", "messages", roomId] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Rooms
// ─────────────────────────────────────────────────────────────────────────────

export function useChatDirectory(query?: string, enabled = true) {
	return useQuery({
		queryKey: chatKeys.directory(query),
		queryFn: () => api.listChatDirectory(query),
		enabled,
		gcTime: CHAT_GC_TIME_MS,
	});
}

export function useChatRooms() {
	return useQuery({
		queryKey: chatKeys.rooms(),
		queryFn: () => api.listChatRooms(),
		gcTime: CHAT_GC_TIME_MS,
		staleTime: CHAT_SUMMARY_STALE_TIME_MS,
	});
}

export function useChatUnread() {
	return useQuery({
		queryKey: chatKeys.unread(),
		queryFn: () => api.getChatUnread(),
		gcTime: CHAT_GC_TIME_MS,
		staleTime: CHAT_SUMMARY_STALE_TIME_MS,
	});
}

/** Resolve (lazily creating) the discussion room bound to a narrator. */
export function useNarratorChatRoom(narratorId: string | undefined, enabled = true) {
	return useQuery({
		queryKey: chatKeys.narratorRoom(narratorId ?? ""),
		queryFn: () => api.getNarratorChatRoom(narratorId as string),
		enabled: enabled && !!narratorId,
		gcTime: CHAT_GC_TIME_MS,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function useOpenChatDm() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (userId: string) => api.openChatDm(userId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: chatKeys.rooms() });
		},
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paginated room history, newest page first.
 *
 * The cursor is `seq` (`nextBeforeSeq`), so pages never overlap or skip even
 * while new messages arrive at the tail — which an offset would not survive.
 */
export function useChatMessages(roomId: string | undefined) {
	return useInfiniteQuery({
		queryKey: chatKeys.messages(roomId ?? ""),
		queryFn: ({ pageParam }) =>
			api.listChatMessages(roomId as string, {
				beforeSeq: pageParam ?? undefined,
				limit: CHAT_PAGE_SIZE,
			}),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (lastPage: ChatMessagePage) => lastPage.nextBeforeSeq ?? undefined,
		enabled: !!roomId,
		gcTime: CHAT_GC_TIME_MS,
	});
}

/**
 * Flatten the infinite-query pages into one oldest-first array.
 *
 * Pages arrive newest-block-first (page 0 is the tail), and each page's own
 * `messages` is already oldest-first, so the blocks are reversed but their
 * contents are not.
 */
export function useFlatChatMessages(
	data: InfiniteData<ChatMessagePage> | undefined,
): ChatMessage[] {
	return useMemo(() => {
		if (!data) return [];
		const out: ChatMessage[] = [];
		for (let i = data.pages.length - 1; i >= 0; i--) {
			out.push(...data.pages[i].messages);
		}
		// Defensive dedupe: a message can arrive both via WS append and in a page
		// fetched a moment later. Keyed by id, keeping the later (fresher) copy.
		const byId = new Map<string, ChatMessage>();
		for (const message of out) byId.set(message.id, message);
		return [...byId.values()].sort((a, b) => a.seq - b.seq);
	}, [data]);
}

export function useSendChatMessage(roomId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			text: string;
			replyToMessageId?: string | null;
			attachmentIds?: string[];
		}) => api.postChatMessage(roomId as string, input),
		onSuccess: (message) => {
			if (!roomId) return;
			appendChatMessageToCache(qc, roomId, message);
			// Same patch-not-invalidate rule as the live path. Posting also advances
			// the sender's own watermark server-side (`postMessage`), so the local
			// unread is zeroed here instead of waiting for a read frame.
			applyChatMessageToRoomsCache(qc, roomId, message);
			clearChatRoomUnreadInCache(qc, roomId, message.seq);
		},
	});
}

export function useDeleteChatMessage(roomId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (messageId: string) => api.deleteChatMessage(roomId as string, messageId),
		onSuccess: (_result, messageId) => {
			if (!roomId) return;
			markChatMessageDeletedInCache(qc, roomId, messageId);
		},
	});
}

export function useMarkChatRead(roomId: string | undefined) {
	const qc = useQueryClient();
	const lastSentRef = useRef(0);
	return useCallback(
		(seq: number) => {
			if (!roomId || seq <= lastSentRef.current) return;
			lastSentRef.current = seq;
			api
				.markChatRead(roomId, seq)
				.then((result) => {
					// Reading a room only zeroes ONE room's counters, so patch them in
					// place. Invalidating instead would refetch `/chat/rooms`, whose
					// unread probe is one query per membership — a per-scroll N+1.
					clearChatRoomUnreadInCache(qc, roomId, result.lastReadSeq);
				})
				.catch(() => {
					// A failed watermark is recoverable: the next read attempt re-sends a
					// higher seq. Rewind so that retry is not suppressed.
					lastSentRef.current = 0;
				});
		},
		[qc, roomId],
	);
}

export function useSummarizeChat(roomId: string | undefined) {
	return useMutation({
		mutationFn: (messageIds: string[]) => api.summarizeChatMessages(roomId as string, messageIds),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachments
//
// Uploads are NOT part of the send mutation: the composer shows a thumbnail before
// the message exists, so each file is uploaded as it is picked and the ids are
// handed to the send. That also means a failed upload is visible (and retryable)
// on its own chip instead of failing the whole message.
// ─────────────────────────────────────────────────────────────────────────────

export function useUploadChatAttachment(roomId: string | undefined) {
	return useMutation({
		mutationFn: (file: File) => api.uploadChatAttachment(roomId as string, file),
	});
}

/**
 * Discard a draft attachment.
 *
 * No cache invalidation: drafts live in composer state, never in a query — they are
 * not part of any message yet, so nothing cached refers to them.
 */
export function useDiscardChatAttachment() {
	return useMutation({
		mutationFn: (attachmentId: string) => api.deleteChatAttachment(attachmentId),
	});
}

export function useMaterializeChatAttachments(roomId: string | undefined) {
	return useMutation({
		mutationFn: (input: { narratorId: string; attachmentIds: string[] }) =>
			api.materializeChatAttachments(roomId as string, input.narratorId, input.attachmentIds),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure cache transforms
//
// Every live chat frame already carries what the summary queries display, so the
// caches are PATCHED rather than invalidated. This is not just a round-trip
// saving: `GET /chat/rooms` and `GET /chat/unread` probe unread once per
// membership, so invalidating on every message turns an active room into an N+1
// query storm on the server's single SQLite thread.
//
// These are exported as pure functions (cache in → cache out) so the folding
// rules can be tested without a QueryClient or a socket.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirror of the server's `truncatePreview` (chat-service.ts). */
const CHAT_PREVIEW_MAX_CHARS = 120;

/**
 * Build the room-list preview for a body the client received over WS.
 *
 * Must match the server byte for byte: the same room's preview comes from here
 * while live and from the server on the next refetch, and a mismatch would show
 * as the text visibly changing under the reader.
 */
export function chatPreviewFromText(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= CHAT_PREVIEW_MAX_CHARS) return flat;
	return `${flat.slice(0, CHAT_PREVIEW_MAX_CHARS)}…`;
}

/**
 * Room-list preview for a whole message, attachments included.
 *
 * ⚠️ Mirrors the server's `buildRoomPreview` (chat-service.ts) — the attachment-only
 * fallback lists FILENAMES rather than a localized `[image]` marker, because the
 * server writes this string once at post time for readers in every language. If the
 * two diverge, an attachment-only message's preview changes visibly the first time
 * the room list refetches.
 */
export function chatPreviewFromMessage(
	message: Pick<ChatMessage, "contentText" | "deletedAt"> & {
		attachments?: ReadonlyArray<{ filename: string }>;
	},
): string {
	if (message.deletedAt) return "";
	const body = message.contentText.trim();
	if (body) return chatPreviewFromText(body);
	const attachments = message.attachments ?? [];
	if (attachments.length === 0) return "";
	return chatPreviewFromText(attachments.map((attachment) => attachment.filename).join(", "));
}

/**
 * Fold a live message into the room list: preview, timestamp, sender, order.
 *
 * Returns `null` when the room is not in the list — a first message in a DM the
 * list has never seen. There is nothing to patch then, and the caller must
 * refetch to learn the peer snapshot, which no message frame carries.
 *
 * `unread` is deliberately untouched: the viewer of a room is about to mark it
 * read, and someone who is NOT viewing gets a `chat:unread_changed` frame with
 * the authoritative count.
 */
export function applyChatMessageToRooms(
	rooms: ChatRoomSummary[] | undefined,
	roomId: string,
	message: Pick<ChatMessage, "contentText" | "createdAt" | "deletedAt"> & {
		sender: { id: string } | null;
		attachments?: ReadonlyArray<{ filename: string }>;
	},
): ChatRoomSummary[] | null {
	if (!rooms) return null;
	const index = rooms.findIndex((room) => room.id === roomId);
	if (index < 0) return null;
	const patched: ChatRoomSummary = {
		...rooms[index],
		lastMessageAt: message.createdAt,
		// Via the message-level builder so an attachment-only post shows its filenames
		// rather than an empty preview until the next refetch.
		lastMessagePreview: chatPreviewFromMessage(message),
		lastMessageSenderId: message.sender?.id ?? null,
	};
	const next = [...rooms];
	next[index] = patched;
	// The server sorts by `lastMessageAt` descending; keep that invariant locally
	// so the room does not jump position on the next refetch.
	next.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
	return next;
}

/**
 * The server's per-room unread probe ceiling (`CHAT_UNREAD_PROBE_LIMIT`).
 *
 * A count at the ceiling means "at least this many", so arithmetic on it is not
 * trustworthy and the summary is refetched instead.
 */
const CHAT_UNREAD_PROBE_LIMIT = 100;

/**
 * Write an authoritative per-room unread count into the badge summary.
 *
 * Two rules from the server (`getUnreadSummary`) have to be reproduced exactly,
 * or the nav badge and the room list will disagree:
 *
 *  - `byRoom` omits rooms at zero, so a read deletes the key rather than storing 0.
 *  - `dmTotal` counts unmuted DM rooms ONLY. A narrator room's badge belongs on
 *    that narrator's toolbar, so it lives in `byRoom` but not in the total.
 *
 * `dmTotal` is adjusted by this room's delta rather than re-summed: `byRoom` also
 * holds narrator rooms, and nothing here can tell which of the OTHER entries
 * those are (the rooms list only contains DMs).
 *
 * Returns `null` when the patch cannot be trusted — unknown room kind, or a
 * count sitting at the probe ceiling — and the caller refetches instead.
 */
export function applyChatUnreadToSummary(
	summary: ChatUnreadSummary | undefined,
	roomId: string,
	unread: number,
	kind: "dm" | "narrator" | undefined,
	muted = false,
): ChatUnreadSummary | null {
	if (!summary) return null;
	if (kind === undefined) return null;

	const previous = summary.byRoom[roomId] ?? 0;
	const byRoom = { ...summary.byRoom };
	if (unread > 0 && !muted) byRoom[roomId] = unread;
	else delete byRoom[roomId];

	if (kind !== "dm") return { ...summary, byRoom };

	// Either endpoint of the delta being capped makes the arithmetic meaningless.
	if (previous >= CHAT_UNREAD_PROBE_LIMIT || unread >= CHAT_UNREAD_PROBE_LIMIT) return null;

	const effective = muted ? 0 : unread;
	const dmTotal = Math.max(0, summary.dmTotal - previous + effective);
	return {
		...summary,
		dmTotal,
		// A cap set by some other room cannot be cleared from here; only a full
		// refetch knows whether it still holds.
		dmTotalCapped: summary.dmTotalCapped && dmTotal > 0,
		byRoom,
	};
}

/** Zero one room's unread in the room list (the local user read it). */
export function applyChatReadToRooms(
	rooms: ChatRoomSummary[] | undefined,
	roomId: string,
	lastReadSeq: number,
): ChatRoomSummary[] | null {
	if (!rooms) return null;
	const index = rooms.findIndex((room) => room.id === roomId);
	if (index < 0) return null;
	const next = [...rooms];
	next[index] = {
		...next[index],
		unread: 0,
		unreadCapped: false,
		lastReadSeq: Math.max(next[index].lastReadSeq, lastReadSeq),
	};
	return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache mutation helpers (shared with the WS hook)
// ─────────────────────────────────────────────────────────────────────────────

type QueryClient = ReturnType<typeof useQueryClient>;

/**
 * Find a room's cached summary, from either cache that can hold one.
 *
 * `/chat/rooms` returns DM rooms ONLY (`listDmRooms`), so a narrator room is
 * never in that list — its summary lives under `chatKeys.narratorRoom` instead.
 * Consulting both is what lets a narrator panel patch rather than fall back to
 * invalidating on every frame.
 */
function cachedRoomSummary(qc: QueryClient, roomId: string): ChatRoomSummary | undefined {
	const fromList = qc
		.getQueryData<ChatRoomSummary[]>(chatKeys.rooms())
		?.find((room) => room.id === roomId);
	if (fromList) return fromList;
	for (const [, data] of qc.getQueriesData<ChatRoomSummary>({
		queryKey: ["chat", "narrator-room"],
	})) {
		if (data?.id === roomId) return data;
	}
	return undefined;
}

/**
 * Patch the room list for a live message, falling back to a refetch.
 *
 * Three outcomes, and only the last costs a request:
 *  - the room is in the list → patched in place;
 *  - the room is a known narrator room → nothing to do, it is not in the list;
 *  - the room is unknown → refetch, because no message frame carries the peer
 *    snapshot a new DM row needs. That fires once per unknown room, not per
 *    message, since the refetch puts the room in the list.
 */
export function applyChatMessageToRoomsCache(
	qc: QueryClient,
	roomId: string,
	message: ChatMessage,
): void {
	const rooms = qc.getQueryData<ChatRoomSummary[]>(chatKeys.rooms());
	const next = applyChatMessageToRooms(rooms, roomId, message);
	if (next) {
		qc.setQueryData(chatKeys.rooms(), next);
		return;
	}
	if (cachedRoomSummary(qc, roomId)?.kind === "narrator") return;
	qc.invalidateQueries({ queryKey: chatKeys.rooms() });
}

/** Apply a `chat:unread_changed` frame; refetch only if the room kind is unknown. */
export function applyChatUnreadFrameToCache(qc: QueryClient, roomId: string, unread: number): void {
	const cached = cachedRoomSummary(qc, roomId);
	const summary = qc.getQueryData<ChatUnreadSummary>(chatKeys.unread());
	const next = applyChatUnreadToSummary(summary, roomId, unread, cached?.kind, cached?.muted);
	if (next) qc.setQueryData(chatKeys.unread(), next);
	else qc.invalidateQueries({ queryKey: chatKeys.unread() });

	// The room list shows the same count, so keep the two consistent. A room the
	// list does not know about is left to the message-frame fallback above.
	const rooms = qc.getQueryData<ChatRoomSummary[]>(chatKeys.rooms());
	if (!rooms) return;
	const index = rooms.findIndex((room) => room.id === roomId);
	if (index < 0) return;
	const patched = [...rooms];
	patched[index] = { ...patched[index], unread, unreadCapped: false };
	qc.setQueryData(chatKeys.rooms(), patched);
}

/** Zero a room's unread in both summary caches after a successful read. */
export function clearChatRoomUnreadInCache(
	qc: QueryClient,
	roomId: string,
	lastReadSeq: number,
): void {
	const rooms = applyChatReadToRooms(
		qc.getQueryData<ChatRoomSummary[]>(chatKeys.rooms()),
		roomId,
		lastReadSeq,
	);
	if (rooms) qc.setQueryData(chatKeys.rooms(), rooms);

	const summary = qc.getQueryData<ChatUnreadSummary>(chatKeys.unread());
	const next = applyChatUnreadToSummary(summary, roomId, 0, cachedRoomSummary(qc, roomId)?.kind);
	if (next) qc.setQueryData(chatKeys.unread(), next);
	else if (summary) qc.invalidateQueries({ queryKey: chatKeys.unread() });
}

/**
 * Append a live message into the newest page instead of refetching.
 *
 * Page 0 is the tail, so that is where a new message belongs. Refetching would
 * re-download the whole page for one row and, worse, could reorder around a page
 * boundary while the reader is scrolled into history.
 */
export function appendChatMessageToCache(
	qc: QueryClient,
	roomId: string,
	message: ChatMessage,
): void {
	qc.setQueryData<InfiniteData<ChatMessagePage>>(chatKeys.messages(roomId), (previous) => {
		if (!previous || previous.pages.length === 0) return previous;
		const [newest, ...rest] = previous.pages;
		if (newest.messages.some((m) => m.id === message.id)) return previous;
		return {
			...previous,
			pages: [{ ...newest, messages: [...newest.messages, message] }, ...rest],
		};
	});
}

/** Reflect a soft delete: the row stays (its seq is a cursor), the body empties. */
export function markChatMessageDeletedInCache(
	qc: QueryClient,
	roomId: string,
	messageId: string,
): void {
	qc.setQueryData<InfiniteData<ChatMessagePage>>(chatKeys.messages(roomId), (previous) => {
		if (!previous) return previous;
		return {
			...previous,
			pages: previous.pages.map((page) => ({
				...page,
				messages: page.messages.map((message) =>
					message.id === messageId
						? {
								...message,
								contentText: "",
								// Attachments must go with the body: the server drops them from
								// both `listMessages` and the broadcast payload for a deleted
								// message, so keeping them here would leave the deleter looking
								// at thumbnails of a message everyone else sees as removed until
								// the next refetch.
								attachments: [],
								deletedAt: new Date().toISOString(),
							}
						: message,
				),
			})),
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Live updates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscribe a room to live updates and fold them into the query cache.
 *
 * Every frame is applied in place. Nothing here invalidates on a per-message
 * basis: both summary endpoints probe unread once per membership, so a busy room
 * would otherwise fan out into repeated N+1 queries on the server.
 *
 * A reconnect is the one case that DOES refetch: frames sent while the socket was
 * down are gone (the server replays subscriptions, not history), so the history
 * query is invalidated once per reconnect to close the gap.
 */
export function useChatRoomLive(roomId: string | undefined): void {
	const qc = useQueryClient();

	useEffect(() => {
		if (!roomId) return;
		const handleId = narratorWSManager.allocateId();
		narratorWSManager.joinChatRoom(roomId, handleId);
		const listener = narratorWSManager.addListener(
			{
				narratorIds: "*",
				types: ["chat:message", "chat:message_deleted", "chat:read"],
			},
			(data) => {
				if (data.roomId !== roomId) return;
				if (data.type === "chat:message") {
					const message = data.message as ChatMessage;
					appendChatMessageToCache(qc, roomId, message);
					applyChatMessageToRoomsCache(qc, roomId, message);
					return;
				}
				if (data.type === "chat:message_deleted") {
					markChatMessageDeletedInCache(qc, roomId, data.messageId as string);
					return;
				}
				// `chat:read` is another member's receipt. The room summary carries only
				// the local user's watermark, so there is nothing to update; the local
				// user's own read from another tab arrives as `chat:unread_changed`.
			},
		);

		// Catch-up on reconnect. `_restoreSubscriptions` re-sends `chat_subscribe`
		// but requests no history, so anything posted during the outage exists only
		// on the server — without this the gap persists until the next staleTime
		// refetch on window focus.
		//
		// Guarded on `isReconnect`: on a first connect the query is already fetching,
		// and invalidating would just duplicate it.
		//
		// Cost note: invalidating an infinite query refetches every page it has
		// cached, so a reader scrolled deep into history pays one request per page.
		// That is bounded (pages are capped at CHAT_PAGE_SIZE) and happens once per
		// reconnect, not per message — unlike the per-frame invalidate this replaced.
		const unsubscribeConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (!connected || !isReconnect) return;
			qc.invalidateQueries({ queryKey: chatKeys.messages(roomId) });
		});

		return () => {
			unsubscribeConnection();
			narratorWSManager.removeListener(listener);
			narratorWSManager.leaveChatRoom(roomId, handleId);
		};
	}, [qc, roomId]);
}

/**
 * Keep the global unread badge fresh.
 *
 * Mounted once high in the tree (the app shell): it listens for the per-user
 * `chat:unread_changed` push, which reaches this client even for rooms it has
 * not subscribed to. The frame carries the authoritative count, so it is written
 * straight into the cache — refetching `/chat/unread` per message would re-probe
 * every one of the user's memberships.
 */
export function useChatUnreadLive(): void {
	const qc = useQueryClient();
	useEffect(() => {
		const listener = narratorWSManager.addListener(
			{ narratorIds: "*", types: ["chat:unread_changed"] },
			(data) => {
				applyChatUnreadFrameToCache(qc, data.roomId as string, (data.unread as number) ?? 0);
			},
		);
		// A reconnect can hide any number of dropped badge frames, and the counts are
		// not derivable from what is cached — this is the one place a full refetch of
		// the summaries is the correct answer.
		const unsubscribeConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (!connected || !isReconnect) return;
			qc.invalidateQueries({ queryKey: chatKeys.unread() });
			qc.invalidateQueries({ queryKey: chatKeys.rooms() });
		});
		return () => {
			unsubscribeConnection();
			narratorWSManager.removeListener(listener);
		};
	}, [qc]);
}

export type { ChatAttachment, ChatMessage, ChatMessagePage, ChatRoomSummary, ChatUnreadSummary };
