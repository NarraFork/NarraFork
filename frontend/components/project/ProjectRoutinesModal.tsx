import { Badge, Group, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useProjectRoutines, useToggleProjectRoutine } from "../../hooks/useRoutines";

interface ProjectRoutinesModalProps {
	projectId: string;
	opened: boolean;
	onClose: () => void;
}

export function ProjectRoutinesModal({ projectId, opened, onClose }: ProjectRoutinesModalProps) {
	const { t } = useTranslation("projects");
	const { t: ts } = useTranslation("settings");
	const { i18n } = useTranslation();
	const isZh = i18n.language?.startsWith("zh");

	const { data } = useProjectRoutines(opened ? projectId : undefined);
	const toggle = useToggleProjectRoutine(projectId);

	const routines = data?.routines ?? [];
	const categories = [...new Set(routines.map((r) => r.category))];

	return (
		<Modal opened={opened} onClose={onClose} title={t("routinesTitle")} size="lg">
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					{t("routinesDesc")}
				</Text>

				{categories.map((cat) => (
					<Stack key={cat} gap="xs">
						<Text size="sm" fw={600} c="dimmed" tt="uppercase">
							{ts(`routineCategory.${cat}`, cat)}
						</Text>
						{routines
							.filter((r) => r.category === cat)
							.map((routine) => (
								<Group key={routine.id} justify="space-between" wrap="nowrap" gap="sm">
									<Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
										<Group gap="xs" wrap="nowrap">
											<Badge
												size="xs"
												variant="light"
												color={routine.type === "command" ? "indigo" : "teal"}
											>
												{ts(`routineType.${routine.type}`)}
											</Badge>
											<Text size="sm" fw={500} truncate>
												{routine.type === "command" ? `/${routine.name}` : routine.name}
											</Text>
											{!routine.globalEnabled && routine.override === "global" && (
												<Badge size="xs" variant="outline" color="gray">
													{ts("routineGlobalOff")}
												</Badge>
											)}
										</Group>
										<Text size="xs" c="dimmed" truncate>
											{isZh ? routine.descriptionZh : routine.descriptionEn}
										</Text>
									</Stack>
									<SegmentedControl
										size="xs"
										value={routine.override}
										onChange={(val) => {
											const action = val as "enable" | "disable" | "reset";
											toggle.mutate({
												id: routine.id,
												action: val === "global" ? "reset" : action,
											});
										}}
										data={[
											{ label: t("routineFollowGlobal"), value: "global" },
											{ label: ts("routineEnabled"), value: "enabled" },
											{ label: ts("routineDisabled"), value: "disabled" },
										]}
									/>
								</Group>
							))}
					</Stack>
				))}
			</Stack>
		</Modal>
	);
}
