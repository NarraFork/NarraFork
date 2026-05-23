import { Alert, Badge, Group, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useContentCapability } from "../../hooks/usePlatform";
import { useProjectRoutines, useToggleProjectRoutine } from "../../hooks/useRoutines";

function routineOverrideToAction(value: string): "enable" | "disable" | "reset" | null {
	switch (value) {
		case "global":
			return "reset";
		case "enabled":
			return "enable";
		case "disabled":
			return "disable";
		default:
			return null;
	}
}

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
	const contentCapability = useContentCapability();
	const routinesCapability = contentCapability.projectRoutines;
	const routinesUnsupportedReason = routinesCapability.supported
		? undefined
		: (routinesCapability.reason ?? t("routinesUnsupportedDesc"));

	const { data } = useProjectRoutines(
		opened && routinesCapability.supported ? projectId : undefined,
	);
	const toggle = useToggleProjectRoutine(projectId);

	const routineGroups = useMemo(() => {
		const groups = new Map<string, NonNullable<typeof data>["routines"]>();
		for (const routine of data?.routines ?? []) {
			const categoryRoutines = groups.get(routine.category);
			if (categoryRoutines) {
				categoryRoutines.push(routine);
			} else {
				groups.set(routine.category, [routine]);
			}
		}
		return Array.from(groups, ([category, routines]) => ({ category, routines }));
	}, [data?.routines]);

	return (
		<Modal opened={opened} onClose={onClose} title={t("routinesTitle")} size="lg">
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					{t("routinesDesc")}
				</Text>

				{routinesUnsupportedReason && (
					<Alert color="yellow" variant="light" title={t("routinesUnsupportedTitle")}>
						{routinesUnsupportedReason}
					</Alert>
				)}

				{routineGroups.map(({ category, routines }) => (
					<Stack key={category} gap="xs">
						<Text size="sm" fw={600} c="dimmed" tt="uppercase">
							{ts(`routineCategory.${category}`, category)}
						</Text>
						{routines.map((routine) => (
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
									disabled={!routinesCapability.supported}
									onChange={(val) => {
										if (!routinesCapability.supported) return;
										const action = routineOverrideToAction(val);
										if (!action) return;
										toggle.mutate({ id: routine.id, action });
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
