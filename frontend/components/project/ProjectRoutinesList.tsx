/**
 * The project's routines on the settings page (R2; moved from the old routines dialog). Tool
 * routines pick a mode in plain words — 新会话默认加载 (resident), 会话内手动加载 (manual), the
 * reserved automatic mode, or following the global setting; command and skill routines keep
 * follow global / on / off. Every change saves at once.
 */
import { Alert, Badge, Group, Select, Stack, Text } from "@mantine/core";
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

export function ProjectRoutinesList({
	projectId,
	canManage,
}: {
	projectId: string;
	canManage: boolean;
}) {
	const { t } = useTranslation("projects");
	const { t: ts } = useTranslation("settings");
	const { i18n } = useTranslation();
	const locale = i18n.resolvedLanguage ?? i18n.language;
	const contentCapability = useContentCapability();
	const routinesCapability = contentCapability.projectRoutines;
	const unsupportedReason = routinesCapability.supported
		? undefined
		: (routinesCapability.reason ?? t("routinesUnsupportedDesc"));
	const { data, isLoading } = useProjectRoutines(
		routinesCapability.supported ? projectId : undefined,
	);
	const toggle = useToggleProjectRoutine(projectId);
	const setToolMode = useSetProjectRoutineMode(projectId);
	const editable = canManage && routinesCapability.supported;
	const modeLabel = (mode: ToolRoutineMode) => t(`settingsPage.routines.modes.${mode}`);

	const groups = useMemo(() => {
		const byCategory = new Map<string, NonNullable<typeof data>["routines"]>();
		for (const routine of data?.routines ?? []) {
			const list = byCategory.get(routine.category);
			if (list) list.push(routine);
			else byCategory.set(routine.category, [routine]);
		}
		return Array.from(byCategory, ([category, routines]) => ({ category, routines }));
	}, [data?.routines]);

	return (
		<Stack gap="md" data-testid="project-routines">
			{unsupportedReason && (
				<Alert color="yellow" variant="light" title={t("routinesUnsupportedTitle")}>
					{unsupportedReason}
				</Alert>
			)}
			{isLoading && (
				<Text size="sm" c="dimmed">
					{t("settingsPage.loading")}
				</Text>
			)}
			{groups.map(({ category, routines }) => (
				<Stack key={category} gap={0}>
					<Text size="xs" fw={600} c="dimmed" tt="uppercase" pb={4}>
						{ts(`routineCategory.${category}`, category)}
					</Text>
					{routines.map((routine) => {
						// Tool routines: the three modes plus "follow global"; command and skill routines
						// keep the original follow global / on / off.
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
							<Group
								key={routine.id}
								justify="space-between"
								wrap="nowrap"
								gap="sm"
								py={10}
								style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
								data-testid="project-routine-row"
							>
								<Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
									<Group gap="xs" wrap="nowrap">
										<Text size="sm" fw={500} truncate>
											{routine.type === "command" ? `/${routine.name}` : routine.name}
										</Text>
										<Badge size="xs" variant="light" color="gray" tt="none">
											{ts(`routineType.${routine.type}`)}
										</Badge>
									</Group>
									<Text size="xs" c="dimmed" lineClamp={2}>
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
									<Select
										size="xs"
										w={220}
										allowDeselect={false}
										value={modeOverride}
										disabled={!editable}
										aria-label={routine.name}
										onChange={(value) => {
											const next = normalizeToolRoutineModeOverride(value);
											if (!editable || !next || next === modeOverride) return;
											setToolMode.mutate({ id: routine.id, mode: next });
										}}
										data={PROJECT_TOOL_MODE_VALUES.map((value) => ({
											value,
											label:
												value === "global"
													? t("settingsPage.routines.followGlobal", {
															mode: modeLabel(globalMode),
														})
													: modeLabel(value),
										}))}
									/>
								) : (
									<Select
										size="xs"
										w={220}
										allowDeselect={false}
										value={routine.override}
										disabled={!editable}
										aria-label={routine.name}
										onChange={(value) => {
											const action = value ? routineOverrideToAction(value) : null;
											if (!editable || !action) return;
											toggle.mutate({ id: routine.id, action });
										}}
										data={[
											{
												value: "global",
												label: t("settingsPage.routines.followGlobal", {
													mode: routine.globalEnabled
														? ts("routineEnabled")
														: ts("routineDisabled"),
												}),
											},
											{ value: "enabled", label: ts("routineEnabled") },
											{ value: "disabled", label: ts("routineDisabled") },
										]}
									/>
								)}
							</Group>
						);
					})}
				</Stack>
			))}
		</Stack>
	);
}
