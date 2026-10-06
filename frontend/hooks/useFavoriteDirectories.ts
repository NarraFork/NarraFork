import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { reportMutationError } from "../lib/query-client";

const FAVORITE_DIRECTORIES_QUERY_GC_TIME_MS = 60_000;

export function useFavoriteDirectories() {
	return useQuery({
		queryKey: ["favoriteDirectories"],
		queryFn: api.listFavoriteDirectories,
		gcTime: FAVORITE_DIRECTORIES_QUERY_GC_TIME_MS,
	});
}

export function useCreateFavoriteDirectory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.createFavoriteDirectory,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["favoriteDirectories"] });
		},
	});
}

export function useDeleteFavoriteDirectory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.deleteFavoriteDirectory,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["favoriteDirectories"] });
		},
	});
}

export function useReorderFavoriteDirectories() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.reorderFavoriteDirectories,
		onMutate: async (ids: string[]) => {
			await qc.cancelQueries({ queryKey: ["favoriteDirectories"] });
			const previous = qc.getQueryData(["favoriteDirectories"]);
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			qc.setQueryData(["favoriteDirectories"], (old: any[]) => {
				if (!old) return old;
				const map = new Map(old.map((f) => [f.id, f]));
				return ids.map((id) => map.get(id)).filter(Boolean);
			});
			return { previous };
		},
		onError: (err, _ids, context) => {
			if (context?.previous) {
				qc.setQueryData(["favoriteDirectories"], context.previous);
			}
			// Declaring onError replaced the global toast, so the list used to just snap
			// back to its old order with no explanation.
			reportMutationError(err);
		},
		onSettled: () => {
			qc.invalidateQueries({ queryKey: ["favoriteDirectories"] });
		},
	});
}
