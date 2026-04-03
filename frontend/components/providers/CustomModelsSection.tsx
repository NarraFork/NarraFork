import {
	ActionIcon,
	Badge,
	Group,
	NumberInput,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { IconEye, IconEyeOff, IconPlayerPlay, IconTrash } from "@tabler/icons-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

interface CustomModelsSectionProps {
	customModels: Array<{ value: string; label: string; provider?: string }>;
	onCustomModelsChange: (
		models: Array<{ value: string; label: string; provider?: string }>,
	) => void;
	hiddenModels: Set<string>;
	onToggleHidden: (modelVal: string) => void;
	prefixOptions: Array<{ value: string; label: string }>;
	modelContextWindows: Record<string, number>;
	onContextWindowChange: (modelVal: string, size: number | null) => void;
	onTestModel?: (model: string) => void;
	/** When true, only show orphan models (no add form) */
	orphanOnly?: boolean;
	/** Pre-filtered orphan models to display */
	orphanModels?: Array<{ value: string; label: string; provider?: string }>;
}

export const CustomModelsSection = React.memo(function CustomModelsSection({
	customModels,
	onCustomModelsChange,
	hiddenModels,
	onToggleHidden,
	modelContextWindows,
	onContextWindowChange,
	onTestModel,
	orphanModels,
}: CustomModelsSectionProps) {
	const { t } = useTranslation("settings");

	const modelsToShow = orphanModels ?? customModels;

	const handleRemoveModel = useCallback(
		(value: string) => {
			onCustomModelsChange(customModels.filter((m) => m.value !== value));
		},
		[customModels, onCustomModelsChange],
	);

	return (
		<Paper withBorder p="md">
			<Stack>
				<div>
					<Title order={4}>{t("orphanCustomModelsSection")}</Title>
					<Text size="xs" c="dimmed">
						{t("orphanCustomModelsSectionDesc")}
					</Text>
				</div>
				{modelsToShow.map((m) => {
					const isHidden = hiddenModels.has(m.value);
					return (
						<Group
							key={m.value}
							gap="xs"
							wrap="wrap"
							style={isHidden ? { opacity: 0.5 } : undefined}
						>
							<TextInput value={m.value} disabled style={{ flex: 1, minWidth: 120 }} />
							<TextInput value={m.label} disabled style={{ flex: 1, minWidth: 120 }} />
							<Badge size="sm" variant="light" color="gray" w={70}>
								{m.provider ?? "?"}
							</Badge>
							<NumberInput
								placeholder={t("contextWindowPlaceholder")}
								value={modelContextWindows[m.value] || ""}
								onChange={(v) => onContextWindowChange(m.value, typeof v === "number" ? v : null)}
								min={1}
								step={1000}
								suffix={` ${t("contextWindowSuffix")}`}
								w={180}
								size="xs"
							/>
							<ActionIcon
								variant="subtle"
								color={isHidden ? "gray" : "blue"}
								onClick={() => onToggleHidden(m.value)}
							>
								{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
							</ActionIcon>
							{onTestModel && (
								<Tooltip label={t("modelTestBtn")}>
									<ActionIcon variant="subtle" color="teal" onClick={() => onTestModel(m.value)}>
										<IconPlayerPlay size={16} />
									</ActionIcon>
								</Tooltip>
							)}
							<ActionIcon color="red" variant="subtle" onClick={() => handleRemoveModel(m.value)}>
								<IconTrash size={14} />
							</ActionIcon>
						</Group>
					);
				})}
			</Stack>
		</Paper>
	);
});
