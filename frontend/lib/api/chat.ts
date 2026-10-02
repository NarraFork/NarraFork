import { ApiError, apiBase, authorizedFetch, readFetchError, request } from "./client";

export interface ChatUserSnapshot {
	id: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
	/** Guests have a display-only id; never use it for user/profile requests. */
	isGuest?: boolean;
}

/**
 * One attachment's metadata. Bytes are fetched from
 * `GET /api/chat/attachments/:id`, which re-checks room access.
 */
export interface ChatAttachment {
	id: string;
	kind: "image" | "file";
	filename: string;
	mediaType: string;
	sizeBytes: number;
	/** Images only. Present so the list can reserve height without loading it. */
	width: number | null;
	height: number | null;
}

export interface ChatMessage {
	id: string;
	roomId: string;
	/** Monotonic within the room. This is the pagination cursor. */
	seq: number;
	kind: "text" | "system";
	contentText: string;
	replyToMessageId: string | null;
	/**
	 * Quote snapshot captured server-side at post time.
	 *
	 * `replyToPreview` distinguishes three states that matter to the UI:
	 * a non-empty string is the quoted text, `""` means the target was already
	 * deleted, and `null` means this row predates snapshots (resolve locally).
	 * `replyToSeq` is what a jump needs to know whether to keep loading older pages.
	 */
	replyToSeq: number | null;
	replyToSender: ChatUserSnapshot | null;
	replyToPreview: string | null;
	attachments: ChatAttachment[];
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

	/** Resolve a message id to its room seq (the vlist's jump coordinate). */
	getChatMessageLocation: (roomId: string, messageId: string) =>
		request<{ messageId: string; seq: number }>(
			`/chat/rooms/${roomId}/messages/${messageId}/location`,
		),

	postChatMessage: (
		roomId: string,
		data: { text: string; replyToMessageId?: string | null; attachmentIds?: string[] },
	) =>
		request<ChatMessage>(`/chat/rooms/${roomId}/messages`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	/**
	 * Upload one attachment as a draft.
	 *
	 * Goes through `authorizedFetch` rather than `request`, matching every other
	 * upload in this layer: `request` sets `Content-Type: application/json` on any
	 * body, which would overwrite the multipart boundary the browser generates and
	 * make the server's `formData()` parse fail.
	 */
	uploadChatAttachment: async (roomId: string, file: File): Promise<ChatAttachment> => {
		const formData = new FormData();
		formData.append("file", file);
		const res = await authorizedFetch(`${apiBase()}/chat/rooms/${roomId}/attachments`, {
			method: "POST",
			body: formData,
		});
		if (!res.ok) {
			const { message, data } = await readFetchError(res, "Attachment upload failed");
			throw new ApiError(message, res.status, data);
		}
		return (await res.json()) as ChatAttachment;
	},

	/** Discard a draft attachment the composer removed before sending. */
	deleteChatAttachment: (attachmentId: string) =>
		request<{ ok: boolean }>(`/chat/attachments/${attachmentId}`, { method: "DELETE" }),

	/**
	 * Copy attachments into a narrator's worktree ahead of a forward.
	 *
	 * Returns the `<attached_files>` hint to append to the forwarded text, produced
	 * by the same builder the narrator's own attachment path uses.
	 */
	materializeChatAttachments: (roomId: string, narratorId: string, attachmentIds: string[]) =>
		request<{
			hint: string;
			files: Array<{ filename: string; filePath: string; size: number }>;
		}>(`/chat/rooms/${roomId}/materialize-attachments`, {
			method: "POST",
			body: JSON.stringify({ narratorId, attachmentIds }),
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
