import { ActionIcon, Group, Stack, Tooltip } from "@mantine/core";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { ModelRow } from "./ModelRow";

export interface ModelListItem {
	value: string;
	label: string;
}

export interface ModelListProps {
	models: ModelListItem[];
	hiddenModels: Set<string>;
	onToggleHidden: (modelVal: string) => void;
	onBatchToggleHidden?: (modelValues: string[], hidden: boolean) => void;
	modelContextWindows: Record<string, number>;
	defaultContextWindows?: Record<string, number>;
	onContextWindowChange: (modelVal: string, size: number | null) => void;
	onTestModel?: (model: string) => void;
	showContextWindow?: boolean;
}

export const ModelList = React.memo(function ModelList({
	models,
	hiddenModels,
	onToggleHidden,
	onBatchToggleHidden,
	modelContextWindows,
	defaultContextWindows,
	onContextWindowChange,
	onTestModel,
	showContextWindow = true,
}: ModelListProps) {
	const { t } = useTranslation("settings");

	if (models.length === 0) return null;

	const allHidden = models.every((m) => hiddenModels.has(m.value));
	const sortedModels = [...models].sort((a, b) => {
		const aHidden = hiddenModels.has(a.value);
		const bHidden = hiddenModels.has(b.value);
		return Number(aHidden) - Number(bHidden);
	});

	return (
		<Stack gap="xs" mt="xs">
			{onBatchToggleHidden && (
				<Group gap="xs" justify="flex-end">
					<Tooltip label={allHidden ? t("showAllModels") : t("hideAllModels")}>
						<ActionIcon
							variant="subtle"
							color={allHidden ? "gray" : "blue"}
							onClick={() =>
								onBatchToggleHidden(
									models.map((m) => m.value),
									!allHidden,
								)
							}
						>
							{allHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
						</ActionIcon>
					</Tooltip>
				</Group>
			)}
			{sortedModels.map((m) => (
				<ModelRow
					key={m.value}
					modelValue={m.value}
					modelLabel={m.label}
					isHidden={hiddenModels.has(m.value)}
					onToggleHidden={() => onToggleHidden(m.value)}
					contextWindow={modelContextWindows[m.value] ?? defaultContextWindows?.[m.value]}
					onContextWindowChange={(size) => onContextWindowChange(m.value, size)}
					onTestModel={onTestModel ? () => onTestModel(m.value) : undefined}
					showContextWindow={showContextWindow}
				/>
			))}
		</Stack>
	);
});
