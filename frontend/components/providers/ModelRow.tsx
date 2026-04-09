import { ActionIcon, Group, NumberInput, Text, Tooltip } from "@mantine/core";
import { IconEye, IconEyeOff, IconPlayerPlay } from "@tabler/icons-react";
import React from "react";
import { useTranslation } from "react-i18next";

export interface ModelRowProps {
	modelValue: string;
	modelLabel: string;
	isHidden: boolean;
	onToggleHidden: () => void;
	contextWindow?: number;
	onContextWindowChange: (size: number | null) => void;
	onTestModel?: () => void;
	/** Set to false to hide the context window input (e.g. Codex). */
	showContextWindow?: boolean;
}

export const ModelRow = React.memo(function ModelRow({
	modelValue,
	modelLabel,
	isHidden,
	onToggleHidden,
	contextWindow,
	onContextWindowChange,
	onTestModel,
	showContextWindow = true,
}: ModelRowProps) {
	const { t } = useTranslation("settings");

	return (
		<Group gap="xs" wrap="wrap" style={isHidden ? { opacity: 0.5 } : undefined}>
			<Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 120 }}>
				{modelValue}
			</Text>
			<Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 120 }}>
				{modelLabel}
			</Text>
			{showContextWindow && (
				<NumberInput
					placeholder={t("contextWindowPlaceholder")}
					value={contextWindow || ""}
					onChange={(v) => onContextWindowChange(typeof v === "number" ? v : null)}
					min={1}
					step={1000}
					suffix={` ${t("contextWindowSuffix")}`}
					w={180}
					size="xs"
				/>
			)}
			{onTestModel && (
				<Tooltip label={t("modelTestBtn")}>
					<ActionIcon variant="subtle" color="teal" onClick={onTestModel}>
						<IconPlayerPlay size={16} />
					</ActionIcon>
				</Tooltip>
			)}
			<ActionIcon variant="subtle" color={isHidden ? "gray" : "blue"} onClick={onToggleHidden}>
				{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
			</ActionIcon>
		</Group>
	);
});
