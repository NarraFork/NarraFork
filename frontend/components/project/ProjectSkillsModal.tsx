import { Modal, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { ProjectSkillsManager } from "./ProjectSkillsManager";

interface ProjectSkillsModalProps {
	projectId: string;
	opened: boolean;
	onClose: () => void;
}

export function ProjectSkillsModal({ projectId, opened, onClose }: ProjectSkillsModalProps) {
	const { t } = useTranslation("projects");

	return (
		<Modal opened={opened} onClose={onClose} title={t("skillsTitle")} size="lg">
			<Stack>
				<Text size="sm" c="dimmed">
					{t("skillsDesc")}
				</Text>
				<ProjectSkillsManager projectId={projectId} enabled={opened} />
			</Stack>
		</Modal>
	);
}
