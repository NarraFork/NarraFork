import { Alert, Badge, Group, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import { pickLocalizedValue } from "@shared/i18n-locales";
import {
	normalizeToolRoutineModeOverride,
	TOOL_ROUTINE_MODES,
	type ToolRoutineMode,
} from "@shared/routine-modes";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useContentCapability } from "../../hooks/usePlatform";
import {
	useProjectRoutines,
	useSetProjectRoutineMode,
	useToggleProjectRoutine,
} from "../../hooks/useRoutines";

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

/** Project-level positions for a tool routine: follow global, then the three modes. */
const PROJECT_TOOL_MODE_VALUES = ["global", ...TOOL_ROUTINE_MODES] as const;

interface ProjectRoutinesModalProps {
	projectId: string;
	opened: boolean;
	onClose: () => void;
}

export function ProjectRoutinesModal({ projectId, opened, onClose }: ProjectRoutinesModalProps) {
	const { t } = useTranslation("projects");
	const { t: ts } = useTranslation("settings");
	const { i18n } = useTranslation();
	const locale = i18n.resolvedLanguage ?? i18n.language;
	const contentCapability = useContentCapability();
	const routinesCapability = contentCapability.projectRoutines;
	const routinesUnsupportedReason = routinesCapability.supported
		? undefined
		: (routinesCapability.reason ?? t("routinesUnsupportedDesc"));

	const { data } = useProjectRoutines(
		opened && routinesCapability.supported ? projectId : undefined,
	);
	const toggle = useToggleProjectRoutine(projectId);
	const setToolMode = useSetProjectRoutineMode(projectId);

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
						{routines.map((routine) => {
							// Tool routines get the three-position mode plus "follow global"; command
							// and skill routines keep the original tri-state on/off.
							const isTool = routine.type === "tool";
							const modeOverride =
								routine.modeOverride ??
								(routine.override === "global"
									? "global"
									: routine.override === "enabled"
										? "resident"
										: "manual");
							const globalMode: ToolRoutineMode =
								routine.globalMode ?? (routine.globalEnabled ? "resident" : "manual");
							return (
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
											{isTool && modeOverride === "global" ? (
												<Badge size="xs" variant="outline" color="gray">
													{ts("routineGlobalMode", {
														mode: ts(`toolMode.${globalMode}`),
													})}
												</Badge>
											) : (
												!routine.globalEnabled &&
												routine.override === "global" && (
													<Badge size="xs" variant="outline" color="gray">
														{ts("routineGlobalOff")}
													</Badge>
												)
											)}
										</Group>
										<Text size="xs" c="dimmed" truncate>
											{pickLocalizedValue(
												{ en: routine.descriptionEn, "zh-CN": routine.descriptionZh },
												locale,
											)}
										</Text>
										{isTool && routine.mode === "auto" && (
											<Text size="xs" c="yellow.6">
												{ts("toolModeAutoPending")}
											</Text>
										)}
									</Stack>
									{isTool ? (
										<SegmentedControl
											size="xs"
											value={modeOverride}
											disabled={!routinesCapability.supported}
											onChange={(val) => {
												if (!routinesCapability.supported) return;
												const next = normalizeToolRoutineModeOverride(val);
												if (!next || next === modeOverride) return;
												setToolMode.mutate({ id: routine.id, mode: next });
											}}
											data={PROJECT_TOOL_MODE_VALUES.map((value) => ({
												value,
												label:
													value === "global" ? t("routineFollowGlobal") : ts(`toolMode.${value}`),
											}))}
										/>
									) : (
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
									)}
								</Group>
							);
						})}
					</Stack>
				))}
			</Stack>
		</Modal>
	);
}
