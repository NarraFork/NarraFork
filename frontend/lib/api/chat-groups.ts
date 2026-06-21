import { request } from "./client";

export interface ChatGroup {
	id: string;
	title: string | null;
	originNarratorId: string | null;
	projectId: string | null;
	createdBy: string | null;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
}

export interface ChatGroupMember {
	id: string;
	groupId: string;
	memberType: "user" | "narrator";
	userId: string | null;
	narratorId: string | null;
	role: "origin" | "named" | "participant";
	canControl: boolean;
	joinedAt: string;
	/** Narrator members are hydrated with a handle/title for display (GET /:groupId). */
	handle?: string | null;
	title?: string | null;
}

export interface ChatGroupMessage {
	id: string;
	groupId: string;
	senderType: "user" | "narrator" | "system";
	senderUserId: string | null;
	senderNarratorId: string | null;
	senderLabel: string;
	content: string;
	urgent: boolean;
	createdAt: string;
}

export interface ChatGroupSummary extends ChatGroup {
	memberCount: number;
}

export const chatGroupsApi = {
	listChatGroups: (limit?: number) => {
		const qs = limit ? `?limit=${limit}` : "";
		return request<{ groups: ChatGroupSummary[] }>(`/chat-groups${qs}`);
	},
	listNarratorGroups: (narratorId: string) =>
		request<{ groups: ChatGroup[] }>(`/narrators/${narratorId}/groups`),
	getChatGroup: (groupId: string) =>
		request<{ group: ChatGroup; members: ChatGroupMember[] }>(`/chat-groups/${groupId}`),
	listChatGroupMessages: (groupId: string, opts?: { cursor?: string; limit?: number }) => {
		const params = new URLSearchParams();
		if (opts?.cursor) params.set("cursor", opts.cursor);
		if (opts?.limit) params.set("limit", String(opts.limit));
		const qs = params.toString();
		return request<{ messages: ChatGroupMessage[]; nextCursor: string | null }>(
			`/chat-groups/${groupId}/messages${qs ? `?${qs}` : ""}`,
		);
	},
	postChatGroupMessage: (groupId: string, content: string, urgent?: boolean) =>
		request<ChatGroupMessage>(`/chat-groups/${groupId}/messages`, {
			method: "POST",
			body: JSON.stringify({ content, urgent }),
		}),
	addChatGroupMember: (groupId: string, handle: string) =>
		request<{ members: ChatGroupMember[] }>(`/chat-groups/${groupId}/members`, {
			method: "POST",
			body: JSON.stringify({ handle }),
		}),
	createChatGroup: (originNarratorId: string, title?: string) =>
		request<ChatGroup>("/chat-groups", {
			method: "POST",
			body: JSON.stringify({ originNarratorId, title }),
		}),
};
