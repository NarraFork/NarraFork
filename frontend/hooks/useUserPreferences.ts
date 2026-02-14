import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useUserPreferences() {
	return useQuery({
		queryKey: ["user-preferences"],
		queryFn: api.getUserPreferences,
		staleTime: 60_000,
	});
}

export function useUpdateUserPreferences() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.updateUserPreferences,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["user-preferences"] });
		},
	});
}
