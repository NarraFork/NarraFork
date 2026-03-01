import { Modal, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { type CommandDef, CommandsEditor } from "../common/CommandsEditor";

interface ProjectCommandsModalProps {
	projectId: string;
	opened: boolean;
	onClose: () => void;
}

export function ProjectCommandsModal({ projectId, opened, onClose }: ProjectCommandsModalProps) {
	const { t } = useTranslation("projects");
	const qc = useQueryClient();

	const { data: project } = useQuery({
		queryKey: ["project", projectId],
		queryFn: () => api.getProject(projectId),
		enabled: opened,
	});

	const updateProject = useMutation({
		mutationFn: (commands: CommandDef[]) =>
			api.updateProject(projectId, { chapterSettings: { commands } }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", projectId] });
		},
	});

	const commands: CommandDef[] = (() => {
		if (!project?.chapterSettings) return [];
		try {
			const settings =
				typeof project.chapterSettings === "string"
					? JSON.parse(project.chapterSettings)
					: project.chapterSettings;
			return Array.isArray(settings?.commands) ? settings.commands : [];
		} catch {
			return [];
		}
	})();

	return (
		<Modal opened={opened} onClose={onClose} title={t("commandsTitle")} size="lg">
			<Stack>
				<Text size="sm" c="dimmed">
					{t("commandsDesc")}
				</Text>
				<CommandsEditor
					commands={commands}
					onChange={(cmds) => updateProject.mutate(cmds)}
					ns="projects"
				/>
			</Stack>
		</Modal>
	);
}
