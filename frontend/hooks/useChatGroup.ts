import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChatGroupMessage } from "../lib/api";

const CHAT_GROUP_GC_TIME_MS = 60_000;

/** Active chat groups visible to the current user (for the groups list page). */
export function useChatGroups(limit?: number) {
	return useQuery({
		queryKey: ["chat-groups", limit ?? 50],
		queryFn: () => api.listChatGroups(limit),
		gcTime: CHAT_GROUP_GC_TIME_MS,
		// Refetch on focus so the list stays fresh without a global broadcast.
		refetchOnWindowFocus: true,
	});
}

/** Active chat groups a specific narrator participates in (named-narrator detail). */
export function useNarratorGroups(narratorId: string | undefined) {
	return useQuery({
		queryKey: ["narrator-groups", narratorId],
		queryFn: () => api.listNarratorGroups(narratorId as string),
		enabled: !!narratorId,
		gcTime: CHAT_GROUP_GC_TIME_MS,
	});
}

/** Named narrators available as @mention targets. */
export function useNamedNarrators() {
	return useQuery({
		queryKey: ["named-narrators"],
		queryFn: () => api.listNamedNarrators(),
		gcTime: CHAT_GROUP_GC_TIME_MS,
		staleTime: 30_000,
	});
}

export function useChatGroup(groupId: string | undefined) {
	return useQuery({
		queryKey: ["chat-group", groupId],
		queryFn: () => api.getChatGroup(groupId as string),
		enabled: !!groupId,
		gcTime: CHAT_GROUP_GC_TIME_MS,
	});
}

/** Cursor-paginated message history (newest-first pages). */
export function useChatGroupMessages(groupId: string | undefined, limit = 50) {
	return useInfiniteQuery({
		queryKey: ["chat-group-messages", groupId, limit],
		queryFn: ({ pageParam }) =>
			api.listChatGroupMessages(groupId as string, {
				cursor: pageParam as string | undefined,
				limit,
			}),
		enabled: !!groupId,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		gcTime: CHAT_GROUP_GC_TIME_MS,
	});
}

export function usePostChatGroupMessage(groupId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ content, urgent }: { content: string; urgent?: boolean }) =>
			api.postChatGroupMessage(groupId as string, content, urgent),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chat-group-messages", groupId] });
		},
	});
}

export function useAddChatGroupMember(groupId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (handle: string) => api.addChatGroupMember(groupId as string, handle),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chat-group", groupId] });
		},
	});
}

export function useUpdateNarratorHandle() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, handle }: { id: string; handle: string | null }) =>
			api.updateNarratorHandle(id, handle),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["named-narrators"] });
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

/** Helper: merge a live WS group_message into the infinite-query cache. */
export function useApplyIncomingGroupMessage() {
	const qc = useQueryClient();
	return (groupId: string, message: ChatGroupMessage) => {
		// Match every page-size variant of this group's message query (prefix match)
		// so the live update isn't silently dropped when a non-default limit is used.
		qc.setQueriesData(
			{ queryKey: ["chat-group-messages", groupId] },
			(
				old: { pages: { messages: ChatGroupMessage[]; nextCursor: string | null }[] } | undefined,
			) => {
				if (!old) return old;
				// Newest-first: prepend to the first page if not already present.
				const exists = old.pages.some((p) => p.messages.some((m) => m.id === message.id));
				if (exists) return old;
				const [first, ...rest] = old.pages;
				return {
					...old,
					pages: [{ ...first, messages: [message, ...first.messages] }, ...rest],
				};
			},
		);
	};
}
