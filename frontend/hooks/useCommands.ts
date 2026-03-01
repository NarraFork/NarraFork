import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useNarratorCommands(narratorId: string | undefined) {
	return useQuery({
		queryKey: ["narrator-commands", narratorId],
		queryFn: () => api.getNarratorCommands(narratorId as string),
		enabled: !!narratorId,
		staleTime: 30_000,
	});
}
