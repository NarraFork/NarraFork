import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useContainers(chapterId: string) {
	return useQuery({
		queryKey: ["containers", chapterId],
		queryFn: () => api.getContainers(chapterId),
		enabled: !!chapterId,
		refetchInterval: 10000, // Poll every 10s for status updates
	});
}

export function useContainerLogs(chapterId: string, opts?: { tail?: number; service?: string }) {
	return useQuery({
		queryKey: ["containerLogs", chapterId, opts],
		queryFn: () => api.getContainerLogs(chapterId, opts),
		enabled: !!chapterId,
	});
}

export function useStartContainers() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.startContainers,
		onSuccess: (_, chapterId) => {
			qc.invalidateQueries({ queryKey: ["containers", chapterId] });
		},
	});
}

export function useStopContainers() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.stopContainers,
		onSuccess: (_, chapterId) => {
			qc.invalidateQueries({ queryKey: ["containers", chapterId] });
		},
	});
}

export function usePauseContainers() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.pauseContainers,
		onSuccess: (_, chapterId) => {
			qc.invalidateQueries({ queryKey: ["containers", chapterId] });
		},
	});
}

export function useUnpauseContainers() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.unpauseContainers,
		onSuccess: (_, chapterId) => {
			qc.invalidateQueries({ queryKey: ["containers", chapterId] });
		},
	});
}
