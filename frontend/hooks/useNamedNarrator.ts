import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const NAMED_NARRATOR_GC_TIME_MS = 60_000;

/** Named narrators available as @mention targets. */
export function useNamedNarrators() {
	return useQuery({
		queryKey: ["named-narrators"],
		queryFn: () => api.listNamedNarrators(),
		gcTime: NAMED_NARRATOR_GC_TIME_MS,
		staleTime: 30_000,
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
