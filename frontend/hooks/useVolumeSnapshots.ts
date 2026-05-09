import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

const VOLUME_SNAPSHOTS_GC_TIME_MS = 60_000;

export function useVolumeSnapshots(
	projectId: string | undefined,
	filters?: { serviceName?: string },
) {
	return useQuery({
		queryKey: ["volumeSnapshots", projectId, filters],
		queryFn: () => api.listVolumeSnapshots(projectId as string, filters),
		enabled: !!projectId,
		gcTime: VOLUME_SNAPSHOTS_GC_TIME_MS,
	});
}

export function useCreateVolumeSnapshot() {
	const qc = useQueryClient();
	const { t } = useTranslation("containers");
	return useMutation({
		mutationFn: (params: {
			projectId: string;
			chapterId: string;
			serviceName: string;
			containerPath: string;
			name: string;
			description?: string;
		}) =>
			api.createVolumeSnapshot(params.projectId, {
				chapterId: params.chapterId,
				serviceName: params.serviceName,
				containerPath: params.containerPath,
				name: params.name,
				description: params.description,
			}),
		onSuccess: (_, params) => {
			qc.invalidateQueries({ queryKey: ["volumeSnapshots", params.projectId] });
			notifications.show({
				color: "green",
				title: t("snapshots.createSuccess"),
				message: params.name,
			});
		},
		onError: (err) => {
			notifications.show({
				color: "red",
				title: t("snapshots.createFailed"),
				message: err instanceof Error ? err.message : String(err),
			});
		},
	});
}

export function useApplyVolumeSnapshot() {
	const qc = useQueryClient();
	const { t } = useTranslation("containers");
	return useMutation({
		mutationFn: (params: { snapshotId: string; targetChapterId: string; projectId: string }) =>
			api.applyVolumeSnapshot(params.snapshotId, params.targetChapterId),
		onSuccess: (_, params) => {
			qc.invalidateQueries({ queryKey: ["volumeSnapshots", params.projectId] });
			notifications.show({
				color: "green",
				title: t("snapshots.applySuccess"),
				message: "",
			});
		},
		onError: (err) => {
			notifications.show({
				color: "red",
				title: t("snapshots.applyFailed"),
				message: err instanceof Error ? err.message : String(err),
			});
		},
	});
}

export function useDeleteVolumeSnapshot() {
	const qc = useQueryClient();
	const { t } = useTranslation("containers");
	return useMutation({
		mutationFn: (params: { snapshotId: string; projectId: string }) =>
			api.deleteVolumeSnapshot(params.snapshotId),
		onSuccess: (_, params) => {
			qc.invalidateQueries({ queryKey: ["volumeSnapshots", params.projectId] });
			notifications.show({
				color: "green",
				title: t("snapshots.deleteSuccess"),
				message: "",
			});
		},
		onError: (err) => {
			notifications.show({
				color: "red",
				title: t("snapshots.deleteFailed"),
				message: err instanceof Error ? err.message : String(err),
			});
		},
	});
}

export function useUpdateVolumeSnapshot() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (params: {
			snapshotId: string;
			projectId: string;
			data: { name?: string; description?: string | null };
		}) => api.updateVolumeSnapshot(params.snapshotId, params.data),
		onSuccess: (_, params) => {
			qc.invalidateQueries({ queryKey: ["volumeSnapshots", params.projectId] });
		},
	});
}

export function useSnapshotApplications(snapshotId: string | undefined) {
	return useQuery({
		queryKey: ["snapshotApplications", snapshotId],
		queryFn: () => api.getSnapshotApplications(snapshotId as string),
		enabled: !!snapshotId,
		gcTime: VOLUME_SNAPSHOTS_GC_TIME_MS,
	});
}
