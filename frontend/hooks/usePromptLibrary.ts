/**
 * Client state for the system-prompt library.
 *
 * One query key (`["prompt-library"]`) for the list, so every surface that offers a
 * picker — the routines tab and the new-session dialog — sees a create/edit/delete
 * immediately without each holding its own copy.
 */

import type { PromptLibraryEntryData, PromptLibraryInputData } from "@frontend/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const SYSTEM_PROMPT_LIBRARY_GC_TIME_MS = 60_000;

export const promptLibraryKey = ["prompt-library"] as const;

export function usePromptLibrary(enabled = true) {
	return useQuery({
		queryKey: promptLibraryKey,
		queryFn: () => api.listPromptLibrary(),
		enabled,
		gcTime: SYSTEM_PROMPT_LIBRARY_GC_TIME_MS,
	});
}

export function useCreatePrompt() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: PromptLibraryInputData) => api.createPromptLibraryEntry(data),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: promptLibraryKey });
		},
	});
}

export function useUpdatePrompt() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: PromptLibraryInputData & { id: string }) =>
			api.updatePromptLibraryEntry(id, data),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: promptLibraryKey });
		},
	});
}

export function useDeletePrompt() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deletePromptLibraryEntry(id),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: promptLibraryKey });
		},
	});
}

export type { PromptLibraryEntryData, PromptLibraryInputData };
