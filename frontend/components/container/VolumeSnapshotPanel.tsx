import { ActionIcon, Badge, Button, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconCamera, IconDownload, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useApplyVolumeSnapshot,
	useDeleteVolumeSnapshot,
	useVolumeSnapshots,
} from "../../hooks/useVolumeSnapshots";
import { useConfirmDialog } from "../common/ConfirmDialogProvider";
import { CreateSnapshotModal } from "./CreateSnapshotModal";

interface VolumeSnapshotPanelProps {
	projectId: string;
	chapterId: string;
	serviceNames: string[];
	/** Whether the target chapter has running containers */
	hasRunningContainers: boolean;
}

function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function VolumeSnapshotPanel({
	projectId,
	chapterId,
	serviceNames,
	hasRunningContainers,
}: VolumeSnapshotPanelProps) {
	const { t } = useTranslation("containers");
	const confirm = useConfirmDialog();
	const { data: snapshots } = useVolumeSnapshots(projectId);
	const applySnapshot = useApplyVolumeSnapshot();
	const deleteSnapshot = useDeleteVolumeSnapshot();
	const [createOpen, setCreateOpen] = useState(false);

	const handleApply = async (snapshotId: string) => {
		if (await confirm({ message: t("snapshots.applyConfirm") })) {
			applySnapshot.mutate({ snapshotId, targetChapterId: chapterId, projectId });
		}
	};

	const handleDelete = async (snapshotId: string) => {
		if (await confirm({ message: t("snapshots.deleteConfirm") })) {
			deleteSnapshot.mutate({ snapshotId, projectId });
		}
	};

	return (
		<Stack gap="xs">
			<Group justify="space-between">
				<Text size="xs" fw={600}>
					{t("snapshots.title")}
				</Text>
				<Button
					size="compact-xs"
					variant="light"
					leftSection={<IconCamera size={12} />}
					onClick={() => setCreateOpen(true)}
					disabled={!hasRunningContainers}
				>
					{t("snapshots.create")}
				</Button>
			</Group>

			{!snapshots?.length ? (
				<Text size="xs" c="dimmed">
					{t("snapshots.empty")}
				</Text>
			) : (
				// biome-ignore lint/suspicious/noExplicitAny: dynamic snapshot entity
				snapshots.map((snap: any) => (
					<Group key={snap.id} gap="xs" justify="space-between" wrap="nowrap">
						<Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
							<Group gap={4} wrap="nowrap">
								<Text size="xs" fw={500} truncate>
									{snap.name}
								</Text>
								<Badge size="xs" variant="light">
									{snap.serviceName}
								</Badge>
							</Group>
							<Text size="xs" c="dimmed" truncate>
								{snap.containerPath}
								{snap.sizeBytes != null && ` · ${formatBytes(snap.sizeBytes)}`}
							</Text>
						</Stack>
						<Group gap={4} wrap="nowrap">
							<Tooltip
								label={
									hasRunningContainers ? t("snapshots.apply") : t("snapshots.noRunningContainers")
								}
							>
								<ActionIcon
									size="xs"
									variant="subtle"
									color="blue"
									onClick={() => handleApply(snap.id)}
									disabled={!hasRunningContainers}
									loading={
										applySnapshot.isPending && applySnapshot.variables?.snapshotId === snap.id
									}
								>
									<IconDownload size={12} />
								</ActionIcon>
							</Tooltip>
							<Tooltip label={t("snapshots.delete")}>
								<ActionIcon
									size="xs"
									variant="subtle"
									color="red"
									onClick={() => handleDelete(snap.id)}
									loading={
										deleteSnapshot.isPending && deleteSnapshot.variables?.snapshotId === snap.id
									}
								>
									<IconTrash size={12} />
								</ActionIcon>
							</Tooltip>
						</Group>
					</Group>
				))
			)}

			<CreateSnapshotModal
				opened={createOpen}
				onClose={() => setCreateOpen(false)}
				projectId={projectId}
				chapterId={chapterId}
				serviceNames={serviceNames}
			/>
		</Stack>
	);
}
