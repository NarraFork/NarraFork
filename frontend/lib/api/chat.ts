import { request } from "./client";

export interface ChatUserSnapshot {
	id: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
}

export interface ChatMessage {
	id: string;
	roomId: string;
	/** Monotonic within the room. This is the pagination cursor. */
	seq: number;
	kind: "text" | "system";
	contentText: string;
	replyToMessageId: string | null;
	editedAt: string | null;
	deletedAt: string | null;
	createdAt: string;
	sender: ChatUserSnapshot | null;
}

export interface ChatRoomSummary {
	id: string;
	kind: "dm" | "narrator";
	narratorId: string | null;
	lastMessageAt: string | null;
	lastMessagePreview: string | null;
	lastMessageSenderId: string | null;
	/** DM only: the other participant. */
	peer: ChatUserSnapshot | null;
	unread: number;
	/** `unread` hit the server probe ceiling — display as "99+". */
	unreadCapped: boolean;
	lastReadSeq: number;
	muted: boolean;
}

export interface ChatMessagePage {
	messages: ChatMessage[];
	hasMore: boolean;
	/** Cursor for the next (older) page; null at the room start. */
	nextBeforeSeq: number | null;
}

export interface ChatUnreadSummary {
	dmTotal: number;
	dmTotalCapped: boolean;
	byRoom: Record<string, number>;
}

export const chatApi = {
	listChatDirectory: (query?: string) =>
		request<ChatUserSnapshot[]>(
			query?.trim() ? `/chat/directory?q=${encodeURIComponent(query.trim())}` : "/chat/directory",
		),

	listChatRooms: () => request<ChatRoomSummary[]>("/chat/rooms"),

	getChatUnread: () => request<ChatUnreadSummary>("/chat/unread"),

	openChatDm: (userId: string) =>
		request<ChatRoomSummary>("/chat/rooms/dm", {
			method: "POST",
			body: JSON.stringify({ userId }),
		}),

	getNarratorChatRoom: (narratorId: string) =>
		request<ChatRoomSummary>(`/chat/rooms/narrator/${narratorId}`),

	listChatMessages: (roomId: string, params?: { beforeSeq?: number; limit?: number }) => {
		const search = new URLSearchParams();
		if (params?.beforeSeq !== undefined) search.set("beforeSeq", String(params.beforeSeq));
		if (params?.limit !== undefined) search.set("limit", String(params.limit));
		const query = search.toString();
		return request<ChatMessagePage>(
			query ? `/chat/rooms/${roomId}/messages?${query}` : `/chat/rooms/${roomId}/messages`,
		);
	},

	postChatMessage: (roomId: string, data: { text: string; replyToMessageId?: string | null }) =>
		request<ChatMessage>(`/chat/rooms/${roomId}/messages`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	markChatRead: (roomId: string, seq: number) =>
		request<{ lastReadSeq: number }>(`/chat/rooms/${roomId}/read`, {
			method: "POST",
			body: JSON.stringify({ seq }),
		}),

	deleteChatMessage: (roomId: string, messageId: string) =>
		request<{ ok: boolean }>(`/chat/rooms/${roomId}/messages/${messageId}`, {
			method: "DELETE",
		}),

	/**
	 * Summarize selected messages. The result is NOT stored server-side — it is a
	 * draft the user reviews before forwarding it to a narrator.
	 */
	summarizeChatMessages: (roomId: string, messageIds: string[]) =>
		request<{ summary: string }>(`/chat/rooms/${roomId}/summarize`, {
			method: "POST",
			body: JSON.stringify({ messageIds }),
		}),
};
