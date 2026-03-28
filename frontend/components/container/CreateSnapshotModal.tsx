import { Button, Group, Modal, Select, Stack, Textarea, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateVolumeSnapshot } from "../../hooks/useVolumeSnapshots";

interface CreateSnapshotModalProps {
	opened: boolean;
	onClose: () => void;
	projectId: string;
	chapterId: string;
	serviceNames: string[];
}

export function CreateSnapshotModal({
	opened,
	onClose,
	projectId,
	chapterId,
	serviceNames,
}: CreateSnapshotModalProps) {
	const { t } = useTranslation("containers");
	const createSnapshot = useCreateVolumeSnapshot();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [serviceName, setServiceName] = useState<string | null>(
		serviceNames.length === 1 ? serviceNames[0] : null,
	);
	const [containerPath, setContainerPath] = useState("");

	const handleSubmit = () => {
		if (!serviceName || !containerPath.trim() || !name.trim()) return;
		createSnapshot.mutate(
			{
				projectId,
				chapterId,
				serviceName,
				containerPath: containerPath.trim(),
				name: name.trim(),
				description: description.trim() || undefined,
			},
			{
				onSuccess: () => {
					setName("");
					setDescription("");
					setContainerPath("");
					onClose();
				},
			},
		);
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t("snapshots.create")} size="md">
			<Stack gap="sm">
				<Select
					label={t("snapshots.serviceName")}
					data={serviceNames.map((n) => ({ value: n, label: n }))}
					value={serviceName}
					onChange={setServiceName}
					required
				/>
				<TextInput
					label={t("snapshots.containerPath")}
					placeholder={t("snapshots.containerPathPlaceholder")}
					value={containerPath}
					onChange={(e) => setContainerPath(e.currentTarget.value)}
					required
				/>
				<TextInput
					label={t("snapshots.name")}
					placeholder={t("snapshots.namePlaceholder")}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					required
				/>
				<Textarea
					label={t("snapshots.description")}
					placeholder={t("snapshots.descriptionPlaceholder")}
					value={description}
					onChange={(e) => setDescription(e.currentTarget.value)}
					autosize
					minRows={2}
					maxRows={4}
				/>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("podman.close")}
					</Button>
					<Button
						onClick={handleSubmit}
						loading={createSnapshot.isPending}
						disabled={!serviceName || !containerPath.trim() || !name.trim()}
					>
						{t("snapshots.create")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
