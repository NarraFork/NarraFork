import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
	MemoryDecision,
	MemoryDraft,
	MemoryProposal,
	MemoryScope,
} from "../lib/api/context-memory";

const rootKey = (userId: string) => ["context-memory", userId] as const;
// Private bodies are never retained after their view unmounts or shown as placeholders.
const privateQuery = { retry: false, gcTime: 0, staleTime: 0, refetchOnMount: "always" as const };
export function useContextMemories(userId: string, scope: MemoryScope, cursor?: string) {
	return useQuery({
		...privateQuery,
		queryKey: [...rootKey(userId), "list", scope, cursor],
		queryFn: ({ signal }) => api.listContextMemories(scope, cursor, signal),
		enabled: !!userId,
	});
}
export function useContextMemory(userId: string, id: string) {
	return useQuery({
		...privateQuery,
		queryKey: [...rootKey(userId), "detail", id],
		queryFn: ({ signal }) => api.getContextMemory(id, signal),
		enabled: !!userId && !!id,
	});
}
export function useContextMemoryEvents(userId: string, id: string) {
	return useQuery({
		...privateQuery,
		queryKey: [...rootKey(userId), "events", id],
		queryFn: ({ signal }) => api.getContextMemoryEvents(id, signal),
		enabled: !!userId && !!id,
	});
}
export type MemoryCommand =
	| { type: "propose"; data: MemoryProposal }
	| { type: "revise"; id: string; data: MemoryDraft & { expectedVersion: number } }
	| { type: "decide"; id: string; data: { expectedVersion: number; action: MemoryDecision } }
	| { type: "forget"; id: string; expectedVersion: number };
export function useContextMemoryMutation(userId: string) {
	const client = useQueryClient();
	return useMutation({
		retry: false,
		mutationFn: async (command: MemoryCommand) => {
			switch (command.type) {
				case "propose":
					return api.proposeContextMemory(command.data);
				case "revise":
					return api.reviseContextMemory(command.id, command.data);
				case "decide":
					return api.decideContextMemory(command.id, command.data);
				case "forget":
					return api.forgetContextMemory(command.id, command.expectedVersion);
			}
		},
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: rootKey(userId) });
		},
	});
}
