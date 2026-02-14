import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useFavoriteDirectories() {
	return useQuery({
		queryKey: ["favoriteDirectories"],
		queryFn: api.listFavoriteDirectories,
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
