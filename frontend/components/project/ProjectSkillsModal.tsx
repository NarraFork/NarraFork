import { Accordion, Badge, Code, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { IconBook2, IconFile } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useSkills } from "../../hooks/useSkills";

interface ProjectSkillsModalProps {
	projectId: string;
	opened: boolean;
	onClose: () => void;
}

export function ProjectSkillsModal({ projectId, opened, onClose }: ProjectSkillsModalProps) {
	const { t } = useTranslation("projects");
	const { data: skills, isLoading } = useSkills(projectId, opened);

	return (
		<Modal opened={opened} onClose={onClose} title={t("skillsTitle")} size="lg">
			<Stack>
				<Text size="sm" c="dimmed">
					{t("skillsDesc")}
				</Text>

				{isLoading && <Loader size="sm" />}

				{!isLoading && (!skills || skills.length === 0) && (
					<Text size="sm" c="dimmed" ta="center" py="md">
						{t("skillsEmpty")}
					</Text>
				)}

				{skills && skills.length > 0 && (
					<Accordion variant="separated">
						{skills.map((skill) => (
							<Accordion.Item key={skill.name} value={skill.name}>
								<Accordion.Control icon={<IconBook2 size={18} />}>
									<Group gap="xs">
										<Text fw={500}>{skill.name}</Text>
										{skill.files.length > 0 && (
											<Badge size="xs" variant="light">
												{skill.files.length} {t("skillsFiles")}
											</Badge>
										)}
									</Group>
								</Accordion.Control>
								<Accordion.Panel>
									<Stack gap="xs">
										<Text size="sm">{skill.description}</Text>
										<Text size="xs" c="dimmed">
											{t("skillsLocation")}: <Code>{skill.location}</Code>
										</Text>
										{skill.files.length > 0 && (
											<Stack gap={4}>
												<Text size="xs" fw={500}>
													{t("skillsCompanionFiles")}:
												</Text>
												{skill.files.map((f) => (
													<Group key={f} gap={4}>
														<IconFile size={14} />
														<Text size="xs" c="dimmed">
															{f}
														</Text>
													</Group>
												))}
											</Stack>
										)}
									</Stack>
								</Accordion.Panel>
							</Accordion.Item>
						))}
					</Accordion>
				)}
			</Stack>
		</Modal>
	);
}
