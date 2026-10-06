import { ActionIcon, Group, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { IconEye, IconEyeOff, IconSearch } from "@tabler/icons-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelRow } from "./ModelRow";

export interface ModelListItem {
	value: string;
	label: string;
}

const MAX_VISIBLE_MODEL_ROWS = 200;

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
	const [query, setQuery] = useState("");
	const normalizedQuery = query.trim().toLowerCase();
	const allHidden = useMemo(
		() => models.every((m) => hiddenModels.has(m.value)),
		[models, hiddenModels],
	);
	const sortedModels = useMemo(() => {
		const filtered = normalizedQuery
			? models.filter((model) => {
					const value = model.value.toLowerCase();
					const label = model.label.toLowerCase();
					return value.includes(normalizedQuery) || label.includes(normalizedQuery);
				})
			: models;
		return [...filtered].sort((a, b) => {
			const aHidden = hiddenModels.has(a.value);
			const bHidden = hiddenModels.has(b.value);
			return Number(aHidden) - Number(bHidden);
		});
	}, [models, hiddenModels, normalizedQuery]);
	const visibleModels = sortedModels.slice(0, MAX_VISIBLE_MODEL_ROWS);
	const hiddenRowCount = Math.max(0, sortedModels.length - visibleModels.length);

	if (models.length === 0) return null;

	return (
		<Stack gap="xs" mt="xs">
			{models.length > MAX_VISIBLE_MODEL_ROWS && (
				<TextInput
					size="xs"
					leftSection={<IconSearch size={14} />}
					placeholder={t("modelListSearchPlaceholder")}
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
				/>
			)}
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
			{visibleModels.map((m) => (
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
			{hiddenRowCount > 0 && (
				<Text size="xs" c="dimmed" ta="center">
					{t("modelListItemsTruncated", {
						shown: visibleModels.length,
						hidden: hiddenRowCount,
					})}
				</Text>
			)}
		</Stack>
	);
});
