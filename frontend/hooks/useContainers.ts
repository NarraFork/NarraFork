import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useContainers(chapterId: string) {
	return useQuery({
		queryKey: ["containers", chapterId],
		queryFn: () => api.getContainers(chapterId),
		enabled: !!chapterId,
		refetchInterval: 60_000, // Fallback polling — primary updates via WS (useContainerEvents)
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
		onError: (err) => {
			notifications.show({
				color: "red",
				title: "Container start failed",
				message: err instanceof Error ? err.message : String(err),
			});
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
		onError: (err) => {
			notifications.show({
				color: "red",
				title: "Container stop failed",
				message: err instanceof Error ? err.message : String(err),
			});
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
		onError: (err) => {
			notifications.show({
				color: "red",
				title: "Container pause failed",
				message: err instanceof Error ? err.message : String(err),
			});
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
		onError: (err) => {
			notifications.show({
				color: "red",
				title: "Container resume failed",
				message: err instanceof Error ? err.message : String(err),
			});
		},
	});
}

export function useRemoveContainers() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ chapterId, deleteVolumes }: { chapterId: string; deleteVolumes?: boolean }) =>
			api.removeContainers(chapterId, { deleteVolumes }),
		onSuccess: (_, { chapterId }) => {
			qc.invalidateQueries({ queryKey: ["containers", chapterId] });
		},
		onError: (err) => {
			notifications.show({
				color: "red",
				title: "Container remove failed",
				message: err instanceof Error ? err.message : String(err),
			});
		},
	});
}
