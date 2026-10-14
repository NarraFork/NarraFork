import { Modal, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { NarratorAccessPanel } from "./details/NarratorAccessPanel";

export interface NarratorAccessSettingsModalProps {
	narratorId: string | null;
	opened: boolean;
	onClose: () => void;
	narratorTitle?: string | null;
}

export function NarratorAccessSettingsModal({
	narratorId,
	opened,
	onClose,
	narratorTitle,
}: NarratorAccessSettingsModalProps) {
	const { t } = useTranslation("narrator");

	return (
		<Modal opened={opened} onClose={onClose} size="lg" title={t("access.settingsTitle")}>
			{narratorTitle ? (
				<Text size="sm" fw={500} mb="md" lineClamp={1}>
					{narratorTitle}
				</Text>
			) : null}
			{narratorId ? <NarratorAccessPanel narratorId={narratorId} /> : null}
		</Modal>
	);
}
