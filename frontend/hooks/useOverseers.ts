import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

export function useGlobalOverseer() {
	const qc = useQueryClient();

	// Listen for overseer:replaced WS events to refresh data immediately
	useEffect(() => {
		const handle = narratorWSManager.addListener(
			{ narratorIds: "*", types: ["overseer:replaced"] },
			() => {
				qc.invalidateQueries({ queryKey: ["overseers", "global"] });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [qc]);

	return useQuery({
		queryKey: ["overseers", "global"],
		queryFn: async () => {
			const list = await api.listOverseers({ scope: "global" });
			return list[0] ?? null;
		},
		staleTime: 30_000,
	});
}

export function useCreateOverseer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: { scope: string; projectId?: string; model?: string }) =>
			api.createOverseer(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["overseers"] });
		},
	});
}

export function useUpdateOverseer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, ...data }: { id: string; enabled?: boolean }) =>
			api.updateOverseer(id, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["overseers"] });
		},
	});
}

export function useDeleteOverseer() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteOverseer(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["overseers"] });
		},
	});
}
